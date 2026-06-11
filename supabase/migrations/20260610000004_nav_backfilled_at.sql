-- Adds nav_backfilled_at to scheme_master.
--
-- Stamped by fetch-fund-nav (and any successful demand-hydration) on every run
-- that confirms the scheme has current NAV data — both on a fresh fetch and on
-- a cache-hit (data ≤ FRESH_NAV_DAYS old).
--
-- The weekly nav-retention job uses this column as a retention signal:
-- a scheme whose nav_backfilled_at IS NULL (never demand-fetched) or is older
-- than 90 days AND is not held by any active user_fund is safe to prune from
-- nav_history.  Clearing that series reclaims storage while keeping the
-- "re-pick from fund-picker" path intact — the 1–2 s re-hydration spinner is
-- the explicit trade-off for the storage saving.

ALTER TABLE public.scheme_master
  ADD COLUMN IF NOT EXISTS nav_backfilled_at timestamptz;

COMMENT ON COLUMN public.scheme_master.nav_backfilled_at IS
  'Last timestamp at which NAV history was successfully confirmed present for this scheme — stamped by fetch-fund-nav on every cache-hit or successful upsert. NULL means the scheme has never been demand-fetched. Used by the weekly nav-retention cron to identify series that are safe to prune: pruneable when NOT in any active user_fund AND (nav_backfilled_at IS NULL OR nav_backfilled_at < now() - interval ''90 days'').';
