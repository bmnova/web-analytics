import { LIMITS, type ClientEvent, type Consent, type Props, type Utm } from "../shared/schema.js";
import { effectiveConsent, getConsentChoice, onConsentChange, saveConsentChoice } from "./consent.js";

export interface TrackerOptions {
  /** Site label written on every row, e.g. "bmnova". */
  site: string;
  /** Collector URL (default "/api/collect"). */
  endpoint?: string;
  /** Honour Global Privacy Control / Do Not Track by staying in basic mode (default true). */
  respectPrivacySignals?: boolean;
  /** Capture window errors and unhandled rejections (default true). */
  trackErrors?: boolean;
  /** Log events to the console. */
  debug?: boolean;
}

interface State {
  opts: Required<TrackerOptions>;
  consent: Consent;
  userId: string | null;
  queue: ClientEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  path: string | null;
  title: string | null;
  href: string | null;
  firstView: boolean;
  visibleSince: number | null;
  engagedMs: number;
  maxScroll: number;
  exitSent: boolean;
  errors: number;
  errorMessages: Set<string>;
}

let state: State | null = null;
const SESSION_IDLE_MS = 30 * 60_000;

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function local(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** Persistent ids exist only with full consent. */
function ids(): { visitor_id?: string; session_id?: string } {
  if (!state || state.consent !== "full") return {};
  // Re-check the saved choice: storage may have been cleared while the page was open.
  if (getConsentChoice() !== "full") {
    state.consent = "basic";
    return {};
  }
  const s = local();
  if (!s) return {};
  try {
    let vid = s.getItem("wa_vid");
    if (!vid) {
      vid = uuid();
      s.setItem("wa_vid", vid);
    }
    const now = Date.now();
    let sess: { id: string; last: number } | null = null;
    try {
      sess = JSON.parse(s.getItem("wa_sid") ?? "null");
    } catch {
      sess = null;
    }
    if (!sess || now - sess.last > SESSION_IDLE_MS) sess = { id: uuid(), last: now };
    sess.last = now;
    s.setItem("wa_sid", JSON.stringify(sess));
    return { visitor_id: vid, session_id: sess.id };
  } catch {
    return {};
  }
}

function utmFromUrl(): Utm | undefined {
  const q = new URLSearchParams(location.search);
  const utm: Utm = {};
  for (const k of ["source", "medium", "campaign", "term", "content"] as const) {
    const v = q.get(`utm_${k}`);
    if (v) utm[k] = v.slice(0, LIMITS.utmLength);
  }
  // Common non-UTM click ids still tell us the source.
  if (!utm.source) {
    if (q.has("gclid")) utm.source = "google", (utm.medium = utm.medium ?? "cpc");
    else if (q.has("fbclid")) utm.source = "facebook";
    else if (q.get("ref")) utm.source = q.get("ref")!.slice(0, LIMITS.utmLength);
  }
  return Object.keys(utm).length ? utm : undefined;
}

function enqueue(event: string, props?: Props, extra: Partial<ClientEvent> = {}) {
  if (!state) return;
  const e: ClientEvent = {
    event,
    ts: Date.now(),
    path: location.pathname,
    title: document.title.slice(0, LIMITS.titleLength) || undefined,
    consent: state.consent,
    ...ids(),
    ...(state.consent === "full" && state.userId ? { user_id: state.userId } : {}),
    ...(props ? { props } : {}),
    ...extra,
  };
  if (state.opts.debug) console.log("[web-analytics]", e);
  state.queue.push(e);
  if (state.queue.length >= 10) flush();
  else if (!state.timer) state.timer = setTimeout(() => flush(), 2000);
}

/** Send queued events. Uses sendBeacon when the page is going away. */
export function flush(beacon = false) {
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  while (state.queue.length) {
    const events = state.queue.splice(0, 10);
    let body = JSON.stringify({ site: state.opts.site, events });
    while (body.length > LIMITS.bodyBytes && events.length > 1) {
      state.queue.unshift(events.pop()!);
      body = JSON.stringify({ site: state.opts.site, events });
    }
    if (body.length > LIMITS.bodyBytes) continue; // a single oversized event is dropped
    const url = state.opts.endpoint;
    try {
      if (beacon && navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) continue;
      void fetch(url, {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
        keepalive: true,
        credentials: "same-origin",
      }).catch(() => {});
    } catch {
      // analytics must never break the page
    }
  }
}

function engagedNow(): number {
  if (!state) return 0;
  return state.engagedMs + (state.visibleSince ? Date.now() - state.visibleSince : 0);
}

function sendExit() {
  if (!state || state.exitSent || !state.path) return;
  state.exitSent = true;
  enqueue("page_exit", { engaged_ms: Math.round(engagedNow()), scroll_pct: state.maxScroll }, { path: state.path, title: state.title ?? undefined });
}

function pageview() {
  if (!state) return;
  const path = location.pathname;
  if (path === state.path) return;
  if (state.path) sendExit();
  const referrer = state.firstView ? document.referrer || undefined : (state.href ?? undefined);
  state.path = path;
  state.href = location.href;
  state.firstView = false;
  state.engagedMs = 0;
  state.visibleSince = document.visibilityState === "visible" ? Date.now() : null;
  state.maxScroll = 0;
  state.exitSent = false;
  state.errors = 0;
  state.errorMessages.clear();
  state.title = document.title.slice(0, LIMITS.titleLength) || null;
  enqueue("pageview", undefined, { referrer, utm: utmFromUrl() });
  onScroll();
}

function onScroll() {
  if (!state) return;
  const doc = document.documentElement;
  const max = doc.scrollHeight - window.innerHeight;
  const pct = max <= 0 ? 100 : Math.min(100, Math.round((window.scrollY / max) * 100));
  if (pct > state.maxScroll) state.maxScroll = pct;
}

function onClick(ev: MouseEvent) {
  if (!state) return;
  const target = ev.target as Element | null;
  if (!target?.closest) return;
  const tracked = target.closest<HTMLElement>("[data-track]");
  if (tracked) {
    const props: Props = {};
    for (const [k, v] of Object.entries(tracked.dataset)) {
      if (k.startsWith("track") && k !== "track" && v !== undefined) {
        const key = k.slice(5).replace(/^./, (c) => c.toLowerCase()).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        props[key] = v;
      }
    }
    const name = tracked.dataset.track!;
    if (LIMITS.eventName.test(name)) enqueue(name, Object.keys(props).length ? props : undefined);
    return;
  }
  const a = target.closest<HTMLAnchorElement>("a[href]");
  if (!a) return;
  const href = a.getAttribute("href") ?? "";
  if (/^mailto:/i.test(href)) return enqueue("contact_click", { type: "email" });
  if (/^tel:/i.test(href)) return enqueue("contact_click", { type: "phone" });
  try {
    const url = new URL(a.href, location.href);
    if (/^https?:$/.test(url.protocol) && url.host !== location.host) {
      enqueue("outbound_click", { host: url.host.replace(/^www\./, ""), path: url.pathname.slice(0, 120) });
    }
  } catch {
    // ignore malformed links
  }
}

function onError(message: string, source?: string, line?: number) {
  if (!state || state.errors >= 5) return;
  const msg = message.slice(0, 200);
  if (state.errorMessages.has(msg)) return;
  state.errors++;
  state.errorMessages.add(msg);
  const file = source ? source.split("?")[0]!.split("/").pop()!.slice(0, 80) : null;
  enqueue("error", { kind: "client", message: msg, source: file, line: line ?? null });
}

function patchHistory() {
  const w = window as Window & { __waPatched?: boolean };
  if (w.__waPatched) return;
  w.__waPatched = true;
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      setTimeout(pageview, 100);
      return result;
    } as History["pushState"];
  }
  addEventListener("popstate", () => pageview());
}

