import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/src/lib/supabase';
import { paginateRangeQuery } from '@/src/utils/supabasePagination';

export interface CachedNavRow {
  scheme_code: number;
  nav_date: string;
  nav: number;
}

export interface CachedIndexRow {
  index_date: string;
  close_value: number;
}

type CompactPoint = [date: string, value: number];

interface StoredSeries {
  version: 1;
  coveredStartDate: string;
  savedAt: string;
  rows: CompactPoint[];
}

const CACHE_VERSION = 1;
const CACHE_PREFIX = 'foliolens:reference-series:v1';
const MAX_SERIES_ROWS = 8000;

export const REFERENCE_QUERY_STALE_TIME_MS = 30 * 60 * 1000;
export const REFERENCE_QUERY_GC_TIME_MS = 24 * 60 * 60 * 1000;
export const REFERENCE_HISTORY_START_DATE = '1900-01-01';

function navCacheKey(schemeCode: number): string {
  return `${CACHE_PREFIX}:nav:${schemeCode}`;
}

function indexCacheKey(symbol: string): string {
  return `${CACHE_PREFIX}:index:${encodeURIComponent(symbol)}`;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isStoredSeries(value: unknown): value is StoredSeries {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredSeries>;
  return (
    candidate.version === CACHE_VERSION &&
    isIsoDate(candidate.coveredStartDate) &&
    Array.isArray(candidate.rows)
  );
}

function compactRowsFromNav(rows: CachedNavRow[]): CompactPoint[] {
  return rows.map((row) => [row.nav_date, Number(row.nav)]);
}

function compactRowsFromIndex(rows: CachedIndexRow[]): CompactPoint[] {
  return rows.map((row) => [row.index_date, Number(row.close_value)]);
}

function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

export function mergeCompactRows(
  existingRows: CompactPoint[],
  incomingRows: CompactPoint[],
  maxRows = MAX_SERIES_ROWS,
): CompactPoint[] {
  const byDate = new Map<string, number>();
  for (const [date, value] of existingRows) {
    if (isIsoDate(date) && Number.isFinite(value)) byDate.set(date, value);
  }
  for (const [date, value] of incomingRows) {
    if (isIsoDate(date) && Number.isFinite(value)) byDate.set(date, value);
  }

  const merged = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, value]) => [date, value] as CompactPoint);

  return merged.length > maxRows ? merged.slice(merged.length - maxRows) : merged;
}

async function readSeries(key: string): Promise<StoredSeries | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredSeries(parsed)) {
      await AsyncStorage.removeItem(key);
      return null;
    }
    const rows = mergeCompactRows(parsed.rows, []);
    return { ...parsed, rows };
  } catch {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      // Ignore storage cleanup failures; cache misses must not break data fetches.
    }
    return null;
  }
}

async function writeSeries(key: string, series: StoredSeries): Promise<void> {
  if (series.rows.length === 0) return;
  try {
    await AsyncStorage.setItem(key, JSON.stringify(series));
  } catch {
    // Quota or private-mode storage failures should degrade to network fetches.
  }
}

function seriesCoversStart(series: StoredSeries | null, startDate: string): series is StoredSeries {
  return !!series && series.coveredStartDate <= startDate;
}

function rowsFromSeries(series: StoredSeries | null, startDate: string): CompactPoint[] {
  return (series?.rows ?? []).filter(([date]) => date >= startDate);
}

function latestDate(series: StoredSeries): string | null {
  return series.rows[series.rows.length - 1]?.[0] ?? null;
}

function buildSeries(
  existing: StoredSeries | null,
  incomingRows: CompactPoint[],
  fetchedStartDate: string,
): StoredSeries {
  return {
    version: CACHE_VERSION,
    coveredStartDate: existing
      ? minDate(existing.coveredStartDate, fetchedStartDate)
      : fetchedStartDate,
    savedAt: new Date().toISOString(),
    rows: mergeCompactRows(existing?.rows ?? [], incomingRows),
  };
}

function groupNavRowsByScheme(rows: CachedNavRow[]): Map<number, CachedNavRow[]> {
  const grouped = new Map<number, CachedNavRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.scheme_code) ?? [];
    existing.push(row);
    grouped.set(row.scheme_code, existing);
  }
  return grouped;
}

async function fetchNavRowsFromSupabase(
  schemeCodes: number[],
  startDate: string,
  mode: 'gte' | 'gt',
): Promise<CachedNavRow[]> {
  if (schemeCodes.length === 0) return [];
  return paginateRangeQuery<CachedNavRow>((from, to) => {
    const query = supabase
      .from('nav_history')
      .select('scheme_code, nav_date, nav')
      .in('scheme_code', schemeCodes);

    const datedQuery = mode === 'gt'
      ? query.gt('nav_date', startDate)
      : query.gte('nav_date', startDate);

    return datedQuery
      .order('nav_date', { ascending: true })
      .order('scheme_code', { ascending: true })
      .range(from, to);
  });
}

