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
 * 28 legacy mfdata-shape rows exist on dev (as of 2026-06-12); readReturnPct
 * in src/utils/mfdataGuards.ts keeps dual-shape read support for them.
 *
 * Provenance marker: mergeOfReturns stamps of_keys: string[] listing every
 * ret_ key it has ever written. mergeMfdataReturns uses this to protect
 * OF-written values from being overwritten by a later mfdata sync, while
 * allowing mfdata-written values to refresh freely (fixing the staleness
 * freeze on OF-404 schemes that fall back to the mfdata leg).
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
 * with the existing blob.
 *
 * Merge order (later steps win):
 *   1. Existing blob as base (preserves horizons absent from incoming mfdata)
 *   2. Incoming mfdata overwrites (enables staleness refresh for mfdata-written values)
 *   3. OF-written keys restored from existing blob (OF always beats mfdata)
 *
 * Step 3 only applies when the existing blob carries of_keys (stamped by
 * mergeOfReturns). Blobs without of_keys were written purely by mfdata and
 * are fully refreshable — this closes the staleness freeze on OF-404 schemes.
 *
 * Returns the merged canonical blob, or null when both inputs are null/empty.
 */
export function mergeMfdataReturns(
  mfdataReturns: Record<string, unknown> | null | undefined,
  existingBlob: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};

  // Step 1: start with existing blob as base (preserves previous mfdata values
  // for horizons not present in the incoming payload).
  if (existingBlob && typeof existingBlob === 'object') {
    for (const [k, v] of Object.entries(existingBlob)) {
      if (v != null) out[k] = v;
    }
  }

  // Step 2: overlay incoming mfdata — mfdata wins for keys it provides.
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

  // Step 3: restore OF-written keys — OF always beats mfdata.
  // of_keys is absent on pure-mfdata blobs; skip restoration in that case so
  // those blobs remain freely refreshable by incoming mfdata.
  if (existingBlob && typeof existingBlob === 'object') {
    const ofKeys = Array.isArray(existingBlob.of_keys)
      ? (existingBlob.of_keys as string[])
      : [];
    for (const k of ofKeys) {
      const v = existingBlob[k];
      if (v != null) out[k] = v;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Merge OpenFolio returns into an existing period_returns blob. OF values win
 * for overlapping keys; mfdata's extra horizons (1m/3m/6m, ranks, as_of_date)
 * already in the blob are preserved untouched.
 *
 * Stamps of_keys: the union of all ret_ keys ever written by OF. This marker
 * lets mergeMfdataReturns protect OF values from later mfdata refreshes.
 */
export function mergeOfReturns(
  ofReturns: Record<string, number | null>,
  existingBlob: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existingBlob ?? {}) };
  const newOfKeys: string[] = [];
  for (const [k, v] of Object.entries(ofReturns)) {
    if (v != null) {
      out[k] = v;
      newOfKeys.push(k);
    }
  }
  // Union new keys with any previously tracked OF keys (handles partial updates).
  const prevOfKeys = Array.isArray(out.of_keys) ? (out.of_keys as string[]) : [];
  const allOfKeys = Array.from(new Set([...prevOfKeys, ...newOfKeys]));
  if (allOfKeys.length > 0) out.of_keys = allOfKeys;
  return out;
}
