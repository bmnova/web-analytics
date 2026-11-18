import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, isProduction, type WaEnv } from "../src/server/env";
import { createCollectHandler, ERROR_HEADER } from "../src/server/collect";
import { trackServer } from "../src/server/track";
import { withAnalytics } from "../src/server/proxy";

const SECRET_KEY = "not-json-but-very-secret-value";
const VALID_SA = JSON.stringify({ client_email: "wa@p.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" });
const base: WaEnv = { WA_SITE: "t", WA_SALT_SECRET: "s".repeat(32), WA_GCP_SA_KEY: undefined, WA_BQ_PROJECT: undefined, WA_DRY_RUN: undefined, VERCEL_ENV: undefined, NODE_ENV: undefined };
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let errors: string[] = [];
let rows: string[] = [];
beforeEach(() => {
  // getConfig logs each problem once per process; reset so every test sees its own message.
  const g = globalThis as { [k: symbol]: Set<string> | undefined };
  g[Symbol.for("@bmnova/web-analytics/errored")]?.clear();
  g[Symbol.for("@bmnova/web-analytics/warned")]?.clear();
  errors = [];
  rows = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation((tag: unknown, json: unknown) => {
    if (tag === "[web-analytics:dry-run]") rows.push(String(json));
  });
});
afterEach(() => vi.restoreAllMocks());

const post = () =>
  new Request("https://example.com/api/collect", {
    method: "POST",
    headers: { origin: "https://example.com", "content-type": "application/json", "user-agent": CHROME, "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify({ events: [{ event: "pageview", path: "/", consent: "basic" }] }),
  });
const collect = (env: WaEnv) => createCollectHandler({ env: { ...base, ...env } }).POST(post());

describe("isProduction", () => {
  it.each<[WaEnv, boolean]>([
    [{ VERCEL_ENV: "production" }, true],
    [{ VERCEL_ENV: "production", NODE_ENV: "development" }, true],
    [{ VERCEL_ENV: "preview", NODE_ENV: "production" }, false],
    [{ VERCEL_ENV: "development", NODE_ENV: "production" }, false],
    [{ NODE_ENV: "production" }, true], // Cloudflare / OpenNext, self-hosted
    [{ NODE_ENV: "development" }, false],
    [{ NODE_ENV: "test" }, false],
    [{}, false],
  ])("%j -> %s", (env, expected) => expect(isProduction(env)).toBe(expected));
});

describe("production without credentials", () => {
  it.each<[string, WaEnv]>([
    ["Vercel production", { VERCEL_ENV: "production" }],
    ["NODE_ENV=production (Cloudflare)", { NODE_ENV: "production" }],
  ])("%s: collector answers 503 with the reason, logs an error, writes nothing", async (_label, env) => {
    const res = await collect(env);
    expect(res.status).toBe(503);
    expect(res.headers.get(ERROR_HEADER)).toBe("missing-config: WA_GCP_SA_KEY, WA_BQ_PROJECT");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("WA_GCP_SA_KEY, WA_BQ_PROJECT");
    expect(rows).toHaveLength(0);
  });

  it("names only the missing variable and never logs values", async () => {
    const res = await collect({ NODE_ENV: "production", WA_GCP_SA_KEY: SECRET_KEY, WA_BQ_PROJECT: "my-project" });
    expect(res.status).toBe(503);
    expect(res.headers.get(ERROR_HEADER)).toBe("missing-config: WA_GCP_SA_KEY (invalid service account JSON)");
    expect(errors.join("\n")).not.toContain(SECRET_KEY);
    expect(errors.join("\n")).not.toContain("my-project");
    expect(res.headers.get(ERROR_HEADER)).not.toContain(SECRET_KEY);

    const res2 = await collect({ VERCEL_ENV: "production", WA_GCP_SA_KEY: VALID_SA });
    expect(res2.headers.get(ERROR_HEADER)).toBe("missing-config: WA_BQ_PROJECT");
    expect(errors.join("\n")).not.toContain("BEGIN PRIVATE KEY");
  });

  it("logs the error once, not on every request", async () => {
    await collect({ NODE_ENV: "production" });
    await collect({ NODE_ENV: "production" });
    expect(errors).toHaveLength(1);
  });

  it("still checks the origin first", async () => {
    const res = await createCollectHandler({ env: { ...base, NODE_ENV: "production" } }).POST(
      new Request("https://example.com/api/collect", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }),
    );
    expect(res.status).toBe(403);
  });

  it("trackServer and the proxy drop rows without throwing or printing them", async () => {
    const env = { ...base, NODE_ENV: "production" };
    await expect(trackServer("signed_up", { plan: "pro" }, { env, await: true })).resolves.toBeUndefined();
    const inner = vi.fn(() => new Response("page"));
    const res = await withAnalytics(inner, { env })(new Request("https://example.com/", { headers: { "user-agent": "GPTBot/1.1" } }), {});
    expect(await res!.text()).toBe("page");
    expect(rows).toHaveLength(0);
  });

  it("getConfig never throws, whatever the input", () => {
    expect(() => getConfig({ ...base, NODE_ENV: "production", WA_GCP_SA_KEY: "%%%not base64%%%" })).not.toThrow();
    expect(() => getConfig({ ...base, VERCEL_ENV: "production", WA_GCP_SA_KEY: "{broken" })).not.toThrow();
  });
});

describe("dry-run stays available", () => {
  it.each<[string, WaEnv]>([
    ["explicit WA_DRY_RUN=1 in production", { NODE_ENV: "production", WA_DRY_RUN: "1" }],
    ["explicit WA_DRY_RUN=true on Vercel production", { VERCEL_ENV: "production", WA_DRY_RUN: "true" }],
    ["development", { NODE_ENV: "development" }],
    ["Vercel preview", { VERCEL_ENV: "preview", NODE_ENV: "production" }],
    ["no NODE_ENV", {}],
  ])("%s: 204 and the row is printed", async (_label, env) => {
    const res = await collect(env);
    expect(res.status).toBe(204);
    expect(res.headers.get(ERROR_HEADER)).toBeNull();
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(getConfig({ ...base, ...env })).toMatchObject({ dryRun: true, missing: [] });
  });

  it("explicit WA_DRY_RUN=1 with full credentials in production still dry-runs", () => {
    expect(getConfig({ ...base, NODE_ENV: "production", WA_DRY_RUN: "1", WA_GCP_SA_KEY: VALID_SA, WA_BQ_PROJECT: "p" })).toMatchObject({ dryRun: true, production: true, missing: [] });
  });

  it("production with valid credentials is not dry-run and reports nothing", () => {
    expect(getConfig({ ...base, VERCEL_ENV: "production", WA_GCP_SA_KEY: VALID_SA, WA_BQ_PROJECT: "p" })).toMatchObject({ dryRun: false, production: true, missing: [] });
    expect(getConfig({ ...base, NODE_ENV: "production", WA_GCP_SA_KEY: btoa(VALID_SA), WA_BQ_PROJECT: "p" })).toMatchObject({ dryRun: false, missing: [] });
    expect(errors).toHaveLength(0);
  });
});
