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

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { navHistoryRepo } from '@/src/lib/data/navHistory';
import { xirr, buildCashflowsFromTransactions, computeRealizedGains } from '@/src/utils/xirr';
import type { NavPoint } from '@/src/utils/navUtils';
import { paginateRangeQuery } from '@/src/utils/supabasePagination';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { perfEnd, perfStart } from '@/src/lib/perfMark';
import { useSession } from '@/src/hooks/useSession';
import { useAppStore } from '@/src/store/appStore';
import {
  buildPreviewFundDetail,
  findPreviewNavHistoryByCode,
} from '@/src/lib/previewData';
import { fetchUserFunds } from '@/src/hooks/useUserFunds';
import { fetchUserTransactions } from '@/src/hooks/useUserTransactions';
import { fetchSchemeMaster } from '@/src/hooks/useSchemeMaster';
import * as navRepo from '@/src/lib/db/nav';
import { SQLITE_AVAILABLE } from '@/src/lib/db/availability';

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
  riskLabel: string | null;
  periodReturns: unknown;
  riskRatios: unknown;
  declaredBenchmarkName: string | null;
  fundManager: string | null;
  portfolioTurnover: number | null;
  terDate: string | null;
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
  row:
    | {
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
      }
    | null
    | undefined,
): row is FundDetailRow {
  return !!row && !!row.id && row.scheme_code != null && !!row.scheme_name;
}

