# Next.js on Vercel

1. **Install** the package and add the collector route, `<Analytics/>` and `withAnalytics` as in the README.
2. **Environment variables:** in Vercel → Project → Settings → Environment Variables, add `WA_SITE`, `WA_BQ_PROJECT`, `WA_BQ_DATASET`, `WA_SALT_SECRET`, and `WA_GCP_SA_KEY`. For `WA_GCP_SA_KEY`, paste the whole JSON or a base64 of it, and mark it **Sensitive**.
3. **Geo:** country and region come from `x-vercel-ip-country` and `x-vercel-ip-country-region`; nothing to configure.
4. **Background writes:** Next 15+ uses `after()`. Next 14 uses the middleware `event.waitUntil` or Vercel's request context, so responses are not delayed.
5. **Local development:** leave `WA_GCP_SA_KEY` unset and rows are printed to the dev-server log (dry-run).

**Matcher tip:** if your middleware excludes paths with a dot (common for i18n), widen the matcher so bot hits on `robots.txt`/`sitemap.xml` are seen, and skip those paths inside your own middleware logic.
