import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { createCollectHandler } from "../src/server/collect";
import { withAnalytics } from "../src/server/proxy";
import { buildAssertion } from "../src/server/bigquery";
import { visitorHash } from "../src/server/hash";
import type { EventRow } from "../src/shared/schema";

const env = { WA_SITE: "test", WA_SALT_SECRET: "s".repeat(32), WA_DRY_RUN: "1" };
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let logged: EventRow[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((tag: unknown, json: unknown) => {
    if (tag === "[web-analytics:dry-run]") logged.push(JSON.parse(String(json)));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.com/api/collect", {
    method: "POST",
    headers: { origin: "https://example.com", "content-type": "application/json", "user-agent": CHROME, "x-forwarded-for": "203.0.113.9", "cf-ipcountry": "TR", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("collect handler", () => {
  const { POST } = createCollectHandler({ env });

  it("writes a cleaned row", async () => {
    const res = await POST(post({ site: "test", events: [{ event: "pageview", path: "/p?secret=1", consent: "basic", utm: { source: "chatgpt.com" }, visitor_id: "should-drop", props: { email: "x@y.z", plan: "pro" } }] }));
    expect(res.status).toBe(204);
    expect(logged).toHaveLength(1);
    const row = logged[0]!;
    expect(row).toMatchObject({ site: "test", event: "pageview", path: "/p", channel: "ai", source: "chatgpt.com", country: "TR", is_bot: false, user_agent: null, visitor_id: null, browser: "Chrome", os: "macOS" });
    expect(row.visitor_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(row.props!)).toEqual({ plan: "pro" });
  });

  it("keeps ids only with full consent", async () => {
    await POST(post({ events: [{ event: "click", path: "/", consent: "full", visitor_id: "v1", session_id: "s1" }] }));
    expect(logged[0]).toMatchObject({ visitor_id: "v1", session_id: "s1", consent: "full" });
  });

  it("rejects other origins, bad JSON, empty and oversized bodies", async () => {
    expect((await POST(post({ events: [{ event: "pageview", path: "/", consent: "basic" }] }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(post("{nope"))).status).toBe(400);
    expect((await POST(post({ events: [] }))).status).toBe(400);
    expect((await POST(post({ events: [{ event: "bad name!", path: "/", consent: "basic" }] }))).status).toBe(400);
    expect((await POST(post({ events: [{ event: "x", path: "/", consent: "basic", title: "y".repeat(9000) }] }))).status).toBe(413);
    expect(logged).toHaveLength(0);
  });

  it("allows configured extra origins", async () => {
    const { POST: p2 } = createCollectHandler({ env: { ...env, WA_ALLOWED_ORIGINS: "https://www.example.com" } });
    expect((await p2(post({ events: [{ event: "pageview", path: "/", consent: "basic" }] }, { origin: "https://www.example.com" }))).status).toBe(204);
  });
});

describe("withAnalytics", () => {
  it("logs bots, passes through humans and calls the inner handler", async () => {
    const inner = vi.fn(() => new Response("inner"));
    const handler = withAnalytics(inner, { env });
    const waits: Promise<unknown>[] = [];
    const event = { waitUntil: (p: Promise<unknown>) => waits.push(p) };

    const botRes = await handler(new Request("https://example.com/robots.txt", { headers: { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.1)" } }), event);
    await Promise.all(waits);
    expect(await botRes!.text()).toBe("inner");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ event: "bot_request", path: "/robots.txt", is_bot: true, bot_name: "GPTBot", bot_kind: "ai_training", visitor_hash: null });
    expect(logged[0]!.user_agent).toContain("GPTBot");

    await handler(new Request("https://example.com/", { headers: { "user-agent": CHROME } }), event);
    await Promise.all(waits);
    expect(logged).toHaveLength(1);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("returns undefined without an inner handler (continue)", async () => {
    const handler = withAnalytics(undefined, { env });
    expect(await handler(new Request("https://example.com/", { headers: { "user-agent": CHROME } }), {})).toBeUndefined();
  });
});

describe("visitorHash", () => {
  it("is stable within a day and rotates across days", async () => {
    const base = { secret: "k".repeat(32), site: "s", ip: "1.2.3.4", ua: "ua" };
    const d1 = await visitorHash({ ...base, date: new Date("2026-01-01T01:00:00Z") });
    const d1b = await visitorHash({ ...base, date: new Date("2026-01-01T23:00:00Z") });
    const d2 = await visitorHash({ ...base, date: new Date("2026-01-02T01:00:00Z") });
    expect(d1).toBe(d1b);
    expect(d1).not.toBe(d2);
  });
});

describe("buildAssertion", () => {
  it("produces a verifiable RS256 JWT", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = await buildAssertion({ client_email: "sa@p.iam.gserviceaccount.com", private_key: pem }, 1000);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toMatchObject({ iss: "sa@p.iam.gserviceaccount.com", iat: 1000, exp: 4600 });
    const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("withAnalytics asset filter", () => {
  it("ignores image requests but keeps robots.txt", async () => {
    const handler = withAnalytics(undefined, { env });
    const waits: Promise<unknown>[] = [];
    const event = { waitUntil: (p: Promise<unknown>) => waits.push(p) };
    await handler(new Request("https://example.com/apps/x/icon.webp"), event);
    await handler(new Request("https://example.com/llms.txt", { headers: { "user-agent": "GPTBot/1.1" } }), event);
    await Promise.all(waits);
    expect(logged.map((r) => r.path)).toEqual(["/llms.txt"]);
  });
});