export async function fetchFundDetail(
  qc: QueryClient,
  userId: string,
  fundId: string,
): Promise<FundDetailData | null> {
  perfStart('query:fundDetail');

  // Read fund + transactions from the shared per-user caches that
  // Portfolio also populates. Once Portfolio has loaded, Fund Detail
  // resolves both in zero network round-trips — the heavy lifting is
  // already in memory.
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

  const fund = allFunds.find((f) => f.id === fundId);
  if (!isFundDetailRow(fund)) {
    perfEnd('query:fundDetail', { found: false });
    return null;
  }

  const txs = allTxs.filter((tx) => tx.fund_id === fundId);

  // Parallel fetch: scheme_master (shared with Compare via the
  // `['scheme-master', code]` cache key) and the two most-recent NAV
  // rows. NAV uses the read-through pattern: try local SQLite, fall
  // through to Supabase and write-back on a cache miss.
  perfStart('query:fundDetail:extras');
  const navFromRepo = SQLITE_AVAILABLE
    ? navRepo.readBySchemeCode(fund.scheme_code, { orderDesc: true, limit: 2 }).catch((err) => {
        console.warn('[useFundDetail] sqlite nav read failed; falling back', err);
        return [] as Awaited<ReturnType<typeof navRepo.readBySchemeCode>>;
      })
    : Promise.resolve([] as Awaited<ReturnType<typeof navRepo.readBySchemeCode>>);
  const [extended, localNavRows] = await Promise.all([
    qc.fetchQuery({
      queryKey: ['scheme-master', fund.scheme_code],
      queryFn: () => fetchSchemeMaster(fund.scheme_code),
      staleTime: STALE_TIMES.NAV_HISTORY,
    }),
    navFromRepo,
  ]);

  let navRowsDesc: { nav_date: string; nav: number }[] = localNavRows.map((r) => ({
    nav_date: r.nav_date,
    nav: r.nav,
  }));
  if (navRowsDesc.length === 0) {
    const { data, error } = await navHistoryRepo
      .from()
      .select('nav_date, nav')
      .eq('scheme_code', fund.scheme_code)
      .order('nav_date', { ascending: false })
      .limit(2);
    if (error) throw error;
    navRowsDesc = (data ?? []) as { nav_date: string; nav: number }[];
    // Deliberately do NOT write these 2 rows back into SQLite. They're only
    // for the header card (current/previous NAV). Seeding the local cache
    // with a 2-row slice trips `useFundNavHistory` into thinking the full
    // history is already cached — its `rows.length === 0` fallback never
    // fires, the paginated Supabase fetch is skipped, and the Growth
    // Consistency chart ends up with two quarters' worth of data instead of
    // three years. The sync orchestrator's `getWatermark` would also be
    // fooled into asking Supabase only for rows newer than the latest of
    // these two, never backfilling pre-watermark history.
  }
  perfEnd('query:fundDetail:extras');

  // Compute net units and cashflows
  const { historicalCashflows: cashflows, netUnits, investedAmount } =
    buildCashflowsFromTransactions(txs, 0, new Date());
  const { realizedGain, realizedAmount, redeemedUnits } = computeRealizedGains(txs);

  // Light NAV fetch — just the two most-recent rows. Enough for the
  // header card (current NAV, previous NAV, "as of" date). The full
  // history needed by the charts is loaded in parallel via
  // `useFundNavHistory`, so the screen stops blocking on a 2,000-row
  // paginated fetch before painting the value / XIRR / metadata.
  const navRows = (navRowsDesc ?? [])
    .map((r) => ({ nav_date: r.nav_date as string, nav: Number(r.nav) }))
    .reverse(); // ascending — matches the legacy contract

  const navHistory: NavPoint[] = navRows.map((r) => ({
    date: r.nav_date,
    value: Number(r.nav),
  }));

  if (navHistory.length === 0) {
    perfEnd('query:fundDetail', { found: true, navs: 0, has_current_nav: false });
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
      riskLabel: extended?.risk_label ?? null,
      periodReturns: extended?.period_returns ?? null,
      riskRatios: extended?.risk_ratios ?? null,
      declaredBenchmarkName: extended?.declared_benchmark_name ?? null,
      fundManager: extended?.fund_manager ?? null,
      portfolioTurnover: extended?.portfolio_turnover ?? null,
      terDate: extended?.ter_date ?? null,
    };
  }
  const currentNav = navHistory[navHistory.length - 1].value;
  const currentValue = netUnits * currentNav;

  // XIRR
  const { xirrCashflows } = buildCashflowsFromTransactions(txs, currentValue, new Date());
  const fundXirr = cashflows.length > 0 ? xirr(xirrCashflows) : NaN;

  // Benchmark index history is loaded by the screen via its own
  // `['fund-detail-index', symbol]` useQuery (see `app/fund/[id].tsx`)
  // so we don't paginate it here.

  perfEnd('query:fundDetail', {
    found: true,
    navs: navHistory.length,
    has_current_nav: true,
    txs: txs.length,
  });
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
    riskLabel: extended?.risk_label ?? null,
    periodReturns: extended?.period_returns ?? null,
    riskRatios: extended?.risk_ratios ?? null,
    declaredBenchmarkName: extended?.declared_benchmark_name ?? null,
    fundManager: extended?.fund_manager ?? null,
    portfolioTurnover: extended?.portfolio_turnover ?? null,
    terDate: extended?.ter_date ?? null,
  };
}

export function useFundDetail(fundId: string) {
  const { session } = useSession();
  const userId = session?.user.id;
  const previewMode = useAppStore((s) => s.previewMode);
  const qc = useQueryClient();
  return useQuery({
    queryKey: previewMode
      ? ['fund-detail', 'preview', fundId]
      : ['fund-detail', fundId],
    // Preview mode swaps the Supabase fetch for an in-memory fixture so
    // the Fund Detail screen paints immediately instead of sitting on a
    // spinner waiting for queries that can't resolve (no real session).
    enabled: !!fundId && (previewMode || !!userId),
    queryFn: () =>
      previewMode
        ? Promise.resolve(buildPreviewFundDetail(fundId))
        : fetchFundDetail(qc, userId!, fundId),
    // Match `PORTFOLIO` so Fund Detail's currentValue stays in sync with
    // the Portfolio cards' currentValue across screen navigation. Cache
    // audit finding #10: `staleTime: 0` was originally chosen to "match
    // portfolio" but achieved the opposite — Fund Detail refetched on
    // every mount and could show a newer NAV than Portfolio's still-
    // cached one (right after the daily NAV publish window). The
    // matching staleTime is the correct way to keep them in sync; users
    // who want the freshest possible NAV pull-to-refresh, which fires
    // a refetch regardless of staleTime.
    staleTime: STALE_TIMES.PORTFOLIO,
  });
}

