# Prompt for an AI coding agent

Use this prompt to have an AI coding agent (Claude Code, Cursor, Copilot, …) add web-analytics to your site. Two steps:
1. Finish **step 1 of [add-a-site.md](add-a-site.md)** (Google Cloud) yourself, or let the agent print the commands for you to run.
2. Fill in the values in the first block and paste the whole prompt into the agent, inside your site's repo.

The prompt keeps the agent away from credentials. Keys are created and stored by you with `scripts/push-secrets.sh`.

````text
Add the analytics package @bmnova/web-analytics (npm) to this site.

Guide (read it fully first, then the README):
https://github.com/bmnova/web-analytics/blob/main/docs/add-a-site.md

## Values for this site
- GCP project (<project>): FILL_ME
- Site label (<site>): FILL_ME
- Dataset / location: web_analytics / EU
- Host: Vercel | Cloudflare Workers (OpenNext)       <- keep one
- Google Cloud setup (guide step 1): done | not done  <- if "not done", print the step 1 commands for me and do not run them
- Privacy policy file: FILL_ME (path), or "find it"
- Signed-in users: none | <auth provider>, e.g. Supabase / NextAuth / Clerk
- Important server events (optional): e.g. payment webhook -> subscription_started, import -> file_imported
- Funnel / custom events (optional): e.g. signup_started, signed_up, checkout_started
- Ids or names in paths/titles: none | e.g. /r/<cardId>, /u/<username>; titles show user names  <- if unsure, ask me before step 9
- Session replay (Clarity): off                       <- leave off unless you really need it

## Do (guide step 2)
1. Install the package with this repo's package manager.
2. Add app/api/collect/route.ts with createCollectHandler({ site }). Do not set a runtime.
3. Add <Analytics site=... /> and <ConsentBanner ... /> to the root layout. Translate the banner if the site is multilingual.
4. Log bots and AI crawlers:
   - Next 16: wrap the existing proxy.ts with withAnalytics(existing, { site }), or create one.
   - Next 14/15: wrap middleware.ts the same way.
   - Make the matcher include robots.txt, llms.txt and sitemap.xml, and keep any existing middleware behaviour exactly as it is.
5. Cloudflare only: move robots.txt and llms.txt out of public/ into route handlers.
6. If there are signed-in users, call identify(user.id) after sign-in and identify(null) on sign-out.
7. Add the listed events: data-track for buttons, track() in client code, trackServer() for server steps and webhooks.
8. Next 15+: add createOnRequestError({ site }) in instrumentation.ts.
9. If paths or titles carry ids or personal names (ask me if the values above do not say): write one exported normalizePath(path) in a shared module (e.g. lib/analytics-path.ts) that replaces those segments with placeholders, and pass it to withAnalytics, createCollectHandler, trackServer and createOnRequestError. Add keepTitle: false to createCollectHandler if titles carry names or ids.
10. Update the privacy policy using docs/consent-and-privacy.md. It must describe both levels:
   - no consent: nothing stored on the device, visitors counted with a daily-rotating hash, IP never stored
   - consent: a persistent random id
   Remove any "no trackers" claim.

## Rules
- Never create, read, print, enter or commit keys or secrets. I will store them myself with the guide's step 3 (scripts/push-secrets.sh).
- You may only add the non-secret settings: WA_BQ_PROJECT, WA_BQ_DATASET and WA_SITE (wrangler.jsonc "vars" on Cloudflare; on Vercel, tell me to let push-secrets.sh set them).
- Never put amounts, revenue, emails, names or file contents in event props.
- Work on a new branch and open a pull request. Do not merge it.

## Verify locally before the PR
Without credentials the package runs in dry-run mode and logs every row as "[web-analytics:dry-run] {...}". Run the site (on Cloudflare: wrangler dev or the OpenNext preview) and confirm:
- curl -A "Mozilla/5.0 (compatible; GPTBot/1.1)" <local>/llms.txt  -> one bot_request row with bot_name GPTBot
- opening <local>/?utm_source=chatgpt.com in a browser -> a pageview row with channel "ai" and source "chatgpt.com"
- clicking around -> pageview and page_exit rows; your custom events appear
- before accepting the banner, localStorage has no wa_vid or wa_sid; after accepting, it does
- existing pages, redirects and locale routing still work, and the production build passes

## When done, tell me
- the PR link and a short summary,
- the exact push-secrets.sh command for me to run,
- the production checks from step 4 of the guide.
````

## Tips
- **Several sites:** run one agent per repo. When all sites are live, run `npx @bmnova/web-analytics observer ...` (guide step 5) to see them in one dashboard.
- **Existing analytics:** if the site already has another analytics tool, say in the prompt whether to keep it (for example as a cross-check) or remove it.
- **Error tracking:** Sentry or similar can stay. This package records errors for funnels; it does not replace an error tracker.
