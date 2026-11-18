-- Views over the daily tables. Run once by setup (not by the hourly scheduled query).

-- AI visibility per day, site and path: how often AI crawlers and assistants fetch a page
-- next to how many people an AI assistant sent there. robots.txt and llms.txt show up as
-- their own paths (path_type tells them apart from pages).
CREATE OR REPLACE VIEW `{{project}}.{{dataset}}.ai_visibility` AS
WITH bots AS (
  SELECT day, site, path,
    SUM(requests) AS ai_bot_requests,
    SUM(IF(bot_kind = 'ai_training', requests, 0)) AS ai_training_requests,
    SUM(IF(bot_kind = 'ai_search', requests, 0)) AS ai_search_requests,
    SUM(IF(bot_kind = 'ai_user', requests, 0)) AS ai_user_fetches
  FROM `{{project}}.{{dataset}}.daily_bots`
  WHERE bot_kind IN ('ai_training', 'ai_search', 'ai_user')
  GROUP BY day, site, path
),
refs AS (
  SELECT day, site, path, visitors AS ai_referred_visitors, sessions AS ai_referred_sessions
  FROM `{{project}}.{{dataset}}.daily_ai_referrals`
)
SELECT
  day, site, path,
  CASE
    WHEN path = '/robots.txt' THEN 'robots.txt'
    WHEN path IN ('/llms.txt', '/llms-full.txt') THEN 'llms.txt'
    WHEN STARTS_WITH(path, '/sitemap') AND ENDS_WITH(path, '.xml') THEN 'sitemap'
    ELSE 'page'
  END AS path_type,
  IFNULL(ai_bot_requests, 0) AS ai_bot_requests,
  IFNULL(ai_training_requests, 0) AS ai_training_requests,
  IFNULL(ai_search_requests, 0) AS ai_search_requests,
  IFNULL(ai_user_fetches, 0) AS ai_user_fetches,
  IFNULL(ai_referred_visitors, 0) AS ai_referred_visitors,
  IFNULL(ai_referred_sessions, 0) AS ai_referred_sessions
FROM bots FULL OUTER JOIN refs USING (day, site, path);
