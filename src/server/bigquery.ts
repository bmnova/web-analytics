import type { EventRow } from "../shared/schema.js";
import type { WaConfig, ServiceAccount } from "./env.js";
import { warnOnce } from "./env.js";

/*
 * Minimal BigQuery streaming-insert client built on fetch + WebCrypto, so it runs on
 * Node, Vercel Edge and Cloudflare Workers alike (the official SDK needs Node APIs).
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/bigquery.insertdata";

let keyCache: { email: string; key: CryptoKey } | null = null;
let tokenCache: { email: string; token: string; exp: number } | null = null;

function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function signingKey(sa: ServiceAccount): Promise<CryptoKey> {
  if (keyCache?.email === sa.client_email) return keyCache.key;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  keyCache = { email: sa.client_email, key };
  return key;
}

/** Build the signed JWT assertion for the OAuth token exchange. Exported for tests. */
export async function buildAssertion(sa: ServiceAccount, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }));
  const input = `${header}.${claims}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey(sa), new TextEncoder().encode(input));
  return `${input}.${b64url(sig)}`;
}

async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.email === sa.client_email && tokenCache.exp - 60_000 > now) return tokenCache.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await buildAssertion(sa),
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { email: sa.client_email, token: json.access_token, exp: now + json.expires_in * 1000 };
  return json.access_token;
}

function insertId(row: EventRow): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${row.ts}-${Math.random().toString(36).slice(2)}`;
}

/** Stream rows into BigQuery. Never throws: analytics must not break the site. */
export async function writeRows(config: WaConfig, rows: EventRow[]): Promise<void> {
  if (!rows.length) return;
  // Misconfigured production: drop rows (the reason was already logged by getConfig) instead of printing them.
  if (config.missing?.length) return;
  if (config.dryRun || !config.serviceAccount || !config.project) {
    for (const row of rows) console.log("[web-analytics:dry-run]", JSON.stringify(row));
    return;
  }
  try {
    const token = await accessToken(config.serviceAccount);
    const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(config.project)}/datasets/${encodeURIComponent(config.dataset)}/tables/${encodeURIComponent(config.table)}/insertAll`;
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        skipInvalidRows: true,
        ignoreUnknownValues: true,
        rows: rows.map((json) => ({ insertId: insertId(json), json })),
      }),
    });
    if (!res.ok) {
      warnOnce(`bq-${res.status}`, `BigQuery insertAll failed with ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      if (res.status === 401) tokenCache = null;
      return;
    }
    const body = (await res.json()) as { insertErrors?: Array<{ index: number; errors: Array<{ message: string }> }> };
    if (body.insertErrors?.length) {
      warnOnce("bq-row", `BigQuery rejected ${body.insertErrors.length} row(s): ${body.insertErrors[0]?.errors[0]?.message ?? "unknown"}`);
    }
  } catch (err) {
    warnOnce("bq-ex", `BigQuery write error: ${(err as Error).message}`);
  }
}
