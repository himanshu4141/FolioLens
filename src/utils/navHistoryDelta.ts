/**
 * Delta-fetch helpers for `nav_history` and `index_history`.
 *
 * Past NAVs and past index closes never change. Re-downloading 12,500+
 * rows on every revalidation just to learn that today's NAV ticked is
 * wasteful. These pure helpers compute the smallest delta the caller can
 * ask Supabase for, given whatever rows are already on hand from the
 * persisted React Query cache.
 *
 * The shape is intentionally generic over `nav_history` (keyed by
 * `scheme_code`) and `index_history` (keyed by `index_symbol`) so both
 * hooks can share the same code.
 */

export interface DatedRow<K extends string | number> {
  key: K;
  date: string; // ISO YYYY-MM-DD
}

/**
 * For each unique key in `rows`, return the maximum `date` seen for that
 * key. Used to compute the delta lower bound per scheme / per symbol.
 *
 * `rows` is expected to be the previously-cached payload (any order).
 * Output uses the same key type as input so the hook can pass a typed
 * `Record<scheme_code, date>` straight to the next layer.
 */
export function deriveLatestByKey<K extends string | number>(
  rows: readonly DatedRow<K>[],
): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const row of rows) {
    const current = out[row.key];
    if (current === undefined || row.date > current) {
      out[row.key] = row.date;
    }
  }
  return out;
}

/**
 * Build the delta-query window for a SELECT that pulls every requested
 * key in one round trip.
 *
 * Returns:
 *   - `keys`: the keys to query (strict subset of `requestedKeys` that
 *     either have a cached date or have nothing cached, dropped only if
 *     requestedKeys is empty).
 *   - `minDate`: the earliest `latest+1day` across all keys, suitable for
 *     a single `.gte('date', minDate)` filter. `null` means "no cache for
 *     anyone, fetch everything".
 *
 * Behaviour:
 *   - If any requested key has *nothing* cached, `minDate` is `null`
 *     (full fetch). The caller can still filter by `keys`.
 *   - If every requested key has cached data, `minDate` is the minimum
 *     of the per-key latest dates. The single SQL call slightly
 *     over-fetches for keys whose latest is later than the minimum, but
 *     that beats firing N parallel queries.
 *   - If `requestedKeys` is empty, returns `{ keys: [], minDate: null }`
 *     and the caller should skip the network entirely.
 *
 * Date arithmetic is intentionally done as ISO-string compare. NAV dates
 * are always emitted by Supabase as `YYYY-MM-DD`, which sort lexically.
 *
 * `latestByKey` is intentionally `Partial<Record<K, string>>` because
 * `deriveLatestByKey` may not have an entry for every requested key
 * (e.g. a brand-new fund the user just added has no cached rows).
 */
export function deltaQueryWindow<K extends string | number>(
  requestedKeys: readonly K[],
  latestByKey: Partial<Record<K, string>>,
): { keys: K[]; minDate: string | null } {
  if (requestedKeys.length === 0) {
    return { keys: [], minDate: null };
  }

  const keys = [...requestedKeys];
  let minDate: string | null = null;
  let anyMissing = false;

  for (const key of keys) {
    const latest = latestByKey[key];
    if (latest === undefined) {
      anyMissing = true;
      continue;
    }
    if (minDate === null || latest < minDate) {
      minDate = latest;
    }
  }

  if (anyMissing) {
    return { keys, minDate: null };
  }

  return { keys, minDate };
}

/**
 * Merge a delta payload back into a cached payload, deduping by
 * `(key, date)`. The returned array preserves the cache's existing sort
 * order convention: descending by `date` then by `key` ascending. The
 * concrete payload types (NavRow / IndexRow) extend `DatedRow` so this
 * helper is usable by both consumers.
 */
export function mergeDeltaRows<K extends string | number, R extends DatedRow<K>>(
  cached: readonly R[],
  delta: readonly R[],
): R[] {
  if (delta.length === 0) return [...cached];
  const seen = new Map<string, R>();
  for (const row of cached) {
    seen.set(`${row.key}|${row.date}`, row);
  }
  for (const row of delta) {
    seen.set(`${row.key}|${row.date}`, row);
  }
  return [...seen.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.key === b.key) return 0;
    return a.key < b.key ? -1 : 1;
  });
}
