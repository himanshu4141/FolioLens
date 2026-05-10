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

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/src/lib/supabase';
import {
  REFERENCE_HISTORY_START_DATE,
  REFERENCE_QUERY_GC_TIME_MS,
  REFERENCE_QUERY_STALE_TIME_MS,
  fetchCachedIndexRows,
  fetchCachedNavRows,
} from '@/src/lib/referenceDataCache';
import {
  xirr,
  buildCashflowsFromTransactions,
  computeRealizedGains,
  buildBenchmarkLookup,
  computeBenchmarkXirr,
  type Cashflow,
} from '@/src/utils/xirr';
import { useSession } from '@/src/hooks/useSession';

const PORTFOLIO_NAV_LOOKBACK_DAYS = 45;

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

function isPortfolioFundRow(
  row: {
    id: string | null;
    scheme_code: number | null;
    scheme_name: string | null;
    scheme_category: string | null;
    benchmark_index_symbol: string | null;
  } | null | undefined,
): row is PortfolioFundRow {
  return !!row && !!row.id && row.scheme_code != null && !!row.scheme_name;
}

function isoDateDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0];
}

function buildLatestNavByScheme(
  navRows: { scheme_code: number; nav_date: string; nav: number }[],
): Map<number, { current: number; previous: number; date: string }> {
  const navByScheme = new Map<number, { current: number; previous: number; date: string }>();
  for (const row of [...navRows].sort((a, b) => String(b.nav_date).localeCompare(String(a.nav_date)))) {
    const code = row.scheme_code as number;
    const existing = navByScheme.get(code);
    if (!existing) {
      navByScheme.set(code, { current: row.nav as number, previous: row.nav as number, date: row.nav_date as string });
    } else if (existing.current === existing.previous) {
      // second row = previous trading day's NAV
      navByScheme.set(code, { ...existing, previous: row.nav as number });
    }
  }
  return navByScheme;
}

function buildNavHistoryByScheme(
  navRows: { scheme_code: number; nav_date: string; nav: number }[],
): Map<number, { date: string; value: number }[]> {
  const navHistoryByScheme = new Map<number, { date: string; value: number }[]>();
  for (const row of [...navRows].sort((a, b) => String(b.nav_date).localeCompare(String(a.nav_date)))) {
    const code = row.scheme_code as number;
    const pts = navHistoryByScheme.get(code) ?? [];
    pts.push({ date: row.nav_date as string, value: row.nav as number });
    navHistoryByScheme.set(code, pts);
  }
  for (const [code, pts] of navHistoryByScheme) {
    navHistoryByScheme.set(code, [...pts].reverse());
  }
  return navHistoryByScheme;
}

export async function fetchPortfolioData(userId: string, benchmarkSymbol: string) {
  // Load active funds
  const { data: funds, error: fundsError } = await supabase
    .from('fund')
    .select('id, scheme_code, scheme_name, scheme_category, benchmark_index_symbol')
    .eq('user_id', userId)
    .eq('is_active', true);

  if (fundsError) throw fundsError;
  if (!funds?.length) return { fundCards: [], summary: null };

  const validFunds = funds.filter(isPortfolioFundRow);
  if (!validFunds.length) return { fundCards: [], summary: null };

  const schemeCodes = validFunds.map((f) => f.scheme_code);
  const navCutoff30d = isoDateDaysAgo(30);
  const navFetchStart = isoDateDaysAgo(PORTFOLIO_NAV_LOOKBACK_DAYS);

  const [txResult, recentNavRows] = await Promise.all([
    // Load all transactions for this user (for XIRR)
    supabase
      .from('transaction')
      .select('fund_id, transaction_date, transaction_type, units, amount')
      .eq('user_id', userId)
      .order('transaction_date', { ascending: true }),
    // Current/previous NAV and fund-card sparklines only need recent rows. The
    // persistent cache keeps this cheap after first load and asks Supabase only
    // for rows newer than the cached latest date.
    fetchCachedNavRows(schemeCodes, navFetchStart),
  ]);

  const { data: allTxs, error: txError } = txResult;
  if (txError) throw txError;

  // Group transactions by fund_id
  const txByFund = new Map<string, typeof allTxs>();
  for (const tx of allTxs ?? []) {
    const existing = txByFund.get(tx.fund_id) ?? [];
    existing.push(tx);
    txByFund.set(tx.fund_id, existing);
  }

  let navRows = recentNavRows;
  let navByScheme = buildLatestNavByScheme(navRows ?? []);
  const schemesWithoutRecentNav = schemeCodes.filter((schemeCode) => !navByScheme.has(schemeCode));
  if (schemesWithoutRecentNav.length > 0) {
    const fallbackRows = await fetchCachedNavRows(schemesWithoutRecentNav, REFERENCE_HISTORY_START_DATE);
    navRows = [...(navRows ?? []), ...fallbackRows];
    navByScheme = buildLatestNavByScheme(navRows);
  }

  // Build sparkline history map (rows came descending — reverse to ascending for rendering)
  const navHistoryByScheme = buildNavHistoryByScheme(navRows ?? []);

  // Slice sparkline data to the last 30 days (rows are now ascending; keep only recent)
  for (const [code, pts] of navHistoryByScheme) {
    navHistoryByScheme.set(code, pts.filter((p) => p.date >= navCutoff30d));
  }

  let benchmarkRows: { index_date: string; close_value: number }[] = [];
  const firstTxDate = (allTxs ?? [])[0]?.transaction_date;
  if (firstTxDate) {
    try {
      benchmarkRows = await fetchCachedIndexRows(benchmarkSymbol, firstTxDate);
    } catch (error) {
      console.warn('[usePortfolio] benchmark history fetch failed', error);
    }
  }

  const benchmarkMap = new Map<string, number>();
  for (const row of benchmarkRows ?? []) {
    benchmarkMap.set(row.index_date as string, row.close_value as number);
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
  if (allCashflows.length > 0 && benchmarkRows?.length) {
    const benchmarkValueAt = buildBenchmarkLookup(
      benchmarkRows.map((row) => ({
        date: row.index_date as string,
        value: row.close_value as number,
      })),
    );
    const allTransactions = (allTxs ?? []).filter((tx) =>
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

  return { fundCards, summary };
}

export function usePortfolio(benchmarkSymbol: string = '^NSEI') {
  const { session } = useSession();
  const userId = session?.user.id;

  return useQuery({
    queryKey: ['portfolio', userId, benchmarkSymbol],
    enabled: !!userId,
    queryFn: () => fetchPortfolioData(userId!, benchmarkSymbol),
    staleTime: REFERENCE_QUERY_STALE_TIME_MS,
    gcTime: REFERENCE_QUERY_GC_TIME_MS,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData, // no jarring flash when switching benchmark
  });
}
