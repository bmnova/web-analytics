import { getConfig, type WaEnv } from "./env.js";
import { writeRows } from "./bigquery.js";
import { defer } from "./defer.js";
import { buildRow, resolveSite } from "./rows.js";

interface RequestInfo {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined> | Headers;
}

interface ErrorContext {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
}

function toHeaders(h: RequestInfo["headers"]): Headers {
  if (h instanceof Headers) return h;
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) if (typeof v === "string") out.set(k, v);
  return out;
}

/**
 * Next.js instrumentation hook. In instrumentation.ts:
 *   export const onRequestError = createOnRequestError();
 * Stores only the message (truncated), digest and route, never stack traces or request bodies.
 */
export function createOnRequestError(options: { site?: string; env?: WaEnv } = {}) {
  return async function onRequestError(error: unknown, request: RequestInfo, context: ErrorContext = {}) {
    try {
      const config = getConfig(options.env);
      const headers = toHeaders(request.headers);
      const err = error as { message?: string; digest?: string; name?: string };
      const site = resolveSite(config, options.site, headers.get("host"));
      await defer(async () => {
        const row = await buildRow(config, {
          site,
          event: "error",
          via: "server",
          path: request.path,
          host: headers.get("host"),
          headers,
          props: {
            message: (err?.message ?? String(error)).slice(0, 200),
            error_name: err?.name ?? null,
            digest: err?.digest ?? null,
            route: context.routePath ?? null,
            route_type: context.routeType ?? null,
            router: context.routerKind ?? null,
            method: request.method,
          },
        });
        await writeRows(config, [row]);
      });
    } catch {
      // never throw from an error hook
    }
  };
}
