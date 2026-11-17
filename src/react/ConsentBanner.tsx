import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { getConsentChoice, privacySignal, saveConsentChoice } from "@bmnova/web-analytics/client";

export interface ConsentBannerProps {
  message?: ReactNode;
  acceptLabel?: string;
  rejectLabel?: string;
  policyHref?: string;
  policyLabel?: string;
  /** Drop the built-in inline styles and style via the wa-consent* class names. */
  unstyled?: boolean;
  className?: string;
}

const styles: Record<string, CSSProperties> = {
  root: {
    position: "fixed",
    insetInline: "16px",
    bottom: "16px",
    zIndex: 2147483000,
    maxWidth: "560px",
    marginInline: "auto",
    padding: "14px 16px",
    borderRadius: "12px",
    background: "rgba(20,20,22,0.96)",
    color: "#f5f5f5",
    font: "14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif",
    boxShadow: "0 8px 30px rgba(0,0,0,.25)",
    display: "flex",
    flexWrap: "wrap",
    gap: "12px",
    alignItems: "center",
  },
  text: { flex: "1 1 260px", margin: 0 },
  link: { color: "inherit", textDecoration: "underline" },
  actions: { display: "flex", gap: "8px", flexShrink: 0 },
  reject: { padding: "8px 14px", borderRadius: "8px", border: "1px solid #666", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" },
  accept: { padding: "8px 14px", borderRadius: "8px", border: 0, background: "#f5f5f5", color: "#111", cursor: "pointer", font: "inherit", fontWeight: 600 },
};

/**
 * Shown until the visitor chooses. Both buttons are equally prominent, and
 * rejecting keeps the cookieless basic mode (no storage besides the choice).
 */
export function ConsentBanner({
  message = "We use privacy-friendly analytics. With your OK we also remember your visits to understand how the site is used.",
  acceptLabel = "Accept",
  rejectLabel = "Reject",
  policyHref,
  policyLabel = "Privacy policy",
  unstyled = false,
  className,
}: ConsentBannerProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(getConsentChoice() === null && !privacySignal());
  }, []);

  if (!open) return null;
  const s = (k: string) => (unstyled ? undefined : styles[k]);
  const choose = (level: "full" | "basic") => {
    saveConsentChoice(level);
    setOpen(false);
  };

  return (
    <div role="dialog" aria-live="polite" aria-label="Analytics consent" className={["wa-consent", className].filter(Boolean).join(" ")} style={s("root")}>
      <p className="wa-consent__text" style={s("text")}>
        {message}{" "}
        {policyHref ? (
          <a className="wa-consent__link" href={policyHref} style={s("link")}>
            {policyLabel}
          </a>
        ) : null}
      </p>
      <div className="wa-consent__actions" style={s("actions")}>
        <button type="button" className="wa-consent__reject" style={s("reject")} onClick={() => choose("basic")}>
          {rejectLabel}
        </button>
        <button type="button" className="wa-consent__accept" style={s("accept")} onClick={() => choose("full")}>
          {acceptLabel}
        </button>
      </div>
    </div>
  );
}
