/**
 * usePerformanceTimeline — fetches raw NAV and index histories for a mix of
 * funds and benchmark indexes. Used by the Compare screen to build the
 * % return chart.
 *
 * Returns:
 *  - entries: one entry per item (fund or index), with full sorted history
 *
 * buildTimelineSeries() converts entries into chart-ready % return series.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/src/lib/supabase';
import { filterToWindow, type TimeWindow, type NavPoint } from '@/src/utils/navUtils';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';

export interface TimelineEntry {
  type: 'fund' | 'index';
  id: string;       // fund ID or index symbol
  name: string;
  history: NavPoint[];  // sorted ascending by date
}

export interface PerformanceTimelineData {
  entries: TimelineEntry[];
}

interface TimelineFundRow {
  id: string;
  scheme_code: number;
  scheme_name: string;
}

function isTimelineFundRow(
  row: {
    id: string | null;
    scheme_code: number | null;
    scheme_name: string | null;
  } | null | undefined,
): row is TimelineFundRow {
  return !!row && !!row.id && row.scheme_code != null && !!row.scheme_name;
}

export async function fetchPerformanceTimeline(
  fundItems: { id: string; name: string }[],
  indexItems: { symbol: string; name: string }[],
): Promise<PerformanceTimelineData> {
  const entries: TimelineEntry[] = [];

  if (fundItems.length > 0) {
    // Fetch scheme codes for the fund IDs
    const { data: funds, error: fundsError } = await supabase
      .from('fund')
      .select('id, scheme_code, scheme_name')
      .in('id', fundItems.map((f) => f.id));

    if (fundsError) throw fundsError;

    const validFunds = (funds ?? []).filter(isTimelineFundRow);
    const schemeCodes = validFunds.map((f) => f.scheme_code);

    if (schemeCodes.length > 0) {
      const { data: navRows, error: navError } = await supabase
        .from('nav_history')
        .select('scheme_code, nav_date, nav')
        .in('scheme_code', schemeCodes)
        .order('nav_date', { ascending: false })
        .limit(5000);

      if (navError) throw navError;

      // Group NAV by scheme_code (rows arrive newest-first; reverse each group to ascending)
      const navByScheme = new Map<number, NavPoint[]>();
      for (const row of navRows ?? []) {
        const code = row.scheme_code as number;
        const existing = navByScheme.get(code) ?? [];
        existing.push({ date: row.nav_date as string, value: row.nav as number });
        navByScheme.set(code, existing);
      }
      for (const [code, pts] of navByScheme) navByScheme.set(code, pts.reverse());

      // Add entries in the order requested by fundItems
      for (const fundItem of fundItems) {
        const fund = validFunds.find((f) => f.id === fundItem.id);
        if (!fund) continue;
        entries.push({
          type: 'fund',
          id: fundItem.id,
          name: fundItem.name,
          history: navByScheme.get(fund.scheme_code) ?? [],
        });
      }
    }
  }

  if (indexItems.length > 0) {
    const { data: idxRows, error: idxError } = await supabase
      .from('index_history')
      .select('index_symbol, index_date, close_value')
      .in('index_symbol', indexItems.map((i) => i.symbol))
      .order('index_date', { ascending: false })
      .limit(5000);

    if (idxError) throw idxError;

    // Group by index_symbol (rows arrive newest-first; reverse each group to ascending)
    const idxBySymbol = new Map<string, NavPoint[]>();
    for (const row of idxRows ?? []) {
      const sym = row.index_symbol as string;
      const existing = idxBySymbol.get(sym) ?? [];
      existing.push({ date: row.index_date as string, value: row.close_value as number });
      idxBySymbol.set(sym, existing);
    }
    for (const [sym, pts] of idxBySymbol) idxBySymbol.set(sym, pts.reverse());

    for (const item of indexItems) {
      entries.push({
        type: 'index',
        id: item.symbol,
        name: item.name,
        history: idxBySymbol.get(item.symbol) ?? [],
      });
    }
  }

  return { entries };
}

export function usePerformanceTimeline(
  fundItems: { id: string; name: string }[],
  indexItems: { symbol: string; name: string }[],
) {
  // Sort keys so query cache hits when order changes
  const fundKey = [...fundItems.map((f) => f.id)].sort().join(',');
  const indexKey = [...indexItems.map((i) => i.symbol)].sort().join(',');

  return useQuery({
    queryKey: ['performance-timeline', fundKey, indexKey],
    enabled: fundItems.length + indexItems.length > 0,
    queryFn: () => fetchPerformanceTimeline(fundItems, indexItems),
    staleTime: STALE_TIMES.PERFORMANCE_TIMELINE,
  });
}

/**
 * Builds chart-ready % return series from timeline entries.
 *
 * Y-axis: % return from start of window (0% = no change, +20% = 20% gain).
 * All series share a common start date (latest first-date across all series).
 * Only dates where ALL series have data are included.
 * Sampled to ≤60 points for render performance.
 *
 * Returns:
 *  - points: array of { value }[] arrays, one per id (in ids order)
 *  - dates: parallel date strings for crosshair tooltips
 */
