# One dashboard for all sites (Looker Studio)

1. **Run setup for every site** (`web-analytics setup --project <site-project>`). All datasets must be in the **same location** (e.g. `EU`).
2. **Create the observer project** (e.g. `my-observer`) and give your Google account **BigQuery Data Viewer** on each site's `web_analytics` dataset.
3. **Run:**
   ```bash
   npx @bmnova/web-analytics observer --project my-observer --location EU \
     --sites site-a.web_analytics,site-b.web_analytics,site-c.web_analytics
   ```
4. **Connect Looker Studio:** in [Looker Studio](https://lookerstudio.google.com), click *Create → Data source → BigQuery* and add each `my-observer.all_sites.daily_*` view (and `ai_visibility`) as a data source. Use *Owner's credentials*, so viewers don't need BigQuery access.
5. **Build the report.** A *site* filter control on every page lets you look at one site or all of them.

   | Page | Source | Charts |
   |---|---|---|
   | Overview | `daily_overview` | visitors, sessions, bounce rate (bounces / sessions), avg session, errors, AI bot requests; time series by day |
   | Acquisition | `daily_channels` | sessions by `channel` (ai / search / social / …); table by `source`; a filter `channel = ai` shows ChatGPT vs Perplexity vs Claude |
   | Pages & exits | `daily_pages` | pageviews, entries, exits, exit rate (exits / pageviews), engaged seconds, scroll % |
   | Events | `daily_events` | custom events by `entry_channel` |
   | Funnel | custom query (below) | bar chart of `sessions` by `step_number`, broken down by `entry_channel` |
   | Errors | `daily_errors` | top messages by occurrences, with path |
   | Audience | `daily_audience` | visitors by `country` (geo map), by `device`, `browser`, `os` (see below) |
   | AI visibility | `ai_visibility` | AI fetches vs. AI-referred visitors per path; robots.txt / llms.txt hits (see below) |
   | AI crawlers & bots | `daily_bots` | requests by `bot_name` over time; table of `path` × `bot_name`; filter `bot_kind` in ai_* |

6. **Funnel data source:** use *BigQuery → Custom query*, enable date parameters, and use:
   ```sql
   SELECT * FROM `my-observer.all_sites.funnel`(
     ['pageview:/', 'pageview:/pricing', 'signup_started', 'signed_up'],
     PARSE_DATE('%Y%m%d', @DS_START_DATE), PARSE_DATE('%Y%m%d', @DS_END_DATE))
   ```
   Make one data source per funnel. Steps are event names or `pageview:<path prefix>`.

7. **Audience page (`daily_audience`):** human traffic only, one row per day × site × country × device × browser × os.
   - *Add a chart → Geo chart* (Google Maps → filled map): dimension `country` (set its type to *Geo → Country* if Looker Studio guesses wrong; values are ISO codes such as `TR`, `DE`), metric `visitors`.
   - *Donut chart*: dimension `device`, metric `sessions`. Add a second one for `browser` or `os`.
   - *Table*: dimensions `country`, `device`; metrics `visitors`, `sessions`, `pageviews`; sort by `visitors`.
   - `visitors` is counted the same way as in `daily_overview` (distinct visitors per day), but per breakdown row. Someone who visits on a phone and a laptop counts once in each row, so the total across rows can be a little higher than `daily_overview.visitors`. Use `daily_overview` for the headline number.
8. **AI visibility page (`ai_visibility`):** per day × site × path, side by side:
   `ai_bot_requests` (all AI bots), `ai_training_requests`, `ai_search_requests`, `ai_user_fetches` (an assistant fetching the page for a user right now, e.g. ChatGPT-User), and `ai_referred_visitors` / `ai_referred_sessions` (people who clicked through from an AI assistant and landed on that path). `path_type` is `robots.txt`, `llms.txt`, `sitemap` or `page`.
   - *Time series*: dimension `day`, metrics `ai_bot_requests`, `ai_user_fetches`, `ai_referred_visitors`. Shows whether AI attention turns into visits.
   - *Table*: dimension `path`, metrics `ai_user_fetches`, `ai_referred_visitors`, `ai_bot_requests`; add a filter `path_type = page`. Pages with many fetches and few visitors are being answered inside the assistant.
   - *Scorecards* with a filter `path_type = robots.txt` (and one for `llms.txt`), metric `ai_bot_requests`: are crawlers reading your rules and your llms.txt at all?
   - *Bar chart* from `daily_channels` with filter `channel = ai`, dimension `source`: which assistant sends the visitors.
   - Rows exist only for paths an AI bot fetched or an AI visitor landed on. On Cloudflare, robots.txt and llms.txt rows appear only once those files are served by route handlers (see [nextjs-cloudflare.md](nextjs-cloudflare.md)).
9. **Health check:** with `--schedule-sa`, setup also creates the scheduled query `web-analytics health (<dataset>)`. Every 3 hours it fails if no human event arrived in the last `--stale-hours` (default 6), and BigQuery Data Transfer emails the account that created it. Low-traffic sites may want `--stale-hours 24`; `--no-health-check` skips it. To check by hand: BigQuery console → *Scheduled queries* → the run history.

## After upgrading
Run `web-analytics setup … --schedule-sa <email>` again. It creates the new tables and views without touching existing data, and points the existing hourly scheduled query at the new SQL (without `--schedule-sa` the hourly job keeps running the old SQL and the new tables stay empty). New tables start filling from the last `--lookback-days` days; to backfill older days, run the aggregates once from `--print` output with a larger `d_from`. Then re-run `observer` so `all_sites` gets the new views.

## Tips from building one
- **First visit:** Looker Studio asks you to authorize it, then to authorize the BigQuery connector, then for a one-time account setup. Use the Google account that owns the BigQuery projects.
- **Quick start link:** this URL creates a report already connected to `daily_overview` (replace `my-observer`). Add the other views with *Add data → BigQuery*. Without a template report, the link accepts only one data source.
  ```
  https://lookerstudio.google.com/reporting/create?c.mode=edit&ds.connector=bigQuery&ds.type=TABLE&ds.projectId=my-observer&ds.datasetId=all_sites&ds.tableId=daily_overview&ds.billingProjectId=my-observer
  ```
- **Same filters on every page:** add a *date range control* and a *drop-down list* on `site`, select each one, then *Arrange → Make report-level*. The site control filters every view because they all have a `site` field.
- **Averages:** set the aggregation of `avg_session_sec`, `avg_engaged_sec` and `avg_scroll_pct` to *Average*, not *Sum*.
- **Empty Events page:** `daily_events` leaves out `pageview` and `page_exit`, so it stays empty until the site sends custom events (`track()`, `data-track`, `trackServer()`).

## Freshness and cost
- **Freshness:** aggregates refresh hourly; raw `events` are real time if you query them directly.
- **Cost:** dashboards read only the small `daily_*` tables. The scheduled query scans the last 2 days of raw events per run. Small and medium sites stay within BigQuery's free tier (10 GB storage and 1 TB queries per month).
