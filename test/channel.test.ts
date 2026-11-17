import { describe, expect, it } from "vitest";
import { classifyChannel, hostOf } from "../src/shared/channel";

describe("classifyChannel", () => {
  it("prefers utm_source over referrer (ChatGPT adds utm_source)", () => {
    expect(classifyChannel({ utmSource: "chatgpt.com", referrer: null })).toMatchObject({ channel: "ai", source: "chatgpt.com" });
  });
  it("detects AI referrers", () => {
    expect(classifyChannel({ referrer: "https://www.perplexity.ai/search?q=x" })).toMatchObject({ channel: "ai", source: "perplexity.ai" });
    expect(classifyChannel({ referrer: "https://gemini.google.com/" })).toMatchObject({ channel: "ai", source: "gemini.google.com" });
  });
  it("detects Google across country domains", () => {
    expect(classifyChannel({ referrer: "https://www.google.com.tr/" })).toMatchObject({ channel: "search", source: "google" });
    expect(classifyChannel({ referrer: "https://google.co.uk/" })).toMatchObject({ channel: "search", source: "google" });
  });
  it("does not treat Gmail as search", () => {
    expect(classifyChannel({ referrer: "https://mail.google.com/" }).channel).toBe("email");
  });
  it("detects social, paid and email UTMs", () => {
    expect(classifyChannel({ referrer: "https://t.co/abc" }).channel).toBe("social");
    expect(classifyChannel({ utmSource: "google", utmMedium: "cpc" }).channel).toBe("paid");
    expect(classifyChannel({ utmSource: "newsletter", utmMedium: "email" }).channel).toBe("email");
    expect(classifyChannel({ utmSource: "launch-week" }).channel).toBe("campaign");
  });
  it("marks internal navigation and direct visits", () => {
    expect(classifyChannel({ referrer: "https://example.com/a", selfHost: "www.example.com" }).channel).toBe("internal");
    expect(classifyChannel({ referrer: "" })).toMatchObject({ channel: "direct", source: null });
  });
  it("falls back to referral", () => {
    expect(classifyChannel({ referrer: "https://blog.someone.dev/post" })).toMatchObject({ channel: "referral", source: "blog.someone.dev" });
  });
  it("normalises hosts", () => {
    expect(hostOf("https://WWW.Example.com/x")).toBe("example.com");
    expect(hostOf("not a url")).toBeNull();
  });
});
