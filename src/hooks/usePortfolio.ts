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

import { useEffect } from 'react';
import { useQuery, useQueryClient, keepPreviousData, type QueryClient } from '@tanstack/react-query';
import { navHistoryRepo } from '@/src/lib/data/navHistory';
import {
  xirr,
  buildCashflowsFromTransactions,
  computeRealizedGains,
  buildBenchmarkLookup,
  computeBenchmarkXirr,
  type Cashflow,
} from '@/src/utils/xirr';
import { useSession } from '@/src/hooks/useSession';
import { BENCHMARK_OPTIONS } from '@/src/store/appStore';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { perfEnd, perfStart } from '@/src/lib/perfMark';
import { fetchUserFunds, type UserFundRow } from '@/src/hooks/useUserFunds';
import { fetchUserTransactions, type UserTransactionRow } from '@/src/hooks/useUserTransactions';
import { fetchIndexHistory } from '@/src/hooks/useIndexSnapshot';
import * as navRepo from '@/src/lib/db/nav';
import * as idxRepo from '@/src/lib/db/idx';
import { SQLITE_AVAILABLE } from '@/src/lib/db/availability';

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
}

export interface PortfolioSummary {
  totalValue: number;
  totalInvested: number;
  dailyChangeAmount: number;
  dailyChangePct: number;
  xirr: number;
  marketXirr: number;
  benchmarkSymbol: string;
  latestNavDate: string | null; // ISO date of most-recent NAV across all holdings
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

export async function fetchPortfolioData(
  qc: QueryClient,
  userId: string,
  benchmarkSymbol: string,
) {
  perfStart('query:portfolio');

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

  // Portfolio renders active funds only; inactive rows still live in the
  // shared cache for Money Trail / historical views.
  const validFunds = allFunds.filter((f) => f.is_active === true).filter(isPortfolioFundRow);
  if (!validFunds.length) {
    perfEnd('query:portfolio', { funds: 0, txs: 0, navs: 0, idxs: 0 });
    return { fundCards: [], summary: null };
  }

  // Group transactions by fund_id
  const txByFund = new Map<string, UserTransactionRow[]>();
  for (const tx of allTxs) {
    const existing = txByFund.get(tx.fund_id) ?? [];
    existing.push(tx);
    txByFund.set(tx.fund_id, existing);
  }

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
  perfStart('query:portfolio:nav');
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
        await navRepo.bulkInsert(navRows);
      } catch (err) {
        console.warn('[usePortfolio] sqlite nav write failed', err);
      }
    }
  }
  perfEnd('query:portfolio:nav', { rows: navRows.length, source: navSource });

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

  // Benchmark index history — for the market-XIRR comparison we need
  // every index close from the user's first transaction onward (so the
  // benchmark cashflows simulate every buy/sell at the right price).
  //
  // Three-tier read order:
  //   1. SQLite local repo (instant, offline-capable)
  //   2. CDN snapshot via `fetchIndexHistory` (Phase 9 M5)
  //   3. Paginated `index_history` SELECT (M5's own fallback inside
  //      `fetchIndexHistory`)
  // On a cold start, the CDN path warms SQLite via write-back so the
  // next mount is purely local.
  const firstTxDate = allTxs[0]?.transaction_date ?? null;
  let benchmarkRows: IndexRow[] = [];
  let benchmarkSource: 'sqlite' | 'snapshot' = 'sqlite';
  if (benchmarkSymbol) {
    perfStart('query:portfolio:index');
    if (SQLITE_AVAILABLE) {
      try {
        const localRows = await idxRepo.readBySymbol(benchmarkSymbol, {
          sinceDate: firstTxDate ?? undefined,
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
      const points = await fetchIndexHistory(benchmarkSymbol, firstTxDate);
      benchmarkRows = points.map((p) => ({ index_date: p.date, close_value: p.value }));
      if (benchmarkRows.length > 0 && SQLITE_AVAILABLE) {
        try {
          await idxRepo.bulkInsert(
            benchmarkRows.map((r) => ({
              index_symbol: benchmarkSymbol,
              index_date: r.index_date,
              close_value: r.close_value,
            })),
          );
        } catch (err) {
          console.warn('[usePortfolio] sqlite idx write failed', err);
        }
      }
    }
    perfEnd('query:portfolio:index', {
      rows: benchmarkRows.length,
      symbol: benchmarkSymbol,
      source: benchmarkSource,
    });
  }

  const benchmarkMap = new Map<string, number>();
  for (const row of benchmarkRows) {
    benchmarkMap.set(row.index_date, row.close_value);
  }

  // Compute per-fund card data
  const fundCards: FundCardData[] = [];
  let portfolioTotalValue = 0;
  let portfolioTotalPreviousValue = 0;
  let portfolioTotalInvested = 0;

  const allCashflows: Cashflow[] = [];

  for (const fund of validFunds) {
    const navInfo = navByScheme.get(fund.scheme_code);
    const txs = txByFund.get(fund.id) ?? [];

    if (txs.length === 0) continue;

    const today = new Date();

    if (!navInfo) {
      // NAV sync hasn't run for this scheme yet — show a pending card so the user
      // can see their holding rather than having it silently disappear.
      console.warn(`[usePortfolio] no NAV data for scheme ${fund.scheme_code} — showing pending card`);
      const { netUnits, investedAmount } = buildCashflowsFromTransactions(txs, 0, today);
      if (netUnits < 0.001) continue; // skip fully-exited funds
      const { realizedGain, realizedAmount, redeemedUnits } = computeRealizedGains(txs);
      fundCards.push({
        id: fund.id,
        schemeName: fund.scheme_name,
        schemeCategory: fund.scheme_category ?? '',
        schemeCode: fund.scheme_code,
        currentNav: null,
        previousNav: null,
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
      });
      continue;
    }

    // First pass: get netUnits and historical cashflows (currentValue unknown yet)
    const { historicalCashflows, netUnits, investedAmount } = buildCashflowsFromTransactions(
      txs,
      0,
      today,
    );

    if (netUnits < 0.001) continue; // skip fully-exited funds (guards against floating-point residuals)

    const currentValue = netUnits * navInfo.current;
    const previousValue = netUnits * navInfo.previous;
    const dailyChangeAmount = currentValue - previousValue;
    const dailyChangePct = previousValue > 0 ? (dailyChangeAmount / previousValue) * 100 : 0;

    // Accumulate historical cashflows for portfolio-level XIRR
    allCashflows.push(...historicalCashflows);

    // Build fund-level XIRR cashflows with terminal inflow
    const { xirrCashflows: fundXirrFlows } = buildCashflowsFromTransactions(
      txs,
      currentValue,
      today,
    );
    const fundXirr = xirr(fundXirrFlows);

    // Realized gains for partially/fully redeemed funds
    const { realizedGain, realizedAmount, redeemedUnits } = computeRealizedGains(txs);

    fundCards.push({
      id: fund.id,
      schemeName: fund.scheme_name,
      schemeCategory: fund.scheme_category ?? '',
      schemeCode: fund.scheme_code,
      currentNav: navInfo.current,
      previousNav: navInfo.previous,
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

  const today = new Date();
  const portfolioXirrFlows: Cashflow[] = [
    ...allCashflows,
    { date: today, amount: portfolioTotalValue },
  ];
  const portfolioXirrRate = allCashflows.length > 0 ? xirr(portfolioXirrFlows) : NaN;

  // Market XIRR — "what would I have got investing the same money in the
  // benchmark." Terminate at `today` (same as portfolioXirr) using at-or-
  // before benchmark lookup, so fund and benchmark XIRR are directly
  // comparable. Previously this terminated at the latest benchmark date,
  // which produced a 1–2-day asymmetry against portfolioXirr's `today`
  // terminal — small per call, but that's exactly how 0.5–1%/yr spurious
  // alpha sneaks in (cf. Past SIP Check fix in PR #99).
  let marketXirr = NaN;
  if (allCashflows.length > 0 && benchmarkRows.length > 0) {
    const benchmarkValueAt = buildBenchmarkLookup(
      benchmarkRows.map((row) => ({
        date: row.index_date,
        value: row.close_value,
      })),
    );
    const allTransactions = allTxs.filter((tx) =>
      validFunds.some((f) => f.id === tx.fund_id),
    );
    marketXirr = computeBenchmarkXirr({
      transactions: allTransactions,
      benchmarkValueAt,
      terminalDate: today,
    }).xirr;
  }

  const latestNavDate =
    [...navByScheme.values()].map((v) => v.date).sort().pop() ?? null;

  const summary: PortfolioSummary = {
    totalValue: portfolioTotalValue,
    totalInvested: portfolioTotalInvested,
    dailyChangeAmount: portfolioDailyChange,
    dailyChangePct: portfolioDailyChangePct,
    xirr: portfolioXirrRate,
    marketXirr,
    benchmarkSymbol,
    latestNavDate,
  };

  perfEnd('query:portfolio', {
    fund_cards: fundCards.length,
    txs: allTxs.length,
    navs: navRows.length,
    idxs: benchmarkRows.length,
  });
  return { fundCards, summary };
}

export function usePortfolio(benchmarkSymbol: string = '^NSEI') {
  const { session } = useSession();
  const userId = session?.user.id;
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['portfolio', userId, benchmarkSymbol],
    enabled: !!userId,
    queryFn: () => fetchPortfolioData(queryClient, userId!, benchmarkSymbol),
    staleTime: STALE_TIMES.PORTFOLIO,
    placeholderData: keepPreviousData, // no jarring flash when switching benchmark
  });

  // Once the active benchmark's data is in cache, prefetch the other
  // benchmarks in the background. The benchmark pill on Portfolio shows
  // 3 options; without this prefetch, switching to either non-default
  // option triggers a fresh fetch and the user waits ~hundreds of ms
  // before chart values update. Prefetching makes pill-switching feel
  // instant on the second tap, with no impact on initial load (the
  // effect runs only after `query.data` is populated).
  useEffect(() => {
    if (!query.data || !userId) return;
    for (const option of BENCHMARK_OPTIONS) {
      if (option.symbol === benchmarkSymbol) continue;
      queryClient.prefetchQuery({
        queryKey: ['portfolio', userId, option.symbol],
        queryFn: () => fetchPortfolioData(queryClient, userId, option.symbol),
        staleTime: STALE_TIMES.PORTFOLIO,
      });
    }
  }, [query.data, userId, benchmarkSymbol, queryClient]);

  return query;
}
