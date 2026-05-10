/**
 * Shared NAV / index history cache + delta-fetch path.
 *
 * Both `usePortfolio` and `useInvestmentVsBenchmarkTimeline` need
 * `nav_history` and `index_history` for the same user. Before this
 * module they each ran their own SELECTs, doubling the network bill on
 * a cold mount. They now route through `fetchNavHistoryWithCache` and
 * `fetchIndexHistoryWithCache`, which:
 *
 *   - Use a shared React Query cache key so a second consumer reads
 *     from the first consumer's cache (no double fetch).
 *
 *   - Honour the persisted cache wired up in `app/_layout.tsx`. A page
 *     reload returns the cached rows without touching the network.
 *
 *   - Delta-fetch on revalidation: when the cache is stale but
 *     populated, the next refetch only asks Supabase for rows whose
 *     `nav_date` (or `index_date`) is greater than the latest already
 *     cached. Today's NAV tick costs ~10 rows of network instead of
 *     12,500.
 *
 * The delta path falls back to a full fetch any time the cache is
 * empty — first run after install, after `__BUSTER__` bump, or after
 * a sign-out that clears the persister.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { supabase } from '@/src/lib/supabase';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import {
  deltaQueryWindow,
  deriveLatestByKey,
} from '@/src/utils/navHistoryDelta';

const PAGE_SIZE = 1000;

export interface NavRow {
  scheme_code: number;
  nav_date: string;
  nav: number;
}

export interface IndexRow {
  index_date: string;
  close_value: number;
}

export function navHistoryQueryKey(userId: string, schemeCodes: number[]): QueryKey {
  // Sort so the cache key is stable regardless of the caller's order.
  // Including userId guards against cache leakage across sign-in/sign-out.
  return ['nav-history', userId, [...schemeCodes].sort((a, b) => a - b)];
}

export function indexHistoryQueryKey(indexSymbol: string): QueryKey {
  return ['index-history', indexSymbol];
}

function sortNavDesc(a: NavRow, b: NavRow): number {
  if (a.nav_date !== b.nav_date) return a.nav_date < b.nav_date ? 1 : -1;
  return a.scheme_code - b.scheme_code;
}

function sortIndexDesc(a: IndexRow, b: IndexRow): number {
  if (a.index_date !== b.index_date) return a.index_date < b.index_date ? 1 : -1;
  return 0;
}

function mergeNavRows(cached: readonly NavRow[], delta: readonly NavRow[]): NavRow[] {
  if (delta.length === 0) return [...cached].sort(sortNavDesc);
  const seen = new Map<string, NavRow>();
  for (const row of cached) seen.set(`${row.scheme_code}|${row.nav_date}`, row);
  for (const row of delta) seen.set(`${row.scheme_code}|${row.nav_date}`, row);
  return [...seen.values()].sort(sortNavDesc);
}

function mergeIndexRows(
  cached: readonly IndexRow[],
  delta: readonly IndexRow[],
): IndexRow[] {
  if (delta.length === 0) return [...cached].sort(sortIndexDesc);
  const seen = new Map<string, IndexRow>();
  for (const row of cached) seen.set(row.index_date, row);
  for (const row of delta) seen.set(row.index_date, row);
  return [...seen.values()].sort(sortIndexDesc);
}

export async function fetchNavHistoryDirect(
  schemeCodes: number[],
  cached: readonly NavRow[] = [],
): Promise<NavRow[]> {
  const sortedCodes = [...schemeCodes].sort((a, b) => a - b);
  if (sortedCodes.length === 0) return [];

  const latestByScheme = deriveLatestByKey(
    cached.map((row) => ({ key: row.scheme_code, date: row.nav_date })),
  );
  const { keys, minDate } = deltaQueryWindow(sortedCodes, latestByScheme);

  const fresh: NavRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let qb = supabase
      .from('nav_history')
      .select('scheme_code, nav_date, nav')
      .in('scheme_code', keys as number[])
      .order('nav_date', { ascending: false });
    if (minDate !== null) {
      qb = qb.gte('nav_date', minDate);
    }
    const { data, error } = await qb.range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as NavRow[];
    fresh.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }

  return mergeNavRows(cached, fresh);
}

export async function fetchIndexHistoryDirect(
  indexSymbol: string,
  cached: readonly IndexRow[] = [],
): Promise<IndexRow[]> {
  if (!indexSymbol) return [];

  const latestByKey = deriveLatestByKey(
    cached.map((row) => ({ key: indexSymbol, date: row.index_date })),
  );
  const { minDate } = deltaQueryWindow([indexSymbol], latestByKey);

  const fresh: IndexRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let qb = supabase
      .from('index_history')
      .select('index_date, close_value')
      .eq('index_symbol', indexSymbol)
      .order('index_date', { ascending: false });
    if (minDate !== null) {
      qb = qb.gte('index_date', minDate);
    }
    const { data, error } = await qb.range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as IndexRow[];
    fresh.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }

  return mergeIndexRows(cached, fresh);
}

export async function fetchNavHistoryWithCache(
  qc: QueryClient,
  userId: string,
  schemeCodes: number[],
): Promise<NavRow[]> {
  const queryKey = navHistoryQueryKey(userId, schemeCodes);
  return qc.fetchQuery<NavRow[]>({
    queryKey,
    queryFn: () => {
      const cached = qc.getQueryData<NavRow[]>(queryKey) ?? [];
      return fetchNavHistoryDirect(schemeCodes, cached);
    },
    staleTime: STALE_TIMES.NAV_HISTORY,
  });
}

export async function fetchIndexHistoryWithCache(
  qc: QueryClient,
  indexSymbol: string,
): Promise<IndexRow[]> {
  const queryKey = indexHistoryQueryKey(indexSymbol);
  return qc.fetchQuery<IndexRow[]>({
    queryKey,
    queryFn: () => {
      const cached = qc.getQueryData<IndexRow[]>(queryKey) ?? [];
      return fetchIndexHistoryDirect(indexSymbol, cached);
    },
    staleTime: STALE_TIMES.INDEX_HISTORY,
  });
}
