/**
 * Pure cache-freshness predicate for `scheme_master` metadata.
 *
 * Background. `sync-fund-meta` (cron) and `fetch-fund-snapshot`
 * (on-demand) both use `fund_meta_synced_at` as the cache key for
 * "did we sync this scheme recently?". Until this helper landed,
 * both bumped that timestamp on *any* successful update — including
 * the partial-success path where mfdata.in is unavailable but mfapi.in
 * still returns the ISIN. That bumped the TTL, locked the scheme into
 * `mfdata_family_id = null` for the full window (META_STALE_DAYS = 7),
 * and `fetch-fund-snapshot` then served `category_fallback`
 * compositions because no family_id meant no holdings to classify.
 *
 * Audit finding #6 (`docs/architecture/cache-surfaces.md`).
 *
 * Fix: a scheme is fresh only if both the timestamp is recent AND the
 * critical mfdata field (`mfdata_family_id`) is populated. If the
 * previous sync was a partial-success, retry rather than wait out the
 * TTL — even if mfdata is still down, we'll hit the same partial path
 * and the result is no worse, but if mfdata recovered the user gets
 * real composition data on the next call.
 */

export interface SchemeMetaCacheRow {
  fund_meta_synced_at: string | null;
  mfdata_family_id: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function isSchemeMetaFresh(
  row: SchemeMetaCacheRow | null | undefined,
  staleDays: number,
  now: number = Date.now(),
): boolean {
  if (!row || !row.fund_meta_synced_at) return false;
  // Partial-success guard: if the previous sync got mfapi-only (mfdata
  // unavailable), `mfdata_family_id` stays null. The fund is then
  // un-classifiable in `fetch-fund-snapshot`'s holdings path. Always
  // retry rather than serve a stale partial.
  if (row.mfdata_family_id == null) return false;
  const ageDays = (now - new Date(row.fund_meta_synced_at).getTime()) / MS_PER_DAY;
  return ageDays < staleDays;
}
