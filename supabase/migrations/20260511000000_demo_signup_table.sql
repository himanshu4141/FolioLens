-- Demo / early-access signup capture for the in-app "Preview the app" gate.
--
-- Separate from the marketing site waitlist (which lives in Tally today and
-- may move to public.waitlist_signup later per
-- foliolens-site/supabase-waitlist-endpoint-guide.md). This table is the
-- list of people who entered the preview from inside the app — their email,
-- whether they consented to marketing emails, and the UTM / referrer
-- attribution at the moment of submission.
--
-- Public writes go ONLY through the `demo-signup` edge function (deployed
-- --no-verify-jwt), never directly from the client. No public RLS policy
-- means a leaked anon key cannot insert here.

CREATE TABLE IF NOT EXISTS public.demo_signup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  email text NOT NULL,
  marketing_consent boolean NOT NULL DEFAULT false,

  source text NOT NULL DEFAULT 'app_preview',
  -- Status mirrors waitlist_signup convention so a future merge into one
  -- list is straightforward. Free-text on purpose — admin workflow only.
  status text NOT NULL DEFAULT 'new',

  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,

  page_url text,
  referrer text,

  ip_address text,
  user_agent text,

  -- How many times this email re-submitted (idempotent re-entry).
  signup_count integer NOT NULL DEFAULT 1,
  last_seen_at timestamptz NOT NULL DEFAULT now(),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT demo_signup_email_format
    CHECK (email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),

  CONSTRAINT demo_signup_email_unique UNIQUE (email)
);

-- Index for status-filtered admin queries ("show me new signups not yet invited").
CREATE INDEX IF NOT EXISTS demo_signup_status_created_idx
  ON public.demo_signup (status, created_at DESC);

-- Index for "find by email" lookups from the edge function on re-submit.
CREATE INDEX IF NOT EXISTS demo_signup_email_idx ON public.demo_signup (lower(email));

-- updated_at touch trigger.
CREATE OR REPLACE FUNCTION public.demo_signup_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS demo_signup_set_updated_at ON public.demo_signup;
CREATE TRIGGER demo_signup_set_updated_at
  BEFORE UPDATE ON public.demo_signup
  FOR EACH ROW
  EXECUTE FUNCTION public.demo_signup_set_updated_at();

-- RLS on; no public insert / select / update / delete policies. The edge
-- function uses the service role key and bypasses RLS.
ALTER TABLE public.demo_signup ENABLE ROW LEVEL SECURITY;

-- Explicit service_role grant: belt-and-suspenders against a future REVOKE
-- on service_role's implicit grants (mirrors the convention from
-- 20260513000002_explicit_data_api_grants.sql). No anon / authenticated
-- grants on purpose — this table is service-role-only and intentionally
-- outside the Data API surface; the demo-signup edge function (running
-- under the service role) is the only writer.
GRANT ALL ON public.demo_signup TO service_role;

COMMENT ON TABLE public.demo_signup IS
  'In-app demo / early-access signups. Captured via demo-signup edge function. Separate from marketing-site waitlist.';
