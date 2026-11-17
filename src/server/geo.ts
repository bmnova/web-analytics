export interface RequestGeo {
  ip: string | null;
  country: string | null;
  region: string | null;
}

const UNKNOWN = new Set(["XX", "T1", ""]);

/**
 * Read client IP and coarse location from platform headers.
 * Vercel: x-vercel-ip-*. Cloudflare: cf-ipcountry (always) and cf-region-code
 * (enable the "Add visitor location headers" managed transform).
 * The IP is only used to compute the daily hash and is never stored.
 */
export function readGeo(headers: Headers): RequestGeo {
  const ip =
    headers.get("cf-connecting-ip") ||
    headers.get("x-real-ip") ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;
  const country = (headers.get("x-vercel-ip-country") || headers.get("cf-ipcountry") || "").toUpperCase();
  const region = headers.get("x-vercel-ip-country-region") || headers.get("cf-region-code") || null;
  return {
    ip,
    country: UNKNOWN.has(country) ? null : country,
    region: region ? decodeURIComponent(region).slice(0, 64) : null,
  };
}
