import { detectBot, type Bot } from "../shared/bots.js";
import { classifyChannel, hostOf } from "../shared/channel.js";
import { cleanPath, sanitizeProps } from "../shared/privacy.js";
import { LIMITS, type Consent, type EventRow, type Props, type Utm, type Via } from "../shared/schema.js";
import { parseUa } from "../shared/ua.js";
import type { WaConfig } from "./env.js";
import { readGeo } from "./geo.js";
import { visitorHash } from "./hash.js";

export interface RowInput {
  site: string;
  event: string;
  via: Via;
  ts?: number;
  path?: string | null;
  host?: string | null;
  title?: string | null;
  referrer?: string | null;
  utm?: Utm | null;
  props?: Props | Record<string, unknown> | null;
  consent?: Consent | null;
  visitorId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  /** Request headers, used for geo, UA and the cookieless hash. */
  headers?: Headers | null;
  /** Pre-detected bot, to avoid re-parsing. */
  bot?: Bot | null;
  /** Rewrites the stored path (e.g. ids to placeholders). See {@link NormalizePath}. */
  normalizePath?: NormalizePath;
}

/**
 * Rewrites a cleaned path (no query or hash) before it is stored, e.g.
 * `(p) => p.replace(/^\/r\/[^/]+/, "/r/[id]")`. Only the stored value changes; bot detection,
 * asset filtering and `ignore` still see the raw path.
 */
export type NormalizePath = (path: string) => string;

/** Stored as `path` when `normalizePath` throws or returns a non-string. The raw path is never stored then. */
export const UNNORMALIZED_PATH = "/[unnormalized]";

/** Clean a path, then run it through `normalize` (fail-closed). */
export function storedPath(path: string | null | undefined, normalize?: NormalizePath): string | null {
  const clean = cleanPath(path);
  if (clean === null || !normalize) return clean;
  try {
    const out = normalize(clean);
    if (typeof out !== "string") return UNNORMALIZED_PATH;
    return cleanPath(out.startsWith("/") ? out : `/${out}`) ?? UNNORMALIZED_PATH;
  } catch {
    return UNNORMALIZED_PATH;
  }
}

const str = (v: string | null | undefined, max: number) => (v ? v.slice(0, max) : null);
const id = (v: string | null | undefined) => (v && LIMITS.id.test(v) ? v : null);

export async function buildRow(config: WaConfig, input: RowInput): Promise<EventRow> {
  const headers = input.headers ?? null;
  const ua = headers?.get("user-agent") ?? null;
  const bot = input.bot !== undefined ? input.bot : headers ? detectBot(ua) : null;
  const geo = headers ? readGeo(headers) : { ip: null, country: null, region: null };
  const info = parseUa(ua);
  const host = hostOf(input.host ?? headers?.get("host") ?? null);
  const { channel, source, referrerHost } = classifyChannel({
    utmSource: input.utm?.source,
    utmMedium: input.utm?.medium,
    referrer: input.referrer,
    selfHost: host,
  });

  const hash =
    !bot && config.saltSecret && headers && (geo.ip || ua)
      ? await visitorHash({ secret: config.saltSecret, site: input.site, ip: geo.ip, ua })
      : null;

  const props = sanitizeProps(input.props);
  const ts = input.ts && Math.abs(Date.now() - input.ts) < 10 * 60_000 ? input.ts : Date.now();

  return {
    ts: new Date(ts).toISOString(),
    site: input.site,
    event: input.event,
    via: input.via,
    visitor_hash: hash,
    visitor_id: input.consent === "full" ? id(input.visitorId) : null,
    session_id: input.consent === "full" ? id(input.sessionId) : null,
    user_id: id(input.userId),
    consent: input.consent ?? null,
    host,
    path: storedPath(input.path, input.normalizePath),
    title: str(input.title, LIMITS.titleLength),
    referrer_host: referrerHost,
    channel: input.via === "server" && !input.referrer && !input.utm ? null : channel,
    source,
    utm_source: str(input.utm?.source, LIMITS.utmLength),
    utm_medium: str(input.utm?.medium, LIMITS.utmLength),
    utm_campaign: str(input.utm?.campaign, LIMITS.utmLength),
    utm_term: str(input.utm?.term, LIMITS.utmLength),
    utm_content: str(input.utm?.content, LIMITS.utmLength),
    country: geo.country,
    region: geo.region,
    device: bot ? null : info.device,
    browser: bot ? null : info.browser,
    os: bot ? null : info.os,
    is_bot: !!bot,
    bot_name: bot?.name ?? null,
    bot_kind: bot?.kind ?? null,
    // Raw user agents are personal data for humans; keep them only for bots.
    user_agent: bot ? str(ua, 400) : null,
    props: props ? JSON.stringify(props) : null,
  };
}

export function resolveSite(config: WaConfig, explicit?: string | null, host?: string | null): string {
  const site = explicit || config.site || hostOf(host) || "unknown";
  return LIMITS.site.test(site) ? site : "unknown";
}
