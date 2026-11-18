-- Health check, run as its own scheduled query. Fails (and BigQuery Data Transfer emails the
-- owner) when no human event has arrived in the last {{stale_hours}} hours: the tracker, the
-- proxy or the writer key is probably broken.
SELECT IF(
  COUNT(*) = 0,
  ERROR(CONCAT('web-analytics: no human events in `{{project}}.{{dataset}}.events` for {{stale_hours}} hours (since ',
    FORMAT_TIMESTAMP('%F %T UTC', TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {{stale_hours}} HOUR)), ')')),
  CONCAT('ok: ', CAST(COUNT(*) AS STRING), ' human events in the last {{stale_hours}} hours')
) AS status
FROM `{{project}}.{{dataset}}.events`
WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {{stale_hours}} HOUR)
  AND is_bot = FALSE;
