import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollectHandler } from "../src/server/collect";
import { withAnalytics } from "../src/server/proxy";
import { trackServer } from "../src/server/track";
import { createOnRequestError } from "../src/server/errors";
import { UNNORMALIZED_PATH, storedPath } from "../src/server/rows";
import type { EventRow } from "../src/shared/schema";

const env = { WA_SITE: "test", WA_SALT_SECRET: "s".repeat(32), WA_DRY_RUN: "1" };
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const GPTBOT = "Mozilla/5.0 (compatible; GPTBot/1.1)";
const normalizePath = (p: string) => p.replace(/^\/r\/[^/]+/, "/r/[id]");

let logged: EventRow[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((tag: unknown, json: unknown) => {
    if (tag === "[web-analytics:dry-run]") logged.push(JSON.parse(String(json)));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const event = { waitUntil: (p: Promise<unknown>) => p };
const flush = () => new Promise((r) => setTimeout(r, 10));

function post(events: unknown[], headers: Record<string, string> = {}) {
  return new Request("https://example.com/api/collect", {
    method: "POST",
    headers: { origin: "https://example.com", "content-type": "application/json", "user-agent": CHROME, ...headers },
    body: JSON.stringify({ events }),
  });
}

async function collect(options: Parameters<typeof createCollectHandler>[0], ev: Record<string, unknown>) {
  const { POST } = createCollectHandler({ env, ...options });
  await POST(post([{ event: "pageview", consent: "basic", path: "/r/abc123?x=1", title: "Ada's card", ...ev }]));
  await flush();
  return logged[0]!;
}

describe("normalizePath", () => {
  it("rewrites the stored path in the collector", async () => {
    expect((await collect({ normalizePath }, {})).path).toBe("/r/[id]");
  });

  it("rewrites the stored path in withAnalytics, after bot detection and ignore see the raw path", async () => {
    const seen: string[] = [];
    const handler = withAnalytics(undefined, { env, normalizePath, ignore: (p) => (seen.push(p), p === "/r/skip") });
    await handler(new Request("https://example.com/r/abc123", { headers: { "user-agent": GPTBOT } }), event);
    await handler(new Request("https://example.com/r/skip", { headers: { "user-agent": GPTBOT } }), event);
    await handler(new Request("https://example.com/r/abc123", { headers: { "user-agent": CHROME } }), event);
    await flush();
    expect(seen).toEqual(["/r/abc123", "/r/skip", "/r/abc123"]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ path: "/r/[id]", is_bot: true, bot_name: "GPTBot" });
  });

  it("does not change the asset filter or collector skip", async () => {
    const handler = withAnalytics(undefined, { env, normalizePath: () => "/everything" });
    await handler(new Request("https://example.com/r/x/icon.png", { headers: { "user-agent": GPTBOT } }), event);
    await handler(new Request("https://example.com/api/collect", { headers: { "user-agent": GPTBOT } }), event);
    await flush();
    expect(logged).toHaveLength(0);
  });

  it("rewrites the stored path in trackServer", async () => {
    await trackServer("share", {}, { env, path: "/r/abc123", normalizePath, await: true });
    await trackServer("share", {}, { env, request: new Request("https://example.com/r/def456?q=1"), normalizePath, await: true });
    expect(logged.map((r) => r.path)).toEqual(["/r/[id]", "/r/[id]"]);
  });

  it("rewrites the stored path in onRequestError but keeps the route pattern", async () => {
    const onRequestError = createOnRequestError({ env, normalizePath });
    await onRequestError(new Error("boom"), { path: "/r/abc123", method: "GET", headers: { host: "example.com" } }, { routePath: "/r/[cardId]" });
    await flush();
    expect(logged[0]!.path).toBe("/r/[id]");
    expect(JSON.parse(logged[0]!.props!).route).toBe("/r/[cardId]");
  });

  it("fails closed when normalizePath throws or returns a non-string", async () => {
    expect((await collect({ normalizePath: () => { throw new Error("x"); } }, {})).path).toBe(UNNORMALIZED_PATH);
    logged = [];
    expect((await collect({ normalizePath: (() => undefined) as never }, {})).path).toBe(UNNORMALIZED_PATH);
    logged = [];
    await trackServer("x", {}, { env, path: "/r/abc", normalizePath: () => { throw new Error("x"); }, await: true });
    expect(logged[0]!.path).toBe(UNNORMALIZED_PATH);
  });

  it("cleans the normalized output (leading slash, query, length)", () => {
    expect(storedPath("/a", () => "b?x=1")).toBe("/b");
    expect(storedPath("/a", () => "/" + "z".repeat(2000))!.length).toBe(512);
    expect(storedPath(null, normalizePath)).toBeNull();
    expect(storedPath("/r/a?x", undefined)).toBe("/r/a");
  });
});

describe("referrer", () => {
  it("stores only the referrer host, so same-site referrer paths never reach the row", async () => {
    const row = await collect({ normalizePath }, { referrer: "https://example.com/r/abc123?x=1" });
    expect(row.referrer_host).toBe("example.com");
    expect(JSON.stringify(row)).not.toContain("abc123");
  });

  it("keeps external referrers as before", async () => {
    const row = await collect({ normalizePath }, { referrer: "https://news.ycombinator.com/item?id=1" });
    expect(row).toMatchObject({ referrer_host: "news.ycombinator.com", channel: "social" });
  });
});

describe("keepTitle", () => {
  it("stores titles by default and null when false", async () => {
    expect((await collect({}, {})).title).toBe("Ada's card");
    logged = [];
    expect((await collect({ keepTitle: false }, {})).title).toBeNull();
  });
});

describe("backward compatibility", () => {
  it("rows without options equal rows with no-op options", async () => {
    const strip = (r: EventRow) => ({ ...r, ts: "" });
    const a = strip(await collect({}, { referrer: "https://example.com/r/abc123" }));
    logged = [];
    const b = strip(await collect({ normalizePath: (p) => p, keepTitle: true }, { referrer: "https://example.com/r/abc123" }));
    expect(b).toEqual(a);
    expect(a).toMatchObject({ path: "/r/abc123", title: "Ada's card" });
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });
});