async function fetchIndexRowsFromSupabase(
  symbol: string,
  startDate: string,
  mode: 'gte' | 'gt',
): Promise<CachedIndexRow[]> {
  return paginateRangeQuery<CachedIndexRow>((from, to) => {
    const query = supabase
      .from('index_history')
      .select('index_date, close_value')
      .eq('index_symbol', symbol);

    const datedQuery = mode === 'gt'
      ? query.gt('index_date', startDate)
      : query.gte('index_date', startDate);

    return datedQuery
      .order('index_date', { ascending: true })
      .range(from, to);
  });
}

export async function fetchCachedNavRows(
  schemeCodes: number[],
  startDate: string,
): Promise<CachedNavRow[]> {
  const uniqueCodes = [...new Set(schemeCodes)].filter((code) => Number.isFinite(code));
  if (uniqueCodes.length === 0) return [];

  const cacheEntries = await Promise.all(
    uniqueCodes.map(async (schemeCode) => [schemeCode, await readSeries(navCacheKey(schemeCode))] as const),
  );
  const cacheByScheme = new Map<number, StoredSeries | null>(cacheEntries);

  const fullFetchCodes = uniqueCodes.filter((schemeCode) =>
    !seriesCoversStart(cacheByScheme.get(schemeCode) ?? null, startDate),
  );
  const deltaCandidates = uniqueCodes
    .map((schemeCode) => {
      const series = cacheByScheme.get(schemeCode) ?? null;
      return seriesCoversStart(series, startDate) ? [schemeCode, series] as const : null;
    })
    .filter((entry): entry is readonly [number, StoredSeries] => !!entry && latestDate(entry[1]) !== null);

  const latestByScheme = new Map(
    deltaCandidates.map(([schemeCode, series]) => [schemeCode, latestDate(series)!]),
  );
  const oldestLatest = [...latestByScheme.values()].sort()[0] ?? null;

  const [fullRows, candidateDeltaRows] = await Promise.all([
    fetchNavRowsFromSupabase(fullFetchCodes, startDate, 'gte'),
    oldestLatest
      ? fetchNavRowsFromSupabase([...latestByScheme.keys()], oldestLatest, 'gt')
      : Promise.resolve([]),
  ]);

  const fullRowsByScheme = groupNavRowsByScheme(fullRows);
  for (const schemeCode of fullFetchCodes) {
    const existing = cacheByScheme.get(schemeCode) ?? null;
    const next = buildSeries(existing, compactRowsFromNav(fullRowsByScheme.get(schemeCode) ?? []), startDate);
    cacheByScheme.set(schemeCode, next);
    await writeSeries(navCacheKey(schemeCode), next);
  }

  const deltaRows = candidateDeltaRows.filter((row) => row.nav_date > (latestByScheme.get(row.scheme_code) ?? ''));
  const deltaRowsByScheme = groupNavRowsByScheme(deltaRows);
  for (const [schemeCode, rows] of deltaRowsByScheme) {
    const existing = cacheByScheme.get(schemeCode) ?? null;
    const next = buildSeries(existing, compactRowsFromNav(rows), existing?.coveredStartDate ?? startDate);
    cacheByScheme.set(schemeCode, next);
    await writeSeries(navCacheKey(schemeCode), next);
  }

  const out: CachedNavRow[] = [];
  for (const schemeCode of uniqueCodes) {
    const seriesRows = rowsFromSeries(cacheByScheme.get(schemeCode) ?? null, startDate);
    for (const [date, value] of seriesRows) {
      out.push({ scheme_code: schemeCode, nav_date: date, nav: value });
    }
  }
  return out.sort((a, b) =>
    a.nav_date === b.nav_date
      ? a.scheme_code - b.scheme_code
      : a.nav_date.localeCompare(b.nav_date),
  );
}

export async function fetchCachedIndexRows(
  symbol: string,
  startDate: string,
): Promise<CachedIndexRow[]> {
  const key = indexCacheKey(symbol);
  const cached = await readSeries(key);
  const hasCoveredRange = seriesCoversStart(cached, startDate);
  const latest = hasCoveredRange ? latestDate(cached) : null;

  const fetchedRows = latest
    ? await fetchIndexRowsFromSupabase(symbol, latest, 'gt')
    : await fetchIndexRowsFromSupabase(symbol, startDate, 'gte');

  const next = buildSeries(
    hasCoveredRange ? cached : null,
    compactRowsFromIndex(fetchedRows),
    hasCoveredRange && cached ? cached.coveredStartDate : startDate,
  );
  await writeSeries(key, next);

  return rowsFromSeries(next, startDate).map(([date, value]) => ({
    index_date: date,
    close_value: value,
  }));
}
