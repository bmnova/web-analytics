/*
 * Run work after the response is sent. Tries, in order:
 *  1. an explicit event/ctx with waitUntil (Next middleware/proxy NextFetchEvent),
 *  2. Next's after() (Next 15+, any server context),
 *  3. the Vercel request context (Next 14 on Vercel),
 *  4. the Cloudflare context set by OpenNext,
 *  5. awaiting the work inline.
 */

export interface WaitUntilLike {
  waitUntil(promise: Promise<unknown>): void;
}

type AfterFn = (task: () => unknown) => void;

let afterFn: AfterFn | null | undefined;

async function loadAfter(): Promise<AfterFn | null> {
  if (afterFn !== undefined) return afterFn;
  try {
    const mod = (await import("next/server")) as Record<string, unknown>;
    const fn = mod["after"];
    afterFn = typeof fn === "function" ? (fn as AfterFn) : null;
  } catch {
    afterFn = null;
  }
  return afterFn;
}

function platformWaitUntil(): WaitUntilLike | null {
  const g = globalThis as Record<symbol, unknown>;
  const vercel = g[Symbol.for("@vercel/request-context")] as { get?: () => { waitUntil?: (p: Promise<unknown>) => void } } | undefined;
  const v = vercel?.get?.();
  if (v?.waitUntil) return { waitUntil: v.waitUntil.bind(v) };
  const cf = g[Symbol.for("__cloudflare-context__")] as { ctx?: WaitUntilLike } | undefined;
  if (cf?.ctx?.waitUntil) return { waitUntil: cf.ctx.waitUntil.bind(cf.ctx) };
  return null;
}

export async function defer(task: () => Promise<void>, event?: WaitUntilLike | null): Promise<void> {
  if (event?.waitUntil) {
    event.waitUntil(task());
    return;
  }
  const after = await loadAfter();
  if (after) {
    try {
      after(task);
      return;
    } catch {
      // after() throws outside a request scope; fall through.
    }
  }
  const platform = platformWaitUntil();
  if (platform) {
    platform.waitUntil(task());
    return;
  }
  await task();
}
