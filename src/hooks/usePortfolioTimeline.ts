/**
 * usePortfolioTimeline — computes a blended portfolio value time-series
 * indexed to 100, alongside the selected benchmark, for the Home screen
 * "Portfolio vs Market" chart.
 *
 * Algorithm:
 *  1. Fetch all NAV history for the user's fund scheme codes
 *  2. Fetch all transactions for the user (to compute cumulative units per fund per date)
 *  3. Fetch index history for the selected benchmark
 *  4. Build per-fund units step function from transactions
 *  5. For each NAV date, sum (units × nav) across all funds → portfolio value
 *  6. Filter both series to the selected window, trim to common start, index to 100
 */

import { useQuery } from '@tanstack/react-query';
import { navHistoryRepo } from '@/src/lib/data/navHistory';
import { transactionRepo } from '@/src/lib/data/transaction';
import { indexHistoryRepo } from '@/src/lib/data/indexHistory';
import { filterToWindow, indexTo100, type TimeWindow, type NavPoint } from '@/src/utils/navUtils';
import { buildXAxisLabels } from '@/src/hooks/usePerformanceTimeline';
import { filterReversedTransactionPairs } from '@/src/utils/xirr';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';

export interface FundRef {
  id: string;         // fund table UUID
  schemeCode: number; // NAV history lookup key
}

export interface PortfolioTimelineResult {
  portfolioPoints: NavPoint[];   // indexed to 100 at window start
  benchmarkPoints: NavPoint[];   // indexed to 100 at window start
  xAxisLabels: string[];
  isLoading: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Pure computation — separated for unit testability
// ---------------------------------------------------------------------------

interface RawNavRow { scheme_code: number; nav_date: string; nav: number }
interface RawTxRow {
  fund_id: string;
  transaction_date: string;
  transaction_type: string;
  units: number;
  amount?: number;
}
interface RawIdxRow { index_date: string; close_value: number }

/** Binary-search last step-function entry with date ≤ target */
function getUnitsAt(
  history: { date: string; units: number }[],
  targetDate: string,
): number {
  let lo = 0;
  let hi = history.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].date <= targetDate) {
      result = history[mid].units;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(0, result);
}


export function computePortfolioTimeline(
  navRows: RawNavRow[],
  txRows: RawTxRow[],
  idxRows: RawIdxRow[],
  funds: FundRef[],
  window: TimeWindow,
): { portfolioPoints: NavPoint[]; benchmarkPoints: NavPoint[]; xAxisLabels: string[] } {
  const empty = { portfolioPoints: [], benchmarkPoints: [], xAxisLabels: [] };
  if (funds.length === 0) return empty;

  // Build nav lookup: schemeCode → date → nav
  const navByScheme = new Map<number, Map<string, number>>();
  const allNavDates = new Set<string>();
  for (const row of navRows) {
    if (!navByScheme.has(row.scheme_code)) navByScheme.set(row.scheme_code, new Map());
    navByScheme.get(row.scheme_code)!.set(row.nav_date, row.nav);
    allNavDates.add(row.nav_date);
  }

  const sortedDates = [...allNavDates].sort();
  if (sortedDates.length === 0) return empty;

  // Build per-fund cumulative units step function (txRows must be ascending by date)
  const unitHistory = new Map<string, { date: string; units: number }[]>();
  const cumUnits = new Map<string, number>();
  for (const fund of funds) {
    unitHistory.set(fund.id, []);
    cumUnits.set(fund.id, 0);
  }
  for (const tx of filterReversedTransactionPairs(txRows)) {
    const fid = tx.fund_id;
    if (!unitHistory.has(fid)) continue; // skip transactions for funds not in our list
    const prev = cumUnits.get(fid) ?? 0;
    const isInflow =
      tx.transaction_type === 'purchase' ||
      tx.transaction_type === 'switch_in' ||
      tx.transaction_type === 'dividend_reinvest';
    const next = isInflow ? prev + tx.units : Math.max(0, prev - tx.units);
    cumUnits.set(fid, next);
    unitHistory.get(fid)!.push({ date: tx.transaction_date, units: next });
  }

  // Build portfolio value series: for each NAV date, sum units × nav across all funds
  const rawPortfolio: NavPoint[] = [];
  for (const date of sortedDates) {
    let total = 0;
    let hasValue = false;
    for (const fund of funds) {
      const units = getUnitsAt(unitHistory.get(fund.id) ?? [], date);
      if (units <= 0) continue;
      const nav = navByScheme.get(fund.schemeCode)?.get(date);
      if (nav !== undefined) {
        total += units * nav;
        hasValue = true;
      }
    }
    if (hasValue && total > 0) rawPortfolio.push({ date, value: total });
  }

  // Build benchmark series (sort ascending regardless of fetch order)
  const rawBenchmark: NavPoint[] = [...idxRows]
    .sort((a, b) => a.index_date.localeCompare(b.index_date))
    .map((r) => ({ date: r.index_date, value: r.close_value }));

  // Filter to the selected time window
  const portfolioFiltered = filterToWindow(rawPortfolio, window);
  const benchmarkFiltered = filterToWindow(rawBenchmark, window);
  if (portfolioFiltered.length === 0 || benchmarkFiltered.length === 0) return empty;

  // Align to common start: latest first date across both series
  const commonStart =
    portfolioFiltered[0].date > benchmarkFiltered[0].date
      ? portfolioFiltered[0].date
      : benchmarkFiltered[0].date;

  const portfolioTrimmed = portfolioFiltered.filter((p) => p.date >= commonStart);
  const benchmarkTrimmed = benchmarkFiltered.filter((p) => p.date >= commonStart);
  if (portfolioTrimmed.length === 0 || benchmarkTrimmed.length === 0) return empty;

  // Index both series to 100 at their respective first points
  const portfolioIndexed = indexTo100(portfolioTrimmed);
  const benchmarkIndexed = indexTo100(benchmarkTrimmed);

  // Sample both series using the SAME indices so they have equal length.
  // Independent sampling can produce series of different lengths, which causes
  // one line to end visually earlier than the other in the chart.
  const maxPoints = 24;
  const n = Math.min(portfolioIndexed.length, benchmarkIndexed.length);
  const step = n <= maxPoints ? 1 : Math.ceil(n / maxPoints);
  const sampleIdxs: number[] = [];
  for (let i = 0; i < n; i += step) sampleIdxs.push(i);
  if (sampleIdxs.length === 0 || sampleIdxs[sampleIdxs.length - 1] !== n - 1) {
    sampleIdxs.push(n - 1);
  }
  const portfolioSampled = sampleIdxs.map((i) => portfolioIndexed[i]);
  const benchmarkSampled = sampleIdxs.map((i) => benchmarkIndexed[i]);

  const xAxisLabels = buildXAxisLabels(portfolioSampled.map((p) => p.date));

  return { portfolioPoints: portfolioSampled, benchmarkPoints: benchmarkSampled, xAxisLabels };
}

