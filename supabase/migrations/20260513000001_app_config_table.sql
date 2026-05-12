-- Replace the `current_setting('app.supabase_functions_base_url')` pattern
-- introduced in PRs #137 + #138 with a `public.app_config` table.
--
-- Why: Supabase managed Postgres locks down `ALTER DATABASE … SET` for
-- arbitrary GUCs from the SQL Editor (the role lacks the `BYPASSRLS`-adjacent
-- privilege required to set restricted database-level parameters). That
-- meant the per-project bootstrap step from #137/#138 was unrunnable, and
-- every cron tick on dev started failing with
-- `unrecognized configuration parameter "app.supabase_functions_base_url"`.
--
-- The table-based pattern works inside Supabase's privilege model:
--   - `INSERT INTO public.app_config` is allowed from the SQL Editor
--     (which runs as the `postgres` role, owner of the public schema).
--   - `SECURITY DEFINER` on the read helper lets pg_cron jobs and
--     triggers fetch values regardless of which role they execute as.
--   - RLS-enabled but no policies → only `postgres` / `service_role`
--     can read directly. The helper function exposes a single value
--     each call site needs without leaking the whole config.

CREATE TABLE IF NOT EXISTS public.app_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  description text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.app_config IS
  'Per-project configuration values that pg_cron jobs and trigger functions read at execution time. Bootstrapped once per Supabase project via INSERT … ON CONFLICT after the migration applies. See docs/INFRASTRUCTURE.md "One-time per-project bootstrap".';

COMMENT ON COLUMN public.app_config.key IS
  'Stable identifier — e.g. supabase_functions_base_url.';

COMMENT ON COLUMN public.app_config.value IS
  'Raw string value. Callers concatenate / parse as needed.';

-- Read helper. SECURITY DEFINER so call sites (pg_cron commands running
-- as postgres, trigger functions executing under user roles) don't need
-- direct grants on the table. Returns NULL when the key is missing so
-- the caller's `NULL || '/sync-nav'` evaluates to NULL and `net.http_post`
-- fails loudly — the intended failure mode if the bootstrap was skipped.
CREATE OR REPLACE FUNCTION public.app_config_get(p_key text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT value FROM public.app_config WHERE key = p_key
$$;

COMMENT ON FUNCTION public.app_config_get(text) IS
  'Looks up a value from public.app_config. SECURITY DEFINER so pg_cron commands and SECURITY DEFINER triggers can read without per-role grants on the table.';

-- ─── Replace pg_cron commands ────────────────────────────────────────────────
-- Same idempotent unschedule pattern as PR #138. Each block drops the
-- existing job (using the wildcard delete by jobname so a missing job
-- is a no-op) then re-schedules with the new helper-function pattern.

-- sync-nav-hourly
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sync-nav-hourly';
SELECT cron.schedule(
  'sync-nav-hourly',
  '0 * * * 1-5',
  $$
  SELECT net.http_post(
    url := public.app_config_get('supabase_functions_base_url') || '/sync-nav',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- sync-index-hourly
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sync-index-hourly';
SELECT cron.schedule(
  'sync-index-hourly',
  '5 * * * 1-5',
  $$
  SELECT net.http_post(
    url := public.app_config_get('supabase_functions_base_url') || '/sync-index',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- sync-portfolio-composition-hourly
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sync-portfolio-composition-hourly';
SELECT cron.schedule(
  'sync-portfolio-composition-hourly',
  '10 * * * *',
  $$
  SELECT net.http_post(
    url     := public.app_config_get('supabase_functions_base_url') || '/sync-fund-portfolios',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- sync-fund-meta-daily
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sync-fund-meta-daily';
SELECT cron.schedule(
  'sync-fund-meta-daily',
  '0 2 * * *',
  $$
  SELECT net.http_post(
    url     := public.app_config_get('supabase_functions_base_url') || '/sync-fund-meta',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- regenerate-index-snapshots-daily (from PR #137)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'regenerate-index-snapshots-daily';
SELECT cron.schedule(
  'regenerate-index-snapshots-daily',
  '0 14 * * 1-5',
  $$
  SELECT net.http_post(
    url := public.app_config_get('supabase_functions_base_url') || '/regenerate-index-snapshots',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ─── Replace notify_feedback_inserted trigger function ───────────────────────
-- `CREATE OR REPLACE FUNCTION` keeps the existing trigger binding intact.
CREATE OR REPLACE FUNCTION public.notify_feedback_inserted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_url text := public.app_config_get('supabase_functions_base_url') || '/notify-feedback';
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
  -- This also catches the case where app_config has not been bootstrapped
  -- yet — the feedback row still lands; the founder can backfill from
  -- the table.
  RAISE WARNING 'notify_feedback_inserted: % %', SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_feedback_inserted() IS
  'Calls the notify-feedback edge function via pg_net so the founder gets an email when a user submits feedback. URL is read from public.app_config via app_config_get(), keeping the trigger free of per-environment hardcoding. Failure-tolerant: a notification error does not block the INSERT.';
