# Consent and privacy

## What the package does by default
- **Basic mode:** nothing is written to the browser until the visitor chooses. Visitors are counted with a server-side HMAC of `site|ip|user-agent` keyed by a salt that is derived from `WA_SALT_SECRET` and the UTC date, so:
  - the hash cannot be linked across days,
  - the salt is never stored,
  - the IP is never stored.
- **Full mode** (after "Accept"):
  - a random visitor id and session id in `localStorage`
  - the signed-in user id if you call `identify()`
  - Clarity session replay if you passed `clarityId`
- **Rejecting** keeps basic mode and stores only the choice (`wa_consent`).
- **GPC/DNT** signals force basic mode and hide the banner.

This design aims to need no banner for basic mode, but the legal assessment depends on your jurisdiction and use. Treat this as engineering documentation, not legal advice.

## Things you must still do
- **Update your privacy policy.** The template below is a starting point.
- **Keep sensitive data out of events.** Never send amounts, revenue, file contents or personal data in event props. The deny-list catches common key names but cannot know your domain.
- **Normalize paths that carry ids.** If your URLs contain record ids (shared cards, invoices, user pages), pass the same `normalizePath` to `withAnalytics`, `createCollectHandler`, `trackServer` and `createOnRequestError`, and set `keepTitle: false` on the collector if page titles carry names or ids. See "Paths with ids" in the README. Known limitation: error rows keep the first 200 characters of the error message; `normalizePath` does not touch it, so do not put ids or personal data in thrown error messages.
- **Session replay needs care.** If you enable it, configure masking in Clarity (mask all inputs and any sensitive numbers), and do not enable it on pages whose promise is "your data stays on your device".

## Privacy policy template (adapt)

> **Analytics.** We use our own analytics to understand how the site is used: which pages are viewed, where visitors come from (for example a search engine or an AI assistant), the browser, device type, country, and errors.
>
> **Without your consent**, we store nothing on your device and do not use cookies. To count visitors, we compute a one-way code from your IP address and browser, and that code changes every day. We never store your IP address.
>
> **If you accept analytics**, we store a random identifier in your browser's local storage, so we can understand repeat visits. [If applicable: we also record anonymised session replays with Microsoft Clarity.] You can withdraw your consent at any time by [link/button calling `setConsent("basic")`].
>
> **Storage and retention.** Data is stored in Google BigQuery ([region]) and deleted after [14] months. We also log requests from automated crawlers (for example search engines and AI crawlers), including their user-agent string.
