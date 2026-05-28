-- Replace the weekday-hourly sync-nav schedule (from 20260513000000) with a
-- bimodal "EOD-aware" schedule that polls mfapi.in more aggressively during
-- the window when AMCs actually publish NAVs, and lightly during the day.
--
-- Why: different AMCs release their EOD NAV at very different times — HDFC /
-- ICICI / DSP typically land in mfapi by 6-8 PM IST, while PPFAS and
-- international FoFs trickle in after 10 PM IST. The previous "top of every
-- hour, Mon-Fri only" schedule meant the 7 PM run caught the early houses
-- but the late ones (often the user's most-watched FoFs) had to wait until
-- the next 8 PM tick — and Saturday-morning corrections never got picked up
-- at all.
--
-- New schedule (cron in UTC):
--   - Hourly between 6 PM IST and 6 AM IST (UTC 12:30, 13:30, …, 23:30, 00:30)
--     → the EOD publish window for Indian AMCs + international FoFs.
--   - Every 2 hours between 8 AM IST and 5 PM IST (UTC 02:30, 04:30, 06:30,
--     08:30, 10:30) → idle daytime; catches late corrections without
--     burning compute.
--   - Every day (was Mon-Fri only) so a Friday-EOD NAV that lands Saturday
--     morning IST gets pulled instead of waiting until Monday.
--
-- Combined hours-of-day (all at :30 UTC) = 0, 2, 4, 6, 8, 10, 12, 13, 14,
-- 15, 16, 17, 18, 19, 20, 21, 22, 23. That's 18 invocations/day vs the
-- previous 24 weekday-only — fewer runs net, but they land where the data
-- actually moves.
--
-- `sync-nav` is already idempotent (upsert with ignoreDuplicates and a
-- net-delta counter in the local-cache sync), so re-runs against an
-- unchanged dataset are cheap; the only real cost is the mfapi fan-out.

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sync-nav-hourly';
SELECT cron.schedule(
  'sync-nav-hourly',
  '30 0,2,4,6,8,10,12,13,14,15,16,17,18,19,20,21,22,23 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_functions_base_url') || '/sync-nav',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
