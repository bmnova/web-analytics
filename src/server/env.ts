export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export interface WaConfig {
  site: string | null;
  project: string | null;
  dataset: string;
  table: string;
  serviceAccount: ServiceAccount | null;
  saltSecret: string | null;
  allowedOrigins: string[];
  /** True when credentials are missing: rows are logged instead of written. */
  dryRun: boolean;
  /** True on a production deployment (VERCEL_ENV=production, or NODE_ENV=production outside Vercel previews). */
  production: boolean;
  /**
   * Names (never values) of the env vars that are missing or invalid in production.
   * Non-empty means nothing is written: the collector answers 503 and the other entry points drop rows.
   * Always empty when WA_DRY_RUN is set or outside production.
   */
  missing: string[];
}

export type WaEnv = Partial<Record<
  "WA_SITE" | "WA_BQ_PROJECT" | "WA_BQ_DATASET" | "WA_BQ_TABLE" | "WA_GCP_SA_KEY" | "WA_SALT_SECRET" | "WA_ALLOWED_ORIGINS" | "WA_DRY_RUN" | "NODE_ENV" | "VERCEL_ENV",
  string | undefined
>>;

// Shared across bundles (OpenNext builds proxy and server separately).
const g = globalThis as { [k: symbol]: Set<string> | undefined };
const WARNED = Symbol.for("@bmnova/web-analytics/warned");
const warned: Set<string> = (g[WARNED] ??= new Set<string>());
export function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[web-analytics] ${message}`);
}

const ERRORED = Symbol.for("@bmnova/web-analytics/errored");
const errored: Set<string> = (g[ERRORED] ??= new Set<string>());
function errorOnce(key: string, message: string) {
  if (errored.has(key)) return;
  errored.add(key);
  console.error(`[web-analytics] ${message}`);
}

const truthy = (v: string | undefined) => v === "1" || v === "true";

/**
 * Production = VERCEL_ENV is "production", or (outside Vercel) NODE_ENV is "production".
 * Vercel preview/development deployments also run with NODE_ENV=production, so a set
 * VERCEL_ENV wins. OpenNext on Cloudflare has no VERCEL_ENV and builds with NODE_ENV=production.
 */
export function isProduction(env: WaEnv): boolean {
  const vercel = env.VERCEL_ENV?.trim();
  if (vercel) return vercel === "production";
  return env.NODE_ENV === "production";
}

function readProcessEnv(): WaEnv {
  // process.env exists on Node, Vercel Edge and OpenNext on Cloudflare (nodejs_compat).
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return (p?.env ?? {}) as WaEnv;
}

function parseServiceAccount(raw: string | undefined, warn: boolean): ServiceAccount | null {
  if (!raw) return null;
  try {
    const json = JSON.parse(raw.trim().startsWith("{") ? raw : atob(raw)) as Partial<ServiceAccount>;
    if (typeof json.client_email === "string" && typeof json.private_key === "string") {
      return { client_email: json.client_email, private_key: json.private_key };
    }
  } catch {
    // fall through
  }
  if (warn) warnOnce("sa", "WA_GCP_SA_KEY is set but is not a valid service account JSON (raw or base64). Running in dry-run mode.");
  return null;
}

let cached: { key: string; config: WaConfig } | null = null;

/** Read configuration from env (overrides win). Never logs secret values. */
export function getConfig(overrides: WaEnv = {}): WaConfig {
  const env = { ...readProcessEnv(), ...overrides };
  const key = JSON.stringify([env.WA_SITE, env.WA_BQ_PROJECT, env.WA_BQ_DATASET, env.WA_BQ_TABLE, env.WA_GCP_SA_KEY?.length, env.WA_SALT_SECRET?.length, env.WA_ALLOWED_ORIGINS, env.WA_DRY_RUN, env.NODE_ENV, env.VERCEL_ENV]);
  if (cached && cached.key === key) return cached.config;

  const forcedDryRun = truthy(env.WA_DRY_RUN);
  const production = isProduction(env);
  // In production a broken key is reported by the error below, not by a dry-run warning.
  const serviceAccount = parseServiceAccount(env.WA_GCP_SA_KEY, !production || forcedDryRun);
  const project = env.WA_BQ_PROJECT?.trim() || null;

  const missing: string[] = [];
  if (production && !forcedDryRun) {
    if (!env.WA_GCP_SA_KEY?.trim()) missing.push("WA_GCP_SA_KEY");
    else if (!serviceAccount) missing.push("WA_GCP_SA_KEY (invalid service account JSON)");
    if (!project) missing.push("WA_BQ_PROJECT");
  }

  const config: WaConfig = {
    site: env.WA_SITE?.trim() || null,
    project,
    dataset: env.WA_BQ_DATASET?.trim() || "web_analytics",
    table: env.WA_BQ_TABLE?.trim() || "events",
    serviceAccount,
    saltSecret: env.WA_SALT_SECRET || null,
    allowedOrigins: (env.WA_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/$/, "").toLowerCase())
      .filter(Boolean),
    dryRun: forcedDryRun || !serviceAccount || !project,
    production,
    missing,
  };
  if (missing.length) {
    errorOnce(
      `missing:${missing.join(",")}`,
      `production deployment is missing ${missing.join(", ")}: no analytics data is being written. ` +
        "The collector answers 503 until this is fixed. Set the variable(s), or set WA_DRY_RUN=1 to log rows instead.",
    );
  } else if (config.dryRun) {
    warnOnce("dry", "dry-run mode: rows are printed to the log, not written to BigQuery (set WA_GCP_SA_KEY and WA_BQ_PROJECT).");
  }
  if (!config.saltSecret) warnOnce("salt", "WA_SALT_SECRET is not set: visitor_hash will be empty, so visitors without consent cannot be counted.");
  cached = { key, config };
  return config;
}
