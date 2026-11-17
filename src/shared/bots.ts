export type BotKind =
  | "ai_training" // crawls content to train models
  | "ai_user" // fetches a page because a person asked an assistant
  | "ai_search" // builds an AI search index
  | "search"
  | "social" // link previews
  | "seo"
  | "monitor"
  | "other";

export interface Bot {
  name: string;
  kind: BotKind;
}

// Order matters: the first match wins, so specific tokens come before generic ones.
const BOTS: Array<[RegExp, string, BotKind]> = [
  // OpenAI
  [/ChatGPT-User/i, "ChatGPT-User", "ai_user"],
  [/OAI-SearchBot/i, "OAI-SearchBot", "ai_search"],
  [/GPTBot/i, "GPTBot", "ai_training"],
  // Anthropic
  [/Claude-User/i, "Claude-User", "ai_user"],
  [/Claude-SearchBot/i, "Claude-SearchBot", "ai_search"],
  [/Claude-Web/i, "Claude-Web", "ai_user"],
  [/ClaudeBot/i, "ClaudeBot", "ai_training"],
  [/anthropic-ai/i, "anthropic-ai", "ai_training"],
  // Perplexity
  [/Perplexity-User/i, "Perplexity-User", "ai_user"],
  [/PerplexityBot/i, "PerplexityBot", "ai_search"],
  // Others
  [/MistralAI-User/i, "MistralAI-User", "ai_user"],
  [/DuckAssistBot/i, "DuckAssistBot", "ai_user"],
  [/Meta-ExternalFetcher/i, "Meta-ExternalFetcher", "ai_user"],
  [/meta-externalagent/i, "meta-externalagent", "ai_training"],
  [/Google-CloudVertexBot/i, "Google-CloudVertexBot", "ai_training"],
  [/Bytespider/i, "Bytespider", "ai_training"],
  [/CCBot/i, "CCBot", "ai_training"],
  [/Amazonbot/i, "Amazonbot", "ai_training"],
  [/cohere-ai|cohere-training-data-crawler/i, "cohere-ai", "ai_training"],
  [/Diffbot/i, "Diffbot", "ai_training"],
  [/YouBot/i, "YouBot", "ai_search"],
  [/PhindBot/i, "PhindBot", "ai_search"],
  [/Timpibot/i, "Timpibot", "ai_training"],
  [/AI2Bot/i, "AI2Bot", "ai_training"],
  [/omgili/i, "omgili", "ai_training"],
  // Search engines
  [/Googlebot|Google-InspectionTool|Storebot-Google/i, "Googlebot", "search"],
  [/GoogleOther/i, "GoogleOther", "other"],
  [/bingbot|BingPreview/i, "Bingbot", "search"],
  [/Applebot/i, "Applebot", "search"],
  [/YandexBot|YandexMobileBot/i, "YandexBot", "search"],
  [/Baiduspider/i, "Baiduspider", "search"],
  [/DuckDuckBot/i, "DuckDuckBot", "search"],
  [/PetalBot/i, "PetalBot", "search"],
  [/Yeti\//i, "NaverYeti", "search"],
  [/SeznamBot/i, "SeznamBot", "search"],
  // Link previews
  [/facebookexternalhit|facebookcatalog/i, "Facebook", "social"],
  [/Twitterbot/i, "Twitterbot", "social"],
  [/LinkedInBot/i, "LinkedInBot", "social"],
  [/Slackbot|Slack-ImgProxy/i, "Slackbot", "social"],
  [/Discordbot/i, "Discordbot", "social"],
  [/TelegramBot/i, "TelegramBot", "social"],
  [/WhatsApp/i, "WhatsApp", "social"],
  [/Pinterestbot/i, "Pinterestbot", "social"],
  [/redditbot/i, "redditbot", "social"],
  // SEO tools
  [/AhrefsBot|AhrefsSiteAudit/i, "AhrefsBot", "seo"],
  [/SemrushBot/i, "SemrushBot", "seo"],
  [/MJ12bot/i, "MJ12bot", "seo"],
  [/DotBot/i, "DotBot", "seo"],
  [/DataForSeoBot/i, "DataForSeoBot", "seo"],
  [/Screaming Frog/i, "ScreamingFrog", "seo"],
  // Monitoring
  [/UptimeRobot/i, "UptimeRobot", "monitor"],
  [/Pingdom/i, "Pingdom", "monitor"],
  [/Better ?Uptime|BetterStack/i, "BetterStack", "monitor"],
  [/vercel-(screenshot|favicon)/i, "Vercel", "monitor"],
];

const GENERIC =
  /bot\b|crawler|spider|crawl|slurp|headlesschrome|phantomjs|puppeteer|playwright|python-requests|python-urllib|aiohttp|httpx|go-http-client|curl\/|wget\/|axios\/|node-fetch|undici|okhttp|java\/|libwww|scrapy/i;

/** Returns the bot behind a user agent, or null for a (probable) human browser. */
export function detectBot(userAgent: string | null | undefined): Bot | null {
  if (!userAgent) return { name: "empty-ua", kind: "other" };
  for (const [re, name, kind] of BOTS) {
    if (re.test(userAgent)) return { name, kind };
  }
  if (GENERIC.test(userAgent)) return { name: "generic", kind: "other" };
  return null;
}

export const AI_BOT_KINDS: ReadonlySet<BotKind> = new Set(["ai_training", "ai_user", "ai_search"]);
