/**
 * Pure helpers for normalising and merging scheme_master.period_returns blobs.
 *
 * The column holds two shapes in the wild:
 *   OpenFolio writers — { ret_1y: 0.125, ret_3y: 0.15, ret_5y: 0.09, ret_incep: 0.18 }
 *                       (decimal CAGR)
 *   mfdata backup leg — { return_1y: 12.5, rank_1y: 3, as_of_date: "2026-05-31", … }
 *                       (percentage points + ranks + date)
 *
 * Normalise at write: always convert mfdata percent → canonical decimal keys,
 * then MERGE into the existing blob so no horizons are lost when the two
 * sources write in either order.
 *
 * 29 legacy mfdata-shape rows exist on dev (as of 2026-06-10); readReturnPct
 * in src/utils/mfdataGuards.ts keeps dual-shape read support for them.
 */

/** Maps mfdata percent-key → canonical decimal-key. */
const MFDATA_RETURN_KEY_MAP: Record<string, string> = {
  return_1m: 'ret_1m',
  return_3m: 'ret_3m',
  return_6m: 'ret_6m',
  return_1y: 'ret_1y',
  return_3y: 'ret_3y',
  return_5y: 'ret_5y',
  return_inception: 'ret_incep',
};

/** mfdata keys copied through unchanged (ranks + date). */
const MFDATA_PASSTHROUGH_KEYS = [
  'rank_1m', 'rank_3m', 'rank_6m',
  'rank_1y', 'rank_3y', 'rank_5y',
  'as_of_date',
] as const;

/**
 * Convert mfdata percent-format returns to canonical decimal keys, then merge
 * with the existing blob. The existing blob wins for any overlapping key —
 * this preserves OF's authoritative values (ret_1y/3y/5y/incep) when mfdata
 * is writing additional horizons (1m/3m/6m/ranks/as_of_date) that OF doesn't
 * supply.
 *
 * Returns the merged canonical blob, or null when both inputs are null/empty.
 */
export function mergeMfdataReturns(
  mfdataReturns: Record<string, unknown> | null | undefined,
  existingBlob: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};

  // Lay in mfdata's converted values (percent → decimal)
  if (mfdataReturns && typeof mfdataReturns === 'object') {
    for (const [mfKey, canonKey] of Object.entries(MFDATA_RETURN_KEY_MAP)) {
      const v = mfdataReturns[mfKey];
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[canonKey] = v / 100;
      }
    }
    for (const key of MFDATA_PASSTHROUGH_KEYS) {
      const v = mfdataReturns[key];
      if (v != null) out[key] = v;
    }
  }

  // Overlay existing blob — existing values win for any key already present
  if (existingBlob && typeof existingBlob === 'object') {
    for (const [k, v] of Object.entries(existingBlob)) {
      if (v != null) out[k] = v;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Merge OpenFolio returns into an existing period_returns blob. OF values win
 * for overlapping keys; mfdata's extra horizons (1m/3m/6m, ranks, as_of_date)
 * already in the blob are preserved untouched.
 */
export function mergeOfReturns(
  ofReturns: Record<string, number | null>,
  existingBlob: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existingBlob ?? {}) };
  for (const [k, v] of Object.entries(ofReturns)) {
    if (v != null) out[k] = v;
  }
  return out;
}
