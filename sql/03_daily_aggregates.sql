-- Daily summary tables the dashboard reads (cheap: never scans raw events at view time).
-- Run as a scheduled query (hourly is fine). Each run rebuilds the last {{lookback_days}} days
-- so late beacons are picked up.
DECLARE d_from DATE DEFAULT DATE_SUB(CURRENT_DATE(), INTERVAL {{lookback_days}} DAY);
DECLARE d_to DATE DEFAULT CURRENT_DATE();

CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.daily_overview` (
  day DATE, site STRING, visitors INT64, sessions INT64, pageviews INT64, bounces INT64,
  avg_session_sec FLOAT64, signed_in_users INT64, errors INT64, bot_requests INT64, ai_bot_requests INT64
) PARTITION BY day CLUSTER BY site;

CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.daily_channels` (
  day DATE, site STRING, channel STRING, source STRING, campaign STRING, visitors INT64, sessions INT64, pageviews INT64, bounces INT64
) PARTITION BY day CLUSTER BY site, channel;

CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.daily_pages` (
  day DATE, site STRING, path STRING, pageviews INT64, visitors INT64, entries INT64, exits INT64, avg_engaged_sec FLOAT64, avg_scroll_pct FLOAT64
) PARTITION BY day CLUSTER BY site, path;

CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.daily_events` (
  day DATE, site STRING, event STRING, entry_channel STRING, events INT64, sessions INT64, users INT64
) PARTITION BY day CLUSTER BY site, event;

CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.daily_errors` (
  day DATE, site STRING, via STRING, message STRING, path STRING, occurrences INT64, sessions INT64
) PARTITION BY day CLUSTER BY site;

CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.daily_bots` (
  day DATE, site STRING, bot_kind STRING, bot_name STRING, path STRING, country STRING, requests INT64
) PARTITION BY day CLUSTER BY site, bot_kind;

CREATE TEMP TABLE s AS SELECT * FROM `{{project}}.{{dataset}}.sessions`(d_from, d_to);
CREATE TEMP TABLE se AS SELECT * FROM `{{project}}.{{dataset}}.sessionized_events`(d_from, d_to);

BEGIN TRANSACTION;

DELETE FROM `{{project}}.{{dataset}}.daily_overview` WHERE day BETWEEN d_from AND d_to;
INSERT INTO `{{project}}.{{dataset}}.daily_overview`
WITH sess AS (
  SELECT DATE(started_at) AS day, site, COUNT(DISTINCT visitor_key) AS visitors, COUNT(*) AS sessions,
    SUM(pageviews) AS pageviews, COUNTIF(pageviews <= 1 AND interactions = 0) AS bounces,
    AVG(duration_sec) AS avg_session_sec, COUNT(DISTINCT user_id) AS signed_in_users
  FROM s GROUP BY day, site
),
raw AS (
  SELECT DATE(ts) AS day, site,
    COUNTIF(event = 'error') AS errors,
    COUNTIF(is_bot) AS bot_requests,
    COUNTIF(is_bot AND bot_kind IN ('ai_training', 'ai_user', 'ai_search')) AS ai_bot_requests
  FROM `{{project}}.{{dataset}}.events`
  WHERE DATE(ts) BETWEEN d_from AND d_to
  GROUP BY day, site
)
SELECT COALESCE(sess.day, raw.day), COALESCE(sess.site, raw.site), IFNULL(visitors, 0), IFNULL(sessions, 0), IFNULL(pageviews, 0),
  IFNULL(bounces, 0), avg_session_sec, IFNULL(signed_in_users, 0), IFNULL(errors, 0), IFNULL(bot_requests, 0), IFNULL(ai_bot_requests, 0)
FROM sess FULL OUTER JOIN raw ON sess.day = raw.day AND sess.site = raw.site;

