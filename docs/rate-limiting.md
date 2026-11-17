# Rate limiting the collector

`/api/collect` is public by design: browsers call it.

## What the package does
- origin allow-list
- 8 KB body cap
- at most 25 events per request
- strict schema validation
- prop sanitising

There is no in-memory rate limit, because serverless isolates share no memory.

## Add a platform rule
- **Cloudflare:** *Security → WAF → Rate limiting rules*, for example `http.request.uri.path eq "/api/collect"`, 60 requests per 1 minute per IP, action Block.
- **Vercel:** *Firewall → Rules → Rate limit*, on path `/api/collect`.

## Watch BigQuery
BigQuery streaming inserts cost about $0.01 per 200 MB. Set a budget alert on each project in *Billing → Budgets & alerts*.
