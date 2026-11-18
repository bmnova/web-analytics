-- Health check, run as its own scheduled query. Fails (and BigQuery Data Transfer emails the
-- owner) when no human event has arrived in the last {{stale_hours}} hours: the tracker, the
-- proxy or the writer key is probably broken.
-- Written as a script (DECLARE first): a scheduled query that is a single SELECT needs a
-- destination table, a script does not.
DECLARE human_events INT64 DEFAULT (
  SELECT COUNT(*)
  FROM `{{project}}.{{dataset}}.events`
  WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {{stale_hours}} HOUR)
    AND is_bot = FALSE
);

SELECT IF(
  human_events = 0,
  ERROR(CONCAT('web-analytics: no human events in `{{project}}.{{dataset}}.events` for {{stale_hours}} hours (since ',
    FORMAT_TIMESTAMP('%F %T UTC', TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {{stale_hours}} HOUR)), ')')),
  CONCAT('ok: ', CAST(human_events AS STRING), ' human events in the last {{stale_hours}} hours')
) AS status;
