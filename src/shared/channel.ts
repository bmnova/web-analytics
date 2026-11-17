export type Channel =
  | "ai"
  | "search"
  | "social"
  | "email"
  | "paid"
  | "campaign"
  | "referral"
  | "internal"
  | "direct";

export interface ChannelInput {
  utmSource?: string | null;
  utmMedium?: string | null;
  /** Full referrer URL or bare host. */
  referrer?: string | null;
  /** Host of the site itself; a referrer on this host is internal navigation. */
  selfHost?: string | null;
}

export interface ChannelResult {
  channel: Channel;
  source: string | null;
  referrerHost: string | null;
}

// Hosts are matched exactly or as a parent domain (sub.example.com matches example.com).
const AI_HOSTS = [
  "chatgpt.com",
  "chat.openai.com",
  "openai.com",
  "perplexity.ai",
  "claude.ai",
  "gemini.google.com",
  "bard.google.com",
  "aistudio.google.com",
  "notebooklm.google.com",
  "copilot.microsoft.com",
  "copilot.cloud.microsoft",
  "deepseek.com",
  "grok.com",
  "meta.ai",
  "chat.mistral.ai",
  "you.com",
  "phind.com",
  "poe.com",
  "kimi.com",
  "kimi.moonshot.cn",
  "chat.qwen.ai",
  "duck.ai",
];

const AI_SOURCE_WORDS = /^(chatgpt|openai|perplexity|claude|gemini|copilot|deepseek|grok|mistral|le-chat|meta-ai|you|phind|poe)$/i;

const SEARCH_HOSTS = [
  "bing.com",
  "duckduckgo.com",
  "search.yahoo.com",
  "yahoo.com",
  "yandex.ru",
  "yandex.com",
  "yandex.com.tr",
  "baidu.com",
  "ecosia.org",
  "search.brave.com",
  "startpage.com",
  "qwant.com",
  "naver.com",
  "seznam.cz",
  "kagi.com",
];

const SOCIAL_HOSTS = [
  "facebook.com",
  "fb.com",
  "instagram.com",
  "t.co",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "lnkd.in",
  "reddit.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "pinterest.com",
  "threads.net",
  "threads.com",
  "bsky.app",
  "mastodon.social",
  "news.ycombinator.com",
  "producthunt.com",
  "medium.com",
  "quora.com",
  "discord.com",
  "t.me",
  "telegram.org",
  "web.whatsapp.com",
  "wa.me",
];

const EMAIL_HOSTS = ["mail.google.com", "outlook.live.com", "outlook.office.com", "mail.yahoo.com", "mail.proton.me"];

const GOOGLE = /^(?:[a-z0-9-]+\.)*google\.[a-z]{2,3}(?:\.[a-z]{2})?$/;

/** Lowercase host without "www." for a URL or bare host; null when unparseable. */
export function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  if (!host || !host.includes(".")) return host || null;
  return host.replace(/^www\./, "");
}

function matches(host: string, list: readonly string[]): string | null {
  for (const d of list) if (host === d || host.endsWith(`.${d}`)) return d;
  return null;
}

/** Classify a host into a channel, or null when it is an ordinary referral. */
function classifyHost(host: string): { channel: Channel; source: string } | null {
  const ai = matches(host, AI_HOSTS);
  if (ai) return { channel: "ai", source: ai };
  const mail = matches(host, EMAIL_HOSTS);
  if (mail) return { channel: "email", source: mail };
  if (GOOGLE.test(host)) return { channel: "search", source: "google" };
  const search = matches(host, SEARCH_HOSTS);
  if (search) return { channel: "search", source: search };
  const social = matches(host, SOCIAL_HOSTS);
  if (social) return { channel: "social", source: social.replace(/^(m|l|lm)\./, "") };
  return null;
}

const PAID = /^(cpc|ppc|paid|paidsearch|paid_search|paid-social|paid_social|paidsocial|display|cpm|banner|ads?)$/i;
const EMAIL_MEDIUM = /^(e-?mail|newsletter)$/i;
const SOCIAL_MEDIUM = /^(social|social-network|social-media|sm|organic_social)$/i;

/**
 * Work out where a visit came from. UTM tags win over the referrer, because AI
 * assistants (e.g. ChatGPT adds utm_source=chatgpt.com) often send no referrer.
 */
export function classifyChannel(input: ChannelInput): ChannelResult {
  const referrerHost = hostOf(input.referrer);
  const selfHost = hostOf(input.selfHost);
  const utmSource = input.utmSource?.trim().toLowerCase() || null;
  const utmMedium = input.utmMedium?.trim().toLowerCase() || null;

  if (utmSource || utmMedium) {
    const srcHost = utmSource ? hostOf(utmSource) : null;
    const byHost = srcHost && srcHost.includes(".") ? classifyHost(srcHost) : null;
    const source = byHost?.source ?? utmSource;
    if (byHost?.channel === "ai" || (utmSource && AI_SOURCE_WORDS.test(utmSource))) {
      return { channel: "ai", source, referrerHost };
    }
    if (utmMedium && PAID.test(utmMedium)) return { channel: "paid", source, referrerHost };
    if (utmMedium && EMAIL_MEDIUM.test(utmMedium)) return { channel: "email", source, referrerHost };
    if (utmMedium && SOCIAL_MEDIUM.test(utmMedium)) return { channel: "social", source, referrerHost };
    if (byHost) return { channel: byHost.channel, source, referrerHost };
    return { channel: "campaign", source, referrerHost };
  }

  if (!referrerHost) return { channel: "direct", source: null, referrerHost: null };
  if (selfHost && (referrerHost === selfHost || referrerHost.endsWith(`.${selfHost}`) || selfHost.endsWith(`.${referrerHost}`))) {
    return { channel: "internal", source: null, referrerHost };
  }
  const byHost = classifyHost(referrerHost);
  if (byHost) return { ...byHost, referrerHost };
  return { channel: "referral", source: referrerHost, referrerHost };
}
