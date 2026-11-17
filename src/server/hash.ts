const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

const saltCache = new Map<string, CryptoKey>();

async function dailyKey(secret: string, day: string): Promise<CryptoKey> {
  const id = `${secret.length}:${day}`;
  const hit = saltCache.get(id);
  if (hit) return hit;
  const master = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const salt = await crypto.subtle.sign("HMAC", master, enc.encode(`web-analytics:${day}`));
  const key = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  saltCache.clear(); // only today's key is needed
  saltCache.set(id, key);
  return key;
}

/**
 * Cookieless visitor id: HMAC(daily salt, site|ip|ua). The salt is derived from a secret
 * and the UTC date, so it rotates every day and is never stored; yesterday's hashes
 * cannot be linked to today's.
 */
export async function visitorHash(opts: { secret: string; site: string; ip: string | null; ua: string | null; date?: Date }): Promise<string | null> {
  if (!opts.ip && !opts.ua) return null;
  const day = (opts.date ?? new Date()).toISOString().slice(0, 10);
  const key = await dailyKey(opts.secret, day);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${opts.site}|${opts.ip ?? ""}|${opts.ua ?? ""}`));
  return hex(sig).slice(0, 32);
}
