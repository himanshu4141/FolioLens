import { useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { transactionRepo } from '@/src/lib/data/transaction';
import { navHistoryRepo } from '@/src/lib/data/navHistory';
import { buildXAxisLabels } from '@/src/hooks/usePerformanceTimeline';
import { type NavPoint, type TimeWindow } from '@/src/utils/navUtils';
import type { FundRef } from '@/src/hooks/usePortfolioTimeline';
import {
  filterReversedTransactionPairs,
  simulateBenchmarkInvestmentFromNormalizedTransactions,
} from '@/src/utils/xirr';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { perfEnd, perfStart } from '@/src/lib/perfMark';
import {
  fetchIndexHistory,
  fetchIndexSnapshot,
  type IndexSnapshot,
} from '@/src/hooks/useIndexSnapshot';
import * as navRepo from '@/src/lib/db/nav';
import * as txRepo from '@/src/lib/db/tx';
import { SQLITE_AVAILABLE } from '@/src/lib/db/availability';
import {
  captureDatabaseWriteScope,
  isStaleDatabaseWriteError,
  type DatabaseWriteScope,
} from '@/src/lib/db/db';

/**
 * React Query key prefixes whose contents this hook's queryFn reads
 * directly via DB calls (not via `qc.fetchQuery`, so React Query's own
 * dependency tracking doesn't fire).
 *
 * **Cache audit finding #11.** When any of these inputs change in a
 * write path (CAS import, manual transaction entry, NAV/index sync),
 * the consumer must invalidate `'investmentVsBenchmarkTimeline'` along
 * with the input key — otherwise the chart's 1h cache keeps serving a
 * stale derived result while the inputs are fresh, and the chart
 * disagrees with Portfolio.
 *
 * Today the existing write paths are well-covered:
 * - `app/_layout.tsx` maps foreground SQLite changes through
 *   `src/lib/syncInvalidation.ts`, which marks this input and output
 *   stale without waking hidden screens.
 * - `app/(tabs)/settings/data-sync.tsx` manual refresh explicitly
 *   invalidates both `'investmentVsBenchmarkTimeline'` and the N2T
 *   `INVESTMENT_TIMELINE_INPUT_QUERY_KEY` along with the other derived
 *   caches.
 *
 * The constant is here for future contributors adding new write paths
 * (e.g. an in-app manual transaction entry UI). Import it and pass
 * each member to `queryClient.invalidateQueries({ queryKey: [key] })`
 * after the mutation succeeds. Keeps the dependency surface in one
 * place rather than relying on grep + comment archaeology.
 */
export const INVESTMENT_VS_BENCHMARK_INPUT_KEYS = [
  'user-transactions',
  'fund-nav-history',
  'index-snapshot',
] as const;

export const INVESTMENT_TIMELINE_INPUT_QUERY_KEY = 'investmentTimelineInputs';

export interface InvestmentVsBenchmarkPoint {
  date: string;
  investedValue: number;
  portfolioValue: number;
  benchmarkValue: number;
}

export interface InvestmentVsBenchmarkTimeline {
  points: InvestmentVsBenchmarkPoint[];
  xAxisLabels: string[];
  isLoading: boolean;
  error: string | null;
}

export interface RawNavRow { scheme_code: number; nav_date: string; nav: number }
export interface RawTxRow {
  fund_id: string;
  transaction_date: string;
  transaction_type: string;
  units: number;
  amount: number;
}
export interface RawIdxRow { index_date: string; close_value: number }

interface TimelineValuation {
  investedValue: number;
  portfolioValue: number;
  hasPortfolioValue: boolean;
}

export interface InvestmentTimelineInputs {
  funds: FundRef[];
  window: TimeWindow;
  firstTransactionDate: string | null;
  transactions: RawTxRow[];
  navRows: RawNavRow[];
  navHistoryByScheme: Map<number, NavPoint[]>;
  unitHistory: Map<string, { date: string; units: number }[]>;
  costHistory: Map<string, { date: string; cost: number }[]>;
  investedHistory: { date: string; investedValue: number }[];
  candidateDates: string[];
  portfolioValidDates: Set<string>;
  valuationByDate: Map<string, TimelineValuation>;
}

interface ComputedTimelineResult {
  points: InvestmentVsBenchmarkPoint[];
  xAxisLabels: string[];
  evaluationDateCount: number;
  valuationCacheHits: number;
  valuationCacheMisses: number;
}

const PAGE_SIZE = 1000;

function isInvestment(type: string): boolean {
  return type === 'purchase' || type === 'switch_in' || type === 'dividend_reinvest';
}

function isRedemption(type: string): boolean {
  return type === 'redemption' || type === 'switch_out';
}

function getLatestAt<T extends { date: string }>(history: T[], targetDate: string): T | null {
  let lo = 0;
  let hi = history.length - 1;
  let result: T | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].date <= targetDate) {
      result = history[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

function getUnitsAt(history: { date: string; units: number }[], targetDate: string): number {
  return Math.max(0, getLatestAt(history, targetDate)?.units ?? 0);
}

function getCostAt(history: { date: string; cost: number }[], targetDate: string): number {
  return Math.max(0, getLatestAt(history, targetDate)?.cost ?? 0);
}

function getInvestedAt(history: { date: string; investedValue: number }[], targetDate: string): number {
  return Math.max(0, getLatestAt(history, targetDate)?.investedValue ?? 0);
}

function monotonicLatestNumber<T>(
  history: T[],
  readDate: (row: T) => string,
  readValue: (row: T) => number,
): (targetDate: string) => number | null {
  let index = -1;
  let latest: number | null = null;
  return (targetDate: string) => {
    while (index + 1 < history.length && readDate(history[index + 1]) <= targetDate) {
      index += 1;
      latest = readValue(history[index]);
    }
    return latest;
  };
}

function sampleIndexes(length: number, maxPoints = 90): number[] {
  if (length <= 0) return [];
  if (length <= maxPoints) return Array.from({ length }, (_, index) => index);
  const step = Math.ceil(length / maxPoints);
  const sampled: number[] = [];
  for (let index = 0; index < length; index += step) sampled.push(index);
  if (sampled[sampled.length - 1] !== length - 1) sampled.push(length - 1);
  return sampled;
}

function buildPortfolioValidDates(
  funds: FundRef[],
  candidateDates: string[],
  navHistoryByScheme: Map<number, NavPoint[]>,
  unitHistory: Map<string, { date: string; units: number }[]>,
  costHistory: Map<string, { date: string; cost: number }[]>,
): Set<string> {
  const states = funds.map((fund) => ({
    unitsAt: monotonicLatestNumber(
      unitHistory.get(fund.id) ?? [],
      (row) => row.date,
      (row) => Math.max(0, row.units),
    ),
    navAt: monotonicLatestNumber(
      navHistoryByScheme.get(fund.schemeCode) ?? [],
      (row) => row.date,
      (row) => row.value,
    ),
    costAt: monotonicLatestNumber(
      costHistory.get(fund.id) ?? [],
      (row) => row.date,
      (row) => Math.max(0, row.cost),
    ),
  }));
  const validDates = new Set<string>();

  // Preserve the legacy pre-sampling portfolio guard without materializing a
  // valuation for every raw date. These monotonic cursors maintain only the
  // current scalar contribution for each fund; the expensive chart valuation
  // objects remain bounded to the sampled evaluation dates below.
  for (const date of candidateDates) {
    let portfolioValue = 0;
    let hasPortfolioValue = false;

    for (const state of states) {
      const units = state.unitsAt(date) ?? 0;
      if (units <= 0) continue;

      const nav = state.navAt(date);
      if (nav !== null) {
        portfolioValue += units * nav;
        hasPortfolioValue = true;
        continue;
      }

      const cost = state.costAt(date) ?? 0;
      if (cost > 0) {
        portfolioValue += cost;
        hasPortfolioValue = true;
      }
    }

    if (hasPortfolioValue && portfolioValue > 0) validDates.add(date);
  }

  return validDates;
}

function timelineOutputFundKey(funds: FundRef[]): string {
  return funds.map((fund) => fund.id).sort().join(',');
}

export function stableInvestmentTimelineFundKey(funds: FundRef[]): string {
  return funds
    .map((fund) => `${fund.id}:${fund.schemeCode}`)
    .sort()
    .join(',');
}

export function investmentTimelineInputQueryKey(
  funds: FundRef[],
  userId: string,
  window: TimeWindow,
): QueryKey {
  return [
    INVESTMENT_TIMELINE_INPUT_QUERY_KEY,
    userId,
    stableInvestmentTimelineFundKey(funds),
    window,
  ];
}

function getWindowStartDate(window: TimeWindow): string | null {
  if (window === 'All') return null;

  const today = new Date();
  const cutoff = new Date(today);
  switch (window) {
    case '1M': cutoff.setMonth(today.getMonth() - 1); break;
    case '3M': cutoff.setMonth(today.getMonth() - 3); break;
    case '6M': cutoff.setMonth(today.getMonth() - 6); break;
    case '1Y': cutoff.setFullYear(today.getFullYear() - 1); break;
    case '3Y': cutoff.setFullYear(today.getFullYear() - 3); break;
    case '5Y': cutoff.setFullYear(today.getFullYear() - 5); break;
    case '10Y': cutoff.setFullYear(today.getFullYear() - 10); break;
    case '15Y': cutoff.setFullYear(today.getFullYear() - 15); break;
  }
  return cutoff.toISOString().split('T')[0];
}

function laterDate(a: string, b: string): string {
  return a > b ? a : b;
}

function subtractDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

export function buildInvestmentTimelineInputs(
  navRows: RawNavRow[],
  txRows: RawTxRow[],
  funds: FundRef[],
  window: TimeWindow,
): InvestmentTimelineInputs {
  const stableFunds = [...funds].sort((a, b) => {
    const idOrder = a.id.localeCompare(b.id);
    return idOrder !== 0 ? idOrder : a.schemeCode - b.schemeCode;
  });
  const fundIds = new Set(funds.map((fund) => fund.id));
  const navHistoryByScheme = new Map<number, NavPoint[]>();
  const allDates = new Set<string>();
  for (const row of navRows) {
    const existing = navHistoryByScheme.get(row.scheme_code) ?? [];
    existing.push({ date: row.nav_date, value: row.nav });
    navHistoryByScheme.set(row.scheme_code, existing);
    allDates.add(row.nav_date);
  }
  for (const [schemeCode, history] of navHistoryByScheme) {
    navHistoryByScheme.set(
      schemeCode,
      history.sort((a, b) => a.date.localeCompare(b.date)),
    );
  }

  const sortedTransactions = filterReversedTransactionPairs(txRows)
    .filter((tx) => fundIds.has(tx.fund_id))
    .sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
  const unitHistory = new Map<string, { date: string; units: number }[]>();
  const costHistory = new Map<string, { date: string; cost: number }[]>();
  const investedHistory: { date: string; investedValue: number }[] = [];
  const fundUnits = new Map<string, number>();
  const fundCost = new Map<string, number>();
  let totalInvested = 0;

  for (const fund of stableFunds) {
    unitHistory.set(fund.id, []);
    costHistory.set(fund.id, []);
    fundUnits.set(fund.id, 0);
    fundCost.set(fund.id, 0);
  }

  for (const tx of sortedTransactions) {
    const date = tx.transaction_date;
    const previousUnits = fundUnits.get(tx.fund_id) ?? 0;
    const previousCost = fundCost.get(tx.fund_id) ?? 0;

    if (isInvestment(tx.transaction_type)) {
      const nextUnits = previousUnits + tx.units;
      const nextCost = previousCost + tx.amount;
      fundUnits.set(tx.fund_id, nextUnits);
      fundCost.set(tx.fund_id, nextCost);
      totalInvested += tx.amount;
    } else if (isRedemption(tx.transaction_type)) {
      const averageCost = previousUnits > 0 ? previousCost / previousUnits : 0;
      const costBasis = tx.units * averageCost;
      const nextUnits = Math.max(0, previousUnits - tx.units);
      const nextCost = Math.max(0, previousCost - costBasis);
      fundUnits.set(tx.fund_id, nextUnits);
      fundCost.set(tx.fund_id, nextCost);
      totalInvested = Math.max(0, totalInvested - costBasis);
    }

    unitHistory.get(tx.fund_id)!.push({ date, units: fundUnits.get(tx.fund_id) ?? 0 });
    costHistory.get(tx.fund_id)!.push({ date, cost: fundCost.get(tx.fund_id) ?? 0 });
    investedHistory.push({ date, investedValue: totalInvested });
    allDates.add(date);
  }

  const candidateDates = [...allDates].sort();
  return {
    funds: stableFunds,
    window,
    firstTransactionDate: txRows[0]?.transaction_date ?? null,
    transactions: sortedTransactions,
    navRows,
    navHistoryByScheme,
    unitHistory,
    costHistory,
    investedHistory,
    candidateDates,
    portfolioValidDates: buildPortfolioValidDates(
      stableFunds,
      candidateDates,
      navHistoryByScheme,
      unitHistory,
      costHistory,
    ),
    valuationByDate: new Map<string, TimelineValuation>(),
  };
}

function getTimelineValuation(
  inputs: InvestmentTimelineInputs,
  date: string,
): { valuation: TimelineValuation; cacheHit: boolean } {
  const cached = inputs.valuationByDate.get(date);
  if (cached) return { valuation: cached, cacheHit: true };

  let portfolioValue = 0;
  let hasPortfolioValue = false;

  for (const fund of inputs.funds) {
    const units = getUnitsAt(inputs.unitHistory.get(fund.id) ?? [], date);
    if (units <= 0) continue;
    const navPoint = getLatestAt(inputs.navHistoryByScheme.get(fund.schemeCode) ?? [], date);
    if (navPoint) {
      portfolioValue += units * navPoint.value;
      hasPortfolioValue = true;
      continue;
    }
    // No NAV on/before this date — typical for NFO close-ended funds in the
    // gap between subscription and allotment. Mark to cost so the early
    // commitment still shows on the chart instead of dropping the point.
    const costBasis = getCostAt(inputs.costHistory.get(fund.id) ?? [], date);
    if (costBasis > 0) {
      portfolioValue += costBasis;
      hasPortfolioValue = true;
    }
  }

  const valuation = {
    investedValue: getInvestedAt(inputs.investedHistory, date),
    portfolioValue,
    hasPortfolioValue,
  };
  inputs.valuationByDate.set(date, valuation);
  return { valuation, cacheHit: false };
}

export function computeInvestmentVsBenchmarkTimelineFromInputs(
  inputs: InvestmentTimelineInputs,
  idxRows: RawIdxRow[],
): ComputedTimelineResult {
  if (
    inputs.funds.length === 0 ||
    inputs.navRows.length === 0 ||
    inputs.transactions.length === 0 ||
    idxRows.length === 0
  ) {
    return {
      points: [],
      xAxisLabels: [],
      evaluationDateCount: 0,
      valuationCacheHits: 0,
      valuationCacheMisses: 0,
    };
  }

  const benchmarkRows = idxRows.every((row, index) => (
    index === 0 || idxRows[index - 1].index_date <= row.index_date
  ))
    ? idxRows
    : [...idxRows].sort((a, b) => a.index_date.localeCompare(b.index_date));

  // Benchmark sim is shared with the portfolio's headline marketXirr — both
  // call simulateBenchmarkInvestment so the chart line and the alpha % can't
  // disagree on terminal value for the same inputs.
  const { unitsHistory: benchmarkUnitHistory } = simulateBenchmarkInvestmentFromNormalizedTransactions(
    inputs.transactions,
    monotonicLatestNumber(
      benchmarkRows,
      (row) => row.index_date,
      (row) => row.close_value,
    ),
  );

  // The pre-N2T implementation filtered on positive portfolio, invested, and
  // benchmark values before sampling. Prepared input retains the exact
  // portfolio-valid set via a monotonic scalar sweep; combining it with the
  // inexpensive benchmark guards preserves that sampling contract while the
  // materialized valuation map remains bounded to the chart budget.
  const investedValueAt = monotonicLatestNumber(
    inputs.investedHistory,
    (row) => row.date,
    (row) => Math.max(0, row.investedValue),
  );
  const benchmarkValueAt = monotonicLatestNumber(
    benchmarkRows,
    (row) => row.index_date,
    (row) => row.close_value,
  );
  const benchmarkUnitsAt = monotonicLatestNumber(
    benchmarkUnitHistory,
    (row) => row.date,
    (row) => Math.max(0, row.units),
  );
  const validDates: string[] = [];
  const validBenchmarkCloses: number[] = [];
  const validBenchmarkUnits: number[] = [];
  for (const date of inputs.candidateDates) {
    const investedValue = investedValueAt(date) ?? 0;
    const benchmarkClose = benchmarkValueAt(date);
    const simulatedBenchmarkUnits = benchmarkUnitsAt(date) ?? 0;
    if (
      inputs.portfolioValidDates.has(date) &&
      investedValue > 0 &&
      benchmarkClose !== null &&
      simulatedBenchmarkUnits > 0
    ) {
      validDates.push(date);
      validBenchmarkCloses.push(benchmarkClose);
      validBenchmarkUnits.push(simulatedBenchmarkUnits);
    }
  }

  const windowStart = getWindowStartDate(inputs.window);
  const firstVisibleIndex = windowStart === null
    ? 0
    : validDates.findIndex((date) => date >= windowStart);
  const windowOffset = firstVisibleIndex >= 0 ? firstVisibleIndex : 0;
  const windowLength = validDates.length - windowOffset;
  if (windowLength <= 0) {
    return {
      points: [],
      xAxisLabels: [],
      evaluationDateCount: 0,
      valuationCacheHits: 0,
      valuationCacheMisses: 0,
    };
  }

  const evaluationIndexes = sampleIndexes(windowLength)
    .map((index) => index + windowOffset);
  const points: InvestmentVsBenchmarkPoint[] = [];
  let valuationCacheHits = 0;
  let valuationCacheMisses = 0;

  for (const evaluationIndex of evaluationIndexes) {
    const date = validDates[evaluationIndex];
    const { valuation, cacheHit } = getTimelineValuation(inputs, date);
    if (cacheHit) valuationCacheHits += 1;
    else valuationCacheMisses += 1;

    const benchmarkClose = validBenchmarkCloses[evaluationIndex] ?? null;
    const simulatedBenchmarkUnits = validBenchmarkUnits[evaluationIndex] ?? 0;

    if (
      valuation.hasPortfolioValue &&
      valuation.portfolioValue > 0 &&
      valuation.investedValue > 0 &&
      benchmarkClose !== null &&
      simulatedBenchmarkUnits > 0
    ) {
      points.push({
        date,
        investedValue: valuation.investedValue,
        portfolioValue: valuation.portfolioValue,
        benchmarkValue: simulatedBenchmarkUnits * benchmarkClose,
      });
    }
  }

  return {
    points,
    xAxisLabels: buildXAxisLabels(points.map((point) => point.date)),
    evaluationDateCount: evaluationIndexes.length,
    valuationCacheHits,
    valuationCacheMisses,
  };
}

export function computeInvestmentVsBenchmarkTimeline(
  navRows: RawNavRow[],
  txRows: RawTxRow[],
  idxRows: RawIdxRow[],
  funds: FundRef[],
  window: TimeWindow,
): { points: InvestmentVsBenchmarkPoint[]; xAxisLabels: string[] } {
  const result = computeInvestmentVsBenchmarkTimelineFromInputs(
    buildInvestmentTimelineInputs(navRows, txRows, funds, window),
    idxRows,
  );
  return { points: result.points, xAxisLabels: result.xAxisLabels };
}

export async function fetchInvestmentTimelineInputs(
  funds: FundRef[],
  userId: string,
  window: TimeWindow,
): Promise<InvestmentTimelineInputs> {
  const inputSpanId = perfStart('query:timeline:inputs');
  const writeScope = captureDatabaseWriteScope();
  const fundIds = funds.map((fund) => fund.id);
  const schemeCodes = funds.map((fund) => fund.schemeCode);

  const txSpanId = perfStart('query:timeline:transactions');
  const txRows = await fetchAllTransactions(userId, fundIds);
  perfEnd(txSpanId, { rows: txRows.length });
  const firstTxDate = txRows[0]?.transaction_date;
  if (!firstTxDate) {
    const empty = buildInvestmentTimelineInputs([], txRows, funds, window);
    perfEnd(inputSpanId, { tx_rows: txRows.length, nav_rows: 0, reason: 'no_txs' });
    return empty;
  }

  const windowStart = getWindowStartDate(window);
  // Pull NAV data 7 days before the visible window so `getLatestAt` can
  // always find the most-recent trading-day NAV even when the window
  // boundary falls on a weekend or public holiday. Without this buffer,
  // a Sunday startDate produces a null NAV lookup → mark-to-cost for
  // that first point. 7 days covers any national holiday run.
  const navFetchStart = windowStart ? subtractDays(windowStart, 7) : null;
  const navStartDate = navFetchStart ? laterDate(firstTxDate, navFetchStart) : firstTxDate;

  // Window-bounded SQL fetches. An earlier iteration of this hook routed
  // through a shared cache layer and pulled *all* history, then filtered
  // in-memory — fine for warm cache but ~8s of cold-load pagination over
  // 12k+ NAV rows + a long-history TRI index. The bounded SELECTs trim
  // both round-trip count and payload size: on the "1Y" window a 10-fund
  // portfolio touches < 3 NAV pages instead of ~13.
  const navSpanId = perfStart('query:timeline:nav');
  const navRows = await fetchAllNavRows(schemeCodes, navStartDate, writeScope);
  perfEnd(navSpanId, { rows: navRows.length, since: navStartDate });

  const inputs = buildInvestmentTimelineInputs(navRows, txRows, funds, window);
  perfEnd(inputSpanId, {
    tx_rows: txRows.length,
    nav_rows: navRows.length,
    candidate_dates: inputs.candidateDates.length,
    window,
  });
  return inputs;
}

export async function fetchInvestmentVsBenchmarkTimeline(
  funds: FundRef[],
  userId: string,
  benchmarkSymbol: string,
  window: TimeWindow,
  inputQueryClient?: QueryClient,
): Promise<{ points: InvestmentVsBenchmarkPoint[]; xAxisLabels: string[] }> {
  const timelineSpanId = perfStart('query:timeline');
  const inputKey = investmentTimelineInputQueryKey(funds, userId, window);
  const inputState = inputQueryClient?.getQueryState<InvestmentTimelineInputs>(inputKey);
  const inputCacheHit = inputState?.data !== undefined &&
    Date.now() - inputState.dataUpdatedAt < STALE_TIMES.INVESTMENT_VS_BENCHMARK;
  const inputs = inputQueryClient
    ? await inputQueryClient.fetchQuery({
      queryKey: inputKey,
      queryFn: () => fetchInvestmentTimelineInputs(funds, userId, window),
      staleTime: STALE_TIMES.INVESTMENT_VS_BENCHMARK,
    })
    : await fetchInvestmentTimelineInputs(funds, userId, window);

  if (!inputs.firstTransactionDate) {
    perfEnd(timelineSpanId, {
      points: 0,
      reason: 'no_txs',
      input_cache_hit: inputCacheHit,
      tx_rows: inputs.transactions.length,
      nav_rows: inputs.navRows.length,
      window,
      symbol: benchmarkSymbol,
    });
    return { points: [], xAxisLabels: [] };
  }

  const indexSpanId = perfStart('query:timeline:index');
  const { rows: idxRows, cacheHit: indexCacheHit } = await fetchAllIndexRows(
    benchmarkSymbol,
    inputs.firstTransactionDate,
    inputQueryClient,
  );
  perfEnd(indexSpanId, {
    rows: idxRows.length,
    symbol: benchmarkSymbol,
    since: inputs.firstTransactionDate,
  });

  const result = computeInvestmentVsBenchmarkTimelineFromInputs(
    inputs,
    idxRows,
  );
  perfEnd(timelineSpanId, {
    points: result.points.length,
    input_cache_hit: inputCacheHit,
    tx_rows: inputs.transactions.length,
    nav_rows: inputs.navRows.length,
    idx_rows: idxRows.length,
    index_cache_hit: indexCacheHit,
    candidate_dates: inputs.candidateDates.length,
    evaluation_dates: result.evaluationDateCount,
    valuation_cache_hits: result.valuationCacheHits,
    valuation_cache_misses: result.valuationCacheMisses,
    window,
    symbol: benchmarkSymbol,
  });
  return { points: result.points, xAxisLabels: result.xAxisLabels };
}

async function fetchAllTransactions(userId: string, fundIds: string[]): Promise<RawTxRow[]> {
  if (SQLITE_AVAILABLE) {
    try {
      const cached = await txRepo.readByFundIds(fundIds);
      // Only use SQLite if every requested fund has at least one transaction row.
      // A partial hit means a recently-added fund hasn't been bootstrapped yet —
      // fall through to Supabase so the computation uses the complete set.
      if (cached.length > 0) {
        const coveredFunds = new Set(cached.map((r) => r.fund_id));
        if (fundIds.every((id) => coveredFunds.has(id))) return cached;
      }
    } catch (err) {
      console.warn('[timeline] sqlite tx read failed', err);
    }
  }

  const rows: RawTxRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await transactionRepo
      .from()
      .select('fund_id, transaction_date, transaction_type, units, amount')
      .eq('user_id', userId)
      .in('fund_id', fundIds)
      .order('transaction_date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    rows.push(...((data ?? []) as RawTxRow[]));
    if ((data ?? []).length < PAGE_SIZE) break;
  }
  return rows;
}

export async function repairTimelineNavCache(
  rows: RawNavRow[],
  writeScope: DatabaseWriteScope = captureDatabaseWriteScope(),
): Promise<void> {
  const cacheRows = rows.map((row) => ({
    scheme_code: row.scheme_code,
    nav_date: row.nav_date,
    nav: row.nav,
  }));

  try {
    await navRepo.bulkInsert(cacheRows, {
      scope: writeScope,
      operation: 'timeline_nav_repair',
      attempt: 1,
    });
  } catch (error) {
    // Cleanup invalidation is intentional cancellation, not a transient
    // SQLite failure. Retrying the same stale scope cannot be correct.
    if (isStaleDatabaseWriteError(error)) throw error;
    console.warn('[timeline] sqlite nav repair retrying', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Retain and reuse the rows fetched by this query. A queue rejection
    // must not force another paginated network read merely to repair SQLite.
    await navRepo.bulkInsert(cacheRows, {
      scope: writeScope,
      operation: 'timeline_nav_repair_retry',
      attempt: 2,
    });
  }
}

async function fetchAllNavRows(
  schemeCodes: number[],
  startDate: string,
  writeScope: DatabaseWriteScope,
): Promise<RawNavRow[]> {
  if (schemeCodes.length === 0) return [];

  if (SQLITE_AVAILABLE) {
    try {
      const cached = await navRepo.readBySchemeCodes(schemeCodes, { sinceDate: startDate });
      // Only use SQLite if every requested scheme has at least one row.
      // A partial hit (rows for some schemes but not others) means a recently-
      // added fund has no local NAV history yet — falling through to Supabase
      // gets the full picture and the write-back populates SQLite for next time.
      if (cached.length > 0) {
        const coveredSchemes = new Set(cached.map((r) => r.scheme_code));
        if (schemeCodes.every((code) => coveredSchemes.has(code))) {
          // Also verify the data covers the requested start date. SQLite may have
          // rows for all schemes but only from a more recent date (e.g. the day
          // bootstrap first ran on a fresh install). A gap between startDate and
          // the earliest available row triggers "mark to cost" for that period,
          // producing a visible step-jump when real NAV values first appear.
          //
          // The caller already extends startDate 7 days before the visible window
          // so `getLatestAt` has a floor NAV for non-trading-day boundaries. That
          // means a normal 2-day weekend gap appears as a 2-day miss here — well
          // within the 3-day tolerance. A holiday week (e.g. Christmas–New Year)
          // can produce a 9+-day gap that exceeds the threshold, triggering a
          // one-time Supabase fetch whose write-back fills the gap permanently.
          const earliestDate = cached[0].nav_date; // sorted ASC — guaranteed by readBySchemeCodes
          const gapMs = new Date(earliestDate).getTime() - new Date(startDate).getTime();
          if (gapMs <= 3 * 24 * 60 * 60 * 1000) return cached;
        }
      }
    } catch (err) {
      console.warn('[timeline] sqlite nav read failed', err);
    }
  }

  const rows: RawNavRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await navHistoryRepo
      .from()
      .select('scheme_code, nav_date, nav')
      .in('scheme_code', schemeCodes)
      .gte('nav_date', startDate)
      .order('nav_date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    rows.push(...((data ?? []) as RawNavRow[]));
    if ((data ?? []).length < PAGE_SIZE) break;
  }

  if (SQLITE_AVAILABLE && rows.length > 0) {
    await repairTimelineNavCache(rows, writeScope);
  }

  return rows;
}

async function fetchAllIndexRows(
  benchmarkSymbol: string,
  startDate: string,
  indexQueryClient?: QueryClient,
): Promise<{ rows: RawIdxRow[]; cacheHit: boolean }> {
  if (!benchmarkSymbol) return { rows: [], cacheHit: false };

  // Reuse the canonical persisted index-snapshot entry across timeline
  // windows. Before N2T, every unseen benchmark+window fetched and parsed the
  // same full snapshot again, which left a nominal input-cache hit spending
  // seconds in benchmark I/O. The cached payload is the existing
  // `IndexSnapshot` shape owned by useIndexSnapshot — no new persisted shape.
  if (indexQueryClient) {
    const key = ['index-snapshot', benchmarkSymbol] as const;
    const state = indexQueryClient.getQueryState<IndexSnapshot | null>(key);
    const cacheHit = state?.data != null &&
      Date.now() - state.dataUpdatedAt < STALE_TIMES.INDEX_HISTORY;
    const snapshot = await indexQueryClient.fetchQuery({
      queryKey: key,
      queryFn: () => fetchIndexSnapshot(benchmarkSymbol),
      staleTime: STALE_TIMES.INDEX_HISTORY,
    });
    if (snapshot) {
      return {
        rows: snapshot.points
          .filter((point) => point.date >= startDate)
          .map((point) => ({ index_date: point.date, close_value: point.value })),
        cacheHit,
      };
    }
  }

  // Snapshot failure retains the existing paginated fallback behavior.
  const points = await fetchIndexHistory(benchmarkSymbol, startDate);
  return {
    rows: points.map((point) => ({ index_date: point.date, close_value: point.value })),
    cacheHit: false,
  };
}

export function useInvestmentVsBenchmarkTimeline(
  funds: FundRef[],
  userId: string | undefined,
  benchmarkSymbol: string,
  window: TimeWindow,
  options: { enabled?: boolean } = {},
): InvestmentVsBenchmarkTimeline {
  const queryClient = useQueryClient();
  const fundKey = timelineOutputFundKey(funds);
  const { data, isLoading, error } = useQuery({
    queryKey: ['investmentVsBenchmarkTimeline', userId, fundKey, benchmarkSymbol, window],
    enabled: (options.enabled ?? true) && funds.length > 0 && !!userId,
    queryFn: () =>
      fetchInvestmentVsBenchmarkTimeline(funds, userId!, benchmarkSymbol, window, queryClient),
    staleTime: STALE_TIMES.INVESTMENT_VS_BENCHMARK,
  });

  return {
    points: data?.points ?? [],
    xAxisLabels: data?.xAxisLabels ?? [],
    isLoading,
    error: error ? String(error) : null,
  };
}

export function prefetchInvestmentVsBenchmarkTimeline(
  queryClient: QueryClient,
  funds: FundRef[],
  userId: string,
  benchmarkSymbol: string,
  window: TimeWindow,
): Promise<void> {
  const fundKey = timelineOutputFundKey(funds);
  return queryClient.prefetchQuery({
    queryKey: ['investmentVsBenchmarkTimeline', userId, fundKey, benchmarkSymbol, window],
    queryFn: () => fetchInvestmentVsBenchmarkTimeline(
      funds,
      userId,
      benchmarkSymbol,
      window,
      queryClient,
    ),
    staleTime: STALE_TIMES.INVESTMENT_VS_BENCHMARK,
  });
}
