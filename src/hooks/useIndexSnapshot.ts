/**
 * useIndexSnapshot — CDN-fronted snapshot of `index_history` for one
 * benchmark.
 *
 * Daily-regenerated JSON file in the `static-snapshots` Supabase
 * Storage bucket. Served via Supabase's public CDN with
 * `stale-while-revalidate=86400`, so the typical fetch is a single
 * round-trip from the nearest edge — ~30–80ms globally vs the 2–8
 * paginated PostgREST round-trips this replaces.
 *
 * Design: `fetchIndexSnapshot` is the raw fetcher and returns `null`
 * on any failure (404, network, JSON parse). `fetchIndexHistory` wraps
 * it with a fallback to the existing paginated `index_history` SELECT
 * so a missing/broken snapshot never blocks the screen — it just
 * makes the next read slower.
 *
 * Phase 9 M5 — Layer 4 of "CDN snapshots for benchmark index history".
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/src/lib/supabase';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { perfEnd, perfStart } from '@/src/lib/perfMark';

export interface IndexSnapshotPoint {
  date: string;
  value: number;
}

export interface IndexSnapshot {
  symbol: string;
  generated_at: string;
  points: IndexSnapshotPoint[];
}

const BUCKET = 'static-snapshots';
const PAGE_SIZE = 1000;

function objectPathFor(symbol: string): string {
  // Mirror of `regenerate-index-snapshots`'s `objectPathFor`. Keep in
  // sync — the symbol's leading caret is stripped and the rest is
  // lowercased so the URL needs no encoding.
  return `index/${symbol.replace(/^\^/, '').toLowerCase()}.json`;
}

function snapshotUrlFor(symbol: string): string | null {
  const base = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  return `${base}/storage/v1/object/public/${BUCKET}/${objectPathFor(symbol)}`;
}

/**
 * Raw CDN fetch. Returns `null` on any failure so the caller can
 * fall back without try/catch noise. The slow path lives elsewhere.
 */
export async function fetchIndexSnapshot(symbol: string): Promise<IndexSnapshot | null> {
  const url = snapshotUrlFor(symbol);
  if (!url) return null;
  perfStart('query:indexSnapshot');
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      perfEnd('query:indexSnapshot', { symbol, ok: false, status: res.status });
      return null;
    }
    const data = (await res.json()) as IndexSnapshot;
    if (!data || !Array.isArray(data.points)) {
      perfEnd('query:indexSnapshot', { symbol, ok: false, reason: 'malformed' });
      return null;
    }
    perfEnd('query:indexSnapshot', { symbol, ok: true, points: data.points.length });
    return data;
  } catch (err) {
    perfEnd('query:indexSnapshot', { symbol, ok: false, reason: 'exception' });
    console.warn('[useIndexSnapshot] fetch failed; falling back', symbol, err);
    return null;
  }
}

interface RawHistoryRow {
  index_date: string;
  close_value: number;
}

async function fallbackFromIndexHistory(
  symbol: string,
  sinceDate: string | null,
): Promise<IndexSnapshotPoint[]> {
  perfStart('query:indexSnapshot:fallback');
  const rows: RawHistoryRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    // `.gte()` precedes `.range()` so the paginator's terminal call
    // stays as `.range()` — tests rely on that to terminate the chain
    // and so does PostgREST's pagination contract.
    let q = supabase
      .from('index_history')
      .select('index_date, close_value')
      .eq('index_symbol', symbol);
    if (sinceDate) q = q.gte('index_date', sinceDate);
    const { data, error } = await q
      .order('index_date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as RawHistoryRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  perfEnd('query:indexSnapshot:fallback', { symbol, rows: rows.length });
  return rows.map((r) => ({ date: r.index_date, value: Number(r.close_value) }));
}

/**
 * One-stop fetcher for "give me the benchmark history for this symbol,
 * optionally filtered to dates >= `sinceDate`". Tries the CDN snapshot
 * first; on miss, falls back to the paginated SELECT that the call
 * sites used pre-M5.
 */
export async function fetchIndexHistory(
  symbol: string,
  sinceDate: string | null = null,
): Promise<IndexSnapshotPoint[]> {
  const snapshot = await fetchIndexSnapshot(symbol);
  if (snapshot) {
    return sinceDate
      ? snapshot.points.filter((p) => p.date >= sinceDate)
      : snapshot.points;
  }
  return fallbackFromIndexHistory(symbol, sinceDate);
}

export function useIndexSnapshot(symbol: string | null | undefined) {
  return useQuery({
    queryKey: ['index-snapshot', symbol],
    enabled: !!symbol,
    queryFn: () => fetchIndexSnapshot(symbol!),
    staleTime: STALE_TIMES.INDEX_HISTORY,
  });
}
