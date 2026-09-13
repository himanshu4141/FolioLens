-- M2.0 (docs/plans/amfi-nav-format-change.md): provenance for plan_type /
-- option_type, and a bug fix for v_fund_family_search.has_idcw.
--
-- 1. plan_option_source records where plan_type/option_type came from:
--    'amfi'   — OpenFolio, sourced from AMFI's own Plan/Option columns
--               (authoritative, post AMFI NAV feed format change)
--    'name'   — inferred from a scheme/mfapi name by regex (seed-scheme-master
--               bootstrap, or the last-resort fallback in client helpers)
--    'mfdata' — filled by the mfdata fallback path in sync-fund-meta
--    'mixed'  — OpenFolio (#83): plan_type from one source, option_type from
--               another (e.g. plan from AMFI's column, option from name
--               inference). Not 'amfi' — never blocks or is protected by the
--               precedence rule below, by construction.
--    NULL     — not yet classified (pre-M2 rows; backfilled over time by
--               universe-backfill / sync-fund-meta)
--
-- 2. v_fund_family_search.has_idcw only matched the values FolioLens's own
--    detectPlanType regex used to write ('idcw_payout', 'idcw_reinvest', …).
--    OpenFolio's option_type enum uses 'reinvest' / 'payout' / 'bonus' / 'idcw'
--    — none of those matched, so every family whose only IDCW plan came from
--    OpenFolio silently showed as IDCW-less. Recreating the view widens the
--    IN-list to cover both vocabularies.

ALTER TABLE scheme_master
  ADD COLUMN IF NOT EXISTS plan_option_source text;

COMMENT ON COLUMN scheme_master.plan_option_source IS
  'Provenance of plan_type/option_type: amfi (OpenFolio, AMFI Plan/Option columns) | '
  'name (regex inference from a scheme/mfapi name) | mfdata (mfdata fallback) | '
  'mixed (OpenFolio: plan_type and option_type from different sources). '
  'NULL = not yet classified. An amfi value is never overwritten by name/mfdata/mixed.';

CREATE OR REPLACE VIEW v_fund_family_search AS
SELECT
  of_family_id,

  -- Representative family-level fields: pick from the best plan row
  -- (active first, then most recently synced).
  (
    ARRAY_AGG(family_name ORDER BY
      CASE WHEN scheme_active = TRUE THEN 0
           WHEN scheme_active = FALSE THEN 1
           ELSE 2 END,
      openfolio_meta_synced_at DESC NULLS LAST
    )
  )[1] AS family_name,

  (
    ARRAY_AGG(amc_name ORDER BY
      CASE WHEN scheme_active = TRUE THEN 0
           WHEN scheme_active = FALSE THEN 1
           ELSE 2 END,
      openfolio_meta_synced_at DESC NULLS LAST
    )
  )[1] AS amc_name,

  (
    ARRAY_AGG(sebi_category ORDER BY
      CASE WHEN scheme_active = TRUE THEN 0
           WHEN scheme_active = FALSE THEN 1
           ELSE 2 END,
      openfolio_meta_synced_at DESC NULLS LAST
    )
  )[1] AS sebi_category,

  (
    ARRAY_AGG(scheme_category ORDER BY
      CASE WHEN scheme_active = TRUE THEN 0
           WHEN scheme_active = FALSE THEN 1
           ELSE 2 END,
      openfolio_meta_synced_at DESC NULLS LAST
    )
  )[1] AS scheme_category,

  -- Plan availability flags (used by picker to label fallbacks).
  BOOL_OR(plan_type = 'direct')                                                          AS has_direct,
  BOOL_OR(plan_type = 'regular')                                                         AS has_regular,
  BOOL_OR(option_type = 'growth')                                                        AS has_growth,
  -- Widened to cover both OpenFolio's option_type vocabulary ('idcw', 'reinvest',
  -- 'payout', 'bonus') and the legacy name-regex vocabulary ('idcw_payout',
  -- 'idcw_reinvest', 'dividend_payout', 'dividend_reinvest') — see header.
  BOOL_OR(option_type IN ('idcw','reinvest','payout','bonus',
                           'idcw_payout','idcw_reinvest',
                           'dividend_payout','dividend_reinvest'))                        AS has_idcw,

  -- Representative scheme_code — best-quality plan; used as last-resort fallback.
  (
    ARRAY_AGG(scheme_code ORDER BY
      CASE WHEN scheme_active = TRUE THEN 0
           WHEN scheme_active = FALSE THEN 1
           ELSE 2 END,
      openfolio_meta_synced_at DESC NULLS LAST
    )
  )[1] AS representative_scheme_code,

  -- Family-level activity / freshness signals for the FL13 ranking rule:
  -- active families surface above matured ones, enriched above unseen.
  BOOL_OR(scheme_active = TRUE)         AS family_active,
  MAX(openfolio_meta_synced_at)         AS max_synced_at

FROM scheme_master
WHERE of_family_id IS NOT NULL
GROUP BY of_family_id;

-- Re-grant per 20260513000002_explicit_data_api_grants.sql: CREATE OR REPLACE
-- VIEW preserves existing grants in Postgres, but re-stating them keeps this
-- migration self-describing per that migration's stated convention.
GRANT SELECT ON public.v_fund_family_search TO authenticated;
GRANT SELECT ON public.v_fund_family_search TO service_role;
