-- OpenFolio-Data becomes the primary holdings source for
-- `fund_portfolio_composition`. This migration adds the provenance the
-- official source carries and schedules the monthly bulk sync.
--
-- See docs/plans/openfolio-holdings-integration.md (Milestones 1 + 3).
--
-- Source ladder after this change (highest wins):
--   'official'         — OpenFolio-Data REST API (parsed AMC disclosures)
--   'amfi'             — mfdata.in holdings (enrichment / backup)
--   'category_fallback'— holdings disclosed but classifier coverage was zero
--   'category_rules'   — SEBI category approximation (last resort)
--
-- The `source` column is free-text (no enum / CHECK constraint), so allowing
-- a new value requires no DDL on the column itself — only the documentation
-- and the read/write precedence in application code. The UNIQUE
-- (scheme_code, portfolio_date, source) key already lets an 'official' row
-- coexist with 'amfi' / 'category_rules' rows for the same scheme + month.

-- ─── 1. Provenance columns (idempotent) ──────────────────────────────────────
-- Both nullable: only 'official' rows populate them; existing 'amfi' /
-- 'category_rules' rows keep them NULL. `portfolio_date` continues to carry
-- the month-end date; `disclosure_date` carries the OpenFolio snapshot's
-- declared disclosure date (the same calendar date in practice, stored
-- explicitly so provenance survives even if portfolio_date semantics change).
ALTER TABLE public.fund_portfolio_composition
  ADD COLUMN IF NOT EXISTS source_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS disclosure_date DATE NULL;

COMMENT ON COLUMN public.fund_portfolio_composition.source_url IS
  'Provenance URL for source=''official'' rows — the AMC portfolio-disclosure '
  'document OpenFolio-Data parsed. NULL for amfi / category_rules rows.';

COMMENT ON COLUMN public.fund_portfolio_composition.disclosure_date IS
  'Disclosure date reported by OpenFolio-Data for source=''official'' rows. '
  'NULL for amfi / category_rules rows.';

COMMENT ON COLUMN public.fund_portfolio_composition.source IS
  'Holdings provenance, highest precedence first: '
  '''official'' (OpenFolio-Data parsed AMC disclosures) > '
  '''amfi'' (mfdata.in holdings) > '
  '''category_fallback'' (holdings disclosed, classifier coverage zero) > '
  '''category_rules'' (SEBI category approximation).';

-- No new GRANTs: this migration only adds columns to an already-exposed table
-- (see 20260513000002_explicit_data_api_grants.sql — SELECT to authenticated,
-- ALL to service_role). Columns inherit the table's grants. No new object,
-- no FK, no RLS change.

-- ─── 2. Monthly OpenFolio bulk-sync cron ─────────────────────────────────────
-- OpenFolio-Data ingests AMC disclosures around the 13th of each month, so we
-- run the FolioLens bulk sync on the 15th to pick up the fresh snapshots.
-- Mirrors the established cron→HTTP pattern (no business logic in SQL): the
-- schedule just POSTs the `openfolio-sync` edge function, which does the work.
--
-- Schedule: 15th of every month at 01:30 UTC (07:00 IST). Avoids the daily
-- NAV/meta windows and the monthly stock-market-cap seed (1st @ 00:30 UTC).
--
-- URL is read from public.app_config_get('supabase_functions_base_url') so the
-- same migration targets dev and prod without per-environment patching
-- (see docs/INFRASTRUCTURE.md → "One-time per-project bootstrap").
--
-- Idempotent unschedule: looking up jobid first means a missing job is a
-- no-op (the named-argument cron.unschedule raises when the job is absent).
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'openfolio-composition-monthly';
SELECT cron.schedule(
  'openfolio-composition-monthly',
  '30 1 15 * *',
  $$
  SELECT net.http_post(
    url     := public.app_config_get('supabase_functions_base_url') || '/openfolio-sync',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{"mode": "monthly"}'::jsonb
  );
  $$
);
