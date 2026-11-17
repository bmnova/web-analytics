import type { Props } from "../shared/schema.js";
import { getConfig, type WaEnv } from "./env.js";
import { writeRows } from "./bigquery.js";
import { defer } from "./defer.js";
import { buildRow, resolveSite } from "./rows.js";

export interface TrackServerOptions {
  userId?: string | null;
  site?: string;
  /** Pass the incoming request to attach country/device; omit for webhooks. */
  request?: Request | null;
  path?: string;
  env?: WaEnv;
  /** Wait for the write to finish instead of deferring it (e.g. in scripts). */
  await?: boolean;
}

/**
 * Record a server-side event (sign-up, payment webhook, import...). Ad blockers
 * cannot drop these. Props pass the same deny-list as browser events.
 */
export async function trackServer(event: string, props: Props = {}, options: TrackServerOptions = {}): Promise<void> {
  const config = getConfig(options.env);
  const host = options.request ? (options.request.headers.get("x-forwarded-host") ?? new URL(options.request.url).host) : null;
  const site = resolveSite(config, options.site, host);
  const task = async () => {
    const row = await buildRow(config, {
      site,
      event,
      via: "server",
      path: options.path ?? (options.request ? new URL(options.request.url).pathname : null),
      host,
      props,
      userId: options.userId,
      headers: options.request?.headers ?? null,
      bot: null,
    });
    await writeRows(config, [row]);
  };
  if (options.await) await task();
  else await defer(task);
}
