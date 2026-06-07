-- OpenFolio metadata sync (FL-P4 / FL-P5): new scheme_master columns.
-- ter_date, fund_manager, portfolio_turnover come from OpenFolio's B1 fields.
-- openfolio_meta_synced_at is the freshness gate for the OpenFolio path in
-- isSchemeMetaFresh (distinct from fund_meta_synced_at / mfdata path).

ALTER TABLE scheme_master
  ADD COLUMN IF NOT EXISTS ter_date date,
  ADD COLUMN IF NOT EXISTS fund_manager text,
  ADD COLUMN IF NOT EXISTS portfolio_turnover numeric,
  ADD COLUMN IF NOT EXISTS openfolio_meta_synced_at timestamptz;
