-- Retrofit every pre-M5 pg_net.http_post site to read its target URL from
-- `current_setting('app.supabase_functions_base_url')` instead of the
-- hardcoded dev project ref.
--
-- The previous migrations (20260319, 20260320, 20260420, 20260428, 20260510)
-- all baked the dev URL `imkgazlrxtlhkfptkzjc.supabase.co` directly into
-- their cron commands and trigger function. Applied to prod via
-- `supabase db push`, those would have caused prod's pg_cron to call the
-- dev project's edge functions — a latent bug that pre-dated PR #137.
--
-- This migration is idempotent: `cron.unschedule(text)` returns FALSE on
-- a missing job (instead of erroring) and `CREATE OR REPLACE FUNCTION`
-- handles the trigger side. Run safely on:
--   - a project that already has dev-URL schedules (replaces them in place)
--   - a project with no existing schedules (creates them parameterised)
--   - a project that already ran this migration (no-op + idempotent re-create)
--
-- Per-project bootstrap requirement — once per Supabase project, via the
-- Dashboard SQL Editor:
--
--   ALTER DATABASE postgres
--     SET app.supabase_functions_base_url =
--         'https://<project-ref>.supabase.co/functions/v1';
--
-- If the setting is missing, cron jobs and the trigger fail loudly at
-- execution time with "unrecognized configuration parameter" — the
-- intended failure mode, since silently calling the wrong project's edge
-- function is worse than failing loudly.
--
-- See `docs/INFRASTRUCTURE.md` → "One-time per-project bootstrap" for the
-- full bootstrap procedure.

-- ─── sync-nav-hourly ─────────────────────────────────────────────────────────
-- Schedule preserved from 20260320000000_update_sync_schedules_hourly.sql
-- Idempotent unschedule: the named-argument form of cron.unschedule
-- raises when the job isn't found. Looking up the job-id first means
-- "no row found" → no rows to delete → safe no-op on fresh projects.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sync-nav-hourly';
SELECT cron.schedule(
  'sync-nav-hourly',
  '0 * * * 1-5',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_functions_base_url') || '/sync-nav',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ─── sync-index-hourly ───────────────────────────────────────────────────────
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sync-index-hourly';
SELECT cron.schedule(
  'sync-index-hourly',
  '5 * * * 1-5',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_functions_base_url') || '/sync-index',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ─── sync-portfolio-composition-hourly ───────────────────────────────────────
-- Schedule preserved from 20260420000001_portfolio_insights_cron.sql
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sync-portfolio-composition-hourly';
SELECT cron.schedule(
  'sync-portfolio-composition-hourly',
  '10 * * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.supabase_functions_base_url') || '/sync-fund-portfolios',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- ─── sync-fund-meta-daily ────────────────────────────────────────────────────
-- Schedule preserved from 20260428000000_fund_meta_daily_cron.sql
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sync-fund-meta-daily';
SELECT cron.schedule(
  'sync-fund-meta-daily',
  '0 2 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.supabase_functions_base_url') || '/sync-fund-meta',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- ─── notify_feedback_inserted trigger function ───────────────────────────────
-- `CREATE OR REPLACE FUNCTION` keeps the existing trigger binding intact —
-- only the body's URL construction changes. The trigger
-- (`user_feedback_notify_after_insert` on `public.user_feedback`) stays
-- bound to this function by name.
CREATE OR REPLACE FUNCTION public.notify_feedback_inserted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text := current_setting('app.supabase_functions_base_url') || '/notify-feedback';
BEGIN
  PERFORM net.http_post(
    url := v_url,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object(
      'feedback_id', NEW.id,
      'user_id', NEW.user_id,
      'type', NEW.type,
      'title', NEW.title,
      'body', NEW.body,
      'app_version', NEW.app_version,
      'update_id', NEW.update_id,
      'created_at', NEW.created_at
    )
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never break the user-facing INSERT because of a notification failure.
  -- This also catches `unrecognized configuration parameter` when the
  -- bootstrap step hasn't been applied yet — the feedback row still
  -- lands; the founder can backfill from the table.
  RAISE WARNING 'notify_feedback_inserted: % %', SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_feedback_inserted() IS
  'Calls the notify-feedback edge function via pg_net so the founder gets an email when a user submits feedback. URL is read from `current_setting(''app.supabase_functions_base_url'')` so dev and prod use their own projects without per-environment migration patching. Failure-tolerant: a notification error does not block the INSERT.';