export function buildTimelineSeries(
  entries: TimelineEntry[],
  ids: string[],
  window: TimeWindow,
): { points: { value: number }[][]; dates: string[] } {
  if (ids.length === 0 || entries.length === 0) return { points: [], dates: [] };

  // Get entries for the requested ids in order
  const ordered = ids
    .map((id) => entries.find((e) => e.id === id))
    .filter((e): e is TimelineEntry => e !== undefined);

  if (ordered.length === 0) return { points: [], dates: [] };

  // Filter each entry to the time window
  const filtered = ordered.map((e) => ({
    ...e,
    history: filterToWindow(e.history, window),
  }));

  // Common start = latest "first date" so all series have data from that point
  let commonStart = '';
  for (const e of filtered) {
    if (e.history.length > 0) {
      const first = e.history[0].date;
      if (!commonStart || first > commonStart) commonStart = first;
    }
  }

  if (!commonStart) return { points: [], dates: [] };

  // Trim to common start
  const trimmed = filtered.map((e) => ({
    ...e,
    history: e.history.filter((p) => p.date >= commonStart),
  }));

  // Reference date list = series with most data
  const reference = trimmed.reduce(
    (best, e) => (e.history.length > best.history.length ? e : best),
    trimmed[0],
  );
  const referenceDates = reference.history.map((p) => p.date);

  if (referenceDates.length === 0) return { points: [], dates: [] };

  // Build date → value maps
  const dateMaps = trimmed.map((e) => {
    const map = new Map<string, number>();
    for (const p of e.history) map.set(p.date, p.value);
    return map;
  });

  // Base values at common start
  const baseValues = trimmed.map((_, i) => {
    return dateMaps[i].get(commonStart) ?? dateMaps[i].get(referenceDates[0]) ?? 0;
  });

  // Build % return series — only dates where ALL series have data
  const validDates: string[] = [];
  const rawSeries: number[][] = trimmed.map(() => []);

  for (const date of referenceDates) {
    let allHaveData = true;
    const values: number[] = [];

    for (let i = 0; i < trimmed.length; i++) {
      const val = dateMaps[i].get(date);
      if (val === undefined || baseValues[i] === 0) {
        allHaveData = false;
        break;
      }
      values.push(((val / baseValues[i]) - 1) * 100);
    }

    if (allHaveData) {
      validDates.push(date);
      for (let i = 0; i < trimmed.length; i++) {
        rawSeries[i].push(values[i]);
      }
    }
  }

  if (validDates.length === 0) return { points: [], dates: [] };

  // Sample to ≤60 points
  const step = Math.max(1, Math.ceil(validDates.length / 60));
  const sampleIndices: number[] = [];
  for (let i = 0; i < validDates.length; i++) {
    if (i % step === 0 || i === validDates.length - 1) sampleIndices.push(i);
  }

  const sampledDates = sampleIndices.map((i) => validDates[i]);
  const points = rawSeries.map((series) => sampleIndices.map((i) => ({ value: series[i] })));

  return { points, dates: sampledDates };
}

/** Format a date string as "Jan '24" for X-axis labels */
export function formatDateShort(dateStr: string): string {
  const [year, month] = dateStr.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(month, 10) - 1]} '${year.slice(2)}`;
}

/**
 * Build a full-length X-axis labels array for gifted-charts.
 *
 * gifted-charts requires xAxisLabelTexts to have one entry per data point.
 * Passing fewer entries only labels the first N positions.
 * This function returns an array of the same length as `dates`, with empty
 * strings for unlabeled positions and ~5 evenly spaced visible labels.
 */
export function buildXAxisLabels(dates: string[], count = 5): string[] {
  if (dates.length === 0) return [];
  const labels = new Array<string>(dates.length).fill('');
  if (dates.length <= count) {
    // Deduplicate consecutive same-month labels for short date ranges
    let prev = '';
    return dates.map((d) => {
      const label = formatDateShort(d);
      if (label === prev) return '';
      prev = label;
      return label;
    });
  }
  const step = (dates.length - 1) / (count - 1);
  let lastPlaced = '';
  for (let i = 0; i < count; i++) {
    const idx = Math.min(Math.round(i * step), dates.length - 1);
    const label = formatDateShort(dates[idx]);
    if (label !== lastPlaced) {
      labels[idx] = label;
      lastPlaced = label;
    }
  }
  // Always label the last point — it marks end-of-data regardless of month duplicates
  labels[dates.length - 1] = formatDateShort(dates[dates.length - 1]);
  return labels;
}
