-- Family-first picker: fund_family_search view (§6.5)
--
-- Returns one row per of_family_id, collapsing the ~8,347 plan/option
-- variants down to ~2,046 logical fund families. Each row carries:
--   - family_name / amc_name / sebi_category for display + search
--   - has_direct / has_regular / has_growth / has_idcw plan-availability flags
--     (used by the picker to label fallbacks, e.g. "Regular-only")
--   - representative_scheme_code — a fallback code when resolution fails
--   - family_active — true if ANY plan in the family is active (active families
--     rank ahead of matured/inactive ones)
--   - max_synced_at — most-recent openfolio_meta_synced_at in the family
--
-- Ordering within the aggregation: active > inactive > null, then most-recently
-- synced first, so the representative row is always the best-quality member.
--
-- Families without of_family_id (older registry shells, not yet backfilled) are
-- excluded. They continue to appear in the plan-level searchSchemes fallback that
-- the past-SIP and other single-select flows still use.
--
-- No RLS on the view — it inherits SELECT from scheme_master which is granted
-- to authenticated. We re-grant explicitly so the explicit-grant convention
-- in 20260513000002_explicit_data_api_grants.sql stays self-describing.

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
  BOOL_OR(option_type IN ('idcw_payout','idcw_reinvest','idcw',
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

-- Explicit grants: view is read-only catalog data; writes go via service_role.
GRANT SELECT ON public.v_fund_family_search TO authenticated;
GRANT SELECT ON public.v_fund_family_search TO service_role;
