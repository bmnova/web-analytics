#!/usr/bin/env node
// web-analytics doctor: checks one site's setup (env, code, live site, BigQuery) and prints
// ✓ / ✗ with a fix for each item. Read-only: it never writes events, rows or config, and it
// never prints secret values (only whether a variable is set and whether its format is valid).
// Exit code 1 when any check fails. Uses Node built-ins plus the bq / vercel CLIs if present.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const HELP = `Usage:
  web-analytics doctor [--url https://example.com] [--vercel] [--dir .]
                       [--project <gcp-project>] [--dataset web_analytics] [--site <label>]

  Checks, each independent of the others:
    env       WA_* variables in .env, .env.local, .env.production (and with --vercel, the names in
              \`vercel env ls production\`). Values are never printed; the service-account key is
              checked for valid JSON/base64 and its client_email is shown.
    code      Next.js collect route (app/api/collect/route.ts), <Analytics> in a layout, withAnalytics.
    live      with --url: the page loads the tracker, and an empty POST to /api/collect returns 400.
              Nothing is written.
    bigquery  with the bq CLI: dataset, events table, scheduled queries, and human (is_bot = FALSE)
              events for the site in the last 24 hours. Read-only queries.
  --project / --dataset / --site override the values found in local env files and code.
Exit code 1 if any check fails.`;

const REQUIRED = ["WA_SITE", "WA_BQ_PROJECT", "WA_GCP_SA_KEY", "WA_SALT_SECRET"];
const OPTIONAL = ["WA_BQ_DATASET", "WA_ALLOWED_ORIGINS"];
const ENV_FILES = [".env", ".env.local", ".env.production"];
// Next.js precedence for a production build: .env.production.local > .env.local > .env.production > .env
const VALUE_ORDER = [".env.local", ".env.production", ".env"];
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DATASET = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".turbo", ".vercel", "dist", "out", "build", ".open-next"]);
export const UA = "web-analytics-doctor (+https://github.com/bmnova/web-analytics)";

// ---------- pure helpers (exported for tests) ----------

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--no-")) out[a.slice(5)] = false;
    else if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
      else (out[a.slice(2)] = next), i++;
    } else out._.push(a);
  }
  return out;
}

