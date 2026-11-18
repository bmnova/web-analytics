# Add a site, step by step

This guide takes a Next.js site from nothing to live analytics in BigQuery, plus one dashboard across all your sites. It covers Vercel and Cloudflare Workers (OpenNext). Each step says which one it applies to.

Placeholders:

| Placeholder | Example |
|---|---|
| `<project>` | the GCP project for this site (e.g. `my-site-prod`) |
| `<site>` | a short label written on every row (e.g. `mysite`) |
| `<observer>` | the GCP project that holds the combined views (one for all your sites) |

All datasets must use the **same location** (this guide uses `EU`), or the combined views cannot read them.

---

## 1. Prepare Google Cloud (once per site)

You need `gcloud` and `bq` (Google Cloud SDK), logged in as a project owner.

1. **Billing must be enabled on `<project>`.** The BigQuery sandbox does not allow streaming inserts.

2. **Enable the APIs:**
   ```bash
   gcloud services enable bigquery.googleapis.com bigquerydatatransfer.googleapis.com --project <project>
   ```

3. **Create two service accounts.** The writer is used by the site; the scheduler runs the hourly aggregation.
   ```bash
   gcloud iam service-accounts create web-analytics-writer --project <project>
   gcloud iam service-accounts create web-analytics-scheduler --project <project>
   ```

4. **Create the dataset, table and functions:**
   ```bash
   npx @bmnova/web-analytics setup --project <project> --location EU
   ```

5. **Give both accounts access to this dataset only,** and let the scheduler run queries:
   ```bash
   bq --project_id=<project> --location=EU query --use_legacy_sql=false \
     "GRANT \`roles/bigquery.dataEditor\` ON SCHEMA \`<project>.web_analytics\`
      TO \"serviceAccount:web-analytics-writer@<project>.iam.gserviceaccount.com\",
         \"serviceAccount:web-analytics-scheduler@<project>.iam.gserviceaccount.com\""
   gcloud projects add-iam-policy-binding <project> --condition=None \
     --member=serviceAccount:web-analytics-scheduler@<project>.iam.gserviceaccount.com \
     --role=roles/bigquery.jobUser
   ```

6. **Create the hourly scheduled query.** Re-running setup is safe: it keeps existing tables and does not create a second schedule.
   ```bash
   npx @bmnova/web-analytics setup --project <project> --location EU \
     --schedule-sa web-analytics-scheduler@<project>.iam.gserviceaccount.com
   ```
   You should see `hourly scheduled query … ok`.

---

## 2. Install the package in the site

> Using an AI coding agent? Paste [agent-prompt.md](agent-prompt.md) into it instead of following this step by hand.

```bash
npm i @bmnova/web-analytics      # or pnpm add / yarn add
```

### 2a. Collector route

Create `app/api/collect/route.ts` (or `src/app/...`):

```ts
import { createCollectHandler } from "@bmnova/web-analytics/server";

export const { POST } = createCollectHandler({ site: "<site>" });
```

Do **not** add `export const runtime = "edge"`.

### 2b. Tracker and consent banner

In the root layout (`app/layout.tsx`, or `app/[lang]/layout.tsx` for i18n sites):

```tsx
import { Analytics, ConsentBanner } from "@bmnova/web-analytics/react";

// inside <body>, after {children}
<Analytics site="<site>" />
<ConsentBanner policyHref="/privacy" />
```

`ConsentBanner` accepts `message`, `acceptLabel`, `rejectLabel` and `policyLabel` for translations. Leave out `clarityId` unless you want session replay, and never enable replay on pages that show sensitive numbers.

### 2c. Bot and AI-crawler logging

**Next 16 (`proxy.ts`, or `src/proxy.ts`):**
```ts
import { withAnalytics } from "@bmnova/web-analytics/server";

// If you already have a proxy function, pass it in: withAnalytics(myProxy, { site: "<site>" })
export const proxy = withAnalytics(undefined, { site: "<site>" });

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

**Next 14/15 (`middleware.ts`):**
```ts
import { withAnalytics } from "@bmnova/web-analytics/server";

export const middleware = withAnalytics(myMiddleware, { site: "<site>" }); // or withAnalytics(undefined, ...)

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

The matcher must include paths with dots (`robots.txt`, `llms.txt`, `sitemap.xml`). If your own middleware logic should not run on those paths, skip them inside your function, not in the matcher.

### 2d. Cloudflare only: serve crawler files from routes

On Workers, files in `public/` are served without running the proxy, so crawler hits on them are invisible.
- Move `public/robots.txt` to `app/robots.ts`.
- Move `public/llms.txt` to `app/llms.txt/route.ts`:

```ts
// app/llms.txt/route.ts
export const dynamic = "force-static";
export function GET() {
  return new Response(`# My site\n\n> One-line summary.\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
