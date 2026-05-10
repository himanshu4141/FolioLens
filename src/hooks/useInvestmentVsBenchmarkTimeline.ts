import { useEffect } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { supabase } from '@/src/lib/supabase';
import { buildXAxisLabels } from '@/src/hooks/usePerformanceTimeline';
import { filterToWindow, type NavPoint, type TimeWindow } from '@/src/utils/navUtils';
import type { FundRef } from '@/src/hooks/usePortfolioTimeline';
import {
  buildBenchmarkLookup,
  filterReversedTransactionPairs,
  simulateBenchmarkInvestment,
} from '@/src/utils/xirr';
import { BENCHMARK_OPTIONS } from '@/src/store/appStore';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import {
  fetchIndexHistoryDirect,
  fetchIndexHistoryWithCache,
  fetchNavHistoryDirect,
  fetchNavHistoryWithCache,
} from '@/src/lib/sharedHistoryCache';

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

interface RawNavRow { scheme_code: number; nav_date: string; nav: number }
interface RawTxRow {
  fund_id: string;
  transaction_date: string;
  transaction_type: string;
  units: number;
  amount: number;
}
interface RawIdxRow { index_date: string; close_value: number }

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

function getInvestedAt(history: { date: string; investedValue: number }[], targetDate: string): number {
  return Math.max(0, getLatestAt(history, targetDate)?.investedValue ?? 0);
}

function getBenchmarkUnitsAt(history: { date: string; units: number }[], targetDate: string): number {
  return Math.max(0, getLatestAt(history, targetDate)?.units ?? 0);
}

function samplePoints(points: InvestmentVsBenchmarkPoint[], maxPoints = 90): InvestmentVsBenchmarkPoint[] {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const sampled = points.filter((_, index) => index % step === 0);
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1]?.date !== last.date) sampled.push(last);
  return sampled;
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

export function computeInvestmentVsBenchmarkTimeline(
  navRows: RawNavRow[],
  txRows: RawTxRow[],
  idxRows: RawIdxRow[],
  funds: FundRef[],
  window: TimeWindow,
): { points: InvestmentVsBenchmarkPoint[]; xAxisLabels: string[] } {
  if (funds.length === 0 || navRows.length === 0 || txRows.length === 0 || idxRows.length === 0) {
    return { points: [], xAxisLabels: [] };
  }

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

  const benchmarkValueAt = buildBenchmarkLookup(
    idxRows.map((row) => ({ date: row.index_date, value: row.close_value })),
  );

  const sortedTransactions = filterReversedTransactionPairs(txRows)
    .filter((tx) => fundIds.has(tx.fund_id))
    .sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));

  // Benchmark sim is shared with the portfolio's headline marketXirr — both
  // call simulateBenchmarkInvestment so the chart line and the alpha % can't
  // disagree on terminal value for the same inputs.
  const { unitsHistory: benchmarkUnitHistory } = simulateBenchmarkInvestment(
    sortedTransactions,
    benchmarkValueAt,
  );

  const unitHistory = new Map<string, { date: string; units: number }[]>();
  const investedHistory: { date: string; investedValue: number }[] = [];
  const fundUnits = new Map<string, number>();
  const fundCost = new Map<string, number>();
  let totalInvested = 0;

  for (const fund of funds) {
    unitHistory.set(fund.id, []);
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
    investedHistory.push({ date, investedValue: totalInvested });
    allDates.add(date);
  }

  const rawPoints: InvestmentVsBenchmarkPoint[] = [];
  for (const date of [...allDates].sort()) {
    let portfolioValue = 0;
    let hasPortfolioValue = false;

    for (const fund of funds) {
      const units = getUnitsAt(unitHistory.get(fund.id) ?? [], date);
      if (units <= 0) continue;
      const navPoint = getLatestAt(navHistoryByScheme.get(fund.schemeCode) ?? [], date);
      if (!navPoint) continue;
      portfolioValue += units * navPoint.value;
      hasPortfolioValue = true;
    }

    const benchmarkClose = benchmarkValueAt(date);
    const simulatedBenchmarkUnits = getBenchmarkUnitsAt(benchmarkUnitHistory, date);
    const investedValue = getInvestedAt(investedHistory, date);

    if (
      hasPortfolioValue &&
      portfolioValue > 0 &&
      investedValue > 0 &&
      benchmarkClose !== null &&
      simulatedBenchmarkUnits > 0
    ) {
      rawPoints.push({
        date,
        investedValue,
        portfolioValue,
        benchmarkValue: simulatedBenchmarkUnits * benchmarkClose,
      });
    }
  }

  const filteredPoints = filterToWindow(
    rawPoints.map((point) => ({ date: point.date, value: point.portfolioValue })),
    window,
  );
  const firstDate = filteredPoints[0]?.date;
  if (!firstDate) return { points: [], xAxisLabels: [] };

  const sampled = samplePoints(rawPoints.filter((point) => point.date >= firstDate));
  return {
    points: sampled,
    xAxisLabels: buildXAxisLabels(sampled.map((point) => point.date)),
  };
}

