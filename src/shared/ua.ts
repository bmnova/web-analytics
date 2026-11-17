export interface UaInfo {
  device: "mobile" | "tablet" | "desktop" | null;
  browser: string | null;
  os: string | null;
}

/** Small, dependency-free user-agent parser. Good enough for dashboards, not for fingerprinting. */
export function parseUa(ua: string | null | undefined): UaInfo {
  if (!ua) return { device: null, browser: null, os: null };

  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : null;

  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser/.test(ua)
        ? "Samsung Internet"
        : /YaBrowser/.test(ua)
          ? "Yandex"
          : /Firefox|FxiOS/.test(ua)
            ? "Firefox"
            : /Chrome|CriOS/.test(ua)
              ? "Chrome"
              : /Safari/.test(ua)
                ? "Safari"
                : null;

  const device = /iPad|Tablet|(Android(?!.*Mobile))/.test(ua)
    ? "tablet"
    : /Mobi|iPhone|iPod|Android/.test(ua)
      ? "mobile"
      : "desktop";

  return { device, browser, os };
}
