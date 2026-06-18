-- Add of_family_id to scheme_master: the OpenFolio family identity key
-- (e.g. "OF-1a2b3c4d5e6f"). Distinct from mfdata_family_id (integer).
-- family_name, plan_type, option_type already exist (20260509000000); this
-- migration only adds the new column + index, then the metadata writers
-- (universe-backfill + sync-fund-meta) populate all four OF fields.

ALTER TABLE scheme_master
  ADD COLUMN IF NOT EXISTS of_family_id text;

CREATE INDEX IF NOT EXISTS idx_scheme_master_of_family_id
  ON scheme_master (of_family_id);

COMMENT ON COLUMN scheme_master.of_family_id IS
  'OpenFolio family identity key (e.g. "OF-1a2b3c4d5e6f"). Groups all plan/option '
  'variants that share the same portfolio. Distinct from mfdata_family_id (integer). '
  'Written by universe-backfill (metadata phase) and sync-fund-meta (OF leg).';
