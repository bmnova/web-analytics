import { detectClientBot } from "../shared/bots.js";
import { LIMITS, type ClientEvent, type Consent } from "../shared/schema.js";
import { getConfig, type WaEnv } from "./env.js";
import { writeRows } from "./bigquery.js";
import { defer } from "./defer.js";
import { buildRow, resolveSite, type NormalizePath } from "./rows.js";

export interface CollectOptions {
  /** Site label; defaults to WA_SITE, then the request host. */
  site?: string;
  /** Env overrides (e.g. Cloudflare bindings). Defaults to process.env. */
  env?: WaEnv;
  /** Rewrite stored paths, e.g. to replace record ids. Pass the same function everywhere. */
  normalizePath?: NormalizePath;
  /** Store page titles (default true). Set false when titles can carry names or ids. */
  keepTitle?: boolean;
}

const noContent = () => new Response(null, { status: 204 });
const reject = (status: number) => new Response(null, { status });
/** Header naming why the collector refused to store events (env var names only, never values). */
export const ERROR_HEADER = "x-web-analytics-error";
const misconfigured = (missing: string[]) =>
  new Response(null, {
    status: 503,
    headers: { [ERROR_HEADER]: `missing-config: ${missing.join(", ")}`, "cache-control": "no-store" },
  });

function originAllowed(req: Request, allowed: string[]): boolean {
  const url = new URL(req.url);
  const self = `${url.protocol}//${url.host}`.toLowerCase();
  const forwardedHost = req.headers.get("x-forwarded-host");
  const candidates = new Set([self, ...allowed]);
  if (forwardedHost) candidates.add(`https://${forwardedHost.toLowerCase()}`);
  const origin = req.headers.get("origin") ?? (() => {
    const ref = req.headers.get("referer");
    try {
      return ref ? new URL(ref).origin : null;
    } catch {
      return null;
    }
  })();
  if (!origin) return false;
  const o = origin.toLowerCase();
  if (candidates.has(o)) return true;
  // Same host over http in local development.
  const oh = (() => { try { return new URL(o).host; } catch { return null; } })();
  return !!oh && (oh === url.host || oh === forwardedHost) && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(oh);
}

function validEvent(e: unknown): e is ClientEvent {
  if (!e || typeof e !== "object") return false;
  const ev = e as Record<string, unknown>;
  return (
    typeof ev.event === "string" &&
    LIMITS.eventName.test(ev.event) &&
    typeof ev.path === "string" &&
    ev.path.length <= LIMITS.pathLength * 2 &&
    (ev.consent === "basic" || ev.consent === "full") &&
    (ev.ts === undefined || typeof ev.ts === "number") &&
    (ev.title === undefined || typeof ev.title === "string") &&
    (ev.referrer === undefined || typeof ev.referrer === "string") &&
    (ev.utm === undefined || (typeof ev.utm === "object" && ev.utm !== null)) &&
    (ev.props === undefined || (typeof ev.props === "object" && ev.props !== null))
  );
}

/**
 * Route handler for the browser tracker. Usage in app/api/collect/route.ts:
 *   export const { POST } = createCollectHandler();
 * Do not set `runtime = "edge"`; it works on the default runtime everywhere.
 */
export function createCollectHandler(options: CollectOptions = {}) {
  async function POST(req: Request): Promise<Response> {
    const config = getConfig(options.env);
    if (!originAllowed(req, config.allowedOrigins)) return reject(403);
    // Production without BigQuery credentials: fail loudly instead of silently dropping data.
    if (config.missing.length) return misconfigured(config.missing);

    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > LIMITS.bodyBytes) return reject(413);
    const text = await req.text();
    if (text.length > LIMITS.bodyBytes) return reject(413);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return reject(400);
    }
    const batch = body as { site?: unknown; events?: unknown };
    if (!Array.isArray(batch.events) || batch.events.length === 0) return reject(400);

    const host = req.headers.get("x-forwarded-host") ?? new URL(req.url).host;
    const site = resolveSite(config, options.site ?? (typeof batch.site === "string" ? batch.site : null), host);
    const bot = detectClientBot(req.headers.get("user-agent"));
    const events = batch.events.slice(0, LIMITS.eventsPerBatch).filter(validEvent);
    if (!events.length) return reject(400);

    await defer(async () => {
      const rows = await Promise.all(
        events.map((e) =>
          buildRow(config, {
            site,
            event: e.event,
            via: "client",
            ts: e.ts,
            path: e.path,
            host,
            title: options.keepTitle === false ? null : e.title,
            referrer: e.referrer,
            utm: e.utm,
            props: e.props,
            consent: e.consent as Consent,
            visitorId: e.visitor_id,
            sessionId: e.session_id,
            userId: e.user_id,
            headers: req.headers,
            bot,
            normalizePath: options.normalizePath,
          }),
        ),
      );
      await writeRows(config, rows);
    });
    return noContent();
  }

  return { POST };
}
