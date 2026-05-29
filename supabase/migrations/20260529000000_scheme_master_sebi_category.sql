-- Two-field category model for scheme_master.
--
-- Background
-- ==========
-- `scheme_master.scheme_category` has always been overloaded. AMFI / mfdata.in
-- return it inconsistently: for some funds it's a specific SEBI sub-bucket
-- ("Flexi Cap Fund"), but for a large slice of the universe — most of the DSP
-- lineup, chunks of HDFC / ICICI Prudential — it's the bare asset class
-- "Equity" / "Debt" / "Hybrid". CAS imports only ever set the broad class.
-- That ambiguity is what produced the "38/33/29 on every DSP equity fund" bug
-- (PR #188): getCategoryRules('Equity') fell through to a flexi-cap proxy.
--
-- PR #188 patched the *read* path by re-deriving the sub-bucket from
-- scheme_name on every call (deriveSchemeCategoryFromName). This migration
-- makes that resolution authoritative and persisted, so screens and the
-- composition pipeline can read a clean granular value directly:
--
--   scheme_category  →  broad asset class only: Equity | Debt | Hybrid | Other
--   sebi_category    →  granular SEBI sub-bucket: 'mid cap fund', 'liquid fund', …
--                       (lowercase canonical key matching CATEGORY_RULES)
--
-- The Compare screen compares on sebi_category; the Insights asset-mix groups
-- on scheme_category. The name parser stays in place as a read-time fallback
-- for funds that haven't been re-synced yet (sebi_category IS NULL).
--
-- Both columns are nullable + additive. The sync-fund-meta cron and
-- fetch-fund-snapshot edge function populate sebi_category (and normalise
-- scheme_category to broad) going forward; scripts/backfill-sebi-category.mjs
-- backfills the existing universe offline from scheme_name + scheme_category.

ALTER TABLE scheme_master
  ADD COLUMN IF NOT EXISTS sebi_category text;

COMMENT ON COLUMN scheme_master.sebi_category IS
  'Authoritative granular SEBI sub-bucket as a lowercase canonical key '
  '("mid cap fund", "flexi cap fund", "liquid fund", …) matching the keys in '
  'CATEGORY_RULES. Resolved from mfdata.category when specific, else derived '
  'from scheme_name (resolveSebiCategory in _shared/portfolio-utils.ts). NULL '
  'means no signal disambiguated the fund yet — read paths fall back to the '
  'name parser. Prefer this over scheme_category for like-for-like comparison.';

COMMENT ON COLUMN scheme_master.scheme_category IS
  'Broad asset class only: Equity | Debt | Hybrid | Other. For the granular '
  'SEBI sub-category use sebi_category. Historically this column was overloaded '
  'with both broad and granular values from inconsistent AMFI/mfdata feeds; the '
  'sync writers now normalise it to the broad class.';

-- B-tree for the Compare screen's same/different sub-category checks and any
-- future "find peers in this SEBI category" query.
CREATE INDEX IF NOT EXISTS idx_scheme_master_sebi_category
  ON scheme_master (sebi_category);

-- ---------------------------------------------------------------------------
-- Offline backfill — no network. Resolves sebi_category from the data already
-- in the row, mirroring resolveSebiCategory():
--   1. If scheme_category is already a specific (non-generic) value, lowercase
--      it as the sebi key.
--   2. Otherwise leave NULL here; scheme_name-based derivation is done by
--      scripts/backfill-sebi-category.mjs, which shares the exact pattern table
--      with the edge functions (kept in lock-step + unit-tested). Encoding that
--      ~40-pattern table in SQL would drift from the TS source of truth.
--
-- Step 1 is safe to run in SQL because it's a pure lowercase of an existing
-- specific value — no name heuristics involved.
-- ---------------------------------------------------------------------------
UPDATE scheme_master
SET sebi_category = lower(trim(scheme_category))
WHERE sebi_category IS NULL
  AND scheme_category IS NOT NULL
  AND lower(trim(scheme_category)) NOT IN ('equity', 'debt', 'hybrid', 'other', '');
