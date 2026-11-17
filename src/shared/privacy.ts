import { LIMITS, type Props, type PropValue } from "./schema.js";

/**
 * Prop keys that must never be stored. Matched case-insensitively as substrings,
 * so "user_email" and "totalAmount" are dropped too.
 */
const DENY = [
  "email",
  "e_mail",
  "phone",
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "auth",
  "cookie",
  "session_token",
  "card",
  "iban",
  "cvv",
  "ssn",
  "tckn",
  "address",
  "amount",
  "revenue",
  "income",
  "salary",
  "price",
  "balance",
  "file_content",
  "content",
  "ip",
];

const DENY_EXACT = new Set(["ip", "name", "first_name", "last_name", "full_name", "fullname"]);

export function isDeniedKey(key: string): boolean {
  const k = key.toLowerCase();
  if (DENY_EXACT.has(k)) return true;
  // "ip" as substring would block "tooltip"/"zip"; only match it as a whole segment.
  return DENY.some((d) => (d === "ip" ? /(^|_)ip(_|$)/.test(k) : k.includes(d)));
}

const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** Drop denied keys and unsafe values, and cap sizes. Returns null when nothing is left. */
export function sanitizeProps(input: unknown): Props | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: Props = {};
  let n = 0;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (n >= LIMITS.propKeys) break;
    if (!LIMITS.propKey.test(key) || isDeniedKey(key)) continue;
    const v = cleanValue(value);
    if (v === undefined) continue;
    out[key] = v;
    n++;
  }
  return n ? out : null;
}

function cleanValue(value: unknown): PropValue | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    if (EMAIL_LIKE.test(value)) return undefined;
    return value.slice(0, LIMITS.propStringLength);
  }
  return undefined;
}

/** Keep only the path: drop query string and hash (they can carry tokens or personal data). */
export function cleanPath(path: string | null | undefined): string | null {
  if (!path) return null;
  let p = path.trim();
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  if (!p.startsWith("/")) {
    try {
      p = new URL(p).pathname;
    } catch {
      return null;
    }
  }
  return p.slice(0, LIMITS.pathLength) || "/";
}
