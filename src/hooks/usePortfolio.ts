/**
 * usePortfolio — loads the user's portfolio data for the Home Screen.
 *
 * Fetches all active funds for the current user, their latest NAV,
 * yesterday's NAV (for daily movement), and all transactions (for XIRR).
 *
 * Returns:
 *  - fundCards: per-fund display data (name, current value, daily change, return)
 *  - portfolioTotal: sum of all fund current values
 *  - dailyChange: total daily change in INR and %
 *  - portfolioXirr: overall portfolio XIRR using all transactions
 *  - vsMarket: portfolio XIRR vs selected benchmark XIRR over same period
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { navHistoryRepo } from '@/src/lib/data/navHistory';
import {
  xirr,
  buildCashflowsFromNormalizedTransactions,
  buildBenchmarkLookup,
  computeBenchmarkXirrFromNormalizedTransactions,
  computeRealizedGainsFromNormalizedTransactions,
  filterReversedTransactionPairs,
  type Cashflow,
  type Transaction,
} from '@/src/utils/xirr';
import { isMaturedScheme } from '@/src/utils/navUtils';
import { useSession } from '@/src/hooks/useSession';
import { useAppStore } from '@/src/store/appStore';
import { PREVIEW_FUND_CARDS, PREVIEW_PORTFOLIO_SUMMARY } from '@/src/lib/previewData';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { perfEnd, perfStart } from '@/src/lib/perfMark';
import { fetchUserFunds, type UserFundRow } from '@/src/hooks/useUserFunds';
import { fetchUserTransactions, type UserTransactionRow } from '@/src/hooks/useUserTransactions';
import { fetchIndexHistory } from '@/src/hooks/useIndexSnapshot';
import * as navRepo from '@/src/lib/db/nav';
import * as idxRepo from '@/src/lib/db/idx';
import { SQLITE_AVAILABLE } from '@/src/lib/db/availability';
import { captureDatabaseWriteScope } from '@/src/lib/db/db';
import {
  transactionFreshnessFromRows,
  type TransactionFreshnessMarker,
} from '@/src/lib/transactionFreshness';

interface NavRow {
  scheme_code: number;
  nav_date: string;
  nav: number;
}

interface IndexRow {
  index_date: string;
  close_value: number;
}

export interface FundCardData {
  id: string;
  schemeName: string;
  schemeCategory: string;
  schemeCode: number;
  currentNav: number | null;
  previousNav: number | null;
  // ISO date of the NAV that `currentNav` came from. Per-fund (not
  // portfolio-wide) so the UI can show "as of …" labels that respect
  // each AMC's publishing cadence — HDFC/ICICI/DSP land their EOD NAV
  // hours before PPFAS / international FoFs.
  currentNavDate: string | null;
  currentUnits: number;
  currentValue: number | null;
  investedAmount: number;
  dailyChangeAmount: number | null;
  dailyChangePct: number | null;
  returnXirr: number;
  realizedGain: number;
  realizedAmount: number;
  redeemedUnits: number;
  navHistory30d: { date: string; value: number }[];
  navUnavailable?: true;
  schemeActive: boolean | null;
}

export interface PortfolioSummary {
  totalValue: number;
  totalInvested: number;
  dailyChangeAmount: number;
  dailyChangePct: number;
  xirr: number;
  marketXirr: number;
  benchmarkSymbol: string;
  latestNavDate: string | null; // ISO date of most-recent NAV across all non-matured holdings
  navUnavailableCount: number; // funds with no NAV data, excluded from totals
}

export interface PortfolioData {
  fundCards: FundCardData[];
  summary: PortfolioSummary | null;
  transactionFreshness?: TransactionFreshnessMarker;
}

export type PortfolioQueryKey = readonly ['portfolio', string, string];
export type PortfolioCoreQueryKey = readonly ['portfolio-core', string];
export type PortfolioBenchmarkQueryKey = readonly ['portfolio-benchmark', string, string];

export interface PortfolioCoreSummary {
  totalValue: number;
  totalInvested: number;
  dailyChangeAmount: number;
  dailyChangePct: number;
  xirr: number;
  latestNavDate: string | null;
  navUnavailableCount: number;
}

export interface PortfolioCoreData {
  fundCards: FundCardData[];
  summary: PortfolioCoreSummary | null;
  benchmarkTransactions: Transaction[];
  firstTransactionDate: string | null;
  terminalDateIso: string;
  totalTransactionCount: number;
  navRowCount: number;
  transactionFreshness: TransactionFreshnessMarker;
}

export interface PortfolioBenchmarkData {
  benchmarkSymbol: string;
  marketXirr: number;
  indexRowCount: number;
}

export interface CachedPortfolioWeight {
  percentage: number;
  rank: number | null;
  totalValue: number;
}

interface PortfolioFundRow {
  id: string;
  scheme_code: number;
  scheme_name: string;
  scheme_category: string | null;
  benchmark_index_symbol: string | null;
}

function isPortfolioFundRow(row: UserFundRow): row is UserFundRow & PortfolioFundRow {
  return !!row && !!row.id && row.scheme_code != null && !!row.scheme_name;
}

function compareBenchmarkTransactions(a: UserTransactionRow, b: UserTransactionRow): number {
  const byDate = a.transaction_date.localeCompare(b.transaction_date);
  if (byDate !== 0) return byDate;

  const byCreatedAt = String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
  if (byCreatedAt !== 0) return byCreatedAt;

  const byId = String(a.id ?? '').localeCompare(String(b.id ?? ''));
  if (byId !== 0) return byId;

  const byFund = a.fund_id.localeCompare(b.fund_id);
  if (byFund !== 0) return byFund;

  const byType = a.transaction_type.localeCompare(b.transaction_type);
  if (byType !== 0) return byType;

  const byAmount = a.amount - b.amount;
  if (byAmount !== 0) return byAmount;

  return a.units - b.units;
}

export function portfolioQueryKey(userId: string, benchmarkSymbol: string): PortfolioQueryKey {
  return ['portfolio', userId, benchmarkSymbol];
}

export function portfolioCoreQueryKey(userId: string): PortfolioCoreQueryKey {
  return ['portfolio-core', userId];
}

export function portfolioBenchmarkQueryKey(
  userId: string,
  benchmarkSymbol: string,
): PortfolioBenchmarkQueryKey {
  return ['portfolio-benchmark', userId, benchmarkSymbol];
}

function composePortfolioData(
  core: PortfolioCoreData,
  benchmark: PortfolioBenchmarkData,
): PortfolioData {
  return {
    fundCards: core.fundCards,
    summary: core.summary
      ? {
        ...core.summary,
        marketXirr: benchmark.marketXirr,
        benchmarkSymbol: benchmark.benchmarkSymbol,
      }
      : null,
    transactionFreshness: core.transactionFreshness,
  };
}

export async function fetchPortfolioCoreData(
  qc: QueryClient,
  userId: string,
): Promise<PortfolioCoreData> {
  const portfolioSpanId = perfStart('query:portfolio:core');
  const writeScope = captureDatabaseWriteScope();

  // Shared user-funds and user-transactions caches. Other screens (Fund
  // Detail, Money Trail, etc.) read from these same keys, so once one
  // screen has loaded them, the others paint without a network round-
  // trip. `fetchQuery` is a cache-or-fetch operation: if the entry is
  // fresh per its staleTime, it returns instantly from memory.
  const [allFunds, allTxs] = await Promise.all([
    qc.fetchQuery({
      queryKey: ['user-funds', userId],
      queryFn: () => fetchUserFunds(userId),
      staleTime: STALE_TIMES.USER_FUNDS,
    }),
    qc.fetchQuery({
      queryKey: ['user-transactions', userId],
      queryFn: () => fetchUserTransactions(userId),
      staleTime: STALE_TIMES.USER_TRANSACTIONS,
    }),
  ]);
  const transactionFreshness = transactionFreshnessFromRows(allTxs);

  // Portfolio renders active funds only; inactive rows still live in the
  // shared cache for Money Trail / historical views.
  const validFunds = allFunds.filter((f) => f.is_active === true).filter(isPortfolioFundRow);
  if (!validFunds.length) {
    perfEnd(portfolioSpanId, { funds: 0, txs: 0, navs: 0, idxs: 0 });
    return {
      fundCards: [],
      summary: null,
      benchmarkTransactions: [],
      firstTransactionDate: allTxs[0]?.transaction_date ?? null,
      terminalDateIso: new Date().toISOString(),
      totalTransactionCount: allTxs.length,
      navRowCount: 0,
      transactionFreshness,
    };
  }

  // Group and reversal-filter transactions by fund_id once. Downstream
  // holdings, realized gains, XIRR, and benchmark simulation reuse these same
  // arrays instead of each helper repeating reversal-pair detection.
  const txByFund = new Map<string, UserTransactionRow[]>();
  for (const tx of allTxs) {
    const existing = txByFund.get(tx.fund_id) ?? [];
    existing.push(tx);
    txByFund.set(tx.fund_id, existing);
  }
  const normalizedTxByFund = new Map<string, UserTransactionRow[]>();
  const normalizedTxSet = new Set<UserTransactionRow>();
  for (const fund of validFunds) {
    const normalizedTxs = filterReversedTransactionPairs(txByFund.get(fund.id) ?? []);
    normalizedTxByFund.set(fund.id, normalizedTxs);
    for (const tx of normalizedTxs) normalizedTxSet.add(tx);
  }
  const validFundIds = new Set(validFunds.map((fund) => fund.id));
  const benchmarkTransactions = allTxs
    .filter((tx) => validFundIds.has(tx.fund_id) && normalizedTxSet.has(tx))
    .sort(compareBenchmarkTransactions);

  const schemeCodes = validFunds.map((f) => f.scheme_code);

  // Load *recent* NAV history. The portfolio screen only uses the most-
  // recent NAV (for current value), the previous trading day's NAV (for
  // daily change), and the last 30 days for sparklines. 90 days of buffer
  // covers long weekends and holidays so the "previous NAV" always
  // resolves to the prior trading day even after an Indian market break.
  //
  // Read-through SQLite — the on-device cache holds full history when
  // the bootstrap has run, and the 90-day window is a cheap
  // `BETWEEN`-style SELECT against the local index. On a cold start
  // (cache empty for this scheme) we fall through to Supabase, write
  // the response into SQLite, and continue.
  const navCutoff = new Date();
  navCutoff.setDate(navCutoff.getDate() - 90);
  const navCutoffIso = navCutoff.toISOString().split('T')[0];
  const navSpanId = perfStart('query:portfolio:nav');
  let navRows: NavRow[] = [];
  let navSource: 'sqlite' | 'supabase' = 'sqlite';
  if (SQLITE_AVAILABLE) {
    try {
      navRows = await navRepo.readBySchemeCodes(schemeCodes, {
        sinceDate: navCutoffIso,
        orderDesc: true,
      });
    } catch (err) {
      console.warn('[usePortfolio] sqlite nav read failed; falling back', err);
    }
  }
  if (navRows.length === 0) {
    navSource = 'supabase';
    const { data: navRowsRaw, error: navError } = await navHistoryRepo
      .from()
      .select('scheme_code, nav_date, nav')
      .in('scheme_code', schemeCodes)
      .gte('nav_date', navCutoffIso)
      .order('nav_date', { ascending: false });
    if (navError) throw navError;
    navRows = (navRowsRaw ?? []) as NavRow[];
    if (navRows.length > 0 && SQLITE_AVAILABLE) {
      try {
        await navRepo.bulkInsert(navRows, {
          scope: writeScope,
          operation: 'portfolio_nav_write_back',
        });
      } catch (err) {
        console.warn('[usePortfolio] sqlite nav write failed', err);
      }
    }
  }
  perfEnd(navSpanId, { rows: navRows.length, source: navSource });

  // Build map: scheme_code → { current, previous } using the two most-recent rows.
  const navByScheme = new Map<number, { current: number; previous: number; date: string }>();
  for (const row of [...(navRows ?? [])].sort((a, b) =>
    String(b.nav_date).localeCompare(String(a.nav_date)),
  )) {
    const code = row.scheme_code as number;
    const existing = navByScheme.get(code);
    if (!existing) {
      navByScheme.set(code, { current: row.nav as number, previous: row.nav as number, date: row.nav_date as string });
    } else if (existing.current === existing.previous) {
      // second row = previous trading day's NAV
      navByScheme.set(code, { ...existing, previous: row.nav as number });
    }
  }

  // Build sparkline history map (rows came descending — reverse to ascending for rendering)
  const navHistoryByScheme = new Map<number, { date: string; value: number }[]>();
  for (const row of [...(navRows ?? [])].sort((a, b) =>
    String(b.nav_date).localeCompare(String(a.nav_date)),
  )) {
    const code = row.scheme_code as number;
    const pts = navHistoryByScheme.get(code) ?? [];
    pts.push({ date: row.nav_date as string, value: row.nav as number });
    navHistoryByScheme.set(code, pts);
  }
  for (const [code, pts] of navHistoryByScheme) {
    navHistoryByScheme.set(code, [...pts].reverse());
  }

  // Slice sparkline data to the last 30 days (rows are now ascending; keep only recent)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const navCutoff30d = thirtyDaysAgo.toISOString().split('T')[0];
  for (const [code, pts] of navHistoryByScheme) {
    navHistoryByScheme.set(code, pts.filter((p) => p.date >= navCutoff30d));
  }

  const firstTxDate = allTxs[0]?.transaction_date ?? null;
  const terminalDate = new Date();

  // Compute per-fund card data
  const fundCards: FundCardData[] = [];
  let portfolioTotalValue = 0;
  let portfolioTotalPreviousValue = 0;
  let portfolioTotalInvested = 0;
  let navUnavailableCount = 0;

  const allCashflows: Cashflow[] = [];

  for (const fund of validFunds) {
    const navInfo = navByScheme.get(fund.scheme_code);
    const txs = normalizedTxByFund.get(fund.id) ?? [];
    const schemeActive = fund.scheme_active ?? null;

    if (txs.length === 0) continue;

    if (!navInfo) {
      // NAV sync hasn't run for this scheme yet — show a pending card so the user
      // can see their holding rather than having it silently disappear.
      console.warn(`[usePortfolio] no NAV data for scheme ${fund.scheme_code} — showing pending card`);
      const { netUnits, investedAmount } = buildCashflowsFromNormalizedTransactions(
        txs,
        0,
        terminalDate,
      );
      if (netUnits < 0.001) continue; // skip fully-exited funds
      const { realizedGain, realizedAmount, redeemedUnits } =
        computeRealizedGainsFromNormalizedTransactions(txs);
      navUnavailableCount++;
      fundCards.push({
        id: fund.id,
        schemeName: fund.scheme_name,
        schemeCategory: fund.scheme_category ?? '',
        schemeCode: fund.scheme_code,
        currentNav: null,
        previousNav: null,
        currentNavDate: null,
        currentUnits: netUnits,
        currentValue: null,
        investedAmount,
        dailyChangeAmount: null,
        dailyChangePct: null,
        returnXirr: NaN,
        realizedGain,
        realizedAmount,
        redeemedUnits,
        navHistory30d: [],
        navUnavailable: true,
        schemeActive,
      });
      continue;
    }

    // First pass: get netUnits and historical cashflows (currentValue unknown yet)
    const { historicalCashflows, netUnits, investedAmount } = buildCashflowsFromNormalizedTransactions(
      txs,
      0,
      terminalDate,
    );

    if (netUnits < 0.001) continue; // skip fully-exited funds (guards against floating-point residuals)

    const currentValue = netUnits * navInfo.current;
    const previousValue = netUnits * navInfo.previous;
    const dailyChangeAmount = currentValue - previousValue;
    const dailyChangePct = previousValue > 0 ? (dailyChangeAmount / previousValue) * 100 : 0;

    // Accumulate historical cashflows for portfolio-level XIRR
    allCashflows.push(...historicalCashflows);

    // Build fund-level XIRR cashflows with terminal inflow
    const { xirrCashflows: fundXirrFlows } = buildCashflowsFromNormalizedTransactions(
      txs,
      currentValue,
      terminalDate,
    );
    const fundXirr = xirr(fundXirrFlows);

    // Realized gains for partially/fully redeemed funds
    const { realizedGain, realizedAmount, redeemedUnits } =
      computeRealizedGainsFromNormalizedTransactions(txs);

    fundCards.push({
      id: fund.id,
      schemeName: fund.scheme_name,
      schemeCategory: fund.scheme_category ?? '',
      schemeCode: fund.scheme_code,
      currentNav: navInfo.current,
      previousNav: navInfo.previous,
      currentNavDate: navInfo.date,
      currentUnits: netUnits,
      currentValue,
      investedAmount,
      dailyChangeAmount,
      dailyChangePct,
      returnXirr: fundXirr,
      realizedGain,
      realizedAmount,
      redeemedUnits,
      navHistory30d: navHistoryByScheme.get(fund.scheme_code) ?? [],
      schemeActive,
    });

    portfolioTotalValue += currentValue;
    portfolioTotalPreviousValue += previousValue;
    portfolioTotalInvested += investedAmount;
  }

  // Portfolio-level XIRR
  const portfolioDailyChange = portfolioTotalValue - portfolioTotalPreviousValue;
  const portfolioDailyChangePct =
    portfolioTotalPreviousValue > 0
      ? (portfolioDailyChange / portfolioTotalPreviousValue) * 100
      : 0;

  const portfolioXirrFlows: Cashflow[] = [
    ...allCashflows,
    { date: terminalDate, amount: portfolioTotalValue },
  ];
  const portfolioXirrRate = allCashflows.length > 0 ? xirr(portfolioXirrFlows) : NaN;

  // Exclude matured/inactive schemes from the freshness date so a frozen
  // NAV (e.g. a matured FMP from 2021) doesn't suppress the "as of today"
  // label when all live holdings are actually current.
  const maturedCodes = new Set(
    validFunds
      .filter((f) => isMaturedScheme(f.scheme_active ?? null, f.scheme_name ?? ''))
      .map((f) => f.scheme_code),
  );
  const latestNavDate =
    [...navByScheme.entries()]
      .filter(([code]) => !maturedCodes.has(code))
      .map(([, v]) => v.date)
      .sort()
      .pop() ?? null;

  const summary: PortfolioCoreSummary = {
    totalValue: portfolioTotalValue,
    totalInvested: portfolioTotalInvested,
    dailyChangeAmount: portfolioDailyChange,
    dailyChangePct: portfolioDailyChangePct,
    xirr: portfolioXirrRate,
    latestNavDate,
    navUnavailableCount,
  };

  perfEnd(portfolioSpanId, {
    fund_cards: fundCards.length,
    txs: allTxs.length,
    navs: navRows.length,
    idxs: 0,
  });
  return {
    fundCards,
    summary,
    benchmarkTransactions,
    firstTransactionDate: firstTxDate,
    terminalDateIso: terminalDate.toISOString(),
    totalTransactionCount: allTxs.length,
    navRowCount: navRows.length,
    transactionFreshness,
  };
}

async function loadBenchmarkRows(
  benchmarkSymbol: string,
  firstTransactionDate: string | null,
  writeScope: ReturnType<typeof captureDatabaseWriteScope>,
): Promise<{ rows: IndexRow[]; source: 'sqlite' | 'snapshot' | 'none' }> {
  if (!benchmarkSymbol) return { rows: [], source: 'none' };

  let benchmarkRows: IndexRow[] = [];
  let benchmarkSource: 'sqlite' | 'snapshot' = 'sqlite';
  if (SQLITE_AVAILABLE) {
    try {
      const localRows = await idxRepo.readBySymbol(benchmarkSymbol, {
        sinceDate: firstTransactionDate ?? undefined,
        orderDesc: true,
      });
      benchmarkRows = localRows.map((r) => ({
        index_date: r.index_date,
        close_value: r.close_value,
      }));
    } catch (err) {
      console.warn('[usePortfolio] sqlite idx read failed; falling back', err);
    }
  }
  if (benchmarkRows.length === 0) {
    benchmarkSource = 'snapshot';
    const points = await fetchIndexHistory(benchmarkSymbol, firstTransactionDate);
    benchmarkRows = points.map((p) => ({ index_date: p.date, close_value: p.value }));
    if (benchmarkRows.length > 0 && SQLITE_AVAILABLE) {
      try {
        await idxRepo.bulkInsert(
          benchmarkRows.map((r) => ({
            index_symbol: benchmarkSymbol,
            index_date: r.index_date,
            close_value: r.close_value,
          })),
          { scope: writeScope, operation: 'portfolio_index_write_back' },
        );
      } catch (err) {
        console.warn('[usePortfolio] sqlite idx write failed', err);
      }
    }
  }

  return { rows: benchmarkRows, source: benchmarkSource };
}

export async function fetchPortfolioBenchmarkData(
  qc: QueryClient,
  userId: string,
  benchmarkSymbol: string,
): Promise<PortfolioBenchmarkData> {
  const benchmarkSpanId = perfStart('query:portfolio:benchmark');
  const writeScope = captureDatabaseWriteScope();
  const core = await qc.fetchQuery({
    queryKey: portfolioCoreQueryKey(userId),
    queryFn: () => fetchPortfolioCoreData(qc, userId),
    staleTime: STALE_TIMES.PORTFOLIO,
  });

  let marketXirr = NaN;
  let indexRowCount = 0;
  let indexSource: 'sqlite' | 'snapshot' | 'none' = 'none';
  if (core.benchmarkTransactions.length > 0 && benchmarkSymbol) {
    const indexSpanId = perfStart('query:portfolio:index');
    const { rows: benchmarkRows, source } = await loadBenchmarkRows(
      benchmarkSymbol,
      core.firstTransactionDate,
      writeScope,
    );
    indexRowCount = benchmarkRows.length;
    indexSource = source;
    perfEnd(indexSpanId, {
      rows: indexRowCount,
      symbol: benchmarkSymbol,
      source: indexSource,
    });

    if (benchmarkRows.length > 0) {
      const benchmarkValueAt = buildBenchmarkLookup(
        benchmarkRows.map((row) => ({
          date: row.index_date,
          value: row.close_value,
        })),
      );
      marketXirr = computeBenchmarkXirrFromNormalizedTransactions({
        transactions: core.benchmarkTransactions,
        benchmarkValueAt,
        terminalDate: new Date(core.terminalDateIso),
      }).xirr;
    }
  }

  perfEnd(benchmarkSpanId, {
    rows: indexRowCount,
    symbol: benchmarkSymbol,
    source: indexSource,
  });
  return { benchmarkSymbol, marketXirr, indexRowCount };
}

export async function fetchPortfolioData(
  qc: QueryClient,
  userId: string,
  benchmarkSymbol: string,
): Promise<PortfolioData> {
  const portfolioSpanId = perfStart('query:portfolio');
  const [core, benchmark] = await Promise.all([
    qc.fetchQuery({
      queryKey: portfolioCoreQueryKey(userId),
      queryFn: () => fetchPortfolioCoreData(qc, userId),
      staleTime: STALE_TIMES.PORTFOLIO,
    }),
    qc.fetchQuery({
      queryKey: portfolioBenchmarkQueryKey(userId, benchmarkSymbol),
      queryFn: () => fetchPortfolioBenchmarkData(qc, userId, benchmarkSymbol),
      staleTime: STALE_TIMES.PORTFOLIO,
    }),
  ]);
  const result = composePortfolioData(core, benchmark);
  perfEnd(portfolioSpanId, {
    fund_cards: result.fundCards.length,
    txs: core.totalTransactionCount,
    navs: core.navRowCount,
    idxs: benchmark.indexRowCount,
  });
  return result;
}

export function prefetchPortfolioBenchmark(
  queryClient: QueryClient,
  userId: string,
  benchmarkSymbol: string,
): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: portfolioQueryKey(userId, benchmarkSymbol),
    queryFn: () => fetchPortfolioData(queryClient, userId, benchmarkSymbol),
    staleTime: STALE_TIMES.PORTFOLIO,
  });
}

export function selectCachedPortfolioWeight(
  portfolio: PortfolioData,
  fundId: string,
  currentValue: number | null,
): CachedPortfolioWeight | null {
  const totalValue = portfolio.summary?.totalValue ?? 0;
  if (!currentValue || currentValue <= 0 || totalValue <= 0) return null;

  const rankedFunds = portfolio.fundCards
    .filter((fund) => fund.currentValue !== null && fund.currentValue > 0)
    .sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0));
  const rankIndex = rankedFunds.findIndex((fund) => fund.id === fundId);

  return {
    percentage: (currentValue / totalValue) * 100,
    rank: rankIndex >= 0 ? rankIndex + 1 : null,
    totalValue,
  };
}

export function selectCachedFundCard(
  portfolio: PortfolioData | undefined,
  fundId: string,
): FundCardData | null {
  return portfolio?.fundCards.find((candidate) => candidate.id === fundId) ?? null;
}

/**
 * Observe the already-cached Funds card used to open Fund Detail. The returned
 * object is the exact cache object, so warm navigation can paint a hero without
 * allocating a partial FundDetailData payload or starting another query.
 */
