# @bmnova/web-analytics

Privacy-first analytics for Next.js sites that writes straight into **your own BigQuery**.
One small package gives you:

- **Who came, from where:** channel and source, with AI assistants (ChatGPT, Perplexity, Claude, Gemini, Copilot…) as their own channel next to Google, social, email, paid and referral.
- **What they did:** pageviews (including SPA navigation), clicks on `data-track` elements, custom events, scroll depth, engaged time and exit pages, plus [automatic events](#automatic-events) for outbound links, email/phone links, file downloads and form submits.
- **Funnels and journeys:** sessions and ordered funnels as BigQuery table functions. Signed-in users and server events (sign-ups, payments) join the same funnel.
- **Errors:** browser errors and Next.js `onRequestError`, stored next to the funnel.
- **AI crawlers and bots:** GPTBot, ChatGPT-User, ClaudeBot, PerplexityBot, Googlebot and others, logged from your middleware/proxy, including hits on `robots.txt` and `llms.txt`. Automated tools that run your pages' JavaScript but send a user agent without a browser or OS (store reviewers, page checkers) are logged as `unknown-client` bots instead of visitors.
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

#### Automatic events

The tracker records these without any code. They land in `daily_events` like custom events.

| Event | When | Props |
|---|---|---|
| `pageview`, `page_exit` | page load and SPA navigation; leaving the page | `engaged_ms`, `scroll_pct` on `page_exit` |
| `contact_click` | click on a `mailto:` or `tel:` link | `type`: `email` or `phone` (never the address or number) |
| `outbound_click` | click on a link to another host | `host`, `path` (first 120 chars, no query) |
| `file_download` | click on a same-origin link ending in a known file extension (`pdf`, `zip`, `dmg`, `apk`, `csv`, `xlsx`, `docx`, `pptx`, `mp4`, …) or with a `download` attribute | `ext`, `path` (first 120 chars, no query) |
| `form_submit` | any form submit (capture phase, so it fires even if your handler calls `preventDefault`) | `form` (the form's `id`, else `name`), `action` (path for same-origin, host only for other origins) |
| `error` | uncaught browser errors and unhandled rejections (`trackErrors: false` to turn off) | `message` (200 chars), `source` file name, `line` |

- `file_download` only sees real links. Downloads built in JavaScript (a `blob:` or `data:` URL, e.g. a generated CSV) are not caught; send them yourself: `track("file_download", { ext: "csv", path: location.pathname })`.
- `form_submit` never reads field values. Add `data-track-ignore` to a form (or a wrapper) to skip it, e.g. login or search forms.
- An element with `data-track` wins over the automatic click events.
- `pageview` and `page_exit` are left out of `daily_events`; they feed `daily_pages` instead.

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

### 4b. Paths with ids

Every row stores the page path without query string or hash. If your paths contain record ids (`/r/<cardId>`, `/invoice/<id>`), those ids are stored too. Pass `normalizePath` to rewrite them before storage:

```ts
// lib/analytics-path.ts
export const normalizePath = (p: string) => p.replace(/^\/r\/[^/]+/, "/r/[id]");
```

```ts
withAnalytics(myProxy, { site: "x", normalizePath });                 // proxy.ts / middleware.ts
createCollectHandler({ site: "x", normalizePath, keepTitle: false }); // app/api/collect/route.ts
trackServer("shared", {}, { site: "x", request, normalizePath });
createOnRequestError({ site: "x", normalizePath });                   // instrumentation.ts
```

- Pass the **same function in all four places**: export it from one module and import it everywhere. Any entry point without it stores raw paths.
- It only changes the stored `path`. Bot detection, the asset filter, the collector skip and `ignore` still see the raw path. Its output is cleaned again (leading `/`, no query/hash, length cap).
- **Fail-closed:** if it throws or returns a non-string, the row is still written with `path = "/[unnormalized]"` (exported as `UNNORMALIZED_PATH`), never the raw path.
- Referrers: only the referrer **host** is stored, never its path, so same-site referrers cannot leak ids.
- `keepTitle: false` (collector only) stores `title` as null; use it when titles carry names or ids.
- Not covered: error `props.message` (first 200 chars of the error message) and your own event props. Keep ids and names out of error messages and props. `props.route` on error rows is Next's route pattern and is left as is.

### 5. Environment
See [.env.example](.env.example). Without `WA_GCP_SA_KEY` or `WA_BQ_PROJECT` the package runs in **dry-run mode** and prints rows to the log, which is handy locally.

**In production it refuses to dry-run silently.** Production means `VERCEL_ENV=production`, or `NODE_ENV=production` when `VERCEL_ENV` is not set (Cloudflare/OpenNext, self-hosted; Vercel previews are not production). If credentials are missing or `WA_GCP_SA_KEY` is not valid JSON there:
- `getConfig` logs one `console.error` naming the missing variables (never their values),
- `/api/collect` answers **503** with `x-web-analytics-error: missing-config: WA_GCP_SA_KEY, WA_BQ_PROJECT`, visible in the browser's network tab,
- the proxy, `trackServer` and `onRequestError` drop rows instead of printing them.

Pages, the proxy and the build keep working; nothing throws. Set `WA_DRY_RUN=1` to dry-run on purpose (for example in `opennextjs-cloudflare preview` or a production-mode staging build). To check the collector by hand, send one valid event; `{}` or an empty `events` array is rejected with 400 (that is also how `doctor` checks it without writing anything):
```bash
curl -si -X POST http://localhost:3000/api/collect -H 'origin: http://localhost:3000' -H 'content-type: application/json' \
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36' \
  -d '{"events":[{"event":"pageview","path":"/","consent":"basic"}]}'
```
It answers 204 (dry-run prints the row; with credentials it is written to BigQuery, so do this locally). Requests with bot user agents (including `curl`) are flagged `is_bot` and never get a `visitor_hash`; test with a browser user agent.

| Var | |
|---|---|
| `WA_SITE` | label on every row |
| `WA_BQ_PROJECT`, `WA_BQ_DATASET` | destination (dataset defaults to `web_analytics`) |
| `WA_GCP_SA_KEY` | service-account JSON (raw or base64); needs BigQuery Data Editor on the dataset only |
| `WA_SALT_SECRET` | random secret for the daily visitor hash (`openssl rand -hex 32`) |
| `WA_ALLOWED_ORIGINS` | extra origins allowed to post (the site's own origin is always allowed) |
| `WA_DRY_RUN` | `1` to log rows instead of writing them, even in production |

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

## Check a site: `doctor`

Run it in the site's directory to check the whole setup in one go:
```bash
npx @bmnova/web-analytics doctor --url https://www.example.com --vercel --project my-site-project
```
Each item prints `✓`, `✗` (with a fix) or `!` (warning). The exit code is 1 if anything failed, so it also works in CI.

| Check | What it looks at |
|---|---|
| Environment | `WA_*` in `.env`, `.env.local`, `.env.production`; with `--vercel`, the names in `vercel env ls production`. Values are never printed: it only says whether each is set, and checks formats it can read locally (the service-account key must be valid JSON or base64; its `client_email` is shown). |
| Code | `app/api/collect/route.ts`, `<Analytics>` in a layout, `withAnalytics` in middleware/proxy. |
| Live site (`--url`) | The page's scripts contain the tracker, and an empty `POST /api/collect` returns 400. A 503 names the missing production variables. Nothing is written. |
| BigQuery (`bq` CLI) | Dataset and `events` table, the hourly and health scheduled queries, and human (`is_bot = FALSE`) events for the site in the last 24 hours. Read-only. |

Without `WA_BQ_PROJECT` in a local env file, pass `--project` (Vercel values are encrypted and not read). `--dataset`, `--site` and `--dir` override the detected values.

## Docs
- **[Add a site, step by step](docs/add-a-site.md)**: start here
- **[Prompt for an AI coding agent](docs/agent-prompt.md)**: paste it into Claude Code or Cursor to do step 2 for you
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
