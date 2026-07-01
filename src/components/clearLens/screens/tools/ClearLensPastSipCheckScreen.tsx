/**
 * Past SIP Check — simulate how a fixed monthly SIP would have performed in
 * one of the user's held funds versus a benchmark.
 *
 * Data flow:
 *  - Fetch the user's active funds and the chosen benchmark NAV history via
 *    `fetchPerformanceTimeline` (same source the Compare screen uses).
 *  - Run the simulation purely in `simulatePastSip` (see `pastSipCheck.ts`).
 *  - Build a chart series with `buildPastSipChartSeries`.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import Svg, { G, Line as SvgLine, Path as SvgPath, Text as SvgText } from 'react-native-svg';
import { ClearLensHeader, ClearLensScreen, ClearLensSegmentedControl } from '@/src/components/clearLens/ClearLensPrimitives';
import { PortfolioDisclaimer } from '@/src/components/clearLens/PortfolioDisclaimer';
import { UniversalFundPicker } from '@/src/components/clearLens/UniversalFundPicker';
import { ToolsPreviewSampleCard } from '@/src/components/clearLens/ToolsPreviewSampleCard';
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
import { navHistoryRepo } from '@/src/lib/data/navHistory';
import { functionsClient } from '@/src/lib/functions';
import { perfEnd, perfStart } from '@/src/lib/perfMark';
import { BENCHMARK_OPTIONS, useAppStore } from '@/src/store/appStore';
import { fetchPerformanceTimeline } from '@/src/hooks/usePerformanceTimeline';
import { fetchUserHeldSchemes, type SchemeSearchResult } from '@/src/utils/fundSearch';
import { shortSchemeName } from '@/src/utils/schemeName';
import {
  buildPastSipChartSeries,
  simulatePastSip,
  CUSTOM_DURATION_MIN_MONTHS,
  CUSTOM_DURATION_MAX_MONTHS,
  type PastSipDuration,
  type PastSipChartPoint,
} from '@/src/utils/pastSipCheck';
import { formatCurrency } from '@/src/utils/formatting';
import { BENCHMARK_DISCLOSURE } from '@/src/utils/benchmarkSymbolMap';
import { paginateRangeQuery } from '@/src/utils/supabasePagination';
import type { NavPoint } from '@/src/utils/navUtils';

// String-only key the segmented control accepts (it's generic over T extends
// string). The actual simulator-bound duration is held separately and can be
// the object-form { months: N } for the Custom case.
type DurationKey = '1Y' | '3Y' | '5Y' | 'All' | 'Custom';

function durationToKey(d: PastSipDuration): DurationKey {
  return typeof d === 'object' ? 'Custom' : d;
}

function formatCustomLabel(months: number): string {
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m}m`;
  if (m === 0) return `${y}y`;
  return `${y}y ${m}m`;
}

/**
 * For 1Y / 3Y / 5Y the duration label already tells the user the window —
 * we don't repeat it. But "All" and Custom hide the actual span, and a
 * 13-year DSP TIGER chart looks identical to a 3-year newer-fund chart
 * unless we spell out the dates in prose.
 */
function shouldShowWindowInProse(duration: PastSipDuration): boolean {
  if (typeof duration === 'object') return true;
  return duration === 'All';
}

