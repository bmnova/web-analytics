-- Human events with a visitor key and a 30-minute-idle session key.
-- visitor_key prefers the consented visitor_id and falls back to the daily hash.
CREATE OR REPLACE TABLE FUNCTION `{{project}}.{{dataset}}.sessionized_events`(from_date DATE, to_date DATE) AS (
  WITH e AS (
    SELECT *, COALESCE(visitor_id, visitor_hash) AS visitor_key
    FROM `{{project}}.{{dataset}}.events`
    WHERE DATE(ts) BETWEEN from_date AND to_date
      AND NOT is_bot
      AND via = 'client'
      AND COALESCE(visitor_id, visitor_hash) IS NOT NULL
  ),
  flagged AS (
    SELECT *,
      IF(LAG(ts) OVER w IS NULL OR TIMESTAMP_DIFF(ts, LAG(ts) OVER w, MINUTE) >= 30, 1, 0) AS is_new_session
    FROM e
    WINDOW w AS (PARTITION BY site, visitor_key ORDER BY ts)
  ),
  numbered AS (
    SELECT *, SUM(is_new_session) OVER (PARTITION BY site, visitor_key ORDER BY ts) AS session_number
    FROM flagged
  ),
  keyed AS (
    SELECT * EXCEPT (is_new_session, session_number),
      CONCAT(visitor_key, '-', CAST(session_number AS STRING)) AS session_key
    FROM numbered
  )
  SELECT *,
    FIRST_VALUE(IF(event = 'pageview', channel, NULL) IGNORE NULLS) OVER s AS entry_channel,
    FIRST_VALUE(IF(event = 'pageview', source, NULL) IGNORE NULLS) OVER s AS entry_source,
    FIRST_VALUE(IF(event = 'pageview', path, NULL) IGNORE NULLS) OVER s AS entry_path,
    FIRST_VALUE(IF(event = 'pageview', utm_campaign, NULL) IGNORE NULLS) OVER s AS entry_campaign
  FROM keyed
  WINDOW s AS (PARTITION BY site, session_key ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
);

-- One row per session: entry, exit, length and what happened.
CREATE OR REPLACE TABLE FUNCTION `{{project}}.{{dataset}}.sessions`(from_date DATE, to_date DATE) AS (
  SELECT
    site,
    session_key,
    ANY_VALUE(visitor_key) AS visitor_key,
    MAX(user_id) AS user_id,
    MIN(ts) AS started_at,
    MAX(ts) AS ended_at,
    TIMESTAMP_DIFF(MAX(ts), MIN(ts), SECOND) AS duration_sec,
    ANY_VALUE(entry_channel) AS entry_channel,
    ANY_VALUE(entry_source) AS entry_source,
    ANY_VALUE(entry_path) AS entry_path,
    ANY_VALUE(entry_campaign) AS entry_campaign,
    ARRAY_AGG(IF(event = 'pageview', path, NULL) IGNORE NULLS ORDER BY ts DESC LIMIT 1)[SAFE_OFFSET(0)] AS exit_path,
    ANY_VALUE(country) AS country,
    ANY_VALUE(device) AS device,
    COUNTIF(event = 'pageview') AS pageviews,
    COUNTIF(event NOT IN ('pageview', 'page_exit')) AS interactions,
    COUNTIF(event = 'error') AS errors,
    LOGICAL_OR(consent = 'full') AS consented
  FROM `{{project}}.{{dataset}}.sessionized_events`(from_date, to_date)
  GROUP BY site, session_key
);

-- Highest step reached in order. hits are step indexes ordered by time.
CREATE OR REPLACE FUNCTION `{{project}}.{{dataset}}.funnel_depth`(hits ARRAY<FLOAT64>)
RETURNS FLOAT64
LANGUAGE js AS r"""
  let depth = 0;
  for (const h of hits || []) { if (h === depth) depth++; }
  return depth;
""";

-- Ordered funnel per site and entry channel.
-- A step is an event name ("signed_up") or a page prefix ("pageview:/pricing").
-- Server events (via = 'server') join through user_id when the session is signed in.
-- Example: SELECT * FROM `p.d.funnel`(['pageview:/', 'pageview:/pricing', 'signup_started', 'signed_up'], '2026-01-01', CURRENT_DATE())
CREATE OR REPLACE TABLE FUNCTION `{{project}}.{{dataset}}.funnel`(steps ARRAY<STRING>, from_date DATE, to_date DATE) AS (
  WITH se AS (
    SELECT site, session_key, user_id, entry_channel, ts, event, path
    FROM `{{project}}.{{dataset}}.sessionized_events`(from_date, to_date)
  ),
  session_users AS (
    SELECT site, session_key, ANY_VALUE(entry_channel) AS entry_channel, MAX(user_id) AS user_id, MIN(ts) AS started_at, MAX(ts) AS ended_at
    FROM se GROUP BY site, session_key
  ),
  server_events AS (
    SELECT su.site, su.session_key, su.entry_channel, e.ts, e.event, e.path
    FROM `{{project}}.{{dataset}}.events` e
    JOIN session_users su
      ON e.site = su.site AND e.user_id = su.user_id
     AND e.ts BETWEEN su.started_at AND TIMESTAMP_ADD(su.ended_at, INTERVAL 30 MINUTE)
    WHERE DATE(e.ts) BETWEEN from_date AND DATE_ADD(to_date, INTERVAL 1 DAY)
      AND e.via = 'server' AND e.user_id IS NOT NULL
  ),
  all_events AS (
    SELECT site, session_key, entry_channel, ts, event, path FROM se
    UNION ALL
    SELECT * FROM server_events
  ),
  hits AS (
    SELECT a.site, a.session_key, a.entry_channel, a.ts, idx
    FROM all_events a, UNNEST(steps) AS step WITH OFFSET idx
    WHERE (STARTS_WITH(step, 'pageview:') AND a.event = 'pageview' AND STARTS_WITH(a.path, SUBSTR(step, 10)))
       OR (NOT STARTS_WITH(step, 'pageview:') AND a.event = step)
  ),
  reached AS (
    SELECT site, session_key, ANY_VALUE(entry_channel) AS entry_channel,
      `{{project}}.{{dataset}}.funnel_depth`(ARRAY_AGG(CAST(idx AS FLOAT64) ORDER BY ts, idx)) AS depth
    FROM hits GROUP BY site, session_key
  )
  SELECT site, IFNULL(entry_channel, 'direct') AS entry_channel, n + 1 AS step_number, steps[OFFSET(n)] AS step,
    COUNTIF(depth > n) AS sessions
  FROM reached, UNNEST(GENERATE_ARRAY(0, ARRAY_LENGTH(steps) - 1)) AS n
  GROUP BY site, entry_channel, step_number, step
);