/** Start tracking. Safe to call more than once; later calls are ignored. */
export function init(options: TrackerOptions) {
  if (typeof window === "undefined" || state) return;
  const opts: Required<TrackerOptions> = {
    endpoint: "/api/collect",
    respectPrivacySignals: true,
    trackErrors: true,
    debug: false,
    ...options,
  };
  state = {
    opts,
    consent: effectiveConsent(opts.respectPrivacySignals),
    userId: null,
    queue: [],
    timer: null,
    path: null,
    title: null,
    href: null,
    firstView: true,
    visibleSince: null,
    engagedMs: 0,
    maxScroll: 0,
    exitSent: false,
    errors: 0,
    errorMessages: new Set(),
  };

  onConsentChange(() => {
    if (state) state.consent = effectiveConsent(state.opts.respectPrivacySignals);
  });
  patchHistory();
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("click", onClick, { capture: true });
  document.addEventListener("visibilitychange", () => {
    if (!state) return;
    if (document.visibilityState === "hidden") {
      if (state.visibleSince) state.engagedMs += Date.now() - state.visibleSince;
      state.visibleSince = null;
      sendExit();
      flush(true);
    } else {
      state.visibleSince = Date.now();
      state.exitSent = false; // a later hide reports the updated engagement
    }
  });
  addEventListener("pagehide", () => {
    sendExit();
    flush(true);
  });
  if (opts.trackErrors) {
    addEventListener("error", (e) => {
      if (e instanceof ErrorEvent && e.message) onError(e.message, e.filename, e.lineno);
    });
    addEventListener("unhandledrejection", (e) => {
      const r = e.reason as { message?: string } | undefined;
      onError(`Unhandled rejection: ${r?.message ?? String(e.reason)}`);
    });
  }
  (window as Window & { webAnalytics?: unknown }).webAnalytics = { track, identify, setConsent };
  pageview();
}

/** Record a custom event, e.g. track("signup_started", { plan: "pro" }). */
export function track(event: string, props?: Props) {
  if (!LIMITS.eventName.test(event)) return;
  enqueue(event, props);
}

/** Attach a signed-in user id (sent only with full consent). Pass null on sign-out. */
export function identify(userId: string | null) {
  if (!state) return;
  state.userId = userId && LIMITS.id.test(userId) ? userId : null;
}

/** Record the visitor's consent choice. */
export function setConsent(level: Consent) {
  saveConsentChoice(level);
}