```

Also enable *Rules → Transform Rules → Managed Transforms → Add visitor location headers* in the Cloudflare dashboard if you want the region next to the country.

### 2e. Signed-in users and server events (optional)

```ts
// client, after sign-in (sent only when the visitor accepted the banner)
import { identify, track } from "@bmnova/web-analytics/client";
identify(user.id);           // identify(null) on sign-out
track("file_parsed", { success: true, source: "csv" });
```

```ts
// server: sign-up, payment webhooks, imports (not blocked by ad blockers)
import { trackServer } from "@bmnova/web-analytics/server";
await trackServer("subscription_started", { plan: "pro" }, { userId });
```

```html
<!-- no code needed for buttons -->
<button data-track="signup_started" data-track-plan="pro">Start</button>
```

Never put amounts, revenue, emails or file contents in event props. Common key names are dropped automatically, but the package cannot know your domain.

### 2f. Server errors (Next 15+, optional)

```ts
// instrumentation.ts
import { createOnRequestError } from "@bmnova/web-analytics/server";
export const onRequestError = createOnRequestError({ site: "<site>" });
```

### 2f-2. Paths with ids

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

### 2g. Privacy policy

Add an analytics paragraph to your privacy page. A template is in [consent-and-privacy.md](consent-and-privacy.md). If the page currently says "no trackers", change that.

---

## 3. Store the settings on the host

Use the bundled script from this repo. It:
- creates a writer key,
- stores it and a fresh salt secret on your host without printing them,
- deletes the key file.

The script runs `npx wrangler` for Cloudflare and needs the `vercel` CLI for Vercel. Get it with `git clone https://github.com/bmnova/web-analytics` or from `node_modules/@bmnova/web-analytics/scripts/`.

**Vercel:**
```bash
vercel login
cd <site-dir> && vercel link
<path>/scripts/push-secrets.sh vercel <project> <site> .
```

**Cloudflare:**
```bash
npx wrangler login
<path>/scripts/push-secrets.sh cloudflare <project> <site> <worker-dir>
```
Then add the printed non-secret vars to `wrangler.jsonc`:
```jsonc
"vars": { "WA_BQ_PROJECT": "<project>", "WA_BQ_DATASET": "web_analytics", "WA_SITE": "<site>" }
```

If the site answers on both `example.com` and `www.example.com`, also set `WA_ALLOWED_ORIGINS=https://example.com,https://www.example.com`.

Deploy the site.

---

## 4. Verify in production

```bash
curl -s -o /dev/null -w "%{http_code}\n" -A "Mozilla/5.0 (compatible; GPTBot/1.1; wa-test)" https://<domain>/llms.txt
```

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<domain>/api/collect \
  -H "origin: https://<domain>" -H "content-type: application/json" \
  -A "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/131 Safari/537.36" \
  --data '{"events":[{"event":"pageview","path":"/","consent":"basic","utm":{"source":"chatgpt.com","campaign":"wa-test"}}]}'
```

```bash
bq --project_id=<project> --location=EU query --use_legacy_sql=false \
  "SELECT ts, event, path, channel, source, bot_name FROM \`<project>.web_analytics.events\`
   WHERE ts > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 10 MINUTE) ORDER BY ts DESC LIMIT 20"
```

Expected results:
- a `bot_request` row with `GPTBot`,
- a `pageview` row with `channel = ai` and `source = chatgpt.com`.

Test rows stay in BigQuery's streaming buffer for up to 90 minutes before they can be deleted:
```sql
DELETE FROM `<project>.web_analytics.events` WHERE utm_campaign = 'wa-test' OR user_agent LIKE '%wa-test%'
```

### Troubleshooting

| Symptom | Fix |
|---|---|
| `[web-analytics:dry-run]` lines in logs | `WA_GCP_SA_KEY` or `WA_BQ_PROJECT` is missing on the host |
| `/api/collect` returns 403 | the page's origin differs from the request host (www vs apex, custom domain); set `WA_ALLOWED_ORIGINS` |
| `visitor_hash` is always null | `WA_SALT_SECRET` is missing, or you tested with a bot user agent such as plain `curl` |
| no rows for `robots.txt` on Cloudflare | the file is still in `public/`; see step 2d |
| scheduled query fails with `getAccessToken` | re-run step 1.6; it grants the transfer agent access to the scheduler account |
| old code after reinstalling the same version | delete `.next` and rebuild |

---

## 5. Add the site to the combined dashboard

Run this once with every site's dataset. Re-run it whenever you add a site:

```bash
npx @bmnova/web-analytics observer --project <observer> --location EU \
  --sites site-a-project.web_analytics,site-b-project.web_analytics,<project>.web_analytics
```

Then build or refresh the Looker Studio report as described in [dashboard.md](dashboard.md).
