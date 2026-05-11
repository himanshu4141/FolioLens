/**
 * useFundDetail — loads data for the Fund Detail screen.
 *
 * Returns:
 *  - fund: fund metadata (name, category, benchmark)
 *  - transactions: all transactions for this fund (for XIRR)
 *  - navHistory: NAV history sorted ascending (for NAV History tab)
 *  - indexHistory: benchmark index history sorted ascending (for Performance tab)
 *  - currentUnits: net units held
 *  - investedAmount: total amount invested
 *  - currentValue: net units * latest NAV
 *  - xirr: fund-level XIRR
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/src/lib/supabase';
import { xirr, buildCashflowsFromTransactions, computeRealizedGains } from '@/src/utils/xirr';
import type { NavPoint } from '@/src/utils/navUtils';
import { paginateRangeQuery } from '@/src/utils/supabasePagination';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';

// Pure windowing utils live in navUtils so they can be unit-tested without
// pulling in React Native / Supabase dependencies.
export { filterToWindow, indexTo100 } from '@/src/utils/navUtils';
export type { TimeWindow, NavPoint } from '@/src/utils/navUtils';

export interface FundDetailData {
  id: string;
  schemeName: string;
  schemeCategory: string;
  schemeCode: number;
  benchmarkIndex: string | null;
  benchmarkSymbol: string | null;
  currentNav: number | null;   // null when NAV sync hasn't run yet for this scheme
  currentUnits: number;
  currentValue: number | null; // null when currentNav is null — never assumed or zeroed
  investedAmount: number;
  realizedGain: number;
  realizedAmount: number;
  redeemedUnits: number;
  fundXirr: number;
  // Two most-recent NAV rows (latest first, oldest second). Just enough
  // for the header card's "current NAV" + "as of" — the full chart
  // history is loaded separately via `useFundNavHistory` so the screen
  // can paint immediately without waiting for the paginated history
  // fetch to finish.
  navHistory: NavPoint[];      // ascending by date, length ≤ 2
  // Technical metadata — populated by sync-fund-meta edge function
  isin: string | null;
  expenseRatio: number | null;
  aumCr: number | null;
  minSipAmount: number | null;
  fundMetaSyncedAt: string | null;
  // Extended scheme_master fields (M3v2 — Compare Funds deep redesign).
  // Sourced via a parallel scheme_master query because the `fund` view
  // doesn't yet expose them. Always nullable — sync-fund-meta backfills
  // these on the daily cron.
  launchDate: string | null;
  exitLoad: string | null;
  minLumpsum: number | null;
  minAdditional: number | null;
  planType: 'direct' | 'regular' | null;
  amcName: string | null;
  familyName: string | null;
  morningstarRating: number | null;
  riskLabel: string | null;
  periodReturns: unknown;
  riskRatios: unknown;
}

interface FundDetailRow {
  id: string;
  scheme_code: number;
  scheme_name: string;
  scheme_category: string | null;
  benchmark_index: string | null;
  benchmark_index_symbol: string | null;
  isin: string | null;
  expense_ratio: number | null;
  aum_cr: number | null;
  min_sip_amount: number | null;
  fund_meta_synced_at: string | null;
}

function isFundDetailRow(
  row: {
    id: string | null;
    scheme_code: number | null;
    scheme_name: string | null;
    scheme_category: string | null;
    benchmark_index: string | null;
    benchmark_index_symbol: string | null;
    isin: string | null;
    expense_ratio: number | null;
    aum_cr: number | null;
    min_sip_amount: number | null;
    fund_meta_synced_at: string | null;
  } | null | undefined,
): row is FundDetailRow {
  return !!row && !!row.id && row.scheme_code != null && !!row.scheme_name;
}

export async function fetchFundDetail(fundId: string): Promise<FundDetailData | null> {
  // Load fund metadata
  const { data: fund, error: fundError } = await supabase
    .from('fund')
    .select('id, scheme_code, scheme_name, scheme_category, benchmark_index, benchmark_index_symbol, isin, expense_ratio, aum_cr, min_sip_amount, fund_meta_synced_at')
    .eq('id', fundId)
    .single();

  if (fundError || !isFundDetailRow(fund)) return null;

  // Parallel fetch: extended scheme_master fields not yet exposed by the
  // `fund` view (M3v2 — Compare Funds redesign). All nullable; the FundDetail
  // screen renders gracefully when sync-fund-meta hasn't backfilled yet.
  const { data: extended } = await supabase
    .from('scheme_master')
    .select(
      'launch_date, exit_load, min_lumpsum, min_additional, plan_type, amc_name, family_name, morningstar_rating, risk_label, period_returns, risk_ratios',
    )
    .eq('scheme_code', fund.scheme_code)
    .maybeSingle();

  // Load transactions for this fund
  const { data: txs, error: txError } = await supabase
    .from('transaction')
    .select('transaction_date, transaction_type, units, amount')
    .eq('fund_id', fundId)
    .order('transaction_date', { ascending: true });

  if (txError) throw txError;

  // Compute net units and cashflows
  const { historicalCashflows: cashflows, netUnits, investedAmount } =
    buildCashflowsFromTransactions(txs ?? [], 0, new Date());
  const { realizedGain, realizedAmount, redeemedUnits } = computeRealizedGains(txs ?? []);

  // Light NAV fetch — just the two most-recent rows. Enough for the
  // header card (current NAV, previous NAV, "as of" date). The full
  // history needed by the charts is loaded in parallel via
  // `useFundNavHistory`, so the screen stops blocking on a 2,000-row
  // paginated fetch before painting the value / XIRR / metadata.
  const { data: navRowsDesc, error: navError } = await supabase
    .from('nav_history')
    .select('nav_date, nav')
    .eq('scheme_code', fund.scheme_code)
    .order('nav_date', { ascending: false })
    .limit(2);
  if (navError) throw navError;
  const navRows = (navRowsDesc ?? [])
    .map((r) => ({ nav_date: r.nav_date as string, nav: Number(r.nav) }))
    .reverse(); // ascending — matches the legacy contract

  const navHistory: NavPoint[] = navRows.map((r) => ({
    date: r.nav_date,
    value: Number(r.nav),
  }));

  if (navHistory.length === 0) {
    // NAV sync hasn't run yet for this scheme — return zeroed data so the UI
    // can show an informative empty state rather than crashing.
    return {
      id: fund.id,
      schemeName: fund.scheme_name,
      schemeCategory: fund.scheme_category ?? '',
      schemeCode: fund.scheme_code,
      benchmarkIndex: fund.benchmark_index,
      benchmarkSymbol: fund.benchmark_index_symbol,
      currentNav: null,
      currentUnits: netUnits,
      currentValue: null,
      investedAmount,
      realizedGain,
      realizedAmount,
      redeemedUnits,
      fundXirr: NaN,
      navHistory: [],
      isin: fund.isin ?? null,
      expenseRatio: fund.expense_ratio ?? null,
      aumCr: fund.aum_cr ?? null,
      minSipAmount: fund.min_sip_amount ?? null,
      fundMetaSyncedAt: fund.fund_meta_synced_at ?? null,
      launchDate: extended?.launch_date ?? null,
      exitLoad: extended?.exit_load ?? null,
      minLumpsum: extended?.min_lumpsum ?? null,
      minAdditional: extended?.min_additional ?? null,
      planType: (extended?.plan_type as 'direct' | 'regular' | null) ?? null,
      amcName: extended?.amc_name ?? null,
      familyName: extended?.family_name ?? null,
      morningstarRating: extended?.morningstar_rating ?? null,
      riskLabel: extended?.risk_label ?? null,
      periodReturns: extended?.period_returns ?? null,
      riskRatios: extended?.risk_ratios ?? null,
    };
  }
  const currentNav = navHistory[navHistory.length - 1].value;
  const currentValue = netUnits * currentNav;

  // XIRR
  const { xirrCashflows } = buildCashflowsFromTransactions(txs ?? [], currentValue, new Date());
  const fundXirr = cashflows.length > 0 ? xirr(xirrCashflows) : NaN;

  // Benchmark index history is loaded by the screen via its own
  // `['fund-detail-index', symbol]` useQuery (see `app/fund/[id].tsx`)
  // so we don't paginate it here.

  return {
    id: fund.id,
    schemeName: fund.scheme_name,
    schemeCategory: fund.scheme_category ?? '',
    schemeCode: fund.scheme_code,
    benchmarkIndex: fund.benchmark_index,
    benchmarkSymbol: fund.benchmark_index_symbol,
    currentNav,
    currentUnits: netUnits,
    currentValue,
    investedAmount,
    realizedGain,
    realizedAmount,
    redeemedUnits,
    fundXirr,
    navHistory,
    isin: fund.isin ?? null,
    expenseRatio: fund.expense_ratio ?? null,
    aumCr: fund.aum_cr ?? null,
    minSipAmount: fund.min_sip_amount ?? null,
    fundMetaSyncedAt: fund.fund_meta_synced_at ?? null,
    launchDate: extended?.launch_date ?? null,
    exitLoad: extended?.exit_load ?? null,
    minLumpsum: extended?.min_lumpsum ?? null,
    minAdditional: extended?.min_additional ?? null,
    planType: (extended?.plan_type as 'direct' | 'regular' | null) ?? null,
    amcName: extended?.amc_name ?? null,
    familyName: extended?.family_name ?? null,
    morningstarRating: extended?.morningstar_rating ?? null,
    riskLabel: extended?.risk_label ?? null,
    periodReturns: extended?.period_returns ?? null,
    riskRatios: extended?.risk_ratios ?? null,
  };
}

export function useFundDetail(fundId: string) {
  return useQuery({
    queryKey: ['fund-detail', fundId],
    enabled: !!fundId,
    queryFn: () => fetchFundDetail(fundId),
    staleTime: 0, // always fetch fresh so current value matches portfolio
  });
}

/**
 * Full NAV history for a scheme — paginated through Supabase. Split off
 * from `useFundDetail` so the Fund Detail screen can paint its header
 * card / metadata / XIRR within the first network round-trip, and the
 * 1,000–3,300-row paginated history populates the chart components in
 * the background.
 */
export async function fetchFundNavHistory(schemeCode: number): Promise<NavPoint[]> {
  const rows = await paginateRangeQuery<{ nav_date: string; nav: number }>(
    (from, to) => supabase
      .from('nav_history')
      .select('nav_date, nav')
      .eq('scheme_code', schemeCode)
      .order('nav_date', { ascending: true })
      .range(from, to),
  );
  return rows.map((r) => ({ date: r.nav_date, value: Number(r.nav) }));
}

export function useFundNavHistory(schemeCode: number | null | undefined) {
  return useQuery({
    queryKey: ['fund-nav-history', schemeCode],
    enabled: schemeCode != null,
    queryFn: () => fetchFundNavHistory(schemeCode!),
    staleTime: STALE_TIMES.NAV_HISTORY,
  });
}
