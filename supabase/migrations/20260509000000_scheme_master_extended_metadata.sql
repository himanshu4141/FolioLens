-- Extended scheme metadata for the Compare Funds deep-redesign (M3v2).
--
-- Adds nine new columns + two JSONB blobs to scheme_master so we can persist
-- the metadata MFData already returns but we currently throw away:
--
--  - launch_date            scheme inception date (drives "fund age" UI)
--  - exit_load              raw label from MFData ("-", "1.00%", "1.00 (1y)")
--  - min_lumpsum            ₹ minimum first investment
--  - min_additional         ₹ minimum subsequent investment
--  - plan_type              'direct' | 'regular' | null
--  - option_type            'growth' | 'idcw_payout' | 'idcw_reinvest' | etc.
--  - family_name            scheme family label (e.g. "HDFC Flexi Cap Fund")
--  - amc_name               AMC label (e.g. "HDFC Mutual Fund")
--  - amc_slug               AMC slug (URL-safe id)
--  - period_returns jsonb   { return_1m, return_3m, ..., return_inception, rank_* }
--  - risk_ratios jsonb      MFData's `ratios` block — { valuation, efficiency, returns, risk, category_averages }
--
-- All new columns are nullable + additive. No backfill required — the daily
-- sync-fund-meta cron populates them on its next pass.
--
-- Per the MFData accuracy comparison (docs/research/mfdata-accuracy-comparison.md):
-- the JSONB blobs are stored as-received but the screen does NOT surface them
-- verbatim — see src/utils/mfdataGuards.ts for the category gating and
-- composition guards we apply at read time.

ALTER TABLE scheme_master
  ADD COLUMN IF NOT EXISTS launch_date     date,
  ADD COLUMN IF NOT EXISTS exit_load       text,
  ADD COLUMN IF NOT EXISTS min_lumpsum     integer,
  ADD COLUMN IF NOT EXISTS min_additional  integer,
  ADD COLUMN IF NOT EXISTS plan_type       text,
  ADD COLUMN IF NOT EXISTS option_type     text,
  ADD COLUMN IF NOT EXISTS family_name     text,
  ADD COLUMN IF NOT EXISTS amc_name        text,
  ADD COLUMN IF NOT EXISTS amc_slug        text,
  ADD COLUMN IF NOT EXISTS period_returns  jsonb,
  ADD COLUMN IF NOT EXISTS risk_ratios     jsonb;

COMMENT ON COLUMN scheme_master.launch_date IS
  'Scheme inception date from MFData. NB: for direct-plan AMFI codes this is '
  'often 2013-01-01 (SEBI direct-plan introduction date) rather than the real '
  'fund inception — the UI labels these as "Direct plan since" not "Fund inception".';

COMMENT ON COLUMN scheme_master.exit_load IS
  'Raw exit-load label from MFData. Labels vary: "-", "1.00", "1.00 (1y)". '
  'Surface verbatim; no parsing.';

COMMENT ON COLUMN scheme_master.period_returns IS
  'MFData returns block — { as_of_date, return_1m, return_3m, return_6m, '
  'return_1y, return_3y, return_5y, return_inception, rank_* }. Stored as-received. '
  'Returns 1Y/3Y/5Y are stale by 1-3pp on average; the UI prefers locally-computed '
  'CAGR from nav_history when available.';

COMMENT ON COLUMN scheme_master.risk_ratios IS
  'MFData ratios block — { valuation, efficiency, returns, risk, category_averages }. '
  'Stored as-received. Sharpe/Sortino/Alpha appear to use a 1Y window where Indian '
  'equities trail the risk-free rate, producing sign-flipped values vs the standard '
  '3Y window. The UI computes Sharpe/Sortino/Std dev locally from monthly returns; '
  'only beta and r_squared are surfaced from this blob, and only for equity/hybrid '
  'categories (debt funds get equity-style ratios applied blindly).';

-- Trigram index for fast ilike search in the universal fund picker.
-- 5K+ schemes × ilike on scheme_name is OK without this; the index becomes
-- meaningful once scheme_master is seeded broadly.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_scheme_master_name_trgm
  ON scheme_master USING gin (scheme_name gin_trgm_ops);

-- B-tree on amc_name for filter-chip queries.
CREATE INDEX IF NOT EXISTS idx_scheme_master_amc_name
  ON scheme_master (amc_name);

-- Recreate the `fund` view so it keeps surfacing the same columns existing
-- callers depend on. New columns are NOT added to the view — they're consumed
-- directly via scheme_master in the Compare/FundDetail screens. Existing
-- callers stay on the view.
-- (The view definition lives in 20260423030000_shared_scheme_catalog.sql; the
-- ALTER TABLE above doesn't break it because the view selects specific columns.)
