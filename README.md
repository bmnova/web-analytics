# @bmnova/web-analytics

Privacy-first analytics for Next.js sites that writes straight into **your own BigQuery**.
One small package gives you:

- **Who came, from where:** channel and source, with AI assistants (ChatGPT, Perplexity, Claude, Gemini, Copilot…) as their own channel next to Google, social, email, paid and referral.
- **What they did:** pageviews (including SPA navigation), clicks on `data-track` elements, outbound links, custom events, scroll depth, engaged time and exit pages.
- **Funnels and journeys:** sessions and ordered funnels as BigQuery table functions. Signed-in users and server events (sign-ups, payments) join the same funnel.
- **Errors:** browser errors and Next.js `onRequestError`, stored next to the funnel.
- **AI crawlers and bots:** GPTBot, ChatGPT-User, ClaudeBot, PerplexityBot, Googlebot and others, logged from your middleware/proxy, including hits on `robots.txt` and `llms.txt`.
- **One panel for many sites:** each site writes to its own GCP project; an observer dataset unions them for Looker Studio.

It runs on **Vercel** (Node or Edge) and **Cloudflare Workers via OpenNext**: no Node-only SDKs; BigQuery is called with `fetch` + WebCrypto.

## How it works

```
browser tracker ──POST /api/collect──┐
middleware/proxy (bots) ─────────────┼──► BigQuery insertAll ──► <project>.web_analytics.events
server code (trackServer, errors) ───┘                              │ hourly scheduled query
                                                                     ▼
                                              daily_* tables ──► observer views ──► Looker Studio
```

## Privacy model

| | `basic` (default, no banner needed) | `full` (after the visitor accepts) |
|---|---|---|
| Stored in the browser | nothing (only the choice itself, once made) | `wa_vid` visitor id, `wa_sid` session id |
| Visitor counting | daily-rotating HMAC of site + IP + UA, computed on the server; the salt is derived from a secret and the date and never stored | persistent visitor id |
| Signed-in user id | not sent from the browser | sent after `identify()` |
| Session replay (Clarity) | never | only if you pass `clarityId` |

Always:
- IP addresses are never stored.
- Query strings are stripped from paths.
- Raw user agents are kept for bots only.
- Event props drop keys such as `email`, `amount`, `revenue`, `token`, `password` and email-looking values.

Global Privacy Control and Do Not Track keep a visitor in `basic`. You are still responsible for your privacy policy; see [docs/consent-and-privacy.md](docs/consent-and-privacy.md).

## Install

```bash
npm i @bmnova/web-analytics
```

### 1. Collector route: `app/api/collect/route.ts`
```ts
import { createCollectHandler } from "@bmnova/web-analytics/server";
export const { POST } = createCollectHandler();
// Do not add `export const runtime = "edge"`; the default runtime works on Vercel and OpenNext.
```

### 2. Tracker and banner in the root layout
```tsx
import { Analytics, ConsentBanner } from "@bmnova/web-analytics/react";

<body>
  {children}
  <Analytics site="mysite" />
  <ConsentBanner policyHref="/privacy" />
</body>
```
Track anything else:
```tsx
<button data-track="signup_started" data-track-plan="pro">Start</button>
```
```ts
import { track, identify } from "@bmnova/web-analytics/client";
track("file_parsed", { success: true, source: "csv" });
identify(user.id); // after sign-in; identify(null) on sign-out
```

### 3. Bot and AI-crawler logging
```ts
// Next 14/15: middleware.ts
import { withAnalytics } from "@bmnova/web-analytics/server";
export default withAnalytics(myMiddleware); // or withAnalytics() if you have none
export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
```
```ts
// Next 16: proxy.ts
import { withAnalytics } from "@bmnova/web-analytics/server";
export const proxy = withAnalytics(myProxy);
```
Make sure the matcher includes `robots.txt`, `sitemap.xml` and `llms.txt`. On Cloudflare, files in `public/` are served without running the worker, so serve them from route handlers (`app/robots.ts`, `app/llms.txt/route.ts`) instead.

### 4. Server events and errors (optional)
```ts
import { trackServer } from "@bmnova/web-analytics/server";
await trackServer("subscription_started", { plan: "pro" }, { userId });
```
```ts
// instrumentation.ts
import { createOnRequestError } from "@bmnova/web-analytics/server";
export const onRequestError = createOnRequestError();
```

### 5. Environment
See [.env.example](.env.example). Without `WA_GCP_SA_KEY` the package runs in **dry-run mode** and prints rows to the log, which is handy locally. Requests with bot user agents (including `curl`) are flagged `is_bot` and never get a `visitor_hash`; test with a browser user agent.

| Var | |
|---|---|
| `WA_SITE` | label on every row |
| `WA_BQ_PROJECT`, `WA_BQ_DATASET` | destination (dataset defaults to `web_analytics`) |
| `WA_GCP_SA_KEY` | service-account JSON (raw or base64); needs BigQuery Data Editor on the dataset only |
| `WA_SALT_SECRET` | random secret for the daily visitor hash (`openssl rand -hex 32`) |
| `WA_ALLOWED_ORIGINS` | extra origins allowed to post (the site's own origin is always allowed) |

## BigQuery setup

```bash
npx @bmnova/web-analytics setup --project my-site-project --location EU
```
This creates:
- the `events` table (partitioned, clustered, 14-month retention by default)
- the `sessionized_events`, `sessions` and `funnel` table functions
- the `daily_*` aggregate tables
- an hourly scheduled query that refreshes the aggregates

Add `--print` to see the SQL without running it.

Funnel example:
```sql
SELECT * FROM `my-site-project.web_analytics.funnel`(
  ['pageview:/', 'pageview:/pricing', 'signup_started', 'signed_up'], '2026-01-01', CURRENT_DATE())
```

### One panel for several sites
```bash
npx @bmnova/web-analytics observer --project my-observer --sites site-a.web_analytics,site-b.web_analytics
```
Then follow [docs/dashboard.md](docs/dashboard.md).

## Docs
- [Next.js on Vercel](docs/nextjs-vercel.md)
- [Next.js on Cloudflare (OpenNext)](docs/nextjs-cloudflare.md)
- [Consent and privacy](docs/consent-and-privacy.md)
- [Dashboard](docs/dashboard.md)
- [Rate limiting](docs/rate-limiting.md)

## Development
```bash
pnpm install
pnpm test
pnpm build
```
- A pre-commit hook runs [gitleaks](https://github.com/gitleaks/gitleaks) on staged changes (`npx simple-git-hooks` once after install).
- CI scans the full history.
- Never commit credentials: configuration lives in env vars only.

## License
MIT
