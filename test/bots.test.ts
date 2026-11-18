import { describe, expect, it } from "vitest";
import { detectBot, detectClientBot } from "../src/shared/bots";

const cases: Array<[string, string | null, string | null]> = [
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)", "GPTBot", "ai_training"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", "ChatGPT-User", "ai_user"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot", "OAI-SearchBot", "ai_search"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "ClaudeBot", "ai_training"],
  ["Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)", "Claude-User", "ai_user"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", "PerplexityBot", "ai_search"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)", "Perplexity-User", "ai_user"],
  ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Googlebot", "search"],
  ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "Bingbot", "search"],
  ["facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "Facebook", "social"],
  ["curl/8.4.0", "generic", "other"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", null, null],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1", null, null],
];

describe("detectBot", () => {
  it.each(cases)("%s", (ua, name, kind) => {
    const bot = detectBot(ua);
    expect(bot?.name ?? null).toBe(name);
    expect(bot?.kind ?? null).toBe(kind);
  });

  it("treats a missing user agent as a bot", () => {
    expect(detectBot(null)?.kind).toBe("other");
  });
});

describe("detectClientBot", () => {
  it.each([
    ["Mozilla/5.0 (compatible; SiteChecker/2.0)", "unknown-client"],
    ["Mozilla/5.0", "unknown-client"],
    ["Mozilla/5.0 (compatible; GPTBot/1.1)", "GPTBot"],
  ])("flags %s", (ua, name) => {
    expect(detectClientBot(ua)?.name).toBe(name);
  });

  it.each([
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]",
  ])("keeps real browsers: %s", (ua) => {
    expect(detectClientBot(ua)).toBeNull();
  });
});
