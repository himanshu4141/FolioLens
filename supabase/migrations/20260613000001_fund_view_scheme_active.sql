-- Expose scheme_master.scheme_active through the fund view so the client
-- can detect matured/wound-up schemes without a second round-trip.
--
-- scheme_active semantics (from OpenFolio / universe-backfill):
--   true  = active in AMFI NAVAll within last 30 days
--   false = wound-up / merged / matured
--   null  = not yet synced with OpenFolio (safe default: unknown)
--
-- The FMPs named "Mat Dt.DD-Mon-YYYY" often have scheme_active = null
-- because OpenFolio doesn't index them; client-side detection falls back
-- to the name pattern.
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
  sm.scheme_active
FROM public.user_fund uf
JOIN public.scheme_master sm USING (scheme_code);

-- Restore the grants that were on the previous version of the view.
GRANT SELECT ON public.fund TO authenticated;
