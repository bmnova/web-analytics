import { detectBot } from "../shared/bots.js";
import { getConfig, type WaEnv } from "./env.js";
import { writeRows } from "./bigquery.js";
import { defer, type WaitUntilLike } from "./defer.js";
import { buildRow, resolveSite, type NormalizePath } from "./rows.js";

type MaybePromise<T> = T | Promise<T>;
// Kept structural so the package does not import Next at runtime.
type RequestLike = Request & { nextUrl?: URL };
export type InnerHandler<Req extends RequestLike = RequestLike, Ev = unknown> = (
  req: Req,
  event: Ev,
) => MaybePromise<Response | null | undefined | void>;

export interface AnalyticsProxyOptions {
  site?: string;
  env?: WaEnv;
  /** Log bot and AI crawler requests (default true). */
  logBots?: boolean;
  /** Skip paths, e.g. health checks. The collector endpoint is always skipped. */
  ignore?: (pathname: string) => boolean;
  /** Rewrite stored paths, e.g. to replace record ids. Runs after bot detection and `ignore`. */
  normalizePath?: NormalizePath;
}

const STATIC = /^\/(_next\/|favicon\.ico$)/;
// Assets are noise (and Next's image optimizer fetches them with no user agent).
// Text files such as robots.txt, llms.txt and sitemap.xml are kept.
const ASSET = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip)$/i;

/**
 * Wrap a Next middleware (Next 14/15) or proxy (Next 16) to log bot and AI crawler
 * requests. Human page views come from the browser tracker instead.
 *
 *   // middleware.ts (Next 14/15)        // proxy.ts (Next 16)
 *   export default withAnalytics(mine);  export const proxy = withAnalytics(mine);
 */
export function withAnalytics<Req extends RequestLike, Ev>(inner?: InnerHandler<Req, Ev>, options: AnalyticsProxyOptions = {}) {
  return async function analytics(req: Req, event: Ev) {
    try {
      if (options.logBots !== false) {
        const url = req.nextUrl ?? new URL(req.url);
        const path = url.pathname;
        if (!STATIC.test(path) && !ASSET.test(path) && path !== "/api/collect" && !options.ignore?.(path)) {
          const bot = detectBot(req.headers.get("user-agent"));
          if (bot) {
            const config = getConfig(options.env);
            const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
            const site = resolveSite(config, options.site, host);
            const ev = event as unknown as Partial<WaitUntilLike> | null;
            const waitable = ev && typeof ev.waitUntil === "function" ? (ev as WaitUntilLike) : null;
            await defer(async () => {
              const row = await buildRow(config, {
                site,
                event: "bot_request",
                via: "proxy",
                path,
                host,
                referrer: req.headers.get("referer"),
                headers: req.headers,
                bot,
                props: { method: req.method },
                normalizePath: options.normalizePath,
              });
              await writeRows(config, [row]);
            }, waitable);
          }
        }
      }
    } catch (err) {
      console.warn("[web-analytics] proxy logging failed:", (err as Error).message);
    }
    return inner ? inner(req, event) : undefined;
  };
}
