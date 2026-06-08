-- Phase 3: drop dead scheme_master columns — morningstar_rating, related_variants.
--
-- morningstar_rating: the rating UI was removed in M5; no app reader remains.
-- related_variants: no app reader; was never surfaced beyond mfdata backfill.
-- Both are now dead cargo. OpenFolio-Data does not supply either field.
--
-- The `fund` view references both via sm.morningstar_rating / sm.related_variants.
-- Dropping the columns would leave the view broken; we must drop and recreate it.
-- CREATE OR REPLACE VIEW cannot remove columns — it can only append them — so we
-- use DROP + CREATE. DROP loses grants; they are reapplied immediately after.
-- The view is security_invoker = true — RLS on the underlying tables
-- (user_fund, scheme_master) still governs row access.
--
-- Client cache shape changes (useSchemeMaster select string loses morningstar_rating).
-- React Query __BUSTER__ bumped from v6 to v7 in the same Phase 3 commit.

-- 1. Drop and recreate the fund view without the two dead columns.
DROP VIEW IF EXISTS public.fund;
CREATE VIEW public.fund
WITH (security_invoker = true)
AS
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
  sm.mfdata_meta_synced_at
FROM user_fund uf
JOIN scheme_master sm USING (scheme_code);

-- 2. Restore grants that DROP VIEW erased
--    (mirrors 20260513000002_explicit_data_api_grants.sql lines 89, 109).
GRANT SELECT ON public.fund TO authenticated;
GRANT ALL    ON public.fund TO service_role;

-- 3. Drop the columns from scheme_master.
ALTER TABLE scheme_master
  DROP COLUMN IF EXISTS morningstar_rating,
  DROP COLUMN IF EXISTS related_variants;