/**
 * Options for `fetchFundNavHistory`.
 */
export interface FetchNavHistoryOptions {
  /**
   * When set, the Supabase fallback only fetches NAVs on or after this date
   * (ISO 'YYYY-MM-DD'). Results are NOT written back to SQLite — a partial
   * slice written back would poison useFundNavHistory into thinking full
   * history is already cached, silently breaking Fund Detail charts.
   *
   * Use this only for callers that need a bounded window (e.g. Compare Funds
   * which only needs 5y for metric computation). Fund Detail's full-history
   * chart path must always call without this option.
   */
  sinceDate?: string;
}

/**
 * Full NAV history for a scheme — read-through SQLite. The on-device
 * cache holds full history after bootstrap; this hook reads the local
 * rows directly. On a cache miss (cold start before bootstrap, or a
 * scheme the user just added), we paginate from Supabase and write the
 * result into SQLite so the next mount is free.
 *
 * Split off from `useFundDetail` so the Fund Detail screen can paint
 * its header card / metadata / XIRR within the first round-trip, and
 * the 1,000–3,300-row history populates the chart components in the
 * background.
 */
export async function fetchFundNavHistory(
  schemeCode: number,
  opts?: FetchNavHistoryOptions,
): Promise<NavPoint[]> {
  const sinceDate = opts?.sinceDate;
  perfStart('query:fundNavHistory');
  let rows: { nav_date: string; nav: number }[] = [];
  let source: 'sqlite' | 'supabase' = 'sqlite';
  if (SQLITE_AVAILABLE) {
    try {
      const local = await navRepo.readBySchemeCode(schemeCode);
      rows = local.map((r) => ({ nav_date: r.nav_date, nav: r.nav }));
    } catch (err) {
      console.warn('[fetchFundNavHistory] sqlite read failed; falling back', err);
    }
  }
  if (rows.length === 0) {
    source = 'supabase';
    rows = await paginateRangeQuery<{ nav_date: string; nav: number }>(
      (from, to) => {
        const q = navHistoryRepo
          .from()
          .select('nav_date, nav')
          .eq('scheme_code', schemeCode)
          .order('nav_date', { ascending: true });
        return (sinceDate ? q.gte('nav_date', sinceDate) : q).range(from, to);
      },
    );
    // Only write back to SQLite for full-history fetches. A windowed slice
    // (sinceDate set) must not be written back — it would look like full
    // history to useFundNavHistory's watermark check and prevent the proper
    // paginated backfill from ever running.
    if (rows.length > 0 && SQLITE_AVAILABLE && !sinceDate) {
      try {
        await navRepo.bulkInsert(
          rows.map((r) => ({ scheme_code: schemeCode, nav_date: r.nav_date, nav: Number(r.nav) })),
        );
      } catch (err) {
        console.warn('[fetchFundNavHistory] sqlite write failed', err);
      }
    }
  }
  perfEnd('query:fundNavHistory', { rows: rows.length, scheme_code: schemeCode, source });
  return rows.map((r) => ({ date: r.nav_date, value: Number(r.nav) }));
}

export function useFundNavHistory(schemeCode: number | null | undefined) {
  const previewMode = useAppStore((s) => s.previewMode);
  return useQuery({
    queryKey: previewMode
      ? ['fund-nav-history', 'preview', schemeCode]
      : ['fund-nav-history', schemeCode],
    enabled: schemeCode != null,
    queryFn: () => {
      if (previewMode && schemeCode != null) {
        // 36-month synthetic series — enough for the Fund Detail
        // chart and the Past SIP Check 3Y simulation.
        return Promise.resolve(findPreviewNavHistoryByCode(schemeCode) ?? []);
      }
      return fetchFundNavHistory(schemeCode!);
    },
    staleTime: STALE_TIMES.NAV_HISTORY,
  });
}