// ---------------------------------------------------------------------------
// Async fetch + compute
// ---------------------------------------------------------------------------

export async function fetchPortfolioTimeline(
  funds: FundRef[],
  userId: string,
  benchmarkSymbol: string,
  window: TimeWindow,
): Promise<{ portfolioPoints: NavPoint[]; benchmarkPoints: NavPoint[]; xAxisLabels: string[] }> {
  const fundIds = funds.map((f) => f.id);
  const schemeCodes = funds.map((f) => f.schemeCode);

  const [navResult, txResult, idxResult] = await Promise.all([
    // Fetch newest rows first so our 10k-row budget covers recent history
    // (nav_history can have 55k+ rows per fund going back to 2013)
    navHistoryRepo
      .from()
      .select('scheme_code, nav_date, nav')
      .in('scheme_code', schemeCodes)
      .order('nav_date', { ascending: false })
      .limit(10000),
    transactionRepo
      .from()
      .select('fund_id, transaction_date, transaction_type, units, amount')
      .eq('user_id', userId)
      .in('fund_id', fundIds)
      .order('transaction_date', { ascending: true }),
    indexHistoryRepo
      .from()
      .select('index_date, close_value')
      .eq('index_symbol', benchmarkSymbol)
      .order('index_date', { ascending: false })
      .limit(10000),
  ]);

  if (navResult.error) throw navResult.error;
  if (txResult.error) throw txResult.error;
  if (idxResult.error) throw idxResult.error;

  return computePortfolioTimeline(
    (navResult.data ?? []) as RawNavRow[],
    (txResult.data ?? []) as RawTxRow[],
    (idxResult.data ?? []) as RawIdxRow[],
    funds,
    window,
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePortfolioTimeline(
  funds: FundRef[],
  userId: string | undefined,
  benchmarkSymbol: string,
  window: TimeWindow,
): PortfolioTimelineResult {
  const fundKey = funds
    .map((f) => f.id)
    .sort()
    .join(',');

  const { data, isLoading, error } = useQuery({
    queryKey: ['portfolioTimeline', userId, fundKey, benchmarkSymbol, window],
    enabled: funds.length > 0 && !!userId,
    queryFn: () => fetchPortfolioTimeline(funds, userId!, benchmarkSymbol, window),
    staleTime: STALE_TIMES.PORTFOLIO_TIMELINE,
  });

  return {
    portfolioPoints: data?.portfolioPoints ?? [],
    benchmarkPoints: data?.benchmarkPoints ?? [],
    xAxisLabels: data?.xAxisLabels ?? [],
    isLoading,
    error: error ? String(error) : null,
  };
}
