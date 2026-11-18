import { describe, expect, it } from "vitest";
// @ts-ignore -- plain ESM CLI module without type declarations
import * as doctor from "../bin/doctor.mjs";
import { detectBot } from "../src/shared/bots";

const {
  parseArgs, parseDotenv, checkServiceAccountKey, parseVercelEnvNames, classifyCollect,
  extractScriptUrls, hasTrackerSignature, sameSite, hasAnalyticsComponent, siteLabelFromCode, formatReport, exitCode, UA,
} = doctor as Record<string, any>;

const PRIVATE = "-----BEGIN PRIVATE KEY-----\nSECRETSECRET\n-----END PRIVATE KEY-----\n";
const KEY = JSON.stringify({ type: "service_account", client_email: "writer@p-123.iam.gserviceaccount.com", private_key: PRIVATE });

describe("doctor: env parsing", () => {
  it("parses dotenv quoting and comments", () => {
    const env = parseDotenv([
      "# comment",
      "WA_SITE=mysite # trailing",
      'export WA_BQ_PROJECT="my-proj"',
      "WA_SALT_SECRET='a#b'",
      'WA_GCP_SA_KEY="{\\"a\\":1}"',
      "EMPTY=",
    ].join("\n"));
    expect(env).toEqual({ WA_SITE: "mysite", WA_BQ_PROJECT: "my-proj", WA_SALT_SECRET: "a#b", WA_GCP_SA_KEY: '{"a":1}', EMPTY: "" });
  });

  it("reads names from vercel env ls output, not the header", () => {
    const out = ` name               value               environments        created\n WA_SITE            Encrypted           Production          18h ago\n WA_GCP_SA_KEY      Encrypted           Production          18h ago\n\nCommon next commands:`;
    expect([...parseVercelEnvNames(out)]).toEqual(["WA_SITE", "WA_GCP_SA_KEY"]);
  });

  it("parses flags", () => {
    expect(parseArgs(["--url", "https://x.com", "--vercel", "--project", "p"])).toEqual({ _: [], url: "https://x.com", vercel: true, project: "p" });
  });
});

describe("doctor: service account key", () => {
  it("accepts raw JSON and base64 and shows only client_email", () => {
    expect(checkServiceAccountKey(KEY)).toEqual({ ok: true, format: "json", clientEmail: "writer@p-123.iam.gserviceaccount.com", problem: undefined });
    expect(checkServiceAccountKey(Buffer.from(KEY).toString("base64"))).toMatchObject({ ok: true, format: "base64" });
  });

  it("never echoes the value in its problem text", () => {
    for (const bad of ['{"private_key": "SECRETSECRET"', "SECRETSECRET!!", Buffer.from("SECRETSECRET").toString("base64"), JSON.stringify({ private_key: "SECRETSECRET" })]) {
      const r = checkServiceAccountKey(bad);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("SECRETSECRET");
    }
  });

  it("flags missing fields", () => {
    expect(checkServiceAccountKey(JSON.stringify({ client_email: "a@b" }))).toMatchObject({ ok: false, problem: "no private_key" });
  });
});

describe("doctor: code and live helpers", () => {
  it("finds <Analytics> imported from the package", () => {
    expect(hasAnalyticsComponent(`import { Analytics, ConsentBanner } from "@bmnova/web-analytics/react";\n<Analytics site="x" />`)).toBe(true);
    expect(hasAnalyticsComponent(`import { Analytics } from "@vercel/analytics/react";\n<Analytics />`)).toBe(false);
    expect(hasAnalyticsComponent(`import { Analytics } from "@bmnova/web-analytics/react";`)).toBe(false);
  });

  it("reads the site label from code", () => {
    expect(siteLabelFromCode(`createCollectHandler({ site: "bmnova" })`)).toBe("bmnova");
    expect(siteLabelFromCode(` site="shop" />`)).toBe("shop");
    expect(siteLabelFromCode(`createCollectHandler()`)).toBeNull();
  });

  it("keeps same-origin and /_next scripts only", () => {
    const html = `<script src="/_next/static/chunks/a.js"></script><script async src="https://cdn.other.com/x.js"></script><script src="https://cdn.x.com/_next/static/b.js?dpl=1&amp;v=2"></script>`;
    expect(extractScriptUrls(html, "https://site.com/en")).toEqual([
      "https://site.com/_next/static/chunks/a.js",
      "https://cdn.x.com/_next/static/b.js?dpl=1&v=2",
    ]);
  });

  it("recognises the tracker bundle", () => {
    expect(hasTrackerSignature(`a="wa_consent";b={endpoint:"/api/collect"}`)).toBe(true);
    expect(hasTrackerSignature(`fetch("/api/collect")`)).toBe(false);
  });

  it("classifies collector answers", () => {
    expect(classifyCollect(400).status).toBe("pass");
    expect(classifyCollect(503, "missing-config: WA_GCP_SA_KEY")).toMatchObject({ status: "fail", detail: "503 missing-config: WA_GCP_SA_KEY" });
    for (const s of [403, 404, 405, 308, 500, 204]) expect(classifyCollect(s).status).toBe("fail");
  });

  it("treats only a www. difference as the same site", () => {
    expect(sameSite("bmnova.com", "www.bmnova.com")).toBe(true);
    expect(sameSite("WWW.Example.com", "example.com")).toBe(true);
    expect(sameSite("my-app-git-x.vercel.app", "vercel.com")).toBe(false);
    expect(sameSite("example.com", "login.example.com")).toBe(false);
  });

  it("uses a user agent the proxy does not log as a bot", () => {
    expect(detectBot(UA)).toBeNull();
  });
});

describe("doctor: report", () => {
  const sections = [
    { title: "A", results: [{ status: "pass", label: "x" }, { status: "fail", label: "y", detail: "no", fix: "do it" }, { status: "fail", label: "z", fix: "do it" }] },
    { title: "B", results: [{ status: "warn", label: "w" }, { status: "skip", label: "s" }] },
  ];
  it("prints marks, one copy of a repeated fix, and totals", () => {
    const out = formatReport(sections);
    expect(out).toContain("✓ x");
    expect(out).toContain("✗ y — no");
    expect(out.match(/→ do it/g)).toHaveLength(1);
    expect(out).toContain("1 ok, 2 failed, 1 warnings, 1 skipped");
  });
  it("exits 1 only when something failed", () => {
    expect(exitCode(sections)).toBe(1);
    expect(exitCode([sections[1]])).toBe(0);
  });
});
