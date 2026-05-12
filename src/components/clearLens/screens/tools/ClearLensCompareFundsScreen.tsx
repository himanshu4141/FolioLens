/**
 * Compare Funds — deep-redesign (M3v2). Hero + prose key-differences summary
 * + tabbed detail.
 *
 * Picks any fund from scheme_master (universal picker), not just user-held.
 * Computes 1Y/3Y/5Y CAGR + Sharpe / Sortino / Std dev locally from
 * nav_history (MFData's numbers are unreliable per the accuracy comparison).
 * Surfaces MFData-derived beta + r_squared + period_returns only with
 * category gating + composition guards (see src/utils/mfdataGuards.ts).
 *
 * The original prose-only PR (#100) and its M3 plan are superseded by this
 * screen and the M3v2 ExecPlan
 * (docs/plans/phase-4-tools-hub/M3v2-compare-funds-deep-redesign.md).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ClearLensHeader, ClearLensScreen } from '@/src/components/clearLens/ClearLensPrimitives';
import { PortfolioDisclaimer } from '@/src/components/clearLens/PortfolioDisclaimer';
import { UniversalFundPicker } from '@/src/components/clearLens/UniversalFundPicker';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { useSession } from '@/src/hooks/useSession';
import { useTrackInsightViewed } from '@/src/hooks/useTrackInsightViewed';
import { supabase } from '@/src/lib/supabase';
import { perfEnd, perfStart } from '@/src/lib/perfMark';
import { fetchUserHeldSchemes, type SchemeSearchResult } from '@/src/utils/fundSearch';
import { shortSchemeName } from '@/src/utils/schemeName';
import {
  computeRiskMetrics,
  computeTrailingReturns,
  type TrailingPeriodReturns,
} from '@/src/utils/computedFundMetrics';
import {
  isCompositionImplausible,
  isLaunchDateDirectPlanIntroduction,
  readMfdataBeta,
  readMfdataPeriodReturn,
  readMfdataRSquared,
  readMfdataRank,
} from '@/src/utils/mfdataGuards';
import { computeHoldingOverlap } from '@/src/utils/holdingOverlap';
import { formatCurrency } from '@/src/utils/formatting';
import type { NavPoint } from '@/src/utils/navUtils';
import { fetchFundNavHistory } from '@/src/hooks/useFundDetail';
import { fetchSchemeMaster } from '@/src/hooks/useSchemeMaster';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FUNDS = 3;
const MIN_FUNDS = 2;

type TabKey = 'returns' | 'risk' | 'asset_mix' | 'sectors' | 'holdings' | 'other';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'returns', label: 'Returns' },
  { key: 'risk', label: 'Risk' },
  { key: 'asset_mix', label: 'Asset mix' },
  { key: 'sectors', label: 'Sectors' },
  { key: 'holdings', label: 'Holdings' },
  { key: 'other', label: 'Other' },
];

interface SchemeMasterRow {
  schemeCode: number;
  schemeName: string;
  schemeCategory: string | null;
  benchmark: string | null;
  expenseRatio: number | null;
  aumCr: number | null;
  isin: string | null;
  amcName: string | null;
  familyName: string | null;
  planType: 'direct' | 'regular' | null;
  optionType: string | null;
  launchDate: string | null;
  exitLoad: string | null;
  minSipAmount: number | null;
  minLumpsum: number | null;
  minAdditional: number | null;
  morningstarRating: number | null;
  riskLabel: string | null;
  periodReturns: unknown;
  riskRatios: unknown;
}

interface CompositionRow {
  schemeCode: number;
  equityPct: number;
  debtPct: number;
  cashPct: number;
  otherPct: number;
  largeCapPct: number | null;
  midCapPct: number | null;
  smallCapPct: number | null;
  sectorAllocation: Record<string, number> | null;
  topHoldings: { name: string; isin: string; sector: string; pctOfNav: number }[] | null;
  rawDebtHoldings: { name?: string; weight_pct?: number; credit_rating?: string }[] | null;
}

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

async function fetchSchemes(
  qc: QueryClient,
  schemeCodes: number[],
): Promise<SchemeMasterRow[]> {
  if (schemeCodes.length === 0) return [];
  perfStart('query:compare:schemes');
  // Each scheme is fetched through the shared `['scheme-master', code]`
  // cache that Fund Detail also uses. Navigating Compare → Fund Detail
  // (or vice versa) on the same scheme hits the warm cache.
  const rows = await Promise.all(
    schemeCodes.map((code) =>
      qc.fetchQuery({
        queryKey: ['scheme-master', code],
        queryFn: () => fetchSchemeMaster(code),
        staleTime: STALE_TIMES.NAV_HISTORY,
      }),
    ),
  );
  const present = rows.filter(
    (r): r is NonNullable<typeof r> => r != null && r.scheme_name != null,
  );
  perfEnd('query:compare:schemes', { rows: present.length, codes: schemeCodes.length });
  return present.map((row) => ({
    schemeCode: row.scheme_code,
    schemeName: row.scheme_name as string,
    schemeCategory: row.scheme_category,
    benchmark: row.benchmark_index,
    expenseRatio: row.expense_ratio,
    aumCr: row.aum_cr,
    isin: row.isin,
    amcName: row.amc_name,
    familyName: row.family_name,
    planType: (row.plan_type as 'direct' | 'regular' | null) ?? null,
    optionType: row.option_type,
    launchDate: row.launch_date,
    exitLoad: row.exit_load,
    minSipAmount: row.min_sip_amount,
    minLumpsum: row.min_lumpsum,
    minAdditional: row.min_additional,
    morningstarRating: row.morningstar_rating,
    riskLabel: row.risk_label,
    periodReturns: row.period_returns,
    riskRatios: row.risk_ratios,
  }));
}

async function fetchCompositionsForCodes(schemeCodes: number[]): Promise<CompositionRow[]> {
  if (schemeCodes.length === 0) return [];
  perfStart('query:compare:compositions');
  // Get the latest composition row per scheme.
  const { data, error } = await supabase
    .from('fund_portfolio_composition')
    .select(
      'scheme_code, portfolio_date, source, equity_pct, debt_pct, cash_pct, other_pct, large_cap_pct, mid_cap_pct, small_cap_pct, sector_allocation, top_holdings, raw_debt_holdings',
    )
    .in('scheme_code', schemeCodes)
    .order('portfolio_date', { ascending: false });
  perfEnd('query:compare:compositions', { rows: data?.length ?? 0, codes: schemeCodes.length });
  if (error) throw new Error(`fetchCompositions: ${error.message}`);
  // Pick the first (= latest) per scheme_code, preferring `amfi` source.
  const latest = new Map<number, typeof data[number]>();
  for (const row of data ?? []) {
    const existing = latest.get(row.scheme_code);
    if (!existing) {
      latest.set(row.scheme_code, row);
    } else if (existing.source !== 'amfi' && row.source === 'amfi') {
      latest.set(row.scheme_code, row);
    }
  }
  return [...latest.values()].map((row) => ({
    schemeCode: row.scheme_code,
    equityPct: row.equity_pct,
    debtPct: row.debt_pct,
    cashPct: row.cash_pct,
    otherPct: row.other_pct,
    largeCapPct: row.large_cap_pct,
    midCapPct: row.mid_cap_pct,
    smallCapPct: row.small_cap_pct,
    sectorAllocation: row.sector_allocation as Record<string, number> | null,
    topHoldings: row.top_holdings as CompositionRow['topHoldings'],
    rawDebtHoldings: row.raw_debt_holdings as CompositionRow['rawDebtHoldings'],
  }));
}

async function fetchNavHistoryForCodes(
  qc: QueryClient,
  schemeCodes: number[],
): Promise<Map<number, NavPoint[]>> {
  const out = new Map<number, NavPoint[]>();
  if (schemeCodes.length === 0) return out;
  perfStart('query:compare:navHistory');
  // Per-scheme reads go through the shared `['fund-nav-history', code]`
  // cache — the same key Fund Detail's `useFundNavHistory` populates. A
  // user who opened a fund's detail page first and then lands on Compare
  // pays zero network cost for that scheme's NAV history.
  //
  // `fetchFundNavHistory` paginates internally; previously this function
  // duplicated that pagination loop. Routing through the shared fetcher
  // keeps a single source of truth for "give me one scheme's NAV
  // history" and means future caching layers (SQLite read-through, etc.)
  // only need to plug in once.
  const entries = await Promise.all(
    schemeCodes.map(async (code) => {
      const rows = await qc.fetchQuery({
        queryKey: ['fund-nav-history', code],
        queryFn: () => fetchFundNavHistory(code),
        staleTime: STALE_TIMES.NAV_HISTORY,
      });
      return [code, rows] as const;
    }),
  );
  let totalRows = 0;
  for (const [code, rows] of entries) {
    out.set(code, rows);
    totalRows += rows.length;
  }
  perfEnd('query:compare:navHistory', { rows: totalRows, codes: schemeCodes.length });
  return out;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function ClearLensCompareFundsScreen() {
  useTrackInsightViewed('compare_funds');
  const router = useRouter();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const queryClient = useQueryClient();

  const [selectedCodes, setSelectedCodes] = useState<number[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('returns');

  // One-shot seed flag — flips true the first time we either auto-seed or
  // the user makes any change to the selection. Without this, removing all
  // chips would re-trigger the useEffect below and the screen would silently
  // re-pick the user's first two holdings, making it impossible to clear out
  // the defaults to start a fresh comparison.
  const hasSeededRef = useRef(false);

  // Auto-seed selection with the user's first two held funds — only on the
  // initial render, never again after the user has interacted.
  const userFundsQuery = useQuery({
    queryKey: ['compare:user-held-seed', userId],
    enabled: !!userId,
    queryFn: () => (userId ? fetchUserHeldSchemes(userId) : Promise.resolve([] as SchemeSearchResult[])),
    staleTime: 5 * 60 * 1000,
  });
  useEffect(() => {
    if (hasSeededRef.current) return;
    if ((userFundsQuery.data?.length ?? 0) >= MIN_FUNDS) {
      setSelectedCodes(userFundsQuery.data!.slice(0, MIN_FUNDS).map((f) => f.schemeCode));
      hasSeededRef.current = true;
    }
  }, [userFundsQuery.data]);

  // On-demand safety net for picks the universe-backfill cron hasn't covered
  // yet. Idempotent — both edge functions are no-ops when the cache is fresh.
  // We invalidate the dependent queries on success so the screen rerenders
  // with the freshly-hydrated rows.
  const hydrationQueries = useQueries({
    queries: selectedCodes.flatMap((code) => [
      {
        queryKey: ['compare:hydrate-snapshot', code],
        queryFn: async () => {
          const { data, error } = await supabase.functions.invoke<{ status: string }>(
            'fetch-fund-snapshot',
            { body: { scheme_code: code } },
          );
          if (error) throw new Error(`fetch-fund-snapshot: ${error.message}`);
          // Refresh the dependent queries — scheme_master and the
          // composition table were just touched. Invalidate both the
          // shared per-scheme entry (`['scheme-master', code]`) so any
          // other screen reading it picks up the new row, and the
          // Compare-derived wrapper so this screen re-renders.
          queryClient.invalidateQueries({ queryKey: ['scheme-master', code] });
          queryClient.invalidateQueries({ queryKey: ['compare:schemes'] });
          queryClient.invalidateQueries({ queryKey: ['compare:compositions'] });
          return data;
        },
        staleTime: 5 * 60 * 1000,
      },
      {
        queryKey: ['compare:hydrate-nav', code],
        queryFn: async () => {
          const { data, error } = await supabase.functions.invoke<{ status: string }>(
            'fetch-fund-nav',
            { body: { scheme_code: code } },
          );
          if (error) throw new Error(`fetch-fund-nav: ${error.message}`);
          // Invalidate the shared per-scheme NAV cache (shared with
          // Fund Detail) and the Compare-derived wrapper.
          queryClient.invalidateQueries({ queryKey: ['fund-nav-history', code] });
          queryClient.invalidateQueries({ queryKey: ['compare:navhistory'] });
          return data;
        },
        staleTime: 5 * 60 * 1000,
      },
    ]),
  });

  const schemesQuery = useQuery({
    queryKey: ['compare:schemes', selectedCodes],
    enabled: selectedCodes.length > 0,
    queryFn: () => fetchSchemes(queryClient, selectedCodes),
    staleTime: 60 * 1000,
  });
  const compositionsQuery = useQuery({
    queryKey: ['compare:compositions', selectedCodes],
    enabled: selectedCodes.length > 0,
    queryFn: () => fetchCompositionsForCodes(selectedCodes),
    staleTime: 5 * 60 * 1000,
  });
  const navHistoryQuery = useQuery({
    queryKey: ['compare:navhistory', selectedCodes],
    enabled: selectedCodes.length > 0,
    queryFn: () => fetchNavHistoryForCodes(queryClient, selectedCodes),
    staleTime: 5 * 60 * 1000,
  });

  // We still declare `hydrationQueries` above for its side effect —
  // each entry's `queryFn` invokes the on-demand edge function and
  // invalidates the dependent data queries when it lands. The UI is no
  // longer gated on whether those are still in flight (see the
  // `isLoading` computation below), so the variable isn't read here.
  void hydrationQueries;

  // Order the schemes to match selection order.
  const schemes = useMemo<SchemeMasterRow[]>(() => {
    if (!schemesQuery.data) return [];
    const byCode = new Map(schemesQuery.data.map((s) => [s.schemeCode, s]));
    return selectedCodes.map((c) => byCode.get(c)).filter((s): s is SchemeMasterRow => !!s);
  }, [schemesQuery.data, selectedCodes]);

  const compositionsByCode = useMemo(() => {
    const map = new Map<number, CompositionRow>();
    for (const row of compositionsQuery.data ?? []) {
      // Apply the read-time composition guard.
      if (isCompositionImplausible(row.equityPct, row.debtPct, row.cashPct, row.otherPct)) continue;
      map.set(row.schemeCode, row);
    }
    return map;
  }, [compositionsQuery.data]);

  // Locally-computed metrics from NAV history.
  type Metrics = {
    trailing: TrailingPeriodReturns;
    sharpe: number | null;
    sortino: number | null;
    stdDev: number | null;
    monthlyObservations: number;
  };
  const metricsByCode = useMemo(() => {
    const map = new Map<number, Metrics>();
    const navMap = navHistoryQuery.data;
    if (!navMap) return map;
    for (const code of selectedCodes) {
      const series = navMap.get(code) ?? [];
      const trailing = computeTrailingReturns(series);
      const risk = computeRiskMetrics(series, { windowYears: 3 });
      map.set(code, {
        trailing,
        sharpe: risk.sharpe,
        sortino: risk.sortino,
        stdDev: risk.stdDev,
        monthlyObservations: risk.monthlyObservations,
      });
    }
    return map;
  }, [navHistoryQuery.data, selectedCodes]);

  // Hero — best performer over the longest common return window.
  const hero = useMemo(() => deriveHero(schemes, metricsByCode), [schemes, metricsByCode]);

  // Prose key differences (render after hero).
  const keyDifferences = useMemo(
    () => deriveKeyDifferences(schemes, compositionsByCode, metricsByCode),
    [schemes, compositionsByCode, metricsByCode],
  );

  const handleToggle = (scheme: SchemeSearchResult) => {
    // Any explicit user pick (or unpick) blocks the auto-seed effect — the
    // user has signalled they want their own selection.
    hasSeededRef.current = true;
    setSelectedCodes((prev) => {
      if (prev.includes(scheme.schemeCode)) return prev.filter((c) => c !== scheme.schemeCode);
      if (prev.length >= MAX_FUNDS) return prev;
      return [...prev, scheme.schemeCode];
    });
  };

  const handleRemove = (schemeCode: number) => {
    hasSeededRef.current = true;
    setSelectedCodes((prev) => prev.filter((c) => c !== schemeCode));
  };

  if (!userId) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <View style={styles.center}><Text style={styles.emptyTitle}>Sign in to use this tool</Text></View>
      </ClearLensScreen>
    );
  }

  // Show the spinner only while the Postgres reads are in flight. The
  // on-demand hydration queries (`fetch-fund-snapshot`, `fetch-fund-nav`)
  // run in parallel and call `invalidateQueries` when they land, so any
  // freshly-backfilled rows flow into the data queries automatically.
  //
  // Previously this gate also waited on `isHydrating`, which meant cold
  // loads paid the full 5–10s edge-function latency before showing
  // anything — even when every scheme was already in our DB. Now the
  // UI paints as soon as the SQL reads complete (typically <1s) and
  // any later refetch from a hydration write just refreshes the cards
  // in place.
  const isLoading = selectedCodes.length > 0
    && (schemesQuery.isLoading || navHistoryQuery.isLoading || compositionsQuery.isLoading);

  return (
    <ClearLensScreen>
      <ClearLensHeader onPressBack={() => router.back()} />

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.titleBlock}>
          <Text style={styles.eyebrow}>Compare Funds</Text>
          <Text style={styles.title}>Side by side, no spin</Text>
          <Text style={styles.subtitle}>
            Pick two or three funds — yours or any in our catalog. We&apos;ll line up the numbers
            and call out the key differences.
          </Text>
        </View>

        {/* Selected fund chips + Add */}
        <View style={styles.chipsCard}>
          <Text style={styles.inputLabel}>Selected funds</Text>
          <View style={styles.chipRow}>
            {schemes.map((scheme) => (
              <View key={scheme.schemeCode} style={styles.fundChip}>
                <Text style={styles.fundChipName} numberOfLines={1}>
                  {shortSchemeName(scheme.schemeName)}
                </Text>
                <TouchableOpacity
                  onPress={() => handleRemove(scheme.schemeCode)}
                  hitSlop={8}
                >
                  <Ionicons name="close-circle" size={18} color={tokens.colors.textTertiary} />
                </TouchableOpacity>
              </View>
            ))}
            {selectedCodes.length < MAX_FUNDS ? (
              <TouchableOpacity style={styles.addChip} onPress={() => setPickerOpen(true)} activeOpacity={0.75}>
                <Ionicons name="add" size={16} color={tokens.colors.emerald} />
                <Text style={styles.addChipText}>Add fund</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        {selectedCodes.length < MIN_FUNDS ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>
              Pick at least {MIN_FUNDS} funds to compare.
            </Text>
          </View>
        ) : isLoading ? (
          <View style={styles.center}><Text style={styles.helperText}>Crunching the numbers…</Text></View>
        ) : (
          <>
            {/* Hero */}
            {hero ? (
              <View style={styles.banner}>
                <Text style={styles.bannerLabel}>{hero.windowLabel} · best performer</Text>
                <Text style={styles.bannerValue} numberOfLines={2}>
                  {hero.leaderName}
                </Text>
                <Text style={styles.bannerSubtitle}>
                  <Text style={styles.bannerGainUp}>
                    +{(hero.leaderReturn * 100).toFixed(1)}%/yr
                  </Text>
                  {hero.deltaPp != null
                    ? ` — ${hero.deltaPp.toFixed(1)} pp ahead of ${joinNames(hero.otherNames)}.`
                    : ` — close to ${joinNames(hero.otherNames)} over the same window.`}
                </Text>
              </View>
            ) : (
              <View style={styles.banner}>
                <Text style={styles.bannerLabel}>Limited common history</Text>
                <Text style={styles.bannerValue}>Pick details by tab</Text>
                <Text style={styles.bannerSubtitle}>
                  At least one of these funds is too new to share a 1-year window with the others. Use the tabs below for what we do have.
                </Text>
              </View>
            )}

            {/* Key differences (prose) */}
            {keyDifferences.length > 0 ? (
              <View style={styles.proseCard}>
                <Text style={styles.proseTitle}>Key differences</Text>
                {keyDifferences.map((line, idx) => (
                  <Text key={idx} style={styles.proseLine}>
                    <Text style={styles.proseLabel}>{line.label}: </Text>
                    {line.body}
                  </Text>
                ))}
              </View>
            ) : null}

            {/* Tab strip */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.tabBar}
            >
              {TABS.map((tab) => {
                const isActive = activeTab === tab.key;
                return (
                  <TouchableOpacity
                    key={tab.key}
                    style={[styles.tabPill, isActive && styles.tabPillActive]}
                    onPress={() => setActiveTab(tab.key)}
                    activeOpacity={0.76}
                  >
                    <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                      {tab.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {/* Active tab */}
            <View style={styles.tabContent}>
              {activeTab === 'returns' && (
                <ReturnsTab schemes={schemes} metricsByCode={metricsByCode} tokens={tokens} />
              )}
              {activeTab === 'risk' && (
                <RiskTab schemes={schemes} metricsByCode={metricsByCode} tokens={tokens} />
              )}
              {activeTab === 'asset_mix' && (
                <AssetMixTab schemes={schemes} compositionsByCode={compositionsByCode} tokens={tokens} />
              )}
              {activeTab === 'sectors' && (
                <SectorsTab schemes={schemes} compositionsByCode={compositionsByCode} tokens={tokens} />
              )}
              {activeTab === 'holdings' && (
                <HoldingsTab schemes={schemes} compositionsByCode={compositionsByCode} tokens={tokens} />
              )}
              {activeTab === 'other' && (
                <OtherTab schemes={schemes} tokens={tokens} />
              )}
            </View>

            <Text style={styles.disclaimer}>
              Trailing returns and risk metrics are computed from NAV history; other metadata
              comes from the latest disclosed scheme details. Past performance is not indicative
              of future returns. We don&apos;t recommend or rate funds.
            </Text>

            <PortfolioDisclaimer />
          </>
        )}
      </ScrollView>

      <UniversalFundPicker
        visible={pickerOpen}
        selectedCodes={selectedCodes}
        mode="multi"
        maxFunds={MAX_FUNDS}
        onToggle={handleToggle}
        onClose={() => setPickerOpen(false)}
        title="Pick funds to compare"
      />
    </ClearLensScreen>
  );
}

// ---------------------------------------------------------------------------
// Hero + key-differences derivation
// ---------------------------------------------------------------------------

interface HeroSummary {
  windowLabel: string;
  leaderName: string;
  leaderReturn: number;
  otherNames: string[];
  deltaPp: number | null;
}

function deriveHero(
  schemes: SchemeMasterRow[],
  metricsByCode: Map<number, { trailing: TrailingPeriodReturns }>,
): HeroSummary | null {
  if (schemes.length < MIN_FUNDS) return null;

  type Entry = { code: number; name: string; value: number };
  const windows: { years: number; label: string; key: 'y3' | 'y1' }[] = [
    { years: 3, label: '3 years', key: 'y3' },
    { years: 1, label: '1 year', key: 'y1' },
  ];
  for (const w of windows) {
    const entries: Entry[] = [];
    let allHave = true;
    for (const scheme of schemes) {
      const m = metricsByCode.get(scheme.schemeCode);
      const v = m?.trailing[w.key];
      if (v == null || !Number.isFinite(v)) {
        // Try MFData fallback (period_returns) — this is biased but better than nothing.
        const mfdataField = w.years === 3 ? 'return_3y' : 'return_1y';
        const fallback = readMfdataPeriodReturn(scheme.periodReturns, mfdataField);
        if (fallback == null) { allHave = false; break; }
        // MFData returns are in % so divide by 100.
        entries.push({ code: scheme.schemeCode, name: shortSchemeName(scheme.schemeName), value: fallback / 100 });
      } else {
        entries.push({ code: scheme.schemeCode, name: shortSchemeName(scheme.schemeName), value: v });
      }
    }
    if (allHave && entries.length === schemes.length) {
      const sorted = [...entries].sort((a, b) => b.value - a.value);
      const leader = sorted[0];
      const next = sorted[1];
      const spreadPp = (sorted[0].value - sorted[sorted.length - 1].value) * 100;
      return {
        windowLabel: w.label.charAt(0).toUpperCase() + w.label.slice(1),
        leaderName: leader.name,
        leaderReturn: leader.value,
        otherNames: sorted.slice(1).map((x) => x.name),
        deltaPp: spreadPp < 1 ? null : (leader.value - next.value) * 100,
      };
    }
  }
  return null;
}

interface KeyDiffLine {
  label: string;
  body: string;
}

function deriveKeyDifferences(
  schemes: SchemeMasterRow[],
  compositionsByCode: Map<number, CompositionRow>,
  metricsByCode: Map<number, { sharpe: number | null; stdDev: number | null }>,
): KeyDiffLine[] {
  const out: KeyDiffLine[] = [];
  if (schemes.length < MIN_FUNDS) return out;

  // 1. Cost (lowest expense ratio)
  const erEntries = schemes
    .map((s) => ({ name: shortSchemeName(s.schemeName), er: s.expenseRatio }))
    .filter((e) => e.er != null) as { name: string; er: number }[];
  if (erEntries.length === schemes.length) {
    erEntries.sort((a, b) => a.er - b.er);
    const cheapest = erEntries[0];
    const priciest = erEntries[erEntries.length - 1];
    if (priciest.er - cheapest.er >= 0.1) {
      out.push({
        label: 'Lowest cost',
        body: `${cheapest.name} (${cheapest.er.toFixed(2)}%/yr), vs ${priciest.name} at ${priciest.er.toFixed(2)}%/yr.`,
      });
    } else {
      out.push({
        label: 'Cost',
        body: `Similar across all ${schemes.length} (${cheapest.er.toFixed(2)}–${priciest.er.toFixed(2)}%/yr).`,
      });
    }
  }

  // 2. Volatility (lowest std dev)
  const stdEntries = schemes
    .map((s) => ({
      name: shortSchemeName(s.schemeName),
      stdDev: metricsByCode.get(s.schemeCode)?.stdDev ?? null,
    }))
    .filter((e) => e.stdDev != null) as { name: string; stdDev: number }[];
  if (stdEntries.length === schemes.length && stdEntries.length >= 2) {
    stdEntries.sort((a, b) => a.stdDev - b.stdDev);
    const calmest = stdEntries[0];
    const wildest = stdEntries[stdEntries.length - 1];
    if ((wildest.stdDev - calmest.stdDev) * 100 >= 2) {
      out.push({
        label: 'Steadier ride',
        body: `${calmest.name} (${(calmest.stdDev * 100).toFixed(1)}% volatility), vs ${wildest.name} at ${(wildest.stdDev * 100).toFixed(1)}%.`,
      });
    }
  }

  // 3. Holding overlap (highest pair)
  const overlaps: { aName: string; bName: string; pct: number }[] = [];
  for (let i = 0; i < schemes.length; i++) {
    for (let j = i + 1; j < schemes.length; j++) {
      const a = schemes[i];
      const b = schemes[j];
      const aH = compositionsByCode.get(a.schemeCode)?.topHoldings ?? null;
      const bH = compositionsByCode.get(b.schemeCode)?.topHoldings ?? null;
      const overlap = computeHoldingOverlap(aH, bH);
      overlaps.push({
        aName: shortSchemeName(a.schemeName),
        bName: shortSchemeName(b.schemeName),
        pct: overlap.overlapPct,
      });
    }
  }
  if (overlaps.length > 0) {
    overlaps.sort((a, b) => b.pct - a.pct);
    const top = overlaps[0];
    if (top.pct >= 25) {
      out.push({
        label: 'Highest holding overlap',
        body: `${top.pct.toFixed(0)}% between ${top.aName} and ${top.bName} — meaningful share of the same names.`,
      });
    } else if (top.pct >= 5) {
      out.push({
        label: 'Holding overlap',
        body: `Modest — at most ${top.pct.toFixed(0)}% (${top.aName} ↔ ${top.bName}). Each fund mostly picks its own.`,
      });
    } else {
      out.push({
        label: 'Holding overlap',
        body: `Low across the board (peak ${top.pct.toFixed(0)}%). Each fund stakes out different names.`,
      });
    }
  }

  // 4. Asset mix divergence
  const equitySplit = schemes
    .map((s) => ({
      name: shortSchemeName(s.schemeName),
      equity: compositionsByCode.get(s.schemeCode)?.equityPct ?? null,
    }))
    .filter((e) => e.equity != null) as { name: string; equity: number }[];
  if (equitySplit.length === schemes.length && equitySplit.length >= 2) {
    equitySplit.sort((a, b) => b.equity - a.equity);
    const mostEquity = equitySplit[0];
    const leastEquity = equitySplit[equitySplit.length - 1];
    if (mostEquity.equity - leastEquity.equity >= 15) {
      out.push({
        label: 'Asset mix',
        body: `${mostEquity.name} runs ${mostEquity.equity.toFixed(0)}% equity vs ${leastEquity.name}'s ${leastEquity.equity.toFixed(0)}%.`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Returns tab
// ---------------------------------------------------------------------------

function ReturnsTab({
  schemes,
  metricsByCode,
  tokens,
}: {
  schemes: SchemeMasterRow[];
  metricsByCode: Map<number, { trailing: TrailingPeriodReturns }>;
  tokens: ClearLensTokens;
}) {
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

  const periods: { key: 'y1' | 'y3' | 'y5'; label: string; mfField: 'return_1y' | 'return_3y' | 'return_5y'; rankField: 'rank_1y' | 'rank_3y' | 'rank_5y' }[] = [
    { key: 'y1', label: '1Y', mfField: 'return_1y', rankField: 'rank_1y' },
    { key: 'y3', label: '3Y', mfField: 'return_3y', rankField: 'rank_3y' },
    { key: 'y5', label: '5Y', mfField: 'return_5y', rankField: 'rank_5y' },
  ];

  type Cell = { value: number | null; source: 'computed' | 'mfdata' | null; rank: number | null };
  function cellFor(scheme: SchemeMasterRow, period: typeof periods[number]): Cell {
    const computed = metricsByCode.get(scheme.schemeCode)?.trailing[period.key] ?? null;
    if (computed != null && Number.isFinite(computed)) {
      return { value: computed, source: 'computed', rank: null };
    }
    const mfdata = readMfdataPeriodReturn(scheme.periodReturns, period.mfField);
    if (mfdata != null) {
      const rank = readMfdataRank(scheme.periodReturns, period.rankField);
      return { value: mfdata / 100, source: 'mfdata', rank };
    }
    return { value: null, source: null, rank: null };
  }

  return (
    <View style={styles.tabCard}>
      <Text style={styles.tabIntro}>
        Annualised return per period. Computed from NAV history when we have ≥{`${period(periods[0].key)}`}; otherwise from MFData (which can be a few weeks stale).
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View style={styles.tableHeaderRow}>
            <View style={styles.cellLabel} />
            {schemes.map((s) => (
              <View key={s.schemeCode} style={styles.cell}>
                <Text style={styles.cellHeader} numberOfLines={2}>
                  {shortSchemeName(s.schemeName)}
                </Text>
              </View>
            ))}
          </View>
          {periods.map((p, idx) => {
            const cells = schemes.map((s) => cellFor(s, p));
            const numericCells = cells.filter((c) => c.value != null) as { value: number; source: 'computed' | 'mfdata'; rank: number | null }[];
            const leaderValue = numericCells.length > 0 ? Math.max(...numericCells.map((c) => c.value)) : null;
            return (
              <View key={p.key} style={[styles.tableRow, idx > 0 && styles.tableRowDividerTop]}>
                <View style={styles.cellLabel}>
                  <Text style={styles.cellLabelText}>{p.label}</Text>
                </View>
                {schemes.map((s, i) => {
                  const cell = cells[i];
                  const isLeader = cell.value != null && leaderValue != null && Math.abs(cell.value - leaderValue) < 1e-9 && numericCells.length > 1;
                  return (
                    <View key={s.schemeCode} style={styles.cell}>
                      <Text style={[styles.cellValue, isLeader && styles.cellValueLeader]}>
                        {cell.value != null ? `${(cell.value * 100).toFixed(1)}%` : '—'}
                      </Text>
                      {cell.source === 'mfdata' ? (
                        <Text style={styles.cellSource}>MFData</Text>
                      ) : null}
                      {cell.rank != null ? (
                        <Text style={styles.cellSource}>rank {cell.rank}</Text>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            );
          })}
        </View>
      </ScrollView>
      <Text style={styles.tabFootnote}>
        Bolded: leader for the period (when ≥2 funds have data and there&apos;s a clear leader).
      </Text>
    </View>
  );
}

function period(key: 'y1' | 'y3' | 'y5'): string {
  return key === 'y1' ? '1 year' : key === 'y3' ? '3 years' : '5 years';
}

// ---------------------------------------------------------------------------
// Risk tab
// ---------------------------------------------------------------------------

function RiskTab({
  schemes,
  metricsByCode,
  tokens,
}: {
  schemes: SchemeMasterRow[];
  metricsByCode: Map<number, { sharpe: number | null; sortino: number | null; stdDev: number | null; monthlyObservations: number }>;
  tokens: ClearLensTokens;
}) {
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

  // Per-fund derived data. Doing this once outside the row loop keeps each
  // cell renderer cheap.
  const perFund = schemes.map((scheme) => ({
    scheme,
    metrics: metricsByCode.get(scheme.schemeCode) ?? null,
    beta: readMfdataBeta(scheme.riskRatios, scheme.schemeCategory),
    r2: readMfdataRSquared(scheme.riskRatios, scheme.schemeCategory),
  }));

  type Row = {
    key: 'std' | 'sharpe' | 'sortino' | 'beta' | 'r2';
    label: string;
    hint: string;
    cell: (f: typeof perFund[number]) => string;
    visible: boolean;
  };
  const anyBetaOrR2 = perFund.some((f) => f.beta != null || f.r2 != null);
  const rows: Row[] = [
    {
      key: 'std',
      label: 'Std deviation',
      hint: 'How wildly returns swing month to month. Lower = smoother ride.',
      cell: (f) => (f.metrics?.stdDev != null ? `${(f.metrics.stdDev * 100).toFixed(1)}%` : '—'),
      visible: true,
    },
    {
      key: 'sharpe',
      label: 'Sharpe',
      hint: 'Return per unit of risk. Higher = more reward for the bumps.',
      cell: (f) => (f.metrics?.sharpe != null ? f.metrics.sharpe.toFixed(2) : '—'),
      visible: true,
    },
    {
      key: 'sortino',
      label: 'Sortino',
      hint: 'Like Sharpe, but counts only downside swings as risk. Higher = better at avoiding losses.',
      cell: (f) => (f.metrics?.sortino != null ? f.metrics.sortino.toFixed(2) : '—'),
      visible: true,
    },
    {
      key: 'beta',
      label: 'Beta',
      hint: 'How much the fund moves with the market. 1 = in step. < 1 = steadier.',
      cell: (f) => (f.beta != null ? f.beta.toFixed(2) : '—'),
      visible: anyBetaOrR2,
    },
    {
      key: 'r2',
      label: 'R²',
      hint: 'How closely the fund tracks its benchmark. 100% = identical movement.',
      cell: (f) => (f.r2 != null ? `${f.r2.toFixed(0)}%` : '—'),
      visible: anyBetaOrR2,
    },
  ];
  const visibleRows = rows.filter((r) => r.visible);

  // Per-fund footnote: short window for risk metrics. Build once so the
  // footer below the table can list "DSP Mid Cap (12 months), HDFC Mid Cap (8 months)".
  const shortWindowNotes = perFund
    .filter((f) => (f.metrics?.monthlyObservations ?? 0) < 36)
    .map((f) => `${shortSchemeName(f.scheme.schemeName)} (${f.metrics?.monthlyObservations ?? 0} months)`);

  return (
    <View style={styles.tabCard}>
      <Text style={styles.tabIntro}>
        Risk metrics over the trailing 3 years. Computed locally from monthly returns;
        Beta and R² come from MFData and only show for equity / hybrid funds.
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View style={styles.tableHeaderRow}>
            <View style={styles.cellLabelWide} />
            {schemes.map((s) => (
              <View key={s.schemeCode} style={styles.cell}>
                <Text style={styles.cellHeader} numberOfLines={2}>
                  {shortSchemeName(s.schemeName)}
                </Text>
              </View>
            ))}
          </View>
          {visibleRows.map((row, idx) => (
            <View key={row.key} style={[styles.tableRow, idx > 0 && styles.tableRowDividerTop]}>
              <View style={styles.cellLabelWide}>
                <Text style={styles.cellLabelText}>{row.label}</Text>
                <Text style={styles.cellLabelHint}>{row.hint}</Text>
              </View>
              {perFund.map((f) => (
                <View key={f.scheme.schemeCode} style={styles.cell}>
                  <Text style={styles.cellValue}>{row.cell(f)}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      {!anyBetaOrR2 ? (
        <Text style={styles.tabFootnote}>
          Beta and R² aren&apos;t shown for these categories — they apply to equity / hybrid funds.
        </Text>
      ) : null}
      {shortWindowNotes.length > 0 ? (
        <Text style={styles.tabFootnote}>
          Short risk-metric window: {shortWindowNotes.join('; ')}. Anything under 36 months of returns
          means a shorter sample than the standard 3-year benchmark.
        </Text>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Asset mix tab
// ---------------------------------------------------------------------------

function AssetMixTab({
  schemes,
  compositionsByCode,
  tokens,
}: {
  schemes: SchemeMasterRow[];
  compositionsByCode: Map<number, CompositionRow>;
  tokens: ClearLensTokens;
}) {
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

  const headerCells = (
    <View style={styles.tableHeaderRow}>
      <View style={styles.cellLabel} />
      {schemes.map((s) => (
        <View key={s.schemeCode} style={styles.cell}>
          <Text style={styles.cellHeader} numberOfLines={2}>
            {shortSchemeName(s.schemeName)}
          </Text>
        </View>
      ))}
    </View>
  );

  const rows: { label: string; pluck: (c: CompositionRow) => number | null | undefined }[] = [
    { label: 'Equity', pluck: (c) => c.equityPct },
    { label: 'Debt', pluck: (c) => c.debtPct },
    { label: 'Cash', pluck: (c) => c.cashPct },
    { label: 'Other', pluck: (c) => c.otherPct },
  ];
  const capRows: { label: string; pluck: (c: CompositionRow) => number | null | undefined }[] = [
    { label: 'Large cap', pluck: (c) => c.largeCapPct },
    { label: 'Mid cap', pluck: (c) => c.midCapPct },
    { label: 'Small cap', pluck: (c) => c.smallCapPct },
  ];

  return (
    <View style={styles.tabCard}>
      <Text style={styles.tabIntro}>
        Where each fund parks its money. Cap mix is shown when a fund has equity exposure.
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          {headerCells}
          {rows.map((r, idx) => (
            <View key={r.label} style={[styles.tableRow, idx > 0 && styles.tableRowDividerTop]}>
              <View style={styles.cellLabel}><Text style={styles.cellLabelText}>{r.label}</Text></View>
              {schemes.map((s) => {
                const c = compositionsByCode.get(s.schemeCode);
                const v = c ? r.pluck(c) : null;
                return (
                  <View key={s.schemeCode} style={styles.cell}>
                    <Text style={styles.cellValue}>{v != null ? `${v.toFixed(0)}%` : '—'}</Text>
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>

      <Text style={styles.subhead}>Market cap mix</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          {headerCells}
          {capRows.map((r, idx) => (
            <View key={r.label} style={[styles.tableRow, idx > 0 && styles.tableRowDividerTop]}>
              <View style={styles.cellLabel}><Text style={styles.cellLabelText}>{r.label}</Text></View>
              {schemes.map((s) => {
                const c = compositionsByCode.get(s.schemeCode);
                const v = c ? r.pluck(c) : null;
                return (
                  <View key={s.schemeCode} style={styles.cell}>
                    <Text style={styles.cellValue}>{v != null ? `${v.toFixed(0)}%` : '—'}</Text>
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sectors tab — top sectors + credit-rating breakdown for debt holdings
// ---------------------------------------------------------------------------

function SectorsTab({
  schemes,
  compositionsByCode,
  tokens,
}: {
  schemes: SchemeMasterRow[];
  compositionsByCode: Map<number, CompositionRow>;
  tokens: ClearLensTokens;
}) {
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

  // Build sector union (top 8 sectors by max weight across funds).
  const sectorWeightsByName = new Map<string, number>();
  for (const s of schemes) {
    const sec = compositionsByCode.get(s.schemeCode)?.sectorAllocation;
    if (!sec) continue;
    for (const [name, weight] of Object.entries(sec)) {
      const w = Number(weight);
      if (!Number.isFinite(w)) continue;
      const existing = sectorWeightsByName.get(name) ?? 0;
      if (w > existing) sectorWeightsByName.set(name, w);
    }
  }
  const topSectors = [...sectorWeightsByName.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name]) => name);

  // Credit rating union for debt funds.
  const creditByCode = new Map<number, { rating: string; weight: number }[]>();
  for (const s of schemes) {
    const debt = compositionsByCode.get(s.schemeCode)?.rawDebtHoldings ?? null;
    if (!debt || debt.length === 0) continue;
    const buckets = new Map<string, number>();
    for (const h of debt) {
      const rating = (h.credit_rating ?? 'Unrated').trim() || 'Unrated';
      const w = Number(h.weight_pct ?? 0);
      if (!Number.isFinite(w)) continue;
      buckets.set(rating, (buckets.get(rating) ?? 0) + w);
    }
    creditByCode.set(
      s.schemeCode,
      [...buckets.entries()]
        .map(([rating, weight]) => ({ rating, weight }))
        .sort((a, b) => b.weight - a.weight),
    );
  }
  const hasAnyCredit = [...creditByCode.values()].some((arr) => arr.length > 0);
  const creditUnion = new Set<string>();
  for (const arr of creditByCode.values()) for (const e of arr) creditUnion.add(e.rating);
  const creditOrder = ['SOV', 'AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB', 'B+', 'B', 'Cash Equivalent', 'Unrated'];
  const orderedRatings = [...creditUnion].sort((a, b) => {
    const ai = creditOrder.indexOf(a);
    const bi = creditOrder.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });

  const headerCells = (
    <View style={styles.tableHeaderRow}>
      <View style={styles.cellLabel} />
      {schemes.map((s) => (
        <View key={s.schemeCode} style={styles.cell}>
          <Text style={styles.cellHeader} numberOfLines={2}>
            {shortSchemeName(s.schemeName)}
          </Text>
        </View>
      ))}
    </View>
  );

  return (
    <View style={styles.tabCard}>
      {topSectors.length > 0 ? (
        <>
          <Text style={styles.tabIntro}>
            Top sector exposures across the selected funds (aggregated from disclosed holdings).
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              {headerCells}
              {topSectors.map((sectorName, idx) => (
                <View key={sectorName} style={[styles.tableRow, idx > 0 && styles.tableRowDividerTop]}>
                  <View style={styles.cellLabel}><Text style={styles.cellLabelText} numberOfLines={2}>{sectorName}</Text></View>
                  {schemes.map((s) => {
                    const v = compositionsByCode.get(s.schemeCode)?.sectorAllocation?.[sectorName];
                    const num = typeof v === 'number' ? v : null;
                    return (
                      <View key={s.schemeCode} style={styles.cell}>
                        <Text style={styles.cellValue}>{num != null ? `${num.toFixed(1)}%` : '—'}</Text>
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
          </ScrollView>
        </>
      ) : (
        <Text style={styles.tabIntro}>
          No sector data disclosed for these funds yet.
        </Text>
      )}

      {hasAnyCredit ? (
        <>
          <Text style={styles.subhead}>Credit rating mix</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              {headerCells}
              {orderedRatings.map((rating, idx) => (
                <View key={rating} style={[styles.tableRow, idx > 0 && styles.tableRowDividerTop]}>
                  <View style={styles.cellLabel}><Text style={styles.cellLabelText}>{rating}</Text></View>
                  {schemes.map((s) => {
                    const arr = creditByCode.get(s.schemeCode) ?? [];
                    const entry = arr.find((e) => e.rating === rating);
                    return (
                      <View key={s.schemeCode} style={styles.cell}>
                        <Text style={styles.cellValue}>{entry ? `${entry.weight.toFixed(1)}%` : '—'}</Text>
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
          </ScrollView>
          <Text style={styles.tabFootnote}>
            SOV = government securities. AAA / AA / A grades indicate corporate credit quality (high to lower).
          </Text>
        </>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Holdings tab
// ---------------------------------------------------------------------------

function HoldingsTab({
  schemes,
  compositionsByCode,
  tokens,
}: {
  schemes: SchemeMasterRow[];
  compositionsByCode: Map<number, CompositionRow>;
  tokens: ClearLensTokens;
}) {
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

  // Equity union — top 25 holding names ranked by max weight across funds.
  const eqWeightsByName = new Map<string, number>();
  for (const s of schemes) {
    const top = compositionsByCode.get(s.schemeCode)?.topHoldings ?? null;
    if (!top) continue;
    for (const h of top) {
      const w = Number(h.pctOfNav);
      if (!Number.isFinite(w)) continue;
      const existing = eqWeightsByName.get(h.name) ?? 0;
      if (w > existing) eqWeightsByName.set(h.name, w);
    }
  }
  const topEquityNames = [...eqWeightsByName.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([name]) => name);

  // Debt union — top 25 debt holdings.
  const debtWeightsByName = new Map<string, number>();
  for (const s of schemes) {
    const debt = compositionsByCode.get(s.schemeCode)?.rawDebtHoldings ?? null;
    if (!debt) continue;
    for (const h of debt) {
      const name = h.name;
      const w = Number(h.weight_pct ?? 0);
      if (!name || !Number.isFinite(w)) continue;
      const existing = debtWeightsByName.get(name) ?? 0;
      if (w > existing) debtWeightsByName.set(name, w);
    }
  }
  const topDebtNames = [...debtWeightsByName.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([name]) => name);

  const headerCells = (
    <View style={styles.tableHeaderRow}>
      <View style={styles.cellLabelWide} />
      {schemes.map((s) => (
        <View key={s.schemeCode} style={styles.cell}>
          <Text style={styles.cellHeader} numberOfLines={2}>
            {shortSchemeName(s.schemeName)}
          </Text>
        </View>
      ))}
    </View>
  );

  return (
    <View style={styles.tabCard}>
      {topEquityNames.length > 0 ? (
        <>
          <Text style={styles.tabIntro}>
            Top 25 equity holdings across the selected funds. Empty cell = the fund doesn&apos;t hold the name.
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              {headerCells}
              {topEquityNames.map((name, idx) => (
                <View key={name} style={[styles.tableRow, idx > 0 && styles.tableRowDividerTop]}>
                  <View style={styles.cellLabelWide}>
                    <Text style={styles.cellLabelText} numberOfLines={2}>{name}</Text>
                  </View>
                  {schemes.map((s) => {
                    const top = compositionsByCode.get(s.schemeCode)?.topHoldings ?? null;
                    const entry = top?.find((h) => h.name === name);
                    return (
                      <View key={s.schemeCode} style={styles.cell}>
                        <Text style={styles.cellValue}>
                          {entry ? `${entry.pctOfNav.toFixed(2)}%` : '—'}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
          </ScrollView>
        </>
      ) : null}

      {topDebtNames.length > 0 ? (
        <>
          <Text style={styles.subhead}>Top debt holdings</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              {headerCells}
              {topDebtNames.map((name, idx) => (
                <View key={name} style={[styles.tableRow, idx > 0 && styles.tableRowDividerTop]}>
                  <View style={styles.cellLabelWide}>
                    <Text style={styles.cellLabelText} numberOfLines={2}>{name}</Text>
                  </View>
                  {schemes.map((s) => {
                    const debt = compositionsByCode.get(s.schemeCode)?.rawDebtHoldings ?? null;
                    const entry = debt?.find((h) => h.name === name);
                    return (
                      <View key={s.schemeCode} style={styles.cell}>
                        <Text style={styles.cellValue}>
                          {entry && entry.weight_pct != null ? `${entry.weight_pct.toFixed(2)}%` : '—'}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
          </ScrollView>
        </>
      ) : null}

      {topEquityNames.length === 0 && topDebtNames.length === 0 ? (
        <Text style={styles.tabIntro}>
          No holdings disclosed for these funds yet.
        </Text>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Other tab — fund metadata
// ---------------------------------------------------------------------------

function OtherTab({
  schemes,
  tokens,
}: {
  schemes: SchemeMasterRow[];
  tokens: ClearLensTokens;
}) {
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

  const fundAge = (launch: string | null): string => {
    if (!launch) return '—';
    const d = new Date(launch);
    if (Number.isNaN(d.getTime())) return '—';
    const ms = Date.now() - d.getTime();
    const years = ms / (365.25 * 24 * 60 * 60 * 1000);
    if (years < 1) return `${Math.max(0, Math.round(years * 12))}m`;
    return `${years.toFixed(1)}y`;
  };

  type Row = { label: string; render: (s: SchemeMasterRow) => string };
  const rows: Row[] = [
    { label: 'Category', render: (s) => s.schemeCategory ?? '—' },
    { label: 'Plan type', render: (s) => s.planType ? s.planType[0].toUpperCase() + s.planType.slice(1) : '—' },
    { label: 'Benchmark', render: (s) => s.benchmark ?? '—' },
    { label: 'Expense ratio', render: (s) => s.expenseRatio != null ? `${s.expenseRatio.toFixed(2)}%/yr` : '—' },
    { label: 'AUM', render: (s) => s.aumCr != null ? formatCurrency(s.aumCr * 1_00_00_000) : '—' },
    { label: 'Exit load', render: (s) => s.exitLoad ?? '—' },
    {
      label: 'Fund age',
      render: (s) => {
        if (!s.launchDate) return '—';
        const age = fundAge(s.launchDate);
        if (isLaunchDateDirectPlanIntroduction(s.launchDate)) {
          return `${age} (direct plan since ${s.launchDate.slice(0, 10)})`;
        }
        return `${age} (since ${s.launchDate.slice(0, 10)})`;
      },
    },
    { label: 'Min SIP', render: (s) => s.minSipAmount != null ? formatCurrency(s.minSipAmount) : '—' },
    { label: 'Min lumpsum', render: (s) => s.minLumpsum != null ? formatCurrency(s.minLumpsum) : '—' },
    { label: 'Min addl', render: (s) => s.minAdditional != null ? formatCurrency(s.minAdditional) : '—' },
    { label: 'AMC', render: (s) => s.amcName ?? '—' },
    { label: 'Riskometer', render: (s) => s.riskLabel ?? '—' },
    { label: 'Morningstar', render: (s) => s.morningstarRating != null ? `${'★'.repeat(s.morningstarRating)}${'☆'.repeat(Math.max(0, 5 - s.morningstarRating))}` : '—' },
  ];

  const headerCells = (
    <View style={styles.tableHeaderRow}>
      <View style={styles.cellLabel} />
      {schemes.map((s) => (
        <View key={s.schemeCode} style={styles.cell}>
          <Text style={styles.cellHeader} numberOfLines={2}>
            {shortSchemeName(s.schemeName)}
          </Text>
        </View>
      ))}
    </View>
  );

  return (
    <View style={styles.tabCard}>
      <Text style={styles.tabIntro}>
        Scheme metadata. Some fields fill in 24h after a fund is added — sync runs daily.
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          {headerCells}
          {rows.map((r, idx) => (
            <View key={r.label} style={[styles.tableRow, idx > 0 && styles.tableRowDividerTop]}>
              <View style={styles.cellLabel}><Text style={styles.cellLabelText}>{r.label}</Text></View>
              {schemes.map((s) => (
                <View key={s.schemeCode} style={styles.cell}>
                  <Text style={styles.cellValue} numberOfLines={2}>{r.render(s)}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function joinNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    scrollContent: {
      paddingHorizontal: ClearLensSpacing.md,
      paddingTop: ClearLensSpacing.xs,
      paddingBottom: ClearLensSpacing.xxl,
      gap: ClearLensSpacing.sm,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: ClearLensSpacing.xl,
      paddingVertical: ClearLensSpacing.lg,
      gap: ClearLensSpacing.sm,
    },
    helperText: { ...ClearLensTypography.body, color: cl.textTertiary },
    titleBlock: {
      gap: 4,
      paddingHorizontal: ClearLensSpacing.xs,
      paddingVertical: ClearLensSpacing.sm,
    },
    eyebrow: {
      ...ClearLensTypography.label,
      color: cl.emerald,
      textTransform: 'uppercase',
    },
    title: { ...ClearLensTypography.h1, color: cl.navy },
    subtitle: { ...ClearLensTypography.body, color: cl.textSecondary },
    emptyTitle: { ...ClearLensTypography.h2, color: cl.navy, textAlign: 'center' },

    chipsCard: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.border,
      ...ClearLensShadow,
      padding: ClearLensSpacing.md,
      gap: ClearLensSpacing.sm,
    },
    inputLabel: {
      ...ClearLensTypography.label,
      color: cl.textTertiary,
      letterSpacing: 0.4,
    },
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: ClearLensSpacing.xs,
    },
    fundChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.xs,
      paddingVertical: 6,
      paddingHorizontal: ClearLensSpacing.sm,
      borderRadius: ClearLensRadii.full,
      backgroundColor: cl.surfaceSoft,
      borderWidth: 1,
      borderColor: cl.borderLight,
      maxWidth: '100%',
    },
    fundChipName: {
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
      flexShrink: 1,
    },
    addChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingVertical: 6,
      paddingHorizontal: ClearLensSpacing.sm,
      borderRadius: ClearLensRadii.full,
      borderWidth: 1,
      borderColor: cl.emerald,
      borderStyle: 'dashed',
    },
    addChipText: {
      fontFamily: ClearLensFonts.semiBold,
      fontSize: 13,
      color: cl.emerald,
    },

    banner: {
      backgroundColor: cl.heroSurface,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
      gap: 4,
    },
    bannerLabel: {
      ...ClearLensTypography.label,
      color: cl.textOnDarkMuted,
      textTransform: 'uppercase',
    },
    bannerValue: {
      ...ClearLensTypography.h1,
      color: cl.textOnDark,
    },
    bannerSubtitle: {
      ...ClearLensTypography.bodySmall,
      color: cl.textOnDarkMuted,
      paddingTop: ClearLensSpacing.xs,
      lineHeight: 19,
    },
    bannerGainUp: {
      color: cl.positive,
      fontFamily: ClearLensFonts.semiBold,
    },

    proseCard: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.border,
      ...ClearLensShadow,
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: ClearLensSpacing.sm,
      gap: ClearLensSpacing.xs,
    },
    proseTitle: {
      ...ClearLensTypography.h3,
      color: cl.navy,
      paddingTop: ClearLensSpacing.xs,
      paddingBottom: ClearLensSpacing.xs,
    },
    proseLine: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      lineHeight: 22,
      paddingBottom: 2,
    },
    proseLabel: {
      color: cl.navy,
      fontFamily: ClearLensFonts.semiBold,
    },

    tabBar: {
      flexDirection: 'row',
      gap: ClearLensSpacing.xs,
      paddingVertical: ClearLensSpacing.xs,
    },
    tabPill: {
      paddingHorizontal: ClearLensSpacing.sm + 2,
      paddingVertical: 8,
      borderRadius: ClearLensRadii.full,
      borderWidth: 1,
      borderColor: cl.borderLight,
      backgroundColor: cl.surface,
    },
    tabPillActive: {
      borderColor: cl.emerald,
      backgroundColor: cl.emerald,
    },
    tabLabel: {
      fontFamily: ClearLensFonts.semiBold,
      fontSize: 13,
      color: cl.textSecondary,
    },
    tabLabelActive: {
      color: cl.textOnDark,
    },

    tabContent: {
      gap: ClearLensSpacing.sm,
    },
    tabCard: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.border,
      ...ClearLensShadow,
      padding: ClearLensSpacing.md,
      gap: ClearLensSpacing.sm,
    },
    tabIntro: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
      lineHeight: 19,
    },
    tabFootnote: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      lineHeight: 16,
    },
    subhead: {
      ...ClearLensTypography.label,
      color: cl.textTertiary,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      paddingTop: ClearLensSpacing.sm,
    },

    tableHeaderRow: {
      flexDirection: 'row',
      paddingVertical: ClearLensSpacing.xs,
    },
    tableRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingVertical: 10,
    },
    tableRowDividerTop: {
      borderTopWidth: 1,
      borderTopColor: cl.borderLight,
    },
    cellLabel: {
      width: 110,
      paddingRight: ClearLensSpacing.xs,
    },
    cellLabelWide: {
      width: 160,
      paddingRight: ClearLensSpacing.xs,
    },
    cellLabelText: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
    },
    cellLabelHint: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      lineHeight: 15,
      paddingTop: 2,
    },
    cell: {
      width: 130,
      paddingRight: ClearLensSpacing.xs,
      gap: 2,
    },
    cellHeader: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      textTransform: 'uppercase',
      letterSpacing: 0.3,
    },
    cellValue: {
      fontFamily: ClearLensFonts.semiBold,
      fontSize: 13,
      color: cl.navy,
    },
    cellValueLeader: {
      color: cl.emerald,
    },
    cellSource: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
    },

    errorBox: {
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.surfaceSoft,
      borderWidth: 1,
      borderColor: cl.borderLight,
    },
    errorText: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
      lineHeight: 18,
    },
    disclaimer: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      textAlign: 'center',
      paddingHorizontal: ClearLensSpacing.sm,
      lineHeight: 17,
      marginTop: ClearLensSpacing.xs,
    },
  });
}
