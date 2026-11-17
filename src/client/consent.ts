import type { Consent } from "../shared/schema.js";

const KEY = "wa_consent";
const listeners = new Set<(c: Consent) => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The visitor's saved choice, or null if they have not chosen yet (show the banner). */
export function getConsentChoice(): Consent | null {
  const v = storage()?.getItem(KEY);
  return v === "full" || v === "basic" ? v : null;
}

/** Global Privacy Control / Do Not Track signals force basic mode. */
export function privacySignal(): boolean {
  if (typeof navigator === "undefined") return false;
  const n = navigator as Navigator & { globalPrivacyControl?: boolean };
  return n.globalPrivacyControl === true || n.doNotTrack === "1";
}

export function effectiveConsent(respectSignals = true): Consent {
  if (respectSignals && privacySignal()) return "basic";
  return getConsentChoice() ?? "basic";
}

/**
 * Save the visitor's choice. Remembering the choice itself is strictly necessary
 * storage; ids are only created after "full".
 */
export function saveConsentChoice(level: Consent) {
  const s = storage();
  try {
    s?.setItem(KEY, level);
    if (level === "basic") {
      s?.removeItem("wa_vid");
      s?.removeItem("wa_sid");
    }
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  for (const fn of listeners) fn(level);
}

export function onConsentChange(fn: (c: Consent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
