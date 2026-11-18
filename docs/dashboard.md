# One dashboard for all sites (Looker Studio)

1. **Run setup for every site** (`web-analytics setup --project <site-project>`). All datasets must be in the **same location** (e.g. `EU`).
2. **Create the observer project** (e.g. `my-observer`) and give your Google account **BigQuery Data Viewer** on each site's `web_analytics` dataset.
3. **Run:**
   ```bash
   npx @bmnova/web-analytics observer --project my-observer --location EU \
     --sites site-a.web_analytics,site-b.web_analytics,site-c.web_analytics
   ```
4. **Connect Looker Studio:** in [Looker Studio](https://lookerstudio.google.com), click *Create → Data source → BigQuery* and add each `my-observer.all_sites.daily_*` view as a data source. Use *Owner's credentials*, so viewers don't need BigQuery access.
5. **Build the report.** A *site* filter control on every page lets you look at one site or all of them.

   | Page | Source | Charts |
   |---|---|---|
   | Overview | `daily_overview` | visitors, sessions, bounce rate (bounces / sessions), avg session, errors, AI bot requests; time series by day |
   | Acquisition | `daily_channels` | sessions by `channel` (ai / search / social / …); table by `source`; a filter `channel = ai` shows ChatGPT vs Perplexity vs Claude |
   | Pages & exits | `daily_pages` | pageviews, entries, exits, exit rate (exits / pageviews), engaged seconds, scroll % |
   | Events | `daily_events` | custom events by `entry_channel` |
   | Funnel | custom query (below) | bar chart of `sessions` by `step_number`, broken down by `entry_channel` |
   | Errors | `daily_errors` | top messages by occurrences, with path |
   | AI crawlers & bots | `daily_bots` | requests by `bot_name` over time; table of `path` × `bot_name`; filter `bot_kind` in ai_* |

6. **Funnel data source:** use *BigQuery → Custom query*, enable date parameters, and use:
   ```sql
   SELECT * FROM `my-observer.all_sites.funnel`(
     ['pageview:/', 'pageview:/pricing', 'signup_started', 'signed_up'],
     PARSE_DATE('%Y%m%d', @DS_START_DATE), PARSE_DATE('%Y%m%d', @DS_END_DATE))
   ```
   Make one data source per funnel. Steps are event names or `pageview:<path prefix>`.

## Tips from building one
- **First visit:** Looker Studio asks you to authorize it, then to authorize the BigQuery connector, then for a one-time account setup. Use the Google account that owns the BigQuery projects.
- **Quick start link:** this URL creates a report already connected to `daily_overview` (replace `my-observer`). Add the other views with *Add data → BigQuery*. Without a template report, the link accepts only one data source.
  ```
  https://lookerstudio.google.com/reporting/create?c.mode=edit&ds.connector=bigQuery&ds.type=TABLE&ds.projectId=my-observer&ds.datasetId=all_sites&ds.tableId=daily_overview&ds.billingProjectId=my-observer
  ```
- **Same filters on every page:** add a *date range control* and a *drop-down list* on `site`, select each one, then *Arrange → Make report-level*. The site control filters every view because they all have a `site` field.
- **Averages:** set the aggregation of `avg_session_sec`, `avg_engaged_sec` and `avg_scroll_pct` to *Average*, not *Sum*.
- **Empty Events page:** `daily_events` leaves out only `pageview` and `page_exit`; automatic events (`contact_click`, `outbound_click`, `file_download`, `form_submit`, client `error`) and custom events are included. Browser events come from `sessionized_events`, which keeps only rows with `via = 'client'`, `NOT is_bot` and a visitor key (`visitor_id` or `visitor_hash`). If the page is empty:
  - `WA_SALT_SECRET` is missing, so `visitor_hash` is null and every `basic`-consent event is dropped (only visitors who accepted the banner remain);
  - the site was dry-running in production (no rows at all; the collector now answers 503 there);
  - the visitors are flagged as bots (headless checkers, `curl`);
  - the scheduled query has not run since the events arrived (hourly), or the date range is outside its lookback.

## Freshness and cost
- **Freshness:** aggregates refresh hourly; raw `events` are real time if you query them directly.
- **Cost:** dashboards read only the small `daily_*` tables. The scheduled query scans the last 2 days of raw events per run. Small and medium sites stay within BigQuery's free tier (10 GB storage and 1 TB queries per month).