export function useCachedFundCard(fundId: string): FundCardData | null {
  const { session } = useSession();
  const userId = session?.user.id;
  const previewMode = useAppStore((state) => state.previewMode);
  const benchmarkSymbol = useAppStore((state) => state.defaultBenchmarkSymbol);
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => previewMode
      ? ['portfolio', 'preview']
      : ['portfolio', userId, benchmarkSymbol],
    [benchmarkSymbol, previewMode, userId],
  );
  const subscribe = useCallback(
    (onStoreChange: () => void) => queryClient.getQueryCache().subscribe(onStoreChange),
    [queryClient],
  );
  const getSnapshot = useCallback(
    () => selectCachedFundCard(queryClient.getQueryData<PortfolioData>(queryKey), fundId),
    [fundId, queryClient, queryKey],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Observe only an already-cached Portfolio result for Fund Detail's weight
 * card. This subscribes directly to QueryCache instead of mounting a second
 * query observer, so a deep-linked detail route cannot fetch or replace the
 * active Portfolio query's fetch options.
 */
export function useCachedPortfolioWeight(
  userId: string | undefined,
  fundId: string,
  currentValue: number | null,
): CachedPortfolioWeight | null {
  const previewMode = useAppStore((state) => state.previewMode);
  const benchmarkSymbol = useAppStore((state) => state.defaultBenchmarkSymbol);
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => previewMode
      ? ['portfolio', 'preview']
      : ['portfolio', userId, benchmarkSymbol],
    [benchmarkSymbol, previewMode, userId],
  );
  const subscribe = useCallback(
    (onStoreChange: () => void) => queryClient.getQueryCache().subscribe(onStoreChange),
    [queryClient],
  );
  const getSnapshot = useCallback(
    () => queryClient.getQueryData<PortfolioData>(queryKey),
    [queryClient, queryKey],
  );
  const portfolio = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(
    () => portfolio
      ? selectCachedPortfolioWeight(portfolio, fundId, currentValue)
      : null,
    [currentValue, fundId, portfolio],
  );
}

export function usePortfolio(
  benchmarkSymbol: string,
  options: { enabled?: boolean } = {},
) {
  const { session } = useSession();
  const previewMode = useAppStore((s) => s.previewMode);
  const userId = session?.user.id;
  const queryClient = useQueryClient();

  const query = useQuery<PortfolioData>({
    queryKey: previewMode ? ['portfolio', 'preview'] : ['portfolio', userId, benchmarkSymbol],
    enabled: (options.enabled ?? true) && (previewMode || !!userId),
    queryFn: () =>
      previewMode
        ? Promise.resolve({ fundCards: PREVIEW_FUND_CARDS, summary: PREVIEW_PORTFOLIO_SUMMARY })
        : fetchPortfolioData(queryClient, userId!, benchmarkSymbol),
    staleTime: STALE_TIMES.PORTFOLIO,
    placeholderData: keepPreviousData, // no jarring flash when switching benchmark
  });

  return query;
}
