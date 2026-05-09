-- Allow scheme_category to be NULL on scheme_master.
--
-- The original migration (20260423030000_shared_scheme_catalog.sql) enforced
-- NOT NULL because all rows came from existing user_fund holdings, which had a
-- category string. The Compare Funds deep-redesign (M3v2) seeds scheme_master
-- with the broader AMFI scheme universe (~12k rows) from mfapi.in, which
-- returns scheme_code + scheme_name only. Category is backfilled by
-- sync-fund-meta from mfdata.in on the next pass for any scheme that gets
-- touched.
--
-- Existing rows keep their non-null category.

ALTER TABLE scheme_master
  ALTER COLUMN scheme_category DROP NOT NULL;
