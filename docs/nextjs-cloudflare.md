# Next.js on Cloudflare Workers (OpenNext)

1. **Use the default runtime:** do not set `runtime = "edge"` on the collector route. OpenNext runs it on workerd with `nodejs_compat`.
2. **Next 16:** export the wrapper as `proxy` from `proxy.ts` (or `src/proxy.ts`). Next 16 runs proxy on the Node runtime; the OpenNext build warns that Node middleware is experimental on Cloudflare. It was tested working with `@opennextjs/cloudflare` 1.20 and `wrangler dev`.
3. **Secrets:**
   ```bash
   wrangler secret put WA_GCP_SA_KEY     # paste the JSON
   wrangler secret put WA_SALT_SECRET
   ```
   Put the non-secret vars (`WA_SITE`, `WA_BQ_PROJECT`, `WA_BQ_DATASET`) in `wrangler.jsonc` `vars`. For local dev use `.dev.vars`, which is git-ignored here; make sure your app ignores it too.
4. **Geo:** `cf-ipcountry` is always present. For region, enable *Rules → Transform Rules → Managed Transforms → Add visitor location headers*.
5. **Static files skip the worker:** anything in `public/` (including `robots.txt` and `llms.txt`) is served by Workers static assets without running your proxy, so bot hits on those files are not logged. Serve them from route handlers (`app/robots.ts`, `app/llms.txt/route.ts`), or read Cloudflare's *AI Crawl Control* report for those paths.
6. **CPU time on the free plan (10 ms):**
   - The proxy only parses the user agent for humans, which is cheap.
   - For bots, it builds the row and writes it inside `waitUntil`; the RSA token signing happens about once an hour per isolate.
   - Watch *Workers → Metrics → CPU time* after deploying.
7. **CSP:** the tracker posts to your own origin (`connect-src 'self'` is enough). Clarity, if enabled, needs `https://*.clarity.ms` in `script-src` and `connect-src`.
