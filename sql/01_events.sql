-- Raw events. One row per pageview, click, custom event, error or bot request.
-- Keep in sync with src/shared/schema.ts (EventRow).
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.events` (
  ts             TIMESTAMP NOT NULL,
  site           STRING    NOT NULL,
  event          STRING    NOT NULL,
  via            STRING    OPTIONS (description = "client | server | proxy"),
  visitor_hash   STRING    OPTIONS (description = "Cookieless id, rotates daily. Null for bots."),
  visitor_id     STRING    OPTIONS (description = "Persistent id, only with full consent"),
  session_id     STRING    OPTIONS (description = "Client session id, only with full consent"),
  user_id        STRING    OPTIONS (description = "Signed-in user id (client: full consent only; server events always)"),
  consent        STRING,
  host           STRING,
  path           STRING    OPTIONS (description = "Path without query string"),
  title          STRING,
  referrer_host  STRING,
  channel        STRING    OPTIONS (description = "ai | search | social | email | paid | campaign | referral | internal | direct"),
  source         STRING,
  utm_source     STRING,
  utm_medium     STRING,
  utm_campaign   STRING,
  utm_term       STRING,
  utm_content    STRING,
  country        STRING,
  region         STRING,
  device         STRING,
  browser        STRING,
  os             STRING,
  is_bot         BOOL      NOT NULL,
  bot_name       STRING,
  bot_kind       STRING    OPTIONS (description = "ai_training | ai_user | ai_search | search | social | seo | monitor | other"),
  user_agent     STRING    OPTIONS (description = "Raw UA, stored for bots only"),
  props          JSON
)
PARTITION BY DATE(ts)
CLUSTER BY site, event, channel
OPTIONS (
  description = "web-analytics raw events",
  partition_expiration_days = {{retention_days}}
);