DELETE FROM `{{project}}.{{dataset}}.daily_channels` WHERE day BETWEEN d_from AND d_to;
INSERT INTO `{{project}}.{{dataset}}.daily_channels`
SELECT DATE(started_at), site, IFNULL(entry_channel, 'direct'), entry_source, entry_campaign,
  COUNT(DISTINCT visitor_key), COUNT(*), SUM(pageviews), COUNTIF(pageviews <= 1 AND interactions = 0)
FROM s GROUP BY 1, 2, 3, 4, 5;

DELETE FROM `{{project}}.{{dataset}}.daily_pages` WHERE day BETWEEN d_from AND d_to;
INSERT INTO `{{project}}.{{dataset}}.daily_pages`
WITH pv AS (
  SELECT DATE(ts) AS day, site, path, COUNT(*) AS pageviews, COUNT(DISTINCT visitor_key) AS visitors
  FROM se WHERE event = 'pageview' GROUP BY 1, 2, 3
),
eng AS (
  SELECT DATE(ts) AS day, site, path,
    AVG(SAFE_CAST(JSON_VALUE(props, '$.engaged_ms') AS FLOAT64)) / 1000 AS avg_engaged_sec,
    AVG(SAFE_CAST(JSON_VALUE(props, '$.scroll_pct') AS FLOAT64)) AS avg_scroll_pct
  FROM se WHERE event = 'page_exit' GROUP BY 1, 2, 3
),
ent AS (SELECT DATE(started_at) AS day, site, entry_path AS path, COUNT(*) AS entries FROM s GROUP BY 1, 2, 3),
ext AS (SELECT DATE(started_at) AS day, site, exit_path AS path, COUNT(*) AS exits FROM s GROUP BY 1, 2, 3)
SELECT pv.day, pv.site, pv.path, pv.pageviews, pv.visitors, IFNULL(ent.entries, 0), IFNULL(ext.exits, 0), eng.avg_engaged_sec, eng.avg_scroll_pct
FROM pv
LEFT JOIN eng USING (day, site, path)
LEFT JOIN ent USING (day, site, path)
LEFT JOIN ext USING (day, site, path);

DELETE FROM `{{project}}.{{dataset}}.daily_events` WHERE day BETWEEN d_from AND d_to;
INSERT INTO `{{project}}.{{dataset}}.daily_events`
SELECT DATE(ts), site, event, IFNULL(entry_channel, 'direct'), COUNT(*), COUNT(DISTINCT session_key), COUNT(DISTINCT user_id)
FROM se WHERE event NOT IN ('pageview', 'page_exit') GROUP BY 1, 2, 3, 4
UNION ALL
SELECT DATE(ts), site, event, 'server', COUNT(*), 0, COUNT(DISTINCT user_id)
FROM `{{project}}.{{dataset}}.events`
WHERE DATE(ts) BETWEEN d_from AND d_to AND via = 'server' AND event != 'error'
GROUP BY 1, 2, 3;

DELETE FROM `{{project}}.{{dataset}}.daily_errors` WHERE day BETWEEN d_from AND d_to;
INSERT INTO `{{project}}.{{dataset}}.daily_errors`
SELECT DATE(ts), site, via, JSON_VALUE(props, '$.message'), path, COUNT(*), COUNT(DISTINCT COALESCE(session_id, visitor_hash))
FROM `{{project}}.{{dataset}}.events`
WHERE DATE(ts) BETWEEN d_from AND d_to AND event = 'error' AND NOT is_bot
GROUP BY 1, 2, 3, 4, 5;

DELETE FROM `{{project}}.{{dataset}}.daily_bots` WHERE day BETWEEN d_from AND d_to;
INSERT INTO `{{project}}.{{dataset}}.daily_bots`
SELECT DATE(ts), site, bot_kind, bot_name, path, country, COUNT(*)
FROM `{{project}}.{{dataset}}.events`
WHERE DATE(ts) BETWEEN d_from AND d_to AND is_bot
GROUP BY 1, 2, 3, 4, 5, 6;

COMMIT TRANSACTION;
