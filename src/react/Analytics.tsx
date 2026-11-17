import { useEffect, useState } from "react";
import { init, type TrackerOptions } from "@bmnova/web-analytics/client";
import { effectiveConsent, onConsentChange } from "@bmnova/web-analytics/client";

export interface AnalyticsProps extends TrackerOptions {
  /** Microsoft Clarity project id. Loaded only after the visitor gives full consent. */
  clarityId?: string;
}

const CLARITY_ID = /^[a-z0-9]{6,20}$/i;

function loadClarity(id: string) {
  if (!CLARITY_ID.test(id) || document.getElementById("wa-clarity")) return;
  const w = window as Window & { clarity?: ((...a: unknown[]) => void) & { q?: unknown[] } };
  w.clarity =
    w.clarity ||
    function (...args: unknown[]) {
      (w.clarity!.q = w.clarity!.q || []).push(args);
    };
  const s = document.createElement("script");
  s.id = "wa-clarity";
  s.async = true;
  s.src = `https://www.clarity.ms/tag/${id}`;
  document.head.appendChild(s);
}

/** Mount once in the root layout: <Analytics site="mysite" /> */
export function Analytics({ clarityId, ...options }: AnalyticsProps) {
  const [full, setFull] = useState(false);

  useEffect(() => {
    init(options);
    const respect = options.respectPrivacySignals ?? true;
    setFull(effectiveConsent(respect) === "full");
    return onConsentChange(() => setFull(effectiveConsent(respect) === "full"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (full && clarityId) loadClarity(clarityId);
  }, [full, clarityId]);

  return null;
}
