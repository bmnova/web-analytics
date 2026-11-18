import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientEvent } from "../src/shared/schema";
import { sanitizeProps } from "../src/shared/privacy";

/*
 * Minimal fake DOM: enough for the tracker's click and submit listeners.
 * Supported selectors: "[attr]" and "tag[attr]".
 */
class FakeElement {
  parent: FakeElement | null = null;
  constructor(public tag: string, public attrs: Record<string, string> = {}) {}
  getAttribute(n: string) {
    return this.attrs[n] ?? null;
  }
  hasAttribute(n: string) {
    return n in this.attrs;
  }
  get dataset() {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.attrs)) {
      if (k.startsWith("data-")) out[k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
    }
    return out;
  }
  get href() {
    const h = this.attrs.href;
    if (h === undefined) return "";
    try {
      return new URL(h, BASE).href;
    } catch {
      return h;
    }
  }
  matches(sel: string) {
    const m = /^([a-z]*)\[([a-z-]+)\]$/.exec(sel);
    if (!m) return false;
    return (!m[1] || m[1] === this.tag) && this.hasAttribute(m[2]!);
  }
  closest(sel: string): FakeElement | null {
    for (let e: FakeElement | null = this; e; e = e.parent) if (e.matches(sel)) return e;
    return null;
  }
}
class FakeForm extends FakeElement {
  // A field named "id" or "action" shadows these on real forms; the tracker must not read them.
  id = { shadowed: true };
  action = { shadowed: true };
  elements = [{ name: "email", value: "secret@example.com" }];
  constructor(attrs: Record<string, string> = {}) {
    super("form", attrs);
  }
}

const BASE = "https://example.com/start";
const handlers: Record<string, Array<(e: unknown) => void>> = {};
const sent: ClientEvent[] = [];

function link(attrs: Record<string, string>, parent?: FakeElement) {
  const a = new FakeElement("a", attrs);
  if (parent) a.parent = parent;
  return a;
}
function child(of: FakeElement) {
  const span = new FakeElement("span");
  span.parent = of;
  return span;
}
function fire(type: string, event: unknown) {
  for (const h of handlers[type] ?? []) h(event);
}

let tracker: typeof import("../src/client/tracker");

beforeAll(async () => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("HTMLFormElement", FakeForm);
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("scrollY", 0);
  vi.stubGlobal("location", Object.assign(new URL(BASE), {}));
  vi.stubGlobal("history", { pushState() {}, replaceState() {} });
  vi.stubGlobal("document", {
    title: "Start",
    referrer: "",
    visibilityState: "visible",
    documentElement: { scrollHeight: 2000 },
    addEventListener() {},
  });
  vi.stubGlobal("addEventListener", (type: string, fn: (e: unknown) => void) => {
    (handlers[type] ??= []).push(fn);
  });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    sent.push(...(JSON.parse(init.body) as { events: ClientEvent[] }).events);
    return new Response(null, { status: 204 });
  }));
  tracker = await import("../src/client/tracker");
  tracker.init({ site: "t" });
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  tracker.flush();
  sent.length = 0;
});

function events() {
  tracker.flush();
  return sent.filter((e) => e.event !== "pageview");
}

describe("file_download", () => {
  it("records same-origin links with a known extension, path only", () => {
    fire("click", { target: child(link({ href: "/files/Report.PDF?token=abc#p2" })) });
    expect(events()).toEqual([expect.objectContaining({ event: "file_download", props: { ext: "pdf", path: "/files/Report.PDF" } })]);
  });

  it("records links with a download attribute and caps the path at 120 chars", () => {
    const long = `/export/${"x".repeat(200)}`;
    fire("click", { target: link({ href: long, download: "" }) });
    const [e] = events();
    expect(e).toMatchObject({ event: "file_download", props: { ext: null } });
    expect((e!.props!.path as string).length).toBe(120);
  });

  it.each(["dmg", "apk", "zip", "csv", "xlsx", "docx", "pptx", "mp4"])("knows .%s", (ext) => {
    fire("click", { target: link({ href: `https://example.com/d/app.${ext}` }) });
    expect(events()[0]).toMatchObject({ event: "file_download", props: { ext } });
  });

  it("treats cross-origin files as outbound clicks and plain pages as nothing", () => {
    fire("click", { target: link({ href: "https://cdn.other.com/app.dmg" }) });
    fire("click", { target: link({ href: "/pricing" }) });
    fire("click", { target: link({ href: "/blog/post.html" }) });
    expect(events()).toEqual([expect.objectContaining({ event: "outbound_click", props: { host: "cdn.other.com", path: "/app.dmg" } })]);
  });

  it("keeps mailto/tel and data-track ahead of downloads", () => {
    fire("click", { target: link({ href: "mailto:a@b.co" }) });
    fire("click", { target: link({ href: "/a.pdf", "data-track": "brochure" }) });
    expect(events().map((e) => e.event)).toEqual(["contact_click", "brochure"]);
  });

  it("helper ignores blob/data links", () => {
    const a = link({ href: "blob:https://example.com/123", download: "x.csv" });
    expect(tracker.downloadProps(a as unknown as HTMLAnchorElement, BASE)).toBeNull();
  });
});

describe("form_submit", () => {
  it("records form id and action path, never field values", () => {
    const form = new FakeForm({ id: "contact", action: "/api/contact?ref=x", method: "post" });
    fire("submit", { target: form, submitter: null });
    const out = events();
    expect(out).toEqual([expect.objectContaining({ event: "form_submit", props: { form: "contact", action: "/api/contact" } })]);
    expect(JSON.stringify(out)).not.toContain("secret@example.com");
    expect(JSON.stringify(out)).not.toContain("shadowed");
  });

  it("falls back to name, uses the submitter's formaction, and the page path without an action", () => {
    fire("submit", { target: new FakeForm({ name: "newsletter" }), submitter: new FakeElement("button", { formaction: "/subscribe" }) });
    fire("submit", { target: new FakeForm(), submitter: null });
    expect(events().map((e) => e.props)).toEqual([
      { form: "newsletter", action: "/subscribe" },
      { form: null, action: "/start" },
    ]);
  });

  it("stores only the host for cross-origin actions", () => {
    fire("submit", { target: new FakeForm({ id: "pay", action: "https://www.payments.example/checkout/abc123" }), submitter: null });
    expect(events()[0]!.props).toEqual({ form: "pay", action: "payments.example" });
  });

  it("skips forms marked data-track-ignore (on the form or an ancestor)", () => {
    fire("submit", { target: new FakeForm({ id: "login", "data-track-ignore": "" }), submitter: null });
    const wrapped = new FakeForm({ id: "search" });
    wrapped.parent = new FakeElement("div", { "data-track-ignore": "" });
    fire("submit", { target: wrapped, submitter: null });
    fire("submit", { target: new FakeElement("div"), submitter: null });
    expect(events()).toEqual([]);
  });

  it("props survive the server-side privacy filter", () => {
    const props = tracker.formProps(new FakeForm({ id: "contact", action: "/c" }) as unknown as HTMLFormElement, null, BASE)!;
    expect(sanitizeProps(props)).toEqual(props);
    const dl = tracker.downloadProps(link({ href: "/a.zip" }) as unknown as HTMLAnchorElement, BASE)!;
    expect(sanitizeProps(dl)).toEqual(dl);
  });
});