/** Minimal dotenv parser: KEY=value, export prefix, single/double/backtick quotes, # comments. */
export function parseDotenv(text) {
  const out = {};
  const re = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|`([^`]*)`|([^\n\r]*))/gm;
  for (const m of String(text).matchAll(re)) {
    let v;
    if (m[2] !== undefined) v = m[2].replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\(["\\])/g, "$1");
    else if (m[3] !== undefined) v = m[3];
    else if (m[4] !== undefined) v = m[4];
    else v = (m[5] ?? "").replace(/[ \t]+#.*$/, "").trim();
    out[m[1]] = v;
  }
  return out;
}

/**
 * Validates a WA_GCP_SA_KEY value without ever returning any part of it except client_email.
 * Parse errors are not passed through: JSON.parse messages quote the input.
 */
export function checkServiceAccountKey(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, problem: "empty" };
  const trimmed = raw.trim();
  let json;
  let format;
  if (trimmed.startsWith("{")) {
    format = "json";
    try {
      json = JSON.parse(trimmed);
    } catch {
      return { ok: false, format, problem: "starts with { but is not valid JSON (paste the whole key file on one line)" };
    }
  } else {
    format = "base64";
    if (!/^[A-Za-z0-9+/=_-\s]+$/.test(trimmed)) return { ok: false, problem: "neither JSON nor base64" };
    try {
      json = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"));
    } catch {
      return { ok: false, format, problem: "base64 does not decode to JSON" };
    }
  }
  if (!json || typeof json !== "object") return { ok: false, format, problem: "not a JSON object" };
  const email = typeof json.client_email === "string" ? json.client_email : null;
  const problems = [];
  if (!email) problems.push("no client_email");
  if (typeof json.private_key !== "string" || !json.private_key.includes("PRIVATE KEY")) problems.push("no private_key");
  if (json.type !== undefined && json.type !== "service_account") problems.push(`type is not service_account`);
  return { ok: problems.length === 0, format, clientEmail: email, problem: problems.join(", ") || undefined };
}

/** Variable names from `vercel env ls <env>` output (header and other lines are ignored). */
export function parseVercelEnvNames(output) {
  const names = new Set();
  for (const line of String(output).split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s{2,}/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/** Interprets the collector's answer to an empty `{}` POST. */
export function classifyCollect(status, errorHeader, location) {
  if (status === 400) return { status: "pass", detail: "an empty POST is rejected with 400: route deployed, config present, nothing written" };
  if (status === 503) {
    return {
      status: "fail",
      detail: `503 ${errorHeader ?? ""}`.trim(),
      fix: "Production is missing BigQuery settings. Set the named variables on the host and redeploy.",
    };
  }
  if (status === 403) {
    return {
      status: "fail",
      detail: "403: the site's own origin was refused",
      fix: "If the page and /api/collect are on different hosts, add the page origin to WA_ALLOWED_ORIGINS.",
    };
  }
  if (status >= 300 && status < 400) {
    return {
      status: "fail",
      detail: `${status} redirect${location ? ` to ${location}` : ""}`,
      fix: "Run doctor against the final URL, and make sure middleware does not redirect /api/collect (e.g. i18n locale prefix).",
    };
  }
  if (status === 404 || status === 405) {
    return { status: "fail", detail: `${status}: no POST handler at /api/collect`, fix: "Deploy app/api/collect/route.ts (see README step 1)." };
  }
  return { status: "fail", detail: `unexpected HTTP ${status}`, fix: "Check the deployment logs for /api/collect." };
}

/** Same-origin (or /_next) script URLs referenced by a page. */
export function extractScriptUrls(html, pageUrl) {
  const base = new URL(pageUrl);
  const urls = new Set();
  for (const m of String(html).matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const u = new URL(m[1].replace(/&amp;/g, "&"), base);
      if (u.origin === base.origin || u.pathname.includes("/_next/")) urls.add(u.href);
    } catch {
      // ignore bad src
    }
  }
  return [...urls];
}

/** True when a JS bundle contains the web-analytics tracker. */
export function hasTrackerSignature(js) {
  const s = String(js);
  return s.includes("wa_consent") && (s.includes("wa_vid") || s.includes("/api/collect"));
}

/** <Analytics> imported from the package and rendered. */
export function hasAnalyticsComponent(source) {
  const s = String(source);
  const imported = /import\s*\{[^}]*\bAnalytics\b[^}]*\}\s*from\s*["']@bmnova\/web-analytics\/react["']/.test(s);
  return imported && /<Analytics[\s/>]/.test(s);
}

export function siteLabelFromCode(source) {
  const m = /\bsite\s*(?:=|:)\s*\{?\s*["'`]([A-Za-z0-9_.-]+)["'`]/.exec(String(source));
  return m ? m[1] : null;
}

const MARK = { pass: "✓", fail: "✗", warn: "!", skip: "–" };