/** "2013-04-15" → "Apr 2013". Empty string for missing input. */
function formatMonthYear(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

interface PickedScheme {
  schemeCode: number;
  schemeName: string;
  schemeCategory: string | null;
}

/**
 * Direct fetch of nav_history by scheme_code — works for any scheme, not
 * just held funds. Returns ascending date order so simulatePastSip can walk
 * forward through it.
 *
 * Tries the month_end_nav RPC first (which returns ~60–240 rows for typical
 * multi-year windows, cutting egress ~30×), falling back to the full paginated
 * fetch if the RPC isn't available (feature detection). The paginated fetch
 * handles Supabase REST's 1000-row limit — schemes with 13+ years of history
 * (~3,300 NAVs) would truncate without pagination.
 */
async function fetchNavSeries(schemeCode: number): Promise<NavPoint[]> {
  const navSpanId = perfStart('query:sipCheck:nav');

  // Try the optimized month-end RPC first
  try {
    const monthEndRows = await navHistoryRepo.monthEndNav(schemeCode);
    perfEnd(navSpanId, {
      rows: monthEndRows.length,
      scheme_code: schemeCode,
      path: 'rpc:month_end_nav',
    });
    return monthEndRows;
  } catch (rpcError) {
    // RPC failed; log and fall back to paginated full fetch
    console.warn('month_end_nav RPC unavailable, falling back to paginated fetch:', rpcError);
  }

  // Fallback: paginate through the full nav_history
  const rows = await paginateRangeQuery<{ nav_date: string; nav: number }>(
    (from, to) => navHistoryRepo
      .from()
      .select('nav_date, nav')
      .eq('scheme_code', schemeCode)
      .order('nav_date', { ascending: true })
      .range(from, to),
  );
  perfEnd(navSpanId, {
    rows: rows.length,
    scheme_code: schemeCode,
    path: 'paginated:nav_history',
  });
  return rows.map((row) => ({ date: row.nav_date, value: Number(row.nav) }));
}

/**
 * Trigger an on-demand NAV backfill for a non-held scheme. The edge function
 * is idempotent (skips the upstream fetch if the cache is fresh), so calling
 * this on every scheme change is safe.
 */
async function ensureNavCached(schemeCode: number): Promise<{ status: string }> {
  const backfillSpanId = perfStart('query:sipCheck:backfill');
  const { data, error } = await functionsClient.invoke<{ status: string }>('fetch-fund-nav', {
    body: { scheme_code: schemeCode },
  });
  perfEnd(backfillSpanId, { status: data?.status ?? 'unknown', scheme_code: schemeCode });
  if (error) throw new Error(`fetch-fund-nav failed: ${error.message}`);
  return data ?? { status: 'unknown' };
}

export function ClearLensPastSipCheckScreen() {
  useTrackInsightViewed('past_sip_check');
  const router = useRouter();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const { width: windowWidth } = useWindowDimensions();
  const { session } = useSession();
  const userId = session?.user.id;
  const previewMode = useAppStore((s) => s.previewMode);
  const { defaultBenchmarkSymbol } = useAppStore();

  const [selectedScheme, setSelectedScheme] = useState<PickedScheme | null>(null);
  const [amountStr, setAmountStr] = useState<string>('10000');
  const [duration, setDuration] = useState<PastSipDuration>('3Y');
  const [benchmarkSymbol, setBenchmarkSymbol] = useState<string>(defaultBenchmarkSymbol);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);

  // The segmented control needs a string key — derive it from the (richer)
  // PastSipDuration. For the Custom case the pill label flips from "Custom"
  // to a compact summary like "2y 6m" once the user has picked a value.
  const selectedDurationKey: DurationKey = durationToKey(duration);
  const durationOptions = useMemo<{ value: DurationKey; label: string }[]>(
    () => [
      { value: '1Y', label: '1Y' },
      { value: '3Y', label: '3Y' },
      { value: '5Y', label: '5Y' },
      { value: 'All', label: 'All' },
      {
        value: 'Custom',
        label:
          typeof duration === 'object' ? formatCustomLabel(duration.months) : 'Custom',
      },
    ],
    [duration],
  );

  const handleDurationKeyChange = (next: DurationKey) => {
    if (next === 'Custom') {
      setCustomOpen(true);
      return;
    }
    setDuration(next);
  };

  const applyCustomDuration = (months: number) => {
    const clamped = Math.min(
      CUSTOM_DURATION_MAX_MONTHS,
      Math.max(CUSTOM_DURATION_MIN_MONTHS, Math.floor(months)),
    );
    setDuration({ months: clamped });
    setCustomOpen(false);
  };

  // For seeding the picker default with the user's first held fund.
  const userHeldQuery = useQuery({
    queryKey: ['past-sip-check:user-held-seed', userId],
    queryFn: () => (userId ? fetchUserHeldSchemes(userId) : Promise.resolve([] as SchemeSearchResult[])),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  });

  // Auto-pick the first holding once data arrives.
  useEffect(() => {
    if (!selectedScheme && (userHeldQuery.data?.length ?? 0) > 0) {
      const f = userHeldQuery.data![0];
      setSelectedScheme({
        schemeCode: f.schemeCode,
        schemeName: f.schemeName,
        schemeCategory: f.schemeCategory,
      });
    }
  }, [userHeldQuery.data, selectedScheme]);

  const benchmarkLabel =
    BENCHMARK_OPTIONS.find((b) => b.symbol === benchmarkSymbol)?.label ?? benchmarkSymbol;

  // On-demand NAV backfill for the picked scheme. Idempotent — the edge
  // function is a no-op when the cache is fresh.
  const navBackfillQuery = useQuery({
    queryKey: ['past-sip-check:nav-backfill', selectedScheme?.schemeCode],
    enabled: !!selectedScheme,
    queryFn: () => (selectedScheme ? ensureNavCached(selectedScheme.schemeCode) : Promise.resolve({ status: 'noop' })),
    staleTime: 5 * 60 * 1000,
  });

  // Fund NAV history — direct query of nav_history by scheme_code. Reruns
  // after the backfill completes (queryKey depends on backfill status).
  const fundNavQuery = useQuery({
    queryKey: ['past-sip-check:fund-nav', selectedScheme?.schemeCode, navBackfillQuery.data?.status],
    enabled: !!selectedScheme && !!navBackfillQuery.data,
    queryFn: () => (selectedScheme ? fetchNavSeries(selectedScheme.schemeCode) : Promise.resolve([])),
    staleTime: 60_000,
  });

  // Benchmark NAV — keep using fetchPerformanceTimeline since index_history
  // is a different schema (index_symbol keyed) and existing benchmark sync
  // already covers our supported indices.
  const benchmarkTimelineQuery = useQuery({
    queryKey: ['past-sip-check:benchmark', benchmarkSymbol],
    queryFn: () =>
      fetchPerformanceTimeline([], [{ symbol: benchmarkSymbol, name: benchmarkLabel }]),
    staleTime: 5 * 60 * 1000,
  });

  const monthlyAmount = parseRupees(amountStr);

  const fundNavSeries = fundNavQuery.data ?? null;
  const benchmarkEntry = benchmarkTimelineQuery.data?.entries.find(
    (e) => e.type === 'index' && e.id === benchmarkSymbol,
  );

  const fundResult = useMemo(() => {
    if (!fundNavSeries || fundNavSeries.length === 0) return null;
    return simulatePastSip({
      navSeries: fundNavSeries,
      monthlyAmount,
      duration,
    });
  }, [fundNavSeries, monthlyAmount, duration]);

  // Align the benchmark sim to the fund's installment dates and terminal date
  // so the XIRR comparison reflects only underlying performance — without
  // alignment, the fund and index choose their own end-of-window dates,
  // creating a 0.5–1%/yr spurious gap from a 1–2 day terminal-date drift.
  const benchmarkResult = useMemo(() => {
    if (!benchmarkEntry || !fundResult) return null;
    return simulatePastSip({
      navSeries: benchmarkEntry.history,
      monthlyAmount,
      duration,
      alignToFund: fundResult,
    });
  }, [benchmarkEntry, monthlyAmount, duration, fundResult]);

  const chartPoints = useMemo(
    () => (fundResult ? buildPastSipChartSeries(fundResult, benchmarkResult) : []),
    [fundResult, benchmarkResult],
  );

  // ClearLensScreen caps content at 960px on desktop (list tier); clamp the
  // chart so the SVG doesn't overflow the card on wide viewports and so it
  // fills the card rather than leaving a gap on the right.
  const chartWidth = Math.min(windowWidth, 960) - ClearLensSpacing.md * 2;

  // -------------------------------------------------------------------------
  // Empty / loading states
  // -------------------------------------------------------------------------
  if (previewMode) {
    // Sample output card — preview users can't run the full backtest
    // (no real fund history loaded), so render a frozen example with a
    // sign-up CTA. Same scheme as the Tools Hub preview elsewhere.
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.titleBlock}>
            <Text style={styles.eyebrow}>Past SIP check</Text>
            <Text style={styles.title}>What if you had SIP&apos;d in this fund?</Text>
            <Text style={styles.subtitle}>
              Picks any fund and shows how a monthly SIP would have grown over a
              chosen window, vs the benchmark.
            </Text>
          </View>
          <ToolsPreviewSampleCard
            bannerMessage="₹10,000/mo SIP into HDFC Mid-Cap Opportunities over 3 years vs Nifty 500 TRI. Sign up to run it on any fund."
            heroLabel="3-year SIP outcome"
            heroValue="₹4.18 L"
            heroSubtitle="₹3.60 L invested → ₹4.18 L final value"
            chart={{
              series: [
                {
                  label: 'HDFC Mid-Cap',
                  color: tokens.colors.emerald,
                  // Cumulative value of a ₹10k/mo SIP — climbs roughly
                  // linearly with a few growth phases. 12 quarterly points
                  // across the 36-month window.
                  points: [10, 31, 56, 85, 119, 158, 199, 245, 295, 348, 401, 418],
                },
                {
                  label: 'Nifty 500 TRI',
                  color: tokens.colors.textTertiary,
                  // Benchmark series — same SIP cadence, ~14.8% XIRR =
                  // shallower curve trailing the fund line.
                  points: [10, 30, 53, 80, 110, 142, 178, 215, 254, 296, 339, 398],
                },
              ],
            }}
            rows={[
              { label: 'Fund XIRR', value: '21.4%', tone: 'positive' },
              { label: 'Nifty 500 TRI XIRR', value: '14.8%' },
              { label: 'Lead over benchmark', value: '+₹19.6k', tone: 'positive' },
              { label: 'Best 3-month stretch', value: '+₹38.4k' },
              { label: 'Worst 3-month stretch', value: '−₹22.1k', tone: 'negative' },
            ]}
            footnote="Sample numbers. Once you import a real CAS, this runs against your actual NAV history."
          />
        </ScrollView>
      </ClearLensScreen>
    );
  }

  if (!userId) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Sign in to use this tool</Text>
        </View>
      </ClearLensScreen>
    );
  }

  // -------------------------------------------------------------------------
  // Main view
  // -------------------------------------------------------------------------
  return (
    <ClearLensScreen>
      <ClearLensHeader onPressBack={() => router.back()} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.titleBlock}>
            <Text style={styles.eyebrow}>Past SIP Check</Text>
            <Text style={styles.title}>What if you&apos;d invested?</Text>
            <Text style={styles.subtitle}>
              See how a monthly SIP into any fund — yours or any in our catalog — would have performed compared to a benchmark.
            </Text>
          </View>

          <View style={styles.card}>
            <TouchableOpacity
              style={styles.fundRow}
              onPress={() => setPickerOpen(true)}
              activeOpacity={0.75}
            >
              <View style={styles.fundRowLeft}>
                <Text style={styles.inputLabel}>Fund</Text>
                <Text style={styles.fundName} numberOfLines={1}>
                  {selectedScheme ? shortSchemeName(selectedScheme.schemeName) : 'Pick a fund'}
                </Text>
              </View>
              <Ionicons name="chevron-down" size={18} color={tokens.colors.textTertiary} />
            </TouchableOpacity>

            <Separator />

            <View style={styles.inputRow}>
              <Text style={styles.inputLabel}>Monthly SIP (₹)</Text>
              <TextInput
                style={styles.textInput}
                placeholder="e.g. 10,000"
                placeholderTextColor={tokens.colors.textTertiary}
                value={amountStr}
                onChangeText={setAmountStr}
                keyboardType="numeric"
                returnKeyType="done"
              />
            </View>

            <Separator />

            <View style={styles.inputRow}>
              <Text style={styles.inputLabel}>Duration</Text>
              <ClearLensSegmentedControl
                options={durationOptions}
                selected={selectedDurationKey}
                onChange={handleDurationKeyChange}
              />
            </View>

            <Separator />

            <View style={styles.inputRow}>
              <Text style={styles.inputLabel}>Benchmark</Text>
              <ClearLensSegmentedControl
                options={BENCHMARK_OPTIONS.map((b) => ({ value: b.symbol, label: b.label }))}
                selected={benchmarkSymbol}
                onChange={setBenchmarkSymbol}
              />
            </View>
          </View>

          {/* Results */}
          {!selectedScheme ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>Pick a fund to see how a SIP would have performed.</Text>
            </View>
          ) : navBackfillQuery.isFetching || fundNavQuery.isLoading || benchmarkTimelineQuery.isLoading ? (
            <View style={styles.center}>
              <Text style={styles.helperText}>Crunching NAV history…</Text>
            </View>
          ) : navBackfillQuery.isError || fundNavQuery.isError || benchmarkTimelineQuery.isError ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>
                Couldn&apos;t load NAV history. Pull down to retry.
              </Text>
            </View>
          ) : fundResult && fundResult.hasEnoughData ? (
            <ResultSection
              fundName={selectedScheme.schemeName}
              benchmarkLabel={benchmarkLabel}
              fundResult={fundResult}
              benchmarkResult={benchmarkResult}
              chartPoints={chartPoints}
              chartWidth={chartWidth}
              duration={duration}
            />
          ) : fundResult ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>
                Not enough NAV history for this fund to run a meaningful simulation. Try a shorter
                duration or pick a different fund.
              </Text>
            </View>
          ) : fundNavSeries && fundNavSeries.length === 0 ? (
            // Fund exists in scheme_master but has zero rows in nav_history —
            // typical for matured FMPs, recently-listed schemes the AMFI cron
            // hasn't covered, or funds whose AMFI series is broken upstream.
            // Without this branch the render chain falls through to `null`
            // and the user is left staring at the form with no feedback.
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>
                No NAV history is available for this fund yet. This usually means the scheme is
                very new, matured, or hasn&apos;t been picked up by the daily NAV sync. Try a
                different fund.
              </Text>
            </View>
          ) : null}

          <Text style={styles.disclaimer}>
            Results are estimates only. Simulated SIPs use the 1st of each month and the next
            available NAV. Past performance is not indicative of future returns.
          </Text>

          <PortfolioDisclaimer />
        </ScrollView>
      </KeyboardAvoidingView>

      <UniversalFundPicker
        visible={pickerOpen}
        selectedCodes={selectedScheme ? [selectedScheme.schemeCode] : []}
        mode="single"
        onToggle={(scheme) => {
          setSelectedScheme({
            schemeCode: scheme.schemeCode,
            schemeName: scheme.schemeName,
            schemeCategory: scheme.schemeCategory,
          });
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
        title="Pick a fund"
      />

      <CustomDurationPicker
        visible={customOpen}
        initialMonths={typeof duration === 'object' ? duration.months : 36}
        onApply={applyCustomDuration}
        onClose={() => setCustomOpen(false)}
      />
    </ClearLensScreen>
  );
}