export async function fetchInvestmentVsBenchmarkTimeline(
  funds: FundRef[],
  userId: string,
  benchmarkSymbol: string,
  window: TimeWindow,
  qc?: QueryClient,
): Promise<{ points: InvestmentVsBenchmarkPoint[]; xAxisLabels: string[] }> {
  const fundIds = funds.map((fund) => fund.id);
  const schemeCodes = funds.map((fund) => fund.schemeCode);

  const txRows = await fetchAllTransactions(userId, fundIds);
  const firstTxDate = txRows[0]?.transaction_date;
  if (!firstTxDate) return { points: [], xAxisLabels: [] };

  const windowStart = getWindowStartDate(window);
  const navStartDate = windowStart ? laterDate(firstTxDate, windowStart) : firstTxDate;

  // Share the NAV / index cache with `usePortfolio` so a warm visit pays
  // zero network cost, and a stale revalidation only delta-fetches new
  // rows. Both fetchers return *full* history; we filter to the active
  // window in-memory below — the JS slice is microseconds, the network
  // savings are seconds on slow connections.
  const [allNavRows, allIdxRows] = await Promise.all([
    qc
      ? fetchNavHistoryWithCache(qc, userId, schemeCodes)
      : fetchNavHistoryDirect(schemeCodes),
    qc
      ? fetchIndexHistoryWithCache(qc, benchmarkSymbol)
      : fetchIndexHistoryDirect(benchmarkSymbol),
  ]);

  const navRows: RawNavRow[] = allNavRows.filter((row) => row.nav_date >= navStartDate);
  const idxRows: RawIdxRow[] = allIdxRows.filter((row) => row.index_date >= firstTxDate);

  return computeInvestmentVsBenchmarkTimeline(
    navRows,
    txRows,
    idxRows,
    funds,
    window,
  );
}

async function fetchAllTransactions(userId: string, fundIds: string[]): Promise<RawTxRow[]> {
  const rows: RawTxRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('transaction')
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

export function useInvestmentVsBenchmarkTimeline(
  funds: FundRef[],
  userId: string | undefined,
  benchmarkSymbol: string,
  window: TimeWindow,
): InvestmentVsBenchmarkTimeline {
  const fundKey = funds.map((fund) => fund.id).sort().join(',');
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['investmentVsBenchmarkTimeline', userId, fundKey, benchmarkSymbol, window],
    enabled: funds.length > 0 && !!userId,
    queryFn: () =>
      fetchInvestmentVsBenchmarkTimeline(
        funds,
        userId!,
        benchmarkSymbol,
        window,
        queryClient,
      ),
    staleTime: STALE_TIMES.INVESTMENT_VS_BENCHMARK,
  });

  // Once the active benchmark/window combo is in cache, prefetch the
  // other benchmarks for the same window in the background. This
  // covers the common case where the user lands on a fund detail and
  // then taps a different benchmark pill — the second tap hits a warm
  // cache. We deliberately do NOT prefetch every (benchmark x window)
  // combination: that would multiply by ~5 windows and burn server
  // round-trips for combos most users never look at. Window switching
  // remains a cold fetch.
  useEffect(() => {
    if (!data || !userId || funds.length === 0) return;
    for (const option of BENCHMARK_OPTIONS) {
      if (option.symbol === benchmarkSymbol) continue;
      queryClient.prefetchQuery({
        queryKey: ['investmentVsBenchmarkTimeline', userId, fundKey, option.symbol, window],
        queryFn: () =>
          fetchInvestmentVsBenchmarkTimeline(
            funds,
            userId,
            option.symbol,
            window,
            queryClient,
          ),
        staleTime: STALE_TIMES.INVESTMENT_VS_BENCHMARK,
      });
    }
  }, [data, userId, funds, fundKey, benchmarkSymbol, window, queryClient]);

  return {
    points: data?.points ?? [],
    xAxisLabels: data?.xAxisLabels ?? [],
    isLoading,
    error: error ? String(error) : null,
  };
}