export function formatReport(sections) {
  const lines = [];
  for (const s of sections) {
    lines.push(`\n${s.title}`);
    const shown = new Set();
    for (const r of s.results) {
      lines.push(`  ${MARK[r.status] ?? "?"} ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
      if (r.fix && r.status !== "pass" && !shown.has(r.fix)) lines.push(`      → ${r.fix}`), shown.add(r.fix);
    }
  }
  const all = sections.flatMap((s) => s.results);
  const n = (st) => all.filter((r) => r.status === st).length;
  lines.push(`\n${n("pass")} ok, ${n("fail")} failed, ${n("warn")} warnings, ${n("skip")} skipped`);
  return lines.join("\n");
}

export const exitCode = (sections) => (sections.some((s) => s.results.some((r) => r.status === "fail")) ? 1 : 0);

// ---------- I/O helpers ----------

function run(cmd, argv, opts = {}) {
  const res = spawnSync(cmd, argv, { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"], ...opts });
  return { ok: !res.error && res.status === 0, missing: res.error?.code === "ENOENT", stdout: res.stdout ?? "", stderr: res.stderr ?? "", error: res.error };
}

const lastLine = (s) => String(s).trim().split("\n").filter(Boolean).pop()?.slice(0, 300) ?? "";

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function walk(dir, match, depth = 8, out = []) {
  if (depth < 0 || !existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, match, depth - 1, out);
    } else if (match(e.name, p)) out.push(p);
  }
  return out;
}

async function fetchWithTimeout(url, init = {}, ms = 15_000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms), headers: { "user-agent": UA, ...(init.headers ?? {}) } });
}

// ---------- checks ----------

function checkEnv(ctx) {
  const results = [];
  const files = {};
  for (const f of ENV_FILES) {
    const text = readText(join(ctx.dir, f));
    if (text !== null) files[f] = parseDotenv(text);
  }
  const found = Object.keys(files);
  results.push(found.length
    ? { status: "pass", label: "env files", detail: found.join(", ") }
    : { status: "warn", label: "env files", detail: `none of ${ENV_FILES.join(", ")} in ${ctx.dir}` });

  let vercel = null;
  if (ctx.args.vercel) {
    const r = run("vercel", ["env", "ls", "production"], { cwd: ctx.dir });
    if (r.missing) results.push({ status: "fail", label: "vercel env ls production", detail: "vercel CLI not found", fix: "npm i -g vercel, then vercel link" });
    else if (!r.ok) results.push({ status: "fail", label: "vercel env ls production", detail: lastLine(r.stderr || r.stdout), fix: "Run `vercel link` in this directory and `vercel login`." });
    else {
      vercel = parseVercelEnvNames(`${r.stdout}\n${r.stderr}`);
      results.push({ status: "pass", label: "vercel env ls production", detail: `${[...vercel].filter((n) => n.startsWith("WA_")).length} WA_* variables` });
    }
  }

  const local = {};
  for (const f of VALUE_ORDER) for (const [k, v] of Object.entries(files[f] ?? {})) if (v && !(k in local)) local[k] = v;
  ctx.localEnv = local;

  for (const name of [...REQUIRED, ...OPTIONAL]) {
    const where = ENV_FILES.filter((f) => files[f]?.[name]);
    const inVercel = vercel?.has(name) ?? false;
    const sources = [...where, ...(inVercel ? ["vercel production"] : [])];
    const value = local[name];
    const required = REQUIRED.includes(name);
    if (!sources.length) {
      if (required) {
        results.push({
          status: "fail", label: name, detail: `not set${vercel ? "" : " locally"}`,
          fix: vercel
            ? `vercel env add ${name} production (see .env.example in the package)`
            : `Set it in .env.local for local tests, or pass --vercel to check production. Without WA_GCP_SA_KEY local dev dry-runs, which is fine.`,
        });
      } else {
        results.push({
          status: "warn", label: name, detail: "not set (optional)",
          fix: name === "WA_BQ_DATASET" ? "Defaults to web_analytics." : "Only needed when other origins post to /api/collect; the site's own origin is always allowed.",
        });
      }
      continue;
    }
    const src = `set in ${sources.join(", ")}`;
    if (!value) {
      results.push({ status: "pass", label: name, detail: `${src}; value not readable here, format not checked` });
      continue;
    }
    results.push(checkValue(name, value, src));
  }
  if (vercel?.has("WA_DRY_RUN") || local.WA_DRY_RUN) {
    results.push({ status: "warn", label: "WA_DRY_RUN", detail: `set${vercel?.has("WA_DRY_RUN") ? " in vercel production" : " locally"}: rows are logged, not written`, fix: "Remove it from production." });
  }
  return results;
}

function checkValue(name, value, src) {
  const ok = (detail) => ({ status: "pass", label: name, detail: `${src}; ${detail}` });
  const bad = (detail, fix) => ({ status: "fail", label: name, detail: `${src}; ${detail}`, fix });
  switch (name) {
    case "WA_GCP_SA_KEY": {
      const k = checkServiceAccountKey(value);
      if (!k.ok) return bad(`invalid${k.format ? ` ${k.format}` : ""} key: ${k.problem}`, "Paste the whole service-account JSON (or base64 of it) for web-analytics-writer.");
      return ok(`valid ${k.format}, client_email ${k.clientEmail}`);
    }
    case "WA_BQ_PROJECT":
      return PROJECT.test(value) ? ok(`"${value}"`) : bad("not a valid GCP project id", "Use the project id (lowercase, 6-30 chars), not the name or number.");
    case "WA_BQ_DATASET":
      return DATASET.test(value) ? ok(`"${value}"`) : bad("not a valid dataset id", "Letters, digits and underscores only.");
    case "WA_SITE":
      return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? ok(`"${value}"`) : bad("unexpected characters", "Use a short label such as mysite.");
    case "WA_SALT_SECRET":
      return value.length >= 32 ? ok(`${value.length} chars`) : { status: "warn", label: name, detail: `${src}; only ${value.length} chars`, fix: "Use openssl rand -hex 32." };
    case "WA_ALLOWED_ORIGINS": {
      const badOnes = value.split(",").map((s) => s.trim()).filter(Boolean).filter((o) => {
        try {
          return new URL(o).origin !== o.replace(/\/$/, "");
        } catch {
          return true;
        }
      });
      return badOnes.length ? bad(`${badOnes.length} entr${badOnes.length === 1 ? "y is" : "ies are"} not a bare origin`, "Use https://host[:port] with no path, comma-separated.")
        : ok(`${value.split(",").filter((s) => s.trim()).length} origin(s)`);
    }
    default:
      return ok("set");
  }
}

function checkCode(ctx) {
  const results = [];
  const pkgText = readText(join(ctx.dir, "package.json"));
  let pkg = null;
  try {
    pkg = pkgText ? JSON.parse(pkgText) : null;
  } catch {
    // reported below
  }
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const isNext = !!deps.next || ["js", "mjs", "ts", "cjs"].some((x) => existsSync(join(ctx.dir, `next.config.${x}`)));
  if (!pkg) return [{ status: "fail", label: "package.json", detail: `not found or invalid in ${ctx.dir}`, fix: "Run doctor in the site's directory or pass --dir." }];
  if (!isNext) return [{ status: "skip", label: "Next.js project", detail: "next is not a dependency; code checks skipped" }];

  const ver = deps["@bmnova/web-analytics"];
  results.push(ver
    ? { status: "pass", label: "@bmnova/web-analytics dependency", detail: ver }
    : { status: "fail", label: "@bmnova/web-analytics dependency", detail: "not in package.json", fix: "npm i @bmnova/web-analytics" });

  const appDirs = ["app", "src/app"].map((d) => join(ctx.dir, d)).filter(existsSync);
  if (!appDirs.length) {
    results.push({ status: "fail", label: "app router", detail: "no app/ or src/app/ directory", fix: "The package's React and route helpers target the App Router." });
    return results;
  }

  const routes = appDirs.flatMap((d) => [".ts", ".js", ".tsx", ".jsx", ".mjs"].map((x) => join(d, "api", "collect", `route${x}`))).filter(existsSync);
  if (!routes.length) {
    results.push({ status: "fail", label: "collect route", detail: "app/api/collect/route.ts not found", fix: 'Create it: export const { POST } = createCollectHandler({ site: "<site>" }); (README step 1)' });
  } else {
    const src = readText(routes[0]) ?? "";
    const rel = relative(ctx.dir, routes[0]);
    if (!/createCollectHandler/.test(src) || !/\bPOST\b/.test(src)) {
      results.push({ status: "fail", label: "collect route", detail: `${rel} does not export POST from createCollectHandler`, fix: "export const { POST } = createCollectHandler(...)" });
    } else if (/export\s+const\s+runtime\s*=\s*["']edge["']/.test(src)) {
      results.push({ status: "warn", label: "collect route", detail: `${rel} sets runtime = "edge"`, fix: "Remove it; the default runtime works on Vercel and OpenNext." });
    } else results.push({ status: "pass", label: "collect route", detail: rel });
    ctx.codeSite ??= siteLabelFromCode(src);
  }

  const sourceFile = (name) => /\.(t|j)sx?$|\.mjs$/.test(name);
  const layouts = appDirs.flatMap((d) => walk(d, (n) => /^layout\.(t|j)sx?$/.test(n)));
  const withComp = layouts.filter((f) => hasAnalyticsComponent(readText(f)));
  if (withComp.length) {
    results.push({ status: "pass", label: "<Analytics> in layout", detail: withComp.map((f) => relative(ctx.dir, f)).join(", ") });
    for (const f of withComp) ctx.codeSite ??= siteLabelFromCode((readText(f) ?? "").split("<Analytics")[1] ?? "");
  } else {
    const elsewhere = ["app", "src", "components"].map((d) => join(ctx.dir, d)).filter(existsSync)
      .flatMap((d) => walk(d, sourceFile)).filter((f) => hasAnalyticsComponent(readText(f)));
    const uniq = [...new Set(elsewhere)];
    results.push(uniq.length
      ? { status: "warn", label: "<Analytics> in layout", detail: `not in a layout, but rendered in ${uniq.map((f) => relative(ctx.dir, f)).join(", ")}`, fix: "Make sure that component is rendered by the root layout on every page." }
      : { status: "fail", label: "<Analytics> in layout", detail: `not found in ${layouts.length} layout file(s)`, fix: 'Add <Analytics site="<site>" /> from @bmnova/web-analytics/react to the root layout (README step 2).' });
  }

  const mw = ["middleware", "proxy", "src/middleware", "src/proxy"].flatMap((b) => [".ts", ".js"].map((x) => join(ctx.dir, b + x))).filter(existsSync);
  const mwWith = mw.filter((f) => /withAnalytics/.test(readText(f) ?? ""));
  results.push(mwWith.length
    ? { status: "pass", label: "bot logging (withAnalytics)", detail: relative(ctx.dir, mwWith[0]) }
    : { status: "warn", label: "bot logging (withAnalytics)", detail: mw.length ? `${relative(ctx.dir, mw[0])} does not use withAnalytics` : "no middleware.ts / proxy.ts", fix: "Wrap your middleware with withAnalytics to log AI crawlers and bots (README step 3)." });
  return results;
}

async function checkLive(ctx) {
  const results = [];
  let url;
  try {
    url = new URL(ctx.args.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    return [{ status: "fail", label: "--url", detail: "not an http(s) URL" }];
  }
  let res;
  let html;
  try {
    res = await fetchWithTimeout(url.href, { redirect: "follow" });
    html = await res.text();
  } catch (e) {
    return [{ status: "fail", label: "page", detail: `could not load ${url.href} (${e.name === "TimeoutError" ? "timeout" : e.message})` }];
  }
  const finalUrl = new URL(res.url || url.href);
  results.push(res.ok
    ? { status: "pass", label: "page", detail: `${res.status} ${finalUrl.href}${finalUrl.href !== url.href ? " (after redirect)" : ""}` }
    : { status: "fail", label: "page", detail: `HTTP ${res.status} ${finalUrl.href}` });

  // Tracker: the component renders nothing, so look for the tracker code in the page's own bundles.
  const scripts = extractScriptUrls(html, finalUrl.href);
  let hit = hasTrackerSignature(html) ? "inline script" : null;
  for (let i = 0; !hit && i < scripts.length && i < 80; i += 8) {
    const batch = scripts.slice(i, i + 8);
    const bodies = await Promise.all(batch.map((s) => fetchWithTimeout(s).then((r) => (r.ok ? r.text() : "")).catch(() => "")));
    const idx = bodies.findIndex(hasTrackerSignature);
    if (idx >= 0) hit = new URL(batch[idx]).pathname;
  }
  results.push(hit
    ? { status: "pass", label: "tracker loaded", detail: `found in ${hit}` }
    : { status: "fail", label: "tracker loaded", detail: `not found in the HTML or its ${scripts.length} script(s)`, fix: "Render <Analytics> in the root layout and redeploy. (Custom endpoint or a build that renames the code also hides it.)" });

  // Collector: an empty batch is rejected after the origin and config checks, before anything is written.
  const collectUrl = new URL("/api/collect", finalUrl.origin).href;
  try {
    const r = await fetchWithTimeout(collectUrl, {
      method: "POST",
      redirect: "manual",
      headers: { origin: finalUrl.origin, "content-type": "application/json" },
      body: "{}",
    });
    const c = classifyCollect(r.status, r.headers.get("x-web-analytics-error"), r.headers.get("location"));
    results.push({ label: `POST ${new URL(collectUrl).pathname}`, ...c });
  } catch (e) {
    results.push({ status: "fail", label: "POST /api/collect", detail: `request failed (${e.name === "TimeoutError" ? "timeout" : e.message})` });
  }
  return results;
}

function bqJson(argv) {
  const r = run("bq", ["--format=json", ...argv]);
  if (!r.ok) return { error: r.missing ? "bq not found" : lastLine(r.stderr || r.stdout) || "bq failed" };
  try {
    return { data: JSON.parse(r.stdout || "null") };
  } catch {
    return { error: "could not parse bq output" };
  }
}

function checkBigQuery(ctx) {
  const results = [];
  const project = ctx.args.project ?? ctx.localEnv?.WA_BQ_PROJECT;
  const dataset = ctx.args.dataset ?? ctx.localEnv?.WA_BQ_DATASET ?? "web_analytics";
  const site = ctx.args.site ?? ctx.localEnv?.WA_SITE ?? ctx.codeSite ?? null;
  const v = run("bq", ["version"]);
  if (v.missing) return [{ status: "skip", label: "bq CLI", detail: "not installed; BigQuery checks skipped", fix: "Install the Google Cloud SDK to run them." }];
  if (typeof project !== "string" || !PROJECT.test(project)) {
    return [{ status: "skip", label: "BigQuery", detail: project ? "WA_BQ_PROJECT is not a valid project id" : "no project id (WA_BQ_PROJECT not in local env files)", fix: "Pass --project <gcp-project>." }];
  }
  if (!DATASET.test(dataset)) return [{ status: "fail", label: "BigQuery", detail: "invalid dataset id" }];
  const fq = `${project}:${dataset}`;

  const ds = bqJson(["show", fq]);
  if (ds.error) {
    results.push({ status: "fail", label: `dataset ${project}.${dataset}`, detail: ds.error, fix: `npx @bmnova/web-analytics setup --project ${project}` });
    return results;
  }
  const location = ds.data?.location ?? "EU";
  results.push({ status: "pass", label: `dataset ${project}.${dataset}`, detail: `location ${location}` });

  const t = bqJson(["show", `${fq}.events`]);
  if (t.error) {
    results.push({ status: "fail", label: "events table", detail: t.error, fix: `npx @bmnova/web-analytics setup --project ${project} --dataset ${dataset}` });
  } else {
    results.push({ status: "pass", label: "events table", detail: `${t.data?.numRows ?? "?"} rows${t.data?.timePartitioning ? ", partitioned" : ""}` });
  }

  const tc = bqJson([`--project_id=${project}`, "ls", "--transfer_config", `--transfer_location=${location}`]);
  if (tc.error) {
    results.push({ status: "fail", label: "scheduled queries", detail: tc.error, fix: "Enable the BigQuery Data Transfer API, or check your access." });
  } else {
    const configs = Array.isArray(tc.data) ? tc.data : [];
    const describe = (c) => `${c.schedule ?? "?"}, last run ${String(c.state ?? "unknown").toLowerCase()}${c.disabled ? ", DISABLED" : ""}`;
    const agg = configs.find((c) => c.displayName === `web-analytics aggregates (${dataset})`);
    results.push(!agg
      ? { status: "fail", label: "hourly aggregation", detail: "scheduled query not found", fix: `npx @bmnova/web-analytics setup --project ${project} --dataset ${dataset} --schedule-sa <scheduler-sa>` }
      : agg.disabled || agg.state === "FAILED"
        ? { status: "fail", label: "hourly aggregation", detail: describe(agg), fix: "Open BigQuery → Scheduled queries to see the error; re-run setup to refresh the SQL." }
        : { status: "pass", label: "hourly aggregation", detail: describe(agg) });
    const health = configs.find((c) => c.displayName === `web-analytics health (${dataset})`);
    results.push(!health
      ? { status: "warn", label: "health check", detail: "scheduled query not found (optional)", fix: `Re-run setup in a terminal to get an email when no human events arrive.` }
      : health.disabled
        ? { status: "warn", label: "health check", detail: describe(health) }
        : health.state === "FAILED"
          ? { status: "fail", label: "health check", detail: `${describe(health)}: no human events in its window`, fix: "Look at the live and env checks above." }
          : { status: "pass", label: "health check", detail: describe(health) });
  }

  if (!t.error) {
    const sql = `SELECT site, COUNTIF(NOT is_bot) AS human, COUNTIF(is_bot) AS bots, CAST(MAX(IF(NOT is_bot, ts, NULL)) AS STRING) AS last_human
FROM \`${project}.${dataset}.events\`
WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
GROUP BY site ORDER BY human DESC LIMIT 20`;
    const q = run("bq", [`--project_id=${project}`, `--location=${location}`, "--format=json", "query", "--use_legacy_sql=false", "--max_rows=20", sql]);
    let rows = null;
    try {
      rows = q.ok ? JSON.parse(q.stdout || "[]") : null;
    } catch {
      rows = null;
    }
    if (!rows) {
      results.push({ status: "fail", label: "human events, last 24h", detail: lastLine(q.stderr || q.stdout) || "query failed", fix: "You need BigQuery Data Viewer on the dataset and Job User on the project." });
    } else {
      const row = site ? rows.find((r) => r.site === site) : rows[0];
      const others = rows.filter((r) => r !== row && Number(r.human) > 0).map((r) => r.site);
      const human = Number(row?.human ?? 0);
      const label = `human events, last 24h${site ? ` (site "${site}")` : ""}`;
      if (human > 0) {
        results.push({ status: "pass", label, detail: `${human} human, ${row.bots} bot; last ${row.last_human}` });
      } else {
        results.push({
          status: "fail", label,
          detail: row ? `0 human, ${row.bots} bot` : "no rows",
          fix: others.length
            ? `Rows exist for site ${others.map((s) => `"${s}"`).join(", ")}: check WA_SITE and the site prop.`
            : "Visit the site in a normal browser and check the live checks above; curl and bots never count as human.",
        });
      }
    }
  }
  return results;
}

async function section(title, fn) {
  try {
    return { title, results: await fn() };
  } catch (e) {
    return { title, results: [{ status: "fail", label: "check crashed", detail: e?.message ?? String(e) }] };
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log(HELP);
    return 0;
  }
  const ctx = { args, dir: resolve(typeof args.dir === "string" ? args.dir : process.cwd()), localEnv: {}, codeSite: null };
  console.log(`web-analytics doctor — ${ctx.dir}`);
  const sections = [];
  sections.push(await section("Environment", () => checkEnv(ctx)));
  sections.push(await section("Code", () => checkCode(ctx)));
  if (typeof args.url === "string") sections.push(await section(`Live site (${args.url})`, () => checkLive(ctx)));
  else sections.push({ title: "Live site", results: [{ status: "skip", label: "live checks", detail: "pass --url https://your-site to run them" }] });
  sections.push(await section("BigQuery", () => checkBigQuery(ctx)));
  console.log(formatReport(sections));
  return exitCode(sections);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
