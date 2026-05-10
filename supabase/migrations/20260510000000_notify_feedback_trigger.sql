-- Founder-notification relay for new user_feedback rows.
--
-- AFTER INSERT trigger fires `pg_net.http_post` to the `notify-feedback`
-- edge function, which sends an email to FEEDBACK_NOTIFICATION_EMAIL via
-- Resend. Failure mode is fire-and-forget — if the edge function or Resend
-- is down the row still lands; the function logs and the founder can
-- backfill from the table.
--
-- Edge function MUST be deployed with `--no-verify-jwt` so the trigger
-- (running as the DB user) can call without an Authorization header,
-- matching the pattern used by `sync-nav-daily` / `sync-index-daily`.

CREATE OR REPLACE FUNCTION public.notify_feedback_inserted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Hardcoded dev project URL, matching the convention used by every other
  -- pg_net cron migration in this repo (sync-nav-daily, sync-index-daily,
  -- portfolio_insights_cron, fund_meta_daily_cron). When promoting to prod
  -- the URL needs a search-and-replace, same as those.
  v_url text := 'https://imkgazlrxtlhkfptkzjc.supabase.co/functions/v1/notify-feedback';
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
  -- pg_net itself is async, but the URL build / json conversion above is
  -- synchronous, so this guard catches cases where the extension is
  -- missing or misconfigured.
  RAISE WARNING 'notify_feedback_inserted: % %', SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_feedback_notify_after_insert ON public.user_feedback;

CREATE TRIGGER user_feedback_notify_after_insert
  AFTER INSERT ON public.user_feedback
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_feedback_inserted();

COMMENT ON FUNCTION public.notify_feedback_inserted() IS
  'Calls the notify-feedback edge function via pg_net so the founder gets an email when a user submits feedback. Failure-tolerant: a notification error does not block the INSERT.';
