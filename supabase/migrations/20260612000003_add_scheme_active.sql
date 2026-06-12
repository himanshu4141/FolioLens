-- Add scheme_active boolean column to scheme_master.
-- This column tracks whether a scheme appeared in the AMFI NAVAll feed within
-- the last 30 days (true = active, false = wound-up/merged, null = not yet synced).
-- Null values allow honest representation of schemes pending first sync; they
-- sort last in picker queries (demoting unsynced schemes below confirmed inactive).

alter table scheme_master
add column scheme_active boolean;

comment on column scheme_master.scheme_active is
'true = appeared in AMFI NAVAll within 30d; false = wound-up/merged; null = not yet synced';

-- No index yet — evaluate if picker query patterns would benefit from it
-- (scheme_active DESC, scheme_name ASC is the new picker sort).
