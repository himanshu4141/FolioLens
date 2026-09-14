-- M2.2b (docs/plans/amfi-nav-format-change.md): expose scheme_master's
-- authoritative plan_type/option_type/family_name through the `fund` view so
-- held-fund screens (FundCard, ClearLensFundsScreen, usePortfolioInsights)
-- can read the DB columns directly instead of only ever regex-parsing the
-- scheme name. Additive columns only — every existing `.select('id, ...')`
-- caller that doesn't name these columns is unaffected; readers still using
-- parseFundName()/shortSchemeName() as their input source see no behaviour
-- change until they're updated to prefer the new columns.

CREATE OR REPLACE VIEW public.fund
WITH (security_invoker = true) AS
SELECT
  uf.id,
  uf.user_id,
  uf.scheme_code,
  sm.scheme_name,
  sm.scheme_category,
  sm.benchmark_index,
  sm.benchmark_index_symbol,
  uf.is_active,
  uf.created_at,
  uf.updated_at,
  sm.isin,
  sm.expense_ratio,
  sm.aum_cr,
  sm.min_sip_amount,
  sm.fund_meta_synced_at,
  sm.mfdata_family_id,
  sm.declared_benchmark_name,
  sm.risk_label,
  sm.mfdata_meta_synced_at,
  sm.scheme_active,
  sm.family_name,
  sm.plan_type,
  sm.option_type
FROM public.user_fund uf
JOIN public.scheme_master sm USING (scheme_code);

-- Restore the grants that were on the previous version of the view (view
-- replacement does not always preserve them across all Postgres versions —
-- 20260613000001 stated the same caution and re-granted explicitly).
GRANT SELECT ON public.fund TO authenticated;
GRANT SELECT ON public.fund TO service_role;