// ---------------------------------------------------------------------------
// Result section
// ---------------------------------------------------------------------------

function ResultSection({
  fundName,
  benchmarkLabel,
  fundResult,
  benchmarkResult,
  chartPoints,
  chartWidth,
  duration,
}: {
  fundName: string;
  benchmarkLabel: string;
  fundResult: ReturnType<typeof simulatePastSip>;
  benchmarkResult: ReturnType<typeof simulatePastSip> | null;
  chartPoints: PastSipChartPoint[];
  chartWidth: number;
  duration: PastSipDuration;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

  // Comparison driven by terminal rupee value rather than XIRR — XIRR can move
  // against the rupee delta on edge cases (very short history, partial period)
  // and the user is ultimately reading "would I have ended up with more
  // money?". XIRR stays in the card as a secondary signal, but the headline
  // comparison reflects rupees.
  const isAhead =
    benchmarkResult &&
    Number.isFinite(fundResult.currentValue) &&
    Number.isFinite(benchmarkResult.currentValue) &&
    fundResult.currentValue > benchmarkResult.currentValue;

  const valueDelta =
    benchmarkResult &&
    Number.isFinite(fundResult.currentValue) &&
    Number.isFinite(benchmarkResult.currentValue)
      ? Math.abs(fundResult.currentValue - benchmarkResult.currentValue)
      : null;

  const xirrDeltaPp =
    benchmarkResult && Number.isFinite(fundResult.xirr) && Number.isFinite(benchmarkResult.xirr)
      ? Math.abs((fundResult.xirr - benchmarkResult.xirr) * 100)
      : null;

  return (
    <>
      {fundResult.shortHistory ? (
        <View style={styles.shortHistoryNotice}>
          <Ionicons name="information-circle-outline" size={18} color={tokens.colors.warning} />
          <Text style={styles.shortHistoryText}>
            Limited NAV history for this fund. Simulation starts from {fundResult.startDate}.
          </Text>
        </View>
      ) : null}

      {/* Hero — leads with the answer. The number that matters most is the
          terminal value; the supporting line carries the rest of the math
          (invested, SIP count, window, gain) so the user doesn't have to
          scan a separate stats card to get the same facts. The window is
          spelled out explicitly for All / Custom durations — without it,
          a user looking at the chart can't tell whether "All" means 3 years
          or 13 years of history. */}
      <View style={styles.banner}>
        <Text style={styles.bannerLabel}>Worth today</Text>
        <Text style={styles.bannerValue}>{formatCurrency(fundResult.currentValue)}</Text>
        <Text style={styles.bannerSubtitle}>
          {formatCurrency(fundResult.totalInvested)} invested across{' '}
          {fundResult.installments.length} monthly SIPs
          {shouldShowWindowInProse(duration) ? (
            <Text>
              {' '}from {formatMonthYear(fundResult.startDate)} to {formatMonthYear(fundResult.endDate)}
            </Text>
          ) : null}
          {' '}·{' '}
          <Text style={fundResult.gain >= 0 ? styles.bannerGainUp : styles.bannerGainDown}>
            {fundResult.gain >= 0 ? '+' : ''}
            {formatCurrency(fundResult.gain)} ({fundResult.gainPct >= 0 ? '+' : ''}
            {fundResult.gainPct.toFixed(1)}%) gain
          </Text>
        </Text>
        <Text style={styles.bannerFund}>{fundName}</Text>
      </View>

      {/* vs-card — single prose paragraph, brand-faithful (lead with the
          answer, no label/value grid). Headline sentence pairs both rupee
          values; conclusion sentence carries the delta and the %p.a.
          context. */}
      {benchmarkResult ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>vs {benchmarkLabel}</Text>
          <Text style={styles.versusBody}>
            <Text style={styles.versusValueFund}>
              {Number.isFinite(fundResult.currentValue)
                ? formatCurrency(fundResult.currentValue)
                : '—'}
            </Text>{' '}
            in your fund vs.{' '}
            <Text style={styles.versusValueBench}>
              {Number.isFinite(benchmarkResult.currentValue)
                ? formatCurrency(benchmarkResult.currentValue)
                : '—'}
            </Text>{' '}
            in {benchmarkLabel}.
          </Text>
          {valueDelta != null ? (
            <Text
              style={[
                styles.versusVerdict,
                isAhead ? styles.versusVerdictUp : styles.versusVerdictDown,
              ]}
            >
              {isAhead
                ? `You're ${formatCurrency(valueDelta)} ahead`
                : `${benchmarkLabel} is ${formatCurrency(valueDelta)} ahead`}
              {xirrDeltaPp != null ? ` — ${xirrDeltaPp.toFixed(1)}% extra per year.` : '.'}
            </Text>
          ) : null}
          <Text style={styles.compareNote}>{BENCHMARK_DISCLOSURE}</Text>
        </View>
      ) : null}

      {chartPoints.length > 1 ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Growth path</Text>
          <View style={styles.chartLegend}>
            <LegendDot color={tokens.colors.emerald} label={fundName || 'Fund'} />
            <LegendDot color={tokens.colors.slate} label={benchmarkLabel} dashed />
            <LegendDot color={tokens.colors.lavender} label="Invested" dashed />
          </View>
          <PastSipChart
            points={chartPoints}
            chartWidth={chartWidth - ClearLensSpacing.md * 2}
            tokens={tokens}
          />
        </View>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Custom-duration picker (years + months steppers)
// ---------------------------------------------------------------------------

function CustomDurationPicker({
  visible,
  initialMonths,
  onApply,
  onClose,
}: {
  visible: boolean;
  initialMonths: number;
  onApply: (months: number) => void;
  onClose: () => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

  const initialYears = Math.floor(initialMonths / 12);
  const initialRemMonths = initialMonths % 12;
  const [years, setYears] = useState<number>(initialYears);
  const [months, setMonths] = useState<number>(initialRemMonths);

  // Reset internal state when the modal reopens with a different initial value
  // (e.g. user picked 2y, closed, then reopened — we shouldn't show stale state).
  useEffect(() => {
    if (visible) {
      setYears(initialYears);
      setMonths(initialRemMonths);
    }
  }, [visible, initialYears, initialRemMonths]);

  const total = years * 12 + months;
  const tooShort = total < CUSTOM_DURATION_MIN_MONTHS;
  const tooLong = total > CUSTOM_DURATION_MAX_MONTHS;
  const valid = !tooShort && !tooLong;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Custom duration</Text>

          <View style={styles.customRow}>
            <Stepper
              label="Years"
              value={years}
              min={0}
              max={Math.floor(CUSTOM_DURATION_MAX_MONTHS / 12)}
              onChange={setYears}
              styles={styles}
            />
            <Stepper
              label="Months"
              value={months}
              min={0}
              max={11}
              onChange={setMonths}
              styles={styles}
            />
          </View>

          <Text style={styles.customSummary}>
            {tooShort
              ? `Pick at least ${CUSTOM_DURATION_MIN_MONTHS} months — fewer SIPs than that won't produce a meaningful XIRR.`
              : `${total} monthly buys (${formatCustomLabel(total)})`}
          </Text>

          <View style={styles.customActions}>
            <TouchableOpacity
              onPress={onClose}
              style={[styles.customBtn, styles.customBtnCancel]}
              activeOpacity={0.76}
            >
              <Text style={styles.customBtnTextCancel}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => valid && onApply(total)}
              disabled={!valid}
              style={[
                styles.customBtn,
                valid ? styles.customBtnApply : styles.customBtnApplyDisabled,
              ]}
              activeOpacity={valid ? 0.76 : 1}
            >
              <Text style={styles.customBtnTextApply}>Apply</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
  styles,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  const dec = () => onChange(Math.max(min, value - 1));
  const inc = () => onChange(Math.min(max, value + 1));
  return (
    <View style={styles.stepperCol}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperRow}>
        <TouchableOpacity
          onPress={dec}
          disabled={value <= min}
          style={[styles.stepperBtn, value <= min && styles.stepperBtnDisabled]}
          activeOpacity={0.7}
        >
          <Text style={styles.stepperBtnText}>−</Text>
        </TouchableOpacity>
        <Text style={styles.stepperValue}>{value}</Text>
        <TouchableOpacity
          onPress={inc}
          disabled={value >= max}
          style={[styles.stepperBtn, value >= max && styles.stepperBtnDisabled]}
          activeOpacity={0.7}
        >
          <Text style={styles.stepperBtnText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

function PastSipChart({
  points,
  chartWidth,
  tokens,
}: {
  points: PastSipChartPoint[];
  chartWidth: number;
  tokens: ClearLensTokens;
}) {
  const chartHeight = 180;
  const plotTop = 12;
  const plotBottom = 28;
  const plotLeft = 48;
  const plotRight = 8;
  const plotWidth = Math.max(1, chartWidth - plotLeft - plotRight);
  const plotHeight = Math.max(1, chartHeight - plotTop - plotBottom);

  const allValues = points.flatMap((p) =>
    [p.invested, p.fundValue, p.benchmarkValue ?? 0],
  );
  const yMax = Math.max(1, Math.max(...allValues) * 1.1);

  function xFor(index: number): number {
    return plotLeft + (points.length <= 1 ? 0 : (index / (points.length - 1)) * plotWidth);
  }

  function yFor(value: number): number {
    return plotTop + plotHeight - (Math.max(0, value) / yMax) * plotHeight;
  }

  function pathFor(values: (number | null)[]): string {
    let path = '';
    let started = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) {
        started = false;
        continue;
      }
      path += `${started ? ' L' : 'M'} ${xFor(i).toFixed(1)} ${yFor(v).toFixed(1)}`;
      started = true;
    }
    return path;
  }

  const ticks = [0, 1, 2, 3, 4].map((t) => ({
    value: (yMax / 4) * t,
    y: yFor((yMax / 4) * t),
  }));

  const labelEvery = points.length <= 6 ? 1 : Math.ceil(points.length / 5);

  return (
    <Svg width={chartWidth} height={chartHeight}>
      {ticks.map((tick) => (
        <G key={`tick-${tick.value}`}>
          <SvgLine
            x1={plotLeft}
            x2={plotLeft + plotWidth}
            y1={tick.y}
            y2={tick.y}
            stroke={tokens.colors.borderLight}
            strokeWidth={0.5}
          />
          <SvgText
            x={plotLeft - 4}
            y={tick.y + 4}
            textAnchor="end"
            fontSize={9}
            fill={tokens.colors.textTertiary}
          >
            {formatCompact(tick.value)}
          </SvgText>
        </G>
      ))}

      <SvgPath
        d={pathFor(points.map((p) => p.invested))}
        stroke={tokens.colors.lavender}
        strokeWidth={1.5}
        strokeDasharray="4 3"
        fill="none"
        opacity={0.7}
      />

      <SvgPath
        d={pathFor(points.map((p) => p.benchmarkValue))}
        stroke={tokens.colors.slate}
        strokeWidth={1.5}
        strokeDasharray="5 3"
        fill="none"
        opacity={0.8}
      />

      <SvgPath
        d={pathFor(points.map((p) => p.fundValue))}
        stroke={tokens.colors.emerald}
        strokeWidth={2}
        fill="none"
      />

      {points.map((p, i) => {
        if (i % labelEvery !== 0 && i !== points.length - 1) return null;
        const isLast = i === points.length - 1;
        const isFirst = i === 0;
        const anchor = isLast ? 'end' : isFirst ? 'start' : 'middle';
        return (
          <SvgText
            key={`xlabel-${i}`}
            x={xFor(i)}
            y={chartHeight - 6}
            textAnchor={anchor}
            fontSize={9}
            fill={tokens.colors.textTertiary}
          >
            {formatDateAxisLabel(p.date)}
          </SvgText>
        );
      })}
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// Helpers / sub-components
// ---------------------------------------------------------------------------

function Separator() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return <View style={styles.separator} />;
}

function LegendDot({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.legendItem}>
      <View style={[
        styles.legendLine,
        { backgroundColor: dashed ? 'transparent' : color, borderColor: color, borderStyle: dashed ? 'dashed' : 'solid' },
      ]} />
      <Text style={styles.legendLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function parseRupees(str: string): number {
  const n = parseFloat(str.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function formatCompact(value: number): string {
  if (value >= 1_00_00_000) return `${(value / 1_00_00_000).toFixed(0)}Cr`;
  if (value >= 1_00_000) return `${(value / 1_00_000).toFixed(0)}L`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return value === 0 ? '0' : Math.round(value).toString();
}

function formatDateAxisLabel(dateStr: string): string {
  const [year, month] = dateStr.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(month, 10) - 1]} '${year.slice(2)}`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    flex: { flex: 1 },
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
      gap: ClearLensSpacing.sm,
    },
    helperText: {
      ...ClearLensTypography.body,
      color: cl.textTertiary,
    },
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
    title: {
      ...ClearLensTypography.h1,
      color: cl.navy,
    },
    subtitle: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
    },

    emptyIcon: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: cl.surfaceSoft,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: ClearLensSpacing.xs,
    },
    emptyTitle: {
      ...ClearLensTypography.h2,
      color: cl.navy,
      textAlign: 'center',
    },
    emptySubtitle: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      textAlign: 'center',
      lineHeight: 22,
    },

    card: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.border,
      ...ClearLensShadow,
      overflow: 'hidden',
      paddingVertical: ClearLensSpacing.xs,
    },
    cardTitle: {
      ...ClearLensTypography.h3,
      color: cl.navy,
      paddingHorizontal: ClearLensSpacing.md,
      paddingTop: ClearLensSpacing.xs,
      paddingBottom: ClearLensSpacing.xs,
    },

    fundRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: ClearLensSpacing.sm + 2,
    },
    fundRowLeft: {
      flex: 1,
      gap: 4,
    },
    fundName: {
      ...ClearLensTypography.body,
      color: cl.navy,
    },

    inputRow: {
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: ClearLensSpacing.sm + 2,
      gap: 8,
    },
    inputLabel: {
      ...ClearLensTypography.label,
      color: cl.textTertiary,
      letterSpacing: 0.4,
    },
    textInput: {
      fontFamily: ClearLensFonts.regular,
      fontSize: 15,
      color: cl.textPrimary,
      paddingVertical: 4,
    },
    separator: {
      height: 1,
      backgroundColor: cl.borderLight,
      marginHorizontal: ClearLensSpacing.md,
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
    bannerFund: {
      ...ClearLensTypography.caption,
      color: cl.textOnDarkMuted,
      paddingTop: 2,
    },
    bannerGainUp: {
      color: cl.positive,
      fontFamily: ClearLensFonts.semiBold,
    },
    bannerGainDown: {
      color: cl.negative,
      fontFamily: ClearLensFonts.semiBold,
    },

    shortHistoryNotice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.xs,
      padding: ClearLensSpacing.sm,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.warningBg,
      borderWidth: 1,
      borderColor: cl.amber,
    },
    shortHistoryText: {
      ...ClearLensTypography.bodySmall,
      flex: 1,
      color: cl.warning,
      lineHeight: 18,
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


    versusBody: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      paddingHorizontal: ClearLensSpacing.md,
      paddingTop: ClearLensSpacing.xs,
      paddingBottom: ClearLensSpacing.xs,
      lineHeight: 22,
    },
    versusValueFund: {
      color: cl.emerald,
      fontFamily: ClearLensFonts.semiBold,
    },
    versusValueBench: {
      color: cl.navy,
      fontFamily: ClearLensFonts.semiBold,
    },
    versusVerdict: {
      ...ClearLensTypography.body,
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: ClearLensSpacing.xs,
      fontFamily: ClearLensFonts.semiBold,
    },
    versusVerdictUp: {
      color: cl.positive,
    },
    versusVerdictDown: {
      color: cl.negative,
    },
    compareNote: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      paddingHorizontal: ClearLensSpacing.md,
      paddingBottom: ClearLensSpacing.sm,
      lineHeight: 16,
    },
    chartLegend: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: ClearLensSpacing.md,
      paddingHorizontal: ClearLensSpacing.md,
      paddingBottom: ClearLensSpacing.xs,
    },
    legendItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.xs,
      maxWidth: 180,
    },
    legendLine: {
      width: 16,
      height: 2,
      borderWidth: 1,
    },
    legendLabel: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      flexShrink: 1,
    },

    disclaimer: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      textAlign: 'center',
      paddingHorizontal: ClearLensSpacing.sm,
      lineHeight: 17,
      marginTop: ClearLensSpacing.xs,
    },

    backdrop: {
      flex: 1,
      backgroundColor: tokens.semantic.overlay.backdrop,
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: cl.surface,
      borderTopLeftRadius: ClearLensRadii.xl,
      borderTopRightRadius: ClearLensRadii.xl,
      paddingTop: ClearLensSpacing.sm,
      paddingHorizontal: ClearLensSpacing.md,
      paddingBottom: ClearLensSpacing.lg,
      maxHeight: '70%',
    },
    sheetHandle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: cl.borderLight,
      alignSelf: 'center',
      marginBottom: ClearLensSpacing.sm,
    },
    sheetTitle: {
      ...ClearLensTypography.h3,
      color: cl.navy,
      paddingVertical: ClearLensSpacing.xs,
    },
    sheetList: {
      flexGrow: 0,
    },
    sheetOption: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: ClearLensSpacing.md - 2,
      gap: ClearLensSpacing.sm,
    },
    sheetDivider: {
      borderTopWidth: 1,
      borderTopColor: cl.borderLight,
    },
    sheetOptionLeft: {
      flex: 1,
      gap: 2,
    },
    sheetRowText: {
      ...ClearLensTypography.body,
      color: cl.navy,
    },
    sheetRowSub: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
    },
    radioOuter: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 1.5,
      borderColor: cl.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    radioOuterActive: {
      borderColor: cl.emerald,
    },
    radioInner: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: cl.emerald,
    },
    customRow: {
      flexDirection: 'row',
      gap: ClearLensSpacing.lg,
      paddingTop: ClearLensSpacing.md,
      paddingBottom: ClearLensSpacing.sm,
    },
    stepperCol: {
      flex: 1,
      gap: ClearLensSpacing.xs,
      alignItems: 'center',
    },
    stepperLabel: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    stepperRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.md,
    },
    stepperBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: cl.borderLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepperBtnDisabled: {
      opacity: 0.35,
    },
    stepperBtnText: {
      ...ClearLensTypography.h3,
      color: cl.navy,
    },
    stepperValue: {
      ...ClearLensTypography.h2,
      color: cl.navy,
      minWidth: 48,
      textAlign: 'center',
    },
    customSummary: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
      paddingVertical: ClearLensSpacing.sm,
      textAlign: 'center',
    },
    customActions: {
      flexDirection: 'row',
      gap: ClearLensSpacing.sm,
      paddingTop: ClearLensSpacing.sm,
    },
    customBtn: {
      flex: 1,
      paddingVertical: ClearLensSpacing.sm,
      borderRadius: ClearLensRadii.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    customBtnCancel: {
      borderWidth: 1,
      borderColor: cl.borderLight,
    },
    customBtnApply: {
      backgroundColor: cl.emerald,
    },
    customBtnApplyDisabled: {
      backgroundColor: cl.borderLight,
    },
    customBtnTextCancel: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
      fontFamily: ClearLensFonts.semiBold,
    },
    customBtnTextApply: {
      ...ClearLensTypography.bodySmall,
      color: cl.textOnDark,
      fontFamily: ClearLensFonts.semiBold,
    },
  });
}
