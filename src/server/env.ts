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
}

export type WaEnv = Partial<Record<
  "WA_SITE" | "WA_BQ_PROJECT" | "WA_BQ_DATASET" | "WA_BQ_TABLE" | "WA_GCP_SA_KEY" | "WA_SALT_SECRET" | "WA_ALLOWED_ORIGINS" | "WA_DRY_RUN",
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

function readProcessEnv(): WaEnv {
  // process.env exists on Node, Vercel Edge and OpenNext on Cloudflare (nodejs_compat).
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return (p?.env ?? {}) as WaEnv;
}

function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw) return null;
  try {
    const json = JSON.parse(raw.trim().startsWith("{") ? raw : atob(raw)) as Partial<ServiceAccount>;
    if (typeof json.client_email === "string" && typeof json.private_key === "string") {
      return { client_email: json.client_email, private_key: json.private_key };
    }
  } catch {
    // fall through
  }
  warnOnce("sa", "WA_GCP_SA_KEY is set but is not a valid service account JSON (raw or base64). Running in dry-run mode.");
  return null;
}

let cached: { key: string; config: WaConfig } | null = null;

/** Read configuration from env (overrides win). Never logs secret values. */
export function getConfig(overrides: WaEnv = {}): WaConfig {
  const env = { ...readProcessEnv(), ...overrides };
  const key = JSON.stringify([env.WA_SITE, env.WA_BQ_PROJECT, env.WA_BQ_DATASET, env.WA_BQ_TABLE, env.WA_GCP_SA_KEY?.length, env.WA_SALT_SECRET?.length, env.WA_ALLOWED_ORIGINS, env.WA_DRY_RUN]);
  if (cached && cached.key === key) return cached.config;

  const serviceAccount = parseServiceAccount(env.WA_GCP_SA_KEY);
  const project = env.WA_BQ_PROJECT?.trim() || null;
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
    dryRun: env.WA_DRY_RUN === "1" || env.WA_DRY_RUN === "true" || !serviceAccount || !project,
  };
  if (config.dryRun) warnOnce("dry", "dry-run mode: rows are printed to the log, not written to BigQuery (set WA_GCP_SA_KEY and WA_BQ_PROJECT).");
  if (!config.saltSecret) warnOnce("salt", "WA_SALT_SECRET is not set: visitor_hash will be empty, so visitors without consent cannot be counted.");
  cached = { key, config };
  return config;
}
