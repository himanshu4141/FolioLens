import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Linking,
  useWindowDimensions,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LineChart, PieChart } from 'react-native-gifted-charts';
import Svg, { G, Line as SvgLine, Rect as SvgRect, Text as SvgText } from 'react-native-svg';
import { useIsRestoring, useQuery } from '@tanstack/react-query';
import {
  useFundDetail,
  useFundNavHistory,
  filterToWindow,
  indexTo100,
  type TimeWindow,
} from '@/src/hooks/useFundDetail';
import { useFundComposition } from '@/src/hooks/useFundComposition';
import { usePortfolio } from '@/src/hooks/usePortfolio';
import { useSession } from '@/src/hooks/useSession';
import { useInvestmentVsBenchmarkTimeline } from '@/src/hooks/useInvestmentVsBenchmarkTimeline';
import { fetchIndexHistory } from '@/src/hooks/useIndexSnapshot';
import { useTrackInsightViewed } from '@/src/hooks/useTrackInsightViewed';
import type { FundRef } from '@/src/hooks/usePortfolioTimeline';
import { computeQuarterlyReturns } from '@/src/utils/quarterlyReturns';
import { formatXirr } from '@/src/utils/xirr';
import { formatCurrency } from '@/src/utils/formatting';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensCard,
  ClearLensHeader,
  ClearLensScreen,
  ClearLensSegmentedControl,
} from '@/src/components/clearLens/ClearLensPrimitives';
import { PortfolioDisclaimer } from '@/src/components/clearLens/PortfolioDisclaimer';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensCompatibleTokens,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import {
  formatClearLensCurrencyDelta,
  formatClearLensPercentDelta,
} from '@/src/utils/clearLensFormat';
import { BENCHMARK_OPTIONS, useAppStore } from '@/src/store/appStore';
import {
  readBenchmarkName,
  readFundManager,
  readReturnPct,
  readRiskLabel,
} from '@/src/utils/mfdataGuards';
import {
  BENCHMARK_DISCLOSURE,
  fundDetailBenchmarkOptions,
} from '@/src/utils/benchmarkSymbolMap';
import { ResponsiveRouteFrame } from '@/src/components/responsive';

// Fund Detail follows the list-tier desktop frame (960 px). Charts cap
// their own width to the same value so they don't overflow the column
// and they fill the card with no right-edge gap. Each chart derives its
// live width from useWindowDimensions inside its component so that
// resizing the browser updates the chart in real time — the old
// module-scope CHART_WIDTH constant captured the viewport once at JS
// load time and left the chart stuck at the original size.
const FUND_DETAIL_CHART_MAX = 960;

const TIME_WINDOWS: TimeWindow[] = ['1M', '3M', '6M', '1Y', '3Y', 'All'];

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format a YYYY-MM-DD NAV date for staleness display: "2026-03-20" → "20 Mar" */
function formatNavDate(iso: string): string {
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  const [, month, day] = parts;
  return `${parseInt(day, 10)} ${MONTH_ABBR[parseInt(month, 10) - 1]}`;
}

/** Format a YYYY-MM-DD date string for x-axis labels based on the selected window. */
function formatChartDate(dateStr: string, window: TimeWindow): string {
  const [year, month, day] = dateStr.split('-');
  const mon = MONTH_ABBR[parseInt(month, 10) - 1] ?? month;
  const yr2 = year.slice(2);
  switch (window) {
    case '1M': return `${parseInt(day, 10)} ${mon}`;   // "5 Feb"
    case '3M': return `${parseInt(day, 10)} ${mon}`;   // "20 Dec"
    case '6M': return `${mon} '${yr2}`;                // "Sep '24"
    case '1Y': return `${mon} '${yr2}`;                // "Mar '25"
    case '3Y':
    case '5Y':
    case '10Y':
    case '15Y':
    case 'All': return `${mon} '${yr2}`;               // "Jan '22"
  }
}

function TimeWindowSelector({
  selected,
  onChange,
}: {
  selected: TimeWindow;
  onChange: (w: TimeWindow) => void;
}) {
  const { compatible: colors } = useClearLensTokens();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={s.windowRow}>
      {TIME_WINDOWS.map((w) => (
        <TouchableOpacity
          key={w}
          style={[
            s.windowPill,
            selected === w && s.windowPillActive,
           
          ]}
          onPress={() => onChange(w)}
          activeOpacity={0.75}
        >
          <Text style={[s.windowPillText, selected === w && s.windowPillTextActive]}>
            {w}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function PerformanceTab({
  navHistory,
  fundBenchmarkIndex,
  fundBenchmarkSymbol,
  fundRef,
  userId,
}: {
  navHistory: { date: string; value: number }[];
  fundBenchmarkIndex: string | null;
  fundBenchmarkSymbol: string | null;
  fundRef?: FundRef;
  userId?: string;
}) {
  const { compatible: colors } = useClearLensTokens();
  const tokens = useClearLensTokens();
  const s = useMemo(() => makeStyles(colors), [colors]);
  // Live viewport width — module-scope CHART_WIDTH is captured once at JS
  // load time, so on web it would leave the chart at the original size when
  // the window is resized. Recompute against the current viewport instead.
  const { width: viewportWidth } = useWindowDimensions();
  const liveChartWidth = Math.min(viewportWidth, FUND_DETAIL_CHART_MAX) - 32;
  const benchmarkColor = tokens.colors.slate;
  const positiveMetricColor = tokens.colors.emerald;
  const negativeMetricColor = tokens.colors.negative;
  const [window, setWindow] = useState<TimeWindow>('1Y');

  // Phase 8 — picker shows the fund's SEBI-mandated benchmark TRI first, then
  // the global picks. Default selection is the fund's own benchmark.
  const benchmarkOptions = useMemo(
    () => fundDetailBenchmarkOptions({
      benchmark_index: fundBenchmarkIndex,
      benchmark_index_symbol: fundBenchmarkSymbol,
    }),
    [fundBenchmarkIndex, fundBenchmarkSymbol],
  );
  const [selectedSymbol, setSelectedSymbol] = useState<string>(
    () => benchmarkOptions[0]?.symbol ?? BENCHMARK_OPTIONS[0].symbol,
  );
  const investmentTimeline = useInvestmentVsBenchmarkTimeline(
    fundRef ? [fundRef] : [],
    userId,
    selectedSymbol,
    window,
  );
  // Track crosshair position so the return summary below the chart stays in sync.
  // null = no active crosshair (show end-of-period values).
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const activeIdxFrameRef = useRef<number | null>(null);
  const updateActiveIdxFromPointer = useCallback((pointerIndex: number) => {
    if (activeIdxFrameRef.current !== null) {
      cancelAnimationFrame(activeIdxFrameRef.current);
    }
    activeIdxFrameRef.current = requestAnimationFrame(() => {
      activeIdxFrameRef.current = null;
      setActiveIdx((current) => (current === pointerIndex ? current : pointerIndex));
    });
  }, []);

  const { data: indexRows } = useQuery({
    // Namespaced separately from any other consumer reading `index_history`
    // so the cache shape can't be poisoned by a fetcher that stores rows
    // as `{ index_date, close_value }[]` rather than this hook's
    // `{ date, value }[]`. Cross-contamination through the persister was
    // responsible for the Nifty 500 TRI chart-vanish on the Portfolio
    // screen — see Phase 9 M3 follow-up notes.
    //
    // Reads through `fetchIndexHistory` (Phase 9 M5): tries the daily
    // CDN snapshot first, falls back to the paginated `index_history`
    // SELECT on miss. Same `{ date, value }[]` shape either way.
    queryKey: ['fund-detail-index', selectedSymbol],
    queryFn: () => fetchIndexHistory(selectedSymbol),
    staleTime: 5 * 60_000,
  });

  // Stable empty-array fallback so the `useMemo`s below don't see a new
  // reference on every render when `indexRows` is still loading.
  const indexHistory = useMemo(() => indexRows ?? [], [indexRows]);
  const selectedLabel = benchmarkOptions.find((b) => b.symbol === selectedSymbol)?.label ?? selectedSymbol;

  // Reset crosshair when window or benchmark changes so summary resets to period-end values.
  useEffect(() => { setActiveIdx(null); }, [window, selectedSymbol]);
  useEffect(() => (
    () => {
      if (activeIdxFrameRef.current !== null) {
        cancelAnimationFrame(activeIdxFrameRef.current);
      }
    }
  ), []);

  // Heavy NAV / index derivations live in a single memo so they only re-run
  // when the inputs (`navHistory`, `indexHistory`, `window`) actually change.
  // The crosshair handler updates `activeIdx` via RAF on every pointer
  // sample — without this memo every one of those updates re-ran
  // `filterToWindow`, `indexTo100`, and the `sample()` pass over a
  // 1,000+ row NAV history.
  const navSeries = useMemo(() => {
    const filteredNav = filterToWindow(navHistory, window);
    const navStartDate = filteredNav[0]?.date ?? '';
    const filteredIdx = indexHistory.filter((p) => p.date >= navStartDate);
    // Use the later of the two start dates so both series are indexed to 100
    // at the same moment. Without this, nearestBenchmarkValue returns 100 for
    // all dates before the index's first point, making the benchmark appear
    // flat while the fund grows.
    const idxStartDate = filteredIdx[0]?.date ?? navStartDate;
    const commonStart = navStartDate >= idxStartDate ? navStartDate : idxStartDate;
    const alignedNav = filteredNav.filter((p) => p.date >= commonStart);
    const alignedIdx = filteredIdx.filter((p) => p.date >= commonStart);
    const indexedNav = indexTo100(alignedNav);
    const indexedBenchmark = indexTo100(alignedIdx);

    function sampleSeries<T>(arr: T[], max: number): T[] {
      if (arr.length <= max) return arr;
      const step = Math.ceil(arr.length / max);
      return arr.filter((_, i) => i % step === 0 || i === arr.length - 1);
    }

    return {
      indexedNav,
      indexedBenchmark,
      sampledNav: sampleSeries(indexedNav, 60),
    };
  }, [navHistory, indexHistory, window]);
  const { indexedNav, indexedBenchmark, sampledNav } = navSeries;

  function nearestBenchmarkValue(
    series: { date: string; value: number }[],
    targetDate: string,
  ): number {
    if (series.length === 0) return 100;
    let lo = 0, hi = series.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid].date < targetDate) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return series[0].value;
    if (lo >= series.length) return series[series.length - 1].value;
    return series[lo - 1].value;
  }

  const navPoints = useMemo(() => sampledNav.map((p) => ({ value: p.value })), [sampledNav]);
  const hasNavData = navPoints.length > 1;
  const hasBenchmarkData = indexedBenchmark.length > 1;
  const benchmarkPoints = useMemo(
    () => (
      hasBenchmarkData
        ? sampledNav.map((p) => ({ value: nearestBenchmarkValue(indexedBenchmark, p.date) }))
        : []
    ),
    [hasBenchmarkData, indexedBenchmark, sampledNav],
  );

  // Spacing: fit all sampled points exactly within the chart body (no overflow / no scroll).
  // chart body width = total width passed to LineChart minus y-axis label area
  const PERF_Y_AXIS_W = 32;
  const perfChartBodyW = liveChartWidth - 32 - PERF_Y_AXIS_W; // 32 = card padding (16×2)
  // No min floor on spacing: with 60 samples in a ~320px iPhone body the
  // natural spacing is ~5px, but a `Math.max(8, …)` clamp pushed total
  // chart width to ~488px and clipped the right ~40% off-canvas (the
  // "chart ends in 2017 on the All range" bug). The chart now exactly
  // fills the available width; spacing scales down on narrow screens.
  const perfSpacing = sampledNav.length > 1 ? Math.max(1, (perfChartBodyW - 16) / (sampledNav.length - 1)) : 20;

  const xLabels = useMemo(() => {
    const labelInterval = Math.max(1, Math.floor(sampledNav.length / 5));
    return sampledNav.map((p, i) =>
      i % labelInterval === 0 || i === sampledNav.length - 1
        ? formatChartDate(p.date, window)
        : '',
    );
  }, [sampledNav, window]);

  const { chartMaxValue, chartMostNegative } = useMemo(() => {
    const allVals = [
      ...navPoints.map((p) => p.value),
      ...(hasBenchmarkData ? benchmarkPoints.map((p) => p.value) : []),
    ];
    const yMax = allVals.length > 0 ? Math.max(...allVals) : 110;
    const yMin = allVals.length > 0 ? Math.min(...allVals) : 90;
    const yPad = ((yMax - yMin) || yMax * 0.1 || 1) * 0.12;
    return { chartMaxValue: yMax + yPad, chartMostNegative: yMin - yPad };
  }, [navPoints, benchmarkPoints, hasBenchmarkData]);

  const latestNav = indexedNav[indexedNav.length - 1]?.value ?? 100;
  const navReturn = ((latestNav - 100) / 100) * 100;

  // Values to show in the summary below the chart.
  // When crosshair is active, show the hovered values; otherwise show end-of-period.
  const summaryIdx = activeIdx !== null && activeIdx < sampledNav.length ? activeIdx : sampledNav.length - 1;
  const summaryNavVal = sampledNav[summaryIdx]?.value ?? 100;
  const summaryBenchVal = hasBenchmarkData ? (benchmarkPoints[summaryIdx]?.value ?? 100) : null;
  const summaryNavReturn = ((summaryNavVal - 100) / 100) * 100;
  const summaryBenchReturn = summaryBenchVal !== null ? ((summaryBenchVal - 100) / 100) * 100 : null;
  const summaryDate = sampledNav[summaryIdx]?.date;

  const timelinePoints = investmentTimeline.points;
  const hasInvestmentTimeline = timelinePoints.length > 1;
  const formatActualYLabel = useCallback((v: string) => formatCurrency(Number(v)), []);
  const formatPerformanceYLabel = useCallback((v: string) => Number(v).toFixed(0), []);
  const actualPointerLabelComponent = useCallback(
    (_items: unknown, _sec: unknown, pointerIndex: number) => {
      updateActiveIdxFromPointer(pointerIndex);
      const point = timelinePoints[pointerIndex];
      if (!point) return null;
      return (
        <View style={s.pointerLabel}>
          <Text style={s.pointerDate}>{formatChartDate(point.date, window)}</Text>
          <Text style={s.pointerSeriesText}>
            <Text style={{ color: tokens.semantic.chart.invested }}>● </Text>
            Net invested: {formatCurrency(point.investedValue)}
          </Text>
          <Text style={s.pointerSeriesText}>
            <Text style={{ color: colors.primary }}>● </Text>
            Fund: {formatCurrency(point.portfolioValue)}
          </Text>
          <Text style={s.pointerSeriesText}>
            <Text style={{ color: benchmarkColor }}>● </Text>
            {selectedLabel}: {formatCurrency(point.benchmarkValue)}
          </Text>
        </View>
      );
    },
    [
      benchmarkColor,
      colors.primary,
      s,
      selectedLabel,
      timelinePoints,
      tokens.semantic.chart.invested,
      updateActiveIdxFromPointer,
      window,
    ],
  );
  const actualPointerConfig = useMemo(
    () => ({
      showPointerStrip: true,
      pointerStripHeight: 212,
      pointerStripWidth: 1,
      pointerStripColor: colors.textTertiary + '88',
      pointerColor: colors.primary,
      radius: 5,
      pointerLabelWidth: 162,
      pointerLabelHeight: 68,
      activatePointersOnLongPress: false,
      autoAdjustPointerLabelPosition: true,
      pointerLabelComponent: actualPointerLabelComponent,
    }),
    [actualPointerLabelComponent, colors.primary, colors.textTertiary],
  );
  const performancePointerLabelComponent = useCallback(
    (_items: unknown, _sec: unknown, pointerIndex: number) => {
      updateActiveIdxFromPointer(pointerIndex);
      const navVal = sampledNav[pointerIndex]?.value;
      const benchVal = hasBenchmarkData ? benchmarkPoints[pointerIndex]?.value : undefined;
      const date = sampledNav[pointerIndex]?.date;
      return (
        <View style={s.pointerLabel}>
          {date !== undefined && (
            <Text style={s.pointerDate}>{formatChartDate(date, window)}</Text>
          )}
          {navVal !== undefined && (
            <Text style={s.pointerSeriesText}>
              <Text style={{ color: colors.primary }}>● </Text>
              Fund: {navVal.toFixed(1)}
            </Text>
          )}
          {benchVal !== undefined && (
            <Text style={s.pointerSeriesText}>
              <Text style={{ color: benchmarkColor }}>● </Text>
              {selectedLabel}: {benchVal.toFixed(1)}
            </Text>
          )}
        </View>
      );
    },
    [benchmarkColor, benchmarkPoints, colors.primary, hasBenchmarkData, s, sampledNav, selectedLabel, updateActiveIdxFromPointer, window],
  );
  const performancePointerConfig = useMemo(
    () => ({
      showPointerStrip: true,
      pointerStripHeight: 200,
      pointerStripWidth: 1,
      pointerStripColor: colors.textTertiary + '88',
      pointerColor: colors.primary,
      radius: 5,
      pointerLabelWidth: 140,
      pointerLabelHeight: hasBenchmarkData ? 52 : 36,
      activatePointersOnLongPress: false,
      autoAdjustPointerLabelPosition: true,
      pointerLabelComponent: performancePointerLabelComponent,
    }),
    [colors.primary, colors.textTertiary, hasBenchmarkData, performancePointerLabelComponent],
  );
  const performanceReferenceLineConfig = useMemo(
    () => ({
      color: colors.textTertiary + '66',
      dashWidth: 4,
      dashGap: 4,
      thickness: 1,
    }),
    [colors.textTertiary],
  );

  // Timeline-branch derivations that depend only on the resolved points
  // (not on the crosshair position). Hoisted out of the `if`-block render
  // path so dragging the pointer doesn't rebuild three N-element arrays
  // and re-flatMap + Math.max(...) the whole series every frame.
  const timelineChart = useMemo(() => {
    if (!hasInvestmentTimeline) return null;
    const points = timelinePoints;
    const investedData = points.map((point) => ({ value: point.investedValue }));
    const fundValueData = points.map((point) => ({ value: point.portfolioValue }));
    const benchmarkValueData = points.map((point) => ({ value: point.benchmarkValue }));
    let actualYMax = -Infinity;
    let actualYMin = Infinity;
    for (const point of points) {
      if (point.investedValue > actualYMax) actualYMax = point.investedValue;
      if (point.portfolioValue > actualYMax) actualYMax = point.portfolioValue;
      if (point.benchmarkValue > actualYMax) actualYMax = point.benchmarkValue;
      if (point.investedValue < actualYMin) actualYMin = point.investedValue;
      if (point.portfolioValue < actualYMin) actualYMin = point.portfolioValue;
      if (point.benchmarkValue < actualYMin) actualYMin = point.benchmarkValue;
    }
    const actualYPad = ((actualYMax - actualYMin) || actualYMax * 0.1 || 1) * 0.12;
    const actualChartTop = actualYMax + actualYPad;
    const actualChartBottom = Math.max(0, actualYMin - actualYPad);
    const actualChartRange = Math.max(1, actualChartTop - actualChartBottom);
    const ACTUAL_Y_AXIS_W = 54;
    const actualChartW = liveChartWidth - 32 - ACTUAL_Y_AXIS_W - 8;
    // See perfSpacing for why the floor is 1 not 8.
    const actualSpacing =
      points.length > 1 ? Math.max(1, (actualChartW - 16) / (points.length - 1)) : 20;
    const actualLabelInterval = Math.max(1, Math.floor(points.length / 5));
    const actualXLabels =
      investmentTimeline.xAxisLabels.length === points.length
        ? investmentTimeline.xAxisLabels
        : points.map((point, index) =>
            index % actualLabelInterval === 0 || index === points.length - 1
              ? formatChartDate(point.date, window)
              : '',
          );
    return {
      investedData,
      fundValueData,
      benchmarkValueData,
      actualChartBottom,
      actualChartRange,
      actualChartW,
      actualSpacing,
      actualXLabels,
      ACTUAL_Y_AXIS_W,
    };
  }, [hasInvestmentTimeline, timelinePoints, investmentTimeline.xAxisLabels, liveChartWidth, window]);

  if (fundRef && userId && investmentTimeline.isLoading && !hasInvestmentTimeline) {
    return (
      <View style={s.tabContent}>
        <TimeWindowSelector selected={window} onChange={setWindow} />
        <View style={s.chartCard}>
          <ActivityIndicator size="small" color={tokens.colors.emerald} />
        </View>
      </View>
    );
  }

  if (fundRef && userId && hasInvestmentTimeline && timelineChart) {
    const points = timelinePoints;
    const actualActiveIdx = activeIdx !== null && activeIdx < points.length ? activeIdx : points.length - 1;
    const latestPoint = points[points.length - 1];
    const activePoint = points[actualActiveIdx] ?? latestPoint;
    const {
      investedData,
      fundValueData,
      benchmarkValueData,
      actualChartBottom,
      actualChartRange,
      actualChartW,
      actualSpacing,
      actualXLabels,
      ACTUAL_Y_AXIS_W,
    } = timelineChart;
    const activeFundReturn =
      activePoint.investedValue > 0
        ? ((activePoint.portfolioValue - activePoint.investedValue) / activePoint.investedValue) * 100
        : 0;
    const activeBenchmarkReturn =
      activePoint.investedValue > 0
        ? ((activePoint.benchmarkValue - activePoint.investedValue) / activePoint.investedValue) * 100
        : 0;
    const windowContext = window === 'All' ? 'since first transaction' : `past ${window}`;

    return (
      <View style={s.tabContent}>
        {/* Benchmark selector — kept above the chart card so the range pills
            below the chart focus only on time window. Mirrors the Portfolio
            screen pattern: benchmark choice is "what to compare against",
            range is "over which period". */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.benchmarkSelectorContent}
        >
          {benchmarkOptions.map((opt) => (
            <TouchableOpacity
              key={opt.symbol}
              style={[
                s.benchmarkPill,
                selectedSymbol === opt.symbol && s.benchmarkPillActive,

              ]}
              onPress={() => setSelectedSymbol(opt.symbol)}
              activeOpacity={0.75}
            >
              <Text style={[s.benchmarkPillText, selectedSymbol === opt.symbol && s.benchmarkPillTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={s.chartCard}>
          <View style={s.chartHeaderRow}>
            <View style={s.chartHeaderCopy}>
              <Text style={s.chartHeaderTitle}>How your money grew</Text>
              <Text style={s.chartHeaderSubtitle}>Using your buys, redemptions, and switches · {windowContext}</Text>
            </View>
            <View style={s.chartHeaderBadge}>
              <Text style={s.chartHeaderBadgeText}>vs {selectedLabel}</Text>
            </View>
          </View>
          {/* The legend + crosshair-synced summary at the bottom of this card
              already exposes "Fund return" and "Same cashflows in benchmark"
              numerically, so the redundant XIRR-comparison card above the
              chart was dropped (matching Portfolio's compact chart layout). */}
          <View style={s.chartLegendRow}>
            <View style={s.legendItem}>
              <View style={[s.legendDot, { backgroundColor: tokens.semantic.chart.invested }]} />
              <Text style={s.legendLabel}>Net invested</Text>
            </View>
            <View style={s.legendItem}>
              <View style={[s.legendDot, { backgroundColor: colors.primary }]} />
              <Text style={s.legendLabel}>Fund value</Text>
            </View>
            <View style={s.legendItem}>
              <View style={[s.legendDot, { backgroundColor: benchmarkColor }]} />
              <Text style={s.legendLabel}>{selectedLabel} value</Text>
            </View>
          </View>

          <View style={s.chartWrap}>
            <LineChart
              data={investedData}
              data2={fundValueData}
              data3={benchmarkValueData}
              width={actualChartW}
              height={196}
              spacing={actualSpacing}
              initialSpacing={8}
              endSpacing={8}
              hideDataPoints
              color1={tokens.semantic.chart.invested}
              color2={colors.primary}
              color3={benchmarkColor}
              thickness1={2.4}
              thickness2={3}
              thickness3={2.5}
              curved
              yAxisLabelWidth={ACTUAL_Y_AXIS_W}
              formatYLabel={formatActualYLabel}
              yAxisTextStyle={s.chartAxisLabel}
              maxValue={actualChartRange}
              yAxisOffset={actualChartBottom}
              xAxisColor={colors.borderLight}
              yAxisColor="transparent"
              rulesColor={colors.borderLight}
              rulesType="solid"
              noOfSections={4}
              xAxisLabelTexts={actualXLabels}
              xAxisLabelTextStyle={s.chartAxisLabel}
              xAxisLabelsHeight={16}
              labelsExtraHeight={36}
              pointerConfig={actualPointerConfig}
            />
          </View>

          <Text style={s.chartExplainer}>
            Net invested is the remaining cost basis after redemptions and switches.
          </Text>

          <View style={s.returnSummary}>
            {activeIdx !== null && (
              <Text style={s.summaryDateLabel}>as of {formatChartDate(activePoint.date, window)}</Text>
            )}
            <View style={s.returnRow}>
              <Text style={s.returnLabel}>Net invested</Text>
              <Text style={s.returnVal}>{formatCurrency(activePoint.investedValue)}</Text>
            </View>
            <View style={s.returnRow}>
              <Text style={s.returnLabel}>Fund value</Text>
              <Text style={[s.returnVal, { color: activeFundReturn >= 0 ? positiveMetricColor : negativeMetricColor }]}>
                {formatCurrency(activePoint.portfolioValue)} · {activeFundReturn >= 0 ? '+' : ''}{activeFundReturn.toFixed(2)}%
              </Text>
            </View>
            <View style={s.returnRow}>
              <Text style={s.returnLabel}>{selectedLabel} value</Text>
              <Text style={[s.returnVal, { color: activeBenchmarkReturn >= 0 ? positiveMetricColor : negativeMetricColor }]}>
                {formatCurrency(activePoint.benchmarkValue)} · {activeBenchmarkReturn >= 0 ? '+' : ''}{activeBenchmarkReturn.toFixed(2)}%
              </Text>
            </View>
          </View>
        </View>

        {/* Range pills sit below the chart, matching the Portfolio screen's
            "How your money grew" layout. */}
        <TimeWindowSelector selected={window} onChange={setWindow} />
      </View>
    );
  }

  if (fundRef && userId) {
    return (
      <View style={s.tabContent}>
        <TimeWindowSelector selected={window} onChange={setWindow} />
        <View style={s.noData}>
          <Ionicons name="bar-chart-outline" size={32} color={colors.textTertiary} />
          <Text style={s.noDataText}>Investment timeline is not available for this window.</Text>
        </View>
      </View>
    );
  }

  const navWindowContext = window === 'All' ? 'since first NAV' : `past ${window}`;

  return (
    <View style={s.tabContent}>
      {/* Benchmark selector — same Portfolio-style layout as the timeline path:
          benchmark above (what to compare against), range below the chart
          (over which period). The fund-vs-benchmark numeric comparison card
          that used to sit at the top is dropped — its values are echoed in
          the legend + summary below the chart. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.benchmarkSelectorContent}
      >
        {benchmarkOptions.map((opt) => (
          <TouchableOpacity
            key={opt.symbol}
            style={[
              s.benchmarkPill,
              selectedSymbol === opt.symbol && s.benchmarkPillActive,

            ]}
            onPress={() => setSelectedSymbol(opt.symbol)}
            activeOpacity={0.75}
          >
            <Text style={[s.benchmarkPillText, selectedSymbol === opt.symbol && s.benchmarkPillTextActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {hasNavData ? (
        <View style={s.chartCard}>
          <View style={s.chartHeaderRow}>
            <View style={s.chartHeaderCopy}>
              <Text style={s.chartHeaderTitle}>NAV vs {selectedLabel}</Text>
              <Text style={s.chartHeaderSubtitle}>Both series rebased to 100 at start of period · {navWindowContext}</Text>
            </View>
            <View style={s.chartHeaderBadge}>
              <Text style={s.chartHeaderBadgeText}>
                {navReturn >= 0 ? '+' : ''}{navReturn.toFixed(1)}%
              </Text>
            </View>
          </View>
          <View style={s.chartLegendRow}>
            <View style={s.legendItem}>
              <View style={[s.legendDot, { backgroundColor: colors.primary }]} />
              <Text style={s.legendLabel}>Fund NAV</Text>
            </View>
            {hasBenchmarkData && (
              <View style={s.legendItem}>
                <View style={[s.legendDot, { backgroundColor: benchmarkColor }]} />
                <Text style={s.legendLabel}>{selectedLabel}</Text>
              </View>
            )}
          </View>

          <View style={s.chartWrap}>
            <LineChart
              data={navPoints}
              data2={hasBenchmarkData ? benchmarkPoints : undefined}
              width={perfChartBodyW}
              height={180}
              spacing={perfSpacing}
              initialSpacing={8}
              endSpacing={8}
              hideDataPoints
              color1={colors.primary}
              color2={benchmarkColor}
              thickness1={3}
              thickness2={2.5}
              curved
              yAxisLabelWidth={32}
              formatYLabel={formatPerformanceYLabel}
              yAxisTextStyle={s.chartAxisLabel}
              maxValue={chartMaxValue - chartMostNegative}
              yAxisOffset={chartMostNegative}
              xAxisColor={colors.borderLight}
              yAxisColor="transparent"
              rulesColor={colors.borderLight}
              rulesType="solid"
              noOfSections={4}
              referenceLine1Config={performanceReferenceLineConfig}
              referenceLine1Position={100}
              xAxisLabelTexts={xLabels}
              xAxisLabelTextStyle={s.chartAxisLabel}
              xAxisLabelsHeight={16}
              labelsExtraHeight={40}
              pointerConfig={performancePointerConfig}
            />
          </View>

          {/* Explainer */}
          <Text style={s.chartExplainer}>
            Both series rebased to 100 at start of period · higher = outperforming
          </Text>

          {!hasBenchmarkData && (
            <Text style={s.noBenchmarkNote}>
              {selectedLabel} data not available for the {window} window
            </Text>
          )}

          <View style={s.returnSummary}>
            {activeIdx !== null && summaryDate && (
              <Text style={s.summaryDateLabel}>
                as of {formatChartDate(summaryDate, window)}
              </Text>
            )}
            <View style={s.returnRow}>
              <Text style={s.returnLabel}>Fund</Text>
              <Text style={[s.returnVal, { color: summaryNavReturn >= 0 ? positiveMetricColor : negativeMetricColor }]}>
                {summaryNavReturn >= 0 ? '+' : ''}{summaryNavReturn.toFixed(2)}%
              </Text>
            </View>
            {hasBenchmarkData && summaryBenchReturn !== null && (
              <View style={s.returnRow}>
                <Text style={s.returnLabel}>{selectedLabel}</Text>
                <Text
                  style={[
                    s.returnVal,
                    { color: summaryBenchReturn >= 0 ? positiveMetricColor : negativeMetricColor },
                  ]}
                >
                  {summaryBenchReturn >= 0 ? '+' : ''}{summaryBenchReturn.toFixed(2)}%
                </Text>
              </View>
            )}
          </View>
        </View>
      ) : (
        <View style={s.noData}>
          <Ionicons name="bar-chart-outline" size={32} color={colors.textTertiary} />
          <Text style={s.noDataText}>No NAV data available for this window.</Text>
        </View>
      )}

      {/* Range pills below the chart, mirroring Portfolio. */}
      <TimeWindowSelector selected={window} onChange={setWindow} />

      {/* Phase 8 — disclose that the benchmark line is total-return so users
          can reconcile our number with their fund's factsheet. */}
      <Text style={s.benchmarkDisclosure}>{BENCHMARK_DISCLOSURE}</Text>
    </View>
  );
}

function NavHistoryTab({ navHistory }: { navHistory: { date: string; value: number }[] }) {
  const { compatible: colors } = useClearLensTokens();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { width: viewportWidth } = useWindowDimensions();
  const liveChartWidth = Math.min(viewportWidth, FUND_DETAIL_CHART_MAX) - 32;
  const [window, setWindow] = useState<TimeWindow>('1Y');
  const filtered = filterToWindow(navHistory, window);

  function sample<T>(arr: T[], max: number): T[] {
    if (arr.length <= max) return arr;
    const step = Math.ceil(arr.length / max);
    return arr.filter((_, i) => i % step === 0 || i === arr.length - 1);
  }

  const sampledFiltered = sample(filtered, 90);
  const points = sampledFiltered.map((p) => ({ value: p.value }));
  const currentNav = filtered[filtered.length - 1]?.value;
  const startNav = filtered[0]?.value;
  const navChange = currentNav && startNav ? ((currentNav - startNav) / startNav) * 100 : null;

  const labelInterval = Math.max(1, Math.floor(sampledFiltered.length / 5));
  const xLabels = sampledFiltered.map((p, i) =>
    i % labelInterval === 0 || i === sampledFiltered.length - 1
      ? formatChartDate(p.date, window)
      : ''
  );

  // Y-axis range with 12% padding
  const navVals = points.map((p) => p.value);
  const navYMax = navVals.length > 0 ? Math.max(...navVals) : 100;
  const navYMin = navVals.length > 0 ? Math.min(...navVals) : 0;
  const navYPad = ((navYMax - navYMin) || navYMax * 0.1 || 1) * 0.12;
  const navChartMax = navYMax + navYPad;
  const navChartMin = navYMin - navYPad;

  const NAV_Y_AXIS_W = 44;
  const navChartBodyW = liveChartWidth - 32 - NAV_Y_AXIS_W;
  // See perfSpacing for why the floor is 1 not 8.
  const navSpacing = sampledFiltered.length > 1 ? Math.max(1, (navChartBodyW - 16) / (sampledFiltered.length - 1)) : 20;
  const formatNavYLabel = useCallback((v: string) => {
    const n = Number(v);
    if (n >= 1000) return `₹${(n / 1000).toFixed(1)}K`;
    return `₹${n.toFixed(0)}`;
  }, []);
  const navPointerLabelComponent = useCallback(
    (_items: unknown, _sec: unknown, pointerIndex: number) => {
      const p = sampledFiltered[pointerIndex];
      if (!p) return null;
      return (
        <View style={s.pointerLabel}>
          <Text style={s.pointerDate}>{formatChartDate(p.date, window)}</Text>
          <Text style={s.pointerSeriesText}>
            <Text style={{ color: colors.primary }}>● </Text>
            ₹{p.value.toFixed(4)}
          </Text>
        </View>
      );
    },
    [colors.primary, s, sampledFiltered, window],
  );
  const navPointerConfig = useMemo(
    () => ({
      showPointerStrip: true,
      pointerStripHeight: 220,
      pointerStripWidth: 1,
      pointerStripColor: colors.textTertiary + '88',
      pointerColor: colors.primary,
      radius: 5,
      pointerLabelWidth: 110,
      pointerLabelHeight: 36,
      activatePointersOnLongPress: false,
      autoAdjustPointerLabelPosition: true,
      pointerLabelComponent: navPointerLabelComponent,
    }),
    [colors.primary, colors.textTertiary, navPointerLabelComponent],
  );

  return (
    <View style={s.tabContent}>
      <TimeWindowSelector selected={window} onChange={setWindow} />

      {points.length > 1 ? (
        <View style={s.chartCard}>
          <View style={s.chartWrap}>
            <LineChart
              data={points}
              width={navChartBodyW}
              height={200}
              spacing={navSpacing}
              initialSpacing={8}
              endSpacing={8}
              hideDataPoints
              color1={colors.primary}
              thickness1={2.5}
              curved
              yAxisLabelWidth={44}
              formatYLabel={formatNavYLabel}
              yAxisTextStyle={s.chartAxisLabel}
              maxValue={navChartMax - navChartMin}
              yAxisOffset={navChartMin}
              xAxisColor={colors.borderLight}
              yAxisColor="transparent"
              rulesColor={colors.borderLight}
              rulesType="solid"
              noOfSections={4}
              xAxisLabelTexts={xLabels}
              xAxisLabelTextStyle={s.chartAxisLabel}
              xAxisLabelsHeight={16}
              labelsExtraHeight={40}
              pointerConfig={navPointerConfig}
            />
          </View>

          <View style={s.navStatsRow}>
            <View style={s.navStat}>
              <Text style={s.statLabel}>Current NAV</Text>
              <Text style={s.navStatValue}>₹{currentNav?.toFixed(4) ?? '—'}</Text>
            </View>
            <View style={s.navStat}>
              <Text style={s.statLabel}>Period start</Text>
              <Text style={s.navStatValue}>₹{startNav?.toFixed(4) ?? '—'}</Text>
            </View>
            {navChange !== null && (
              <View style={s.navStat}>
                <Text style={s.statLabel}>Change ({window})</Text>
                <Text
                  style={[s.navStatValue, { color: navChange >= 0 ? colors.positive : colors.negative }]}
                >
                  {navChange >= 0 ? '+' : ''}{navChange.toFixed(2)}%
                </Text>
              </View>
            )}
          </View>
        </View>
      ) : (
        <View style={s.noData}>
          <Ionicons name="bar-chart-outline" size={32} color={colors.textTertiary} />
          <Text style={s.noDataText}>No NAV data for this window.</Text>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Technical Details Card
// ---------------------------------------------------------------------------

function fmtReturn(v: number | null): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function TechnicalDetailsCard({
  expenseRatio,
  aumCr,
  minSipAmount,
  fundMetaSyncedAt,
  schemeCode,
  isin,
  launchDate,
  exitLoad,
  minLumpsum,
  minAdditional,
  planType,
  amcName,
  riskLabel,
  schemeCategory,
  declaredBenchmarkName,
  benchmarkIndex,
  fundManager,
  portfolioTurnover,
  terDate,
  periodReturns,
}: {
  expenseRatio: number | null;
  aumCr: number | null;
  minSipAmount: number | null;
  fundMetaSyncedAt: string | null;
  schemeCode: number;
  isin: string | null;
  launchDate: string | null;
  exitLoad: string | null;
  minLumpsum: number | null;
  minAdditional: number | null;
  planType: 'direct' | 'regular' | null;
  amcName: string | null;
  riskLabel: string | null;
  schemeCategory: string | null;
  declaredBenchmarkName: string | null;
  benchmarkIndex: string | null;
  fundManager: string | null;
  portfolioTurnover: number | null;
  terDate: string | null;
  periodReturns: unknown;
}) {
  const { compatible: colors } = useClearLensTokens();
  const ts = useMemo(() => makeTechStyles(colors), [colors]);
  const metaStatus = fundMetaSyncedAt
    ? `as of ${formatNavDate(fundMetaSyncedAt.split('T')[0] ?? fundMetaSyncedAt)}`
    : 'latest available';

  function openFactsheet() {
    const url = isin
      ? `https://www.amfiindia.com/schemes/the-scheme-detail?ISIN=${isin}`
      : `https://api.mfapi.in/mf/${schemeCode}`;
    Linking.openURL(url);
  }

  // Fund age — accounting for the SEBI direct-plan introduction-date gotcha.
  const ageInfo = useMemo(() => formatFundAge(launchDate), [launchDate]);

  const ret1y = readReturnPct(periodReturns, '1y');
  const ret3y = readReturnPct(periodReturns, '3y');
  const ret5y = readReturnPct(periodReturns, '5y');
  const hasReturns = ret1y != null || ret3y != null || ret5y != null;
  const guardedRiskLabel = readRiskLabel(riskLabel);
  const guardedBenchmarkDisplay = readBenchmarkName(declaredBenchmarkName ?? benchmarkIndex);
  const guardedFundManager = readFundManager(fundManager);
  const hasOFMeta = guardedFundManager != null || portfolioTurnover != null || terDate != null;

  return (
    <View style={[ts.card, ts.clearLensCard]}>
      <Text style={ts.title}>Fund details</Text>
      <Text style={ts.metaStatus}>{metaStatus}</Text>

      {/* Top row — the three numbers users glance at most */}
      <View style={ts.row}>
        <View style={ts.cell}>
          <Text style={ts.label}>Expense Ratio</Text>
          <Text style={ts.value}>
            {expenseRatio == null ? 'Unavailable' : `${expenseRatio.toFixed(2)}%`}
          </Text>
        </View>
        <View style={ts.cell}>
          <Text style={ts.label}>AUM</Text>
          <Text style={ts.value}>
            {aumCr == null ? 'Unavailable' : `₹${Math.round(aumCr).toLocaleString('en-IN')} Cr`}
          </Text>
        </View>
        <View style={ts.cell}>
          <Text style={ts.label}>Fund age</Text>
          <Text style={ts.value}>{ageInfo.value}</Text>
          {ageInfo.caption ? (
            <Text style={ts.captionSmall}>{ageInfo.caption}</Text>
          ) : null}
        </View>
      </View>

      {/* Second row — investment minimums + exit load */}
      <View style={ts.row}>
        <View style={ts.cell}>
          <Text style={ts.label}>Min SIP</Text>
          <Text style={ts.value}>
            {minSipAmount == null ? '—' : `₹${minSipAmount.toLocaleString('en-IN')}`}
          </Text>
        </View>
        <View style={ts.cell}>
          <Text style={ts.label}>Min lumpsum</Text>
          <Text style={ts.value}>
            {minLumpsum == null ? '—' : `₹${minLumpsum.toLocaleString('en-IN')}`}
          </Text>
        </View>
        <View style={ts.cell}>
          <Text style={ts.label}>Exit load</Text>
          <Text style={ts.value}>{exitLoad ?? '—'}</Text>
        </View>
      </View>

      {/* Third row — plan type + AMC + declared benchmark */}
      <View style={ts.row}>
        <View style={ts.cell}>
          <Text style={ts.label}>Plan</Text>
          <Text style={ts.value}>
            {planType ? planType[0].toUpperCase() + planType.slice(1) : '—'}
          </Text>
        </View>
        <View style={ts.cell}>
          <Text style={ts.label}>AMC</Text>
          <Text style={ts.valueSmall} numberOfLines={2}>{amcName ?? '—'}</Text>
        </View>
        <View style={ts.cell}>
          <Text style={ts.label}>Benchmark</Text>
          <Text style={ts.valueSmall} numberOfLines={2}>{guardedBenchmarkDisplay ?? '—'}</Text>
        </View>
      </View>

      {/* Fourth row — category + risk label + min additional */}
      {(schemeCategory || guardedRiskLabel || minAdditional != null) ? (
        <View style={ts.row}>
          <View style={ts.cell}>
            <Text style={ts.label}>Category</Text>
            <Text style={ts.valueSmall} numberOfLines={2}>{schemeCategory || '—'}</Text>
          </View>
          <View style={ts.cell}>
            <Text style={ts.label}>Riskometer</Text>
            <Text style={ts.valueSmall}>{guardedRiskLabel ?? '—'}</Text>
          </View>
          <View style={ts.cell}>
            <Text style={ts.label}>Min addl</Text>
            <Text style={ts.value}>
              {minAdditional == null ? '—' : `₹${minAdditional.toLocaleString('en-IN')}`}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Fifth row — fund manager + portfolio turnover + TER date (OF-sourced) */}
      {hasOFMeta ? (
        <View style={ts.row}>
          <View style={ts.cell}>
            <Text style={ts.label}>Manager</Text>
            <Text style={ts.valueSmall} numberOfLines={2}>{guardedFundManager ?? '—'}</Text>
          </View>
          <View style={ts.cell}>
            <Text style={ts.label}>Turnover</Text>
            <Text style={ts.value}>
              {portfolioTurnover == null ? '—' : `${portfolioTurnover.toFixed(0)}%`}
            </Text>
          </View>
          <View style={ts.cell}>
            <Text style={ts.label}>TER date</Text>
            <Text style={ts.value}>{terDate ? formatNavDate(terDate) : '—'}</Text>
          </View>
        </View>
      ) : null}

      {/* Sixth row — period returns (1Y / 3Y / 5Y CAGR) */}
      {hasReturns ? (
        <View style={ts.row}>
          <View style={ts.cell}>
            <Text style={ts.label}>1Y return</Text>
            <Text style={ts.value}>{fmtReturn(ret1y)}</Text>
          </View>
          <View style={ts.cell}>
            <Text style={ts.label}>3Y return</Text>
            <Text style={ts.value}>{fmtReturn(ret3y)}</Text>
          </View>
          <View style={ts.cell}>
            <Text style={ts.label}>5Y return</Text>
            <Text style={ts.value}>{fmtReturn(ret5y)}</Text>
          </View>
        </View>
      ) : null}

      <TouchableOpacity onPress={openFactsheet} style={ts.sidLink}>
        <Text style={ts.sidLinkText}>View fund factsheet ↗</Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * Format launch_date as a fund age string with a caption that disambiguates
 * the SEBI direct-plan introduction date (2013-01-01 — when most direct
 * plans were created, not when the underlying fund was launched).
 */
function formatFundAge(launchDate: string | null): { value: string; caption: string | null } {
  if (!launchDate) return { value: '—', caption: null };
  const d = new Date(launchDate);
  if (Number.isNaN(d.getTime())) return { value: '—', caption: null };
  const ms = Date.now() - d.getTime();
  const years = ms / (365.25 * 24 * 60 * 60 * 1000);
  const value = years < 1 ? `${Math.max(0, Math.round(years * 12))}m` : `${years.toFixed(1)}y`;
  const isDirectPlanDate = launchDate.startsWith('2013-01-01');
  const caption = isDirectPlanDate
    ? 'direct plan since 2013'
    : `since ${launchDate.slice(0, 10)}`;
  return { value, caption };
}

function makeTechStyles(colors: ClearLensCompatibleTokens) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
      marginHorizontal: ClearLensSpacing.md,
      marginTop: ClearLensSpacing.md,
      borderWidth: 1,
      borderColor: colors.border,
    },
    clearLensCard: {
      // The sibling NavHistoryTab adds its own paddingHorizontal:16 inside
      // its own container, so its chart card sits 32 px from the viewport
      // edge. This card sits directly under the same ScrollView (16 px
      // padding) so without the extra margin it ends up 16 px wider on each
      // side — matching the parent indent fixes the visual mismatch.
      marginHorizontal: ClearLensSpacing.md,
      marginTop: 0,
      borderRadius: ClearLensRadii.lg,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    title: {
      ...ClearLensTypography.label,
      color: colors.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 2,
    },
    metaStatus: {
      ...ClearLensTypography.caption,
      color: colors.textTertiary,
      marginBottom: ClearLensSpacing.sm,
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: ClearLensSpacing.xs,
    },
    cell: {
      flex: 1,
      alignItems: 'center',
    },
    label: {
      ...ClearLensTypography.caption,
      color: colors.textSecondary,
      marginBottom: 2,
      textAlign: 'center',
    },
    value: {
      ...ClearLensTypography.body,
      color: colors.textPrimary,
      fontWeight: '600' as const,
      textAlign: 'center',
    },
    valueSmall: {
      ...ClearLensTypography.bodySmall,
      color: colors.textPrimary,
      fontWeight: '600' as const,
      textAlign: 'center',
    },
    captionSmall: {
      ...ClearLensTypography.caption,
      color: colors.textTertiary,
      textAlign: 'center',
    },
    sidLink: {
      marginTop: ClearLensSpacing.xs,
      alignItems: 'center',
    },
    sidLinkText: {
      ...ClearLensTypography.caption,
      color: colors.primary,
      fontWeight: '600' as const,
    },
  });
}

// ---------------------------------------------------------------------------
// Growth Consistency Chart — quarterly returns from navHistory
// ---------------------------------------------------------------------------

function GrowthConsistencyChart({ navHistory }: { navHistory: { date: string; value: number }[] }) {
  const { compatible: colors } = useClearLensTokens();
  const gs = useMemo(() => makeGrowthStyles(colors), [colors]);
  // Use the live viewport width rather than the module-scope CHART_WIDTH.
  // The module-scope value is captured once when the JS bundle loads, so on
  // web it reflects whatever the browser was at on first paint — resizing
  // afterwards leaves the chart rendered at the stale (often desktop) width
  // and bars get clipped by the mobile viewport.
  const { width: viewportWidth } = useWindowDimensions();
  const chartWidth = Math.min(viewportWidth, FUND_DETAIL_CHART_MAX) - 32 - 64;
  // Memoize the quarterly-return reduction — it walks the entire NAV
  // history (1,000+ rows for a long-lived scheme) and re-bucketing on
  // every parent render (e.g. when the Performance tab's crosshair
  // updates) is wasted work.
  const bars = useMemo(
    () => computeQuarterlyReturns(navHistory, colors.positive, colors.negative),
    [navHistory, colors.positive, colors.negative],
  );
  if (bars.length < 2) return null;

  const vals = bars.map((b) => Math.abs(b.value));
  const maxAbs = Math.max(...vals, 1);
  const chartMax = Math.ceil(maxAbs * 1.2);
  const chartHeight = 176;
  const plotTop = 18;
  const plotBottom = 34;
  const plotLeft = 34;
  const plotRight = 8;
  const plotWidth = chartWidth - plotLeft - plotRight;
  const plotHeight = chartHeight - plotTop - plotBottom;
  const zeroY = plotTop + plotHeight / 2;
  // Each bar gets an equal slot across the full plot width so the cluster
  // doesn't cling to the left edge on wide viewports. The bar itself stays
  // capped between 12 px and 28 px and is centered within its slot.
  const slotWidth = plotWidth / bars.length;
  const barWidth = Math.max(12, Math.min(28, slotWidth - 8));
  const xLabelEvery = bars.length <= 8 ? 1 : 2;

  function yFor(value: number): number {
    return zeroY - (value / chartMax) * (plotHeight / 2);
  }

  return (
    <View style={gs.card}>
      <Text style={gs.title}>Growth Consistency</Text>
      <Text style={gs.subtitle}>Quarterly returns (%)</Text>
      <View style={gs.svgWrap}>
        <Svg width={chartWidth} height={chartHeight}>
          {[-1, -0.5, 0, 0.5, 1].map((tick) => {
            const value = tick * chartMax;
            const y = yFor(value);
            return (
              <G key={`tick-${tick}`}>
                <SvgLine
                  x1={plotLeft}
                  x2={plotLeft + plotWidth}
                  y1={y}
                  y2={y}
                  stroke={tick === 0 ? colors.textTertiary : colors.borderLight}
                  strokeWidth={tick === 0 ? 1.2 : 1}
                  strokeDasharray={tick === 0 ? undefined : '4 5'}
                />
                <SvgText
                  x={plotLeft - 8}
                  y={y + 4}
                  fill={colors.textTertiary}
                  fontSize={10}
                  textAnchor="end"
                >
                  {`${Math.round(value)}%`}
                </SvgText>
              </G>
            );
          })}
          {bars.map((bar, index) => {
            const x = plotLeft + index * slotWidth + (slotWidth - barWidth) / 2;
            const positive = bar.value >= 0;
            const y = positive ? yFor(bar.value) : zeroY;
            const height = Math.max(3, Math.abs(yFor(bar.value) - zeroY));
            const labelY = positive ? y - 5 : y + height + 12;
            const showXAxisLabel = index === 0 || index === bars.length - 1 || index % xLabelEvery === 0;
            return (
              <G key={bar.label}>
                <SvgRect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={height}
                  rx={4}
                  fill={bar.frontColor}
                />
                <SvgText
                  x={x + barWidth / 2}
                  y={labelY}
                  fill={positive ? colors.positive : colors.negative}
                  fontSize={9}
                  fontWeight="600"
                  textAnchor="middle"
                >
                  {bar.value.toFixed(Math.abs(bar.value) >= 10 ? 1 : 2)}
                </SvgText>
                {showXAxisLabel && (
                  <SvgText
                    x={x + barWidth / 2}
                    y={chartHeight - 10}
                    fill={colors.textTertiary}
                    fontSize={9}
                    textAnchor="middle"
                  >
                    {bar.label}
                  </SvgText>
                )}
              </G>
            );
          })}
        </Svg>
      </View>
      <View style={gs.legend}>
        <View style={gs.legendItem}>
          <View style={[gs.legendDot, { backgroundColor: colors.positive }]} />
          <Text style={gs.legendText}>Positive quarter</Text>
        </View>
        <View style={gs.legendItem}>
          <View style={[gs.legendDot, { backgroundColor: colors.negative }]} />
          <Text style={gs.legendText}>Negative quarter</Text>
        </View>
      </View>
    </View>
  );
}

function makeGrowthStyles(colors: ClearLensCompatibleTokens) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
      marginHorizontal: ClearLensSpacing.md,
      marginTop: ClearLensSpacing.md,
      borderWidth: 1,
      borderColor: colors.border,
    },
    title: {
      ...ClearLensTypography.label,
      color: colors.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 2,
    },
    subtitle: {
      ...ClearLensTypography.caption,
      color: colors.textTertiary,
    },
    svgWrap: {
      marginTop: ClearLensSpacing.xs,
      alignItems: 'center',
      overflow: 'hidden',
    },
    axisLabel: { fontSize: 10, color: colors.textTertiary },
    barTopLabel: { fontSize: 9, color: colors.textSecondary },
    legend: {
      flexDirection: 'row',
      gap: ClearLensSpacing.md,
      marginTop: ClearLensSpacing.xs,
    },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    legendDot: { width: 8, height: 8, borderRadius: 4 },
    legendText: { ...ClearLensTypography.caption, color: colors.textTertiary },
  });
}

// ---------------------------------------------------------------------------
// Portfolio Health Donut
// ---------------------------------------------------------------------------

function ordinalRank(rank: number): string {
  if (rank === 1) return 'Largest position';
  if (rank === 2) return '2nd largest';
  if (rank === 3) return '3rd largest';
  return `${rank}th largest`;
}

function PortfolioHealthDonut({
  fundId,
  currentValue,
}: {
  fundId: string;
  currentValue: number | null;
}) {
  const { compatible: colors } = useClearLensTokens();
  const ds = useMemo(() => makeDonutStyles(colors), [colors]);
  const { defaultBenchmarkSymbol } = useAppStore();
  const { data: portfolioData } = usePortfolio(defaultBenchmarkSymbol);
  const fundCards = portfolioData?.fundCards ?? [];
  const summary = portfolioData?.summary ?? null;
  const totalValue = summary?.totalValue ?? 0;

  if (!currentValue || currentValue <= 0 || totalValue <= 0) return null;

  const fundPct = (currentValue / totalValue) * 100;
  const restPct = 100 - fundPct;

  // Rank this fund among all holdings by currentValue (descending)
  const sorted = [...fundCards]
    .filter((f) => f.currentValue !== null && f.currentValue > 0)
    .sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0));
  const rank = sorted.findIndex((f) => f.id === fundId) + 1;
  const rankLabel = rank > 0 ? ordinalRank(rank) : null;

  const donutData = [
    { value: fundPct, color: colors.primary },
    { value: Math.max(restPct, 0), color: colors.borderLight },
  ];

  return (
    <View style={ds.card}>
      <Text style={ds.title}>Portfolio Weight</Text>
      <View style={ds.content}>
        <PieChart
          data={donutData}
          donut
          radius={56}
          innerRadius={38}
          innerCircleColor={colors.surface}
          centerLabelComponent={() => (
            <View style={ds.centerLabel}>
              <Text style={ds.centerPct}>{fundPct.toFixed(1)}%</Text>
            </View>
          )}
        />
        <View style={ds.info}>
          <Text style={ds.infoValue}>{fundPct.toFixed(1)}%</Text>
          <Text style={ds.infoLabel}>of portfolio</Text>
          {rankLabel && (
            <Text style={ds.rankLabel}>{rankLabel}</Text>
          )}
          <Text style={ds.totalLabel}>
            Total: {formatCurrency(totalValue)}
          </Text>
        </View>
      </View>
      <View style={ds.legend}>
        <View style={ds.legendItem}>
          <View style={[ds.legendDot, { backgroundColor: colors.primary }]} />
          <Text style={ds.legendText}>This fund</Text>
        </View>
        <View style={ds.legendItem}>
          <View style={[ds.legendDot, { backgroundColor: colors.borderLight }]} />
          <Text style={ds.legendText}>Rest of portfolio</Text>
        </View>
      </View>
    </View>
  );
}

function makeDonutStyles(colors: ClearLensCompatibleTokens) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
      marginHorizontal: ClearLensSpacing.md,
      marginTop: ClearLensSpacing.md,
      borderWidth: 1,
      borderColor: colors.border,
      // The donut + info pair is compact; on desktop the parent frame is
      // ~920 px wide so capping the card keeps the content from drifting
      // in a sea of whitespace.
      maxWidth: 460,
      alignSelf: 'flex-start',
    },
    title: {
      ...ClearLensTypography.label,
      color: colors.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: ClearLensSpacing.sm,
    },
    content: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.md,
    },
    centerLabel: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    centerPct: {
      fontSize: 14,
      fontWeight: '700' as const,
      color: colors.primary,
    },
    info: {
      flex: 1,
      gap: 4,
    },
    infoValue: {
      fontSize: 28,
      fontWeight: '700' as const,
      color: colors.primary,
      lineHeight: 32,
    },
    infoLabel: {
      ...ClearLensTypography.bodySmall,
      color: colors.textTertiary,
    },
    rankLabel: {
      ...ClearLensTypography.body,
      color: colors.textSecondary,
      fontWeight: '600' as const,
      marginTop: 2,
    },
    totalLabel: {
      ...ClearLensTypography.caption,
      color: colors.textTertiary,
      marginTop: 4,
    },
    legend: {
      flexDirection: 'row',
      gap: ClearLensSpacing.md,
      marginTop: ClearLensSpacing.sm,
    },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    legendDot: { width: 8, height: 8, borderRadius: 4 },
    legendText: { ...ClearLensTypography.caption, color: colors.textTertiary },
  });
}

// ---------------------------------------------------------------------------
// Fund Composition Tab
// ---------------------------------------------------------------------------

function FundCompositionTab({ schemeCode }: { schemeCode: number }) {
  const { compatible: colors } = useClearLensTokens();
  const tokens = useClearLensTokens();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const cs = useMemo(() => makeCompStyles(colors), [colors]);
  const { composition, isLoading } = useFundComposition(schemeCode);
  const compAssetColors = useMemo(
    () => ({
      equity: tokens.semantic.asset.equity,
      debt: tokens.semantic.asset.debt,
      cash: tokens.semantic.asset.cash,
      other: tokens.semantic.asset.other,
    }),
    [tokens.semantic.asset],
  );
  const compCapColors = useMemo(
    () => ({
      large: tokens.semantic.marketCap.large,
      mid: tokens.semantic.marketCap.mid,
      small: tokens.semantic.marketCap.small,
      other: tokens.semantic.marketCap.other,
    }),
    [tokens.semantic.marketCap],
  );

  if (isLoading) {
    return (
      <View style={[s.tabContent, { alignItems: 'center', paddingTop: 40 }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!composition) {
    return (
      <View style={s.tabContent}>
        <View style={s.noData}>
          <Ionicons name="pie-chart-outline" size={32} color={colors.textTertiary} />
          <Text style={s.noDataText}>No composition data available for this fund.</Text>
        </View>
      </View>
    );
  }

  const hasMarketCap = composition.largeCapPct !== null && composition.equityPct > 5;
  const sectors = composition.sectorAllocation
    ? Object.entries(composition.sectorAllocation).sort(([, a], [, b]) => b - a).slice(0, 8)
    : null;
  const holdings = composition.topHoldings?.slice(0, 10) ?? null;

  return (
    <View style={s.tabContent}>
      {/* Asset Mix */}
      <View style={[s.chartCard, { gap: ClearLensSpacing.sm }]}>
        <Text style={cs.cardTitle}>Asset Mix</Text>
        <View style={cs.stackedBar}>
          {composition.equityPct > 0.5 && (
            <View style={[cs.barSeg, { flex: composition.equityPct, backgroundColor: compAssetColors.equity }]} />
          )}
          {composition.debtPct > 0.5 && (
            <View style={[cs.barSeg, { flex: composition.debtPct, backgroundColor: compAssetColors.debt }]} />
          )}
          {composition.cashPct > 0.5 && (
            <View style={[cs.barSeg, { flex: composition.cashPct, backgroundColor: compAssetColors.cash }]} />
          )}
          {composition.otherPct > 0.5 && (
            <View style={[cs.barSeg, { flex: composition.otherPct, backgroundColor: compAssetColors.other }]} />
          )}
        </View>
        <View style={cs.assetRow}>
          {composition.equityPct > 0 && (
            <View style={cs.assetItem}>
              <View style={[cs.assetDot, { backgroundColor: compAssetColors.equity }]} />
              <Text style={cs.assetLabel}>Equity</Text>
              <Text style={cs.assetValue}>{composition.equityPct.toFixed(1)}%</Text>
            </View>
          )}
          {composition.debtPct > 0 && (
            <View style={cs.assetItem}>
              <View style={[cs.assetDot, { backgroundColor: compAssetColors.debt }]} />
              <Text style={cs.assetLabel}>Debt</Text>
              <Text style={cs.assetValue}>{composition.debtPct.toFixed(1)}%</Text>
            </View>
          )}
          {composition.cashPct > 0 && (
            <View style={cs.assetItem}>
              <View style={[cs.assetDot, { backgroundColor: compAssetColors.cash }]} />
              <Text style={cs.assetLabel}>Cash</Text>
              <Text style={cs.assetValue}>{composition.cashPct.toFixed(1)}%</Text>
            </View>
          )}
          {composition.otherPct > 0 && (
            <View style={cs.assetItem}>
              <View style={[cs.assetDot, { backgroundColor: compAssetColors.other }]} />
              <Text style={cs.assetLabel}>Other</Text>
              <Text style={cs.assetValue}>{composition.otherPct.toFixed(1)}%</Text>
            </View>
          )}
        </View>
      </View>

      {/* Market Cap Mix */}
      {hasMarketCap && (
        <View style={[s.chartCard, { gap: ClearLensSpacing.sm }]}>
          <Text style={cs.cardTitle}>Market Cap Mix</Text>
          {composition.source !== 'amfi' && (
            <Text style={cs.capDisclosure}>
              Showing SEBI category average — this fund hasn’t disclosed enough holdings yet.
            </Text>
          )}
          <View style={cs.stackedBar}>
            {(composition.largeCapPct ?? 0) > 0.5 && (
              <View style={[cs.barSeg, { flex: composition.largeCapPct!, backgroundColor: compCapColors.large }]} />
            )}
            {(composition.midCapPct ?? 0) > 0.5 && (
              <View style={[cs.barSeg, { flex: composition.midCapPct!, backgroundColor: compCapColors.mid }]} />
            )}
            {(composition.smallCapPct ?? 0) > 0.5 && (
              <View style={[cs.barSeg, { flex: composition.smallCapPct!, backgroundColor: compCapColors.small }]} />
            )}
            {(composition.notClassifiedPct ?? 0) > 0.5 && (
              <View style={[cs.barSeg, { flex: composition.notClassifiedPct!, backgroundColor: compCapColors.other }]} />
            )}
          </View>
          <View style={cs.assetRow}>
            {(composition.largeCapPct ?? 0) > 0 && (
              <View style={cs.assetItem}>
                <View style={[cs.assetDot, { backgroundColor: compCapColors.large }]} />
                <Text style={cs.assetLabel}>Large</Text>
                <Text style={cs.assetValue}>{composition.largeCapPct!.toFixed(1)}%</Text>
              </View>
            )}
            {(composition.midCapPct ?? 0) > 0 && (
              <View style={cs.assetItem}>
                <View style={[cs.assetDot, { backgroundColor: compCapColors.mid }]} />
                <Text style={cs.assetLabel}>Mid</Text>
                <Text style={cs.assetValue}>{composition.midCapPct!.toFixed(1)}%</Text>
              </View>
            )}
            {(composition.smallCapPct ?? 0) > 0 && (
              <View style={cs.assetItem}>
                <View style={[cs.assetDot, { backgroundColor: compCapColors.small }]} />
                <Text style={cs.assetLabel}>Small</Text>
                <Text style={cs.assetValue}>{composition.smallCapPct!.toFixed(1)}%</Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Sector Breakdown */}
      <View style={[s.chartCard, { gap: ClearLensSpacing.xs }]}>
        <Text style={[cs.cardTitle, { marginBottom: ClearLensSpacing.xs }]}>Sector Breakdown</Text>
        {sectors && sectors.length > 0 ? (
          sectors.map(([sector, pct]) => (
            <View key={sector} style={cs.sectorRow}>
              <Text style={cs.sectorName} numberOfLines={1}>{sector}</Text>
              <View style={cs.sectorBarWrap}>
                <View
                  style={[cs.sectorBar, {
                    width: `${Math.min(pct, 30) / 30 * 100}%`,
                    backgroundColor: colors.primary + '66',
                  }]}
                />
              </View>
              <Text style={cs.sectorPct}>{pct.toFixed(1)}%</Text>
            </View>
          ))
        ) : (
          <View style={cs.emptySlot}>
            <Ionicons name="grid-outline" size={24} color={colors.textTertiary} />
            <Text style={cs.emptySlotText}>Syncs from AMFI monthly disclosures</Text>
          </View>
        )}
      </View>

      {/* Top Holdings */}
      <View style={[s.chartCard, { gap: 0, overflow: 'hidden' }]}>
        <Text style={[cs.cardTitle, { marginBottom: ClearLensSpacing.xs }]}>Top Holdings</Text>
        {holdings && holdings.length > 0 ? (
          holdings.map((h, i) => (
            <View
              key={h.isin || h.name}
              style={[cs.holdingRow, i > 0 && { borderTopWidth: 1, borderTopColor: colors.borderLight }]}
            >
              <Text style={cs.holdingRank}>{i + 1}</Text>
              <View style={cs.holdingInfo}>
                <Text style={cs.holdingName} numberOfLines={1}>{h.name}</Text>
                <Text style={cs.holdingSector}>{h.sector}</Text>
              </View>
              <Text style={cs.holdingPct}>{h.pctOfNav.toFixed(1)}%</Text>
            </View>
          ))
        ) : (
          <View style={cs.emptySlot}>
            <Ionicons name="list-outline" size={24} color={colors.textTertiary} />
            <Text style={cs.emptySlotText}>Syncs from AMFI monthly disclosures</Text>
          </View>
        )}
      </View>

      <Text style={cs.footer}>
        {composition.source === 'amfi' ? 'AMFI disclosure' : 'Estimated from fund category'} ·{' '}
        {new Date(composition.portfolioDate).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}
      </Text>
    </View>
  );
}

function makeCompStyles(colors: ClearLensCompatibleTokens) {
  return StyleSheet.create({
    cardTitle: {
      fontSize: 11,
      fontWeight: '700' as const,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      color: colors.textTertiary,
    },
    capDisclosure: {
      fontSize: 12,
      lineHeight: 16,
      color: colors.textSecondary,
      fontStyle: 'italic' as const,
    },
    stackedBar: {
      flexDirection: 'row',
      height: 10,
      borderRadius: ClearLensRadii.full,
      overflow: 'hidden',
    },
    barSeg: { height: '100%' },
    assetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: ClearLensSpacing.sm },
    assetItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    assetDot: { width: 8, height: 8, borderRadius: 4 },
    assetLabel: { fontSize: 12, color: colors.textTertiary, fontWeight: '600' as const },
    assetValue: { fontSize: 13, fontWeight: '700' as const, color: colors.textPrimary },
    sectorRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      paddingVertical: 4,
    },
    sectorName: { flex: 1, fontSize: 13, color: colors.textPrimary, fontWeight: '600' as const },
    sectorBarWrap: {
      width: 80,
      height: 6,
      backgroundColor: colors.borderLight,
      borderRadius: 3,
      overflow: 'hidden',
    },
    sectorBar: { height: '100%', borderRadius: 3 },
    sectorPct: {
      fontSize: 12,
      fontWeight: '600' as const,
      minWidth: 42,
      textAlign: 'right',
      color: colors.textSecondary,
    },
    holdingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      gap: ClearLensSpacing.sm,
    },
    holdingRank: {
      fontSize: 12,
      fontWeight: '600' as const,
      minWidth: 18,
      textAlign: 'center',
      color: colors.textTertiary,
    },
    holdingInfo: { flex: 1, gap: 2 },
    holdingName: { fontSize: 13, fontWeight: '600' as const, color: colors.textPrimary },
    holdingSector: { fontSize: 11, color: colors.textTertiary, fontWeight: '500' as const },
    holdingPct: {
      fontSize: 13,
      fontWeight: '700' as const,
      minWidth: 48,
      textAlign: 'right',
      color: colors.textPrimary,
    },
    emptySlot: { alignItems: 'center', paddingVertical: ClearLensSpacing.md, gap: 6 },
    emptySlotText: { fontSize: 12, color: colors.textTertiary, textAlign: 'center' },
    footer: {
      fontSize: 11,
      color: colors.textTertiary,
      textAlign: 'center',
      fontStyle: 'italic',
      paddingBottom: ClearLensSpacing.sm,
    },
  });
}


type ClearLensFundTab = 'performance' | 'nav' | 'composition';

function ClearLensFundDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useTrackInsightViewed('fund_detail', id ?? null);
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<ClearLensFundTab>('performance');
  const { data, isLoading, isError } = useFundDetail(id);
  // Full NAV history is fetched in parallel as a background query. The
  // header card / metadata / XIRR render off `data` (small fetch), and
  // the charts gate on `navHistory.length > 1` so they show their own
  // empty/skeleton state until the paginated history arrives.
  const { data: navHistoryFull } = useFundNavHistory(data?.schemeCode);
  const navHistory = navHistoryFull ?? data?.navHistory ?? [];
  // See ClearLensPortfolioScreen for rationale — `useIsRestoring` keeps
  // the "Couldn't load fund data" / spinner branches from racing the
  // persister rehydrate.
  const isRestoring = useIsRestoring();
  const showFirstLoad = isRestoring || isLoading || data === undefined;
  const { session } = useSession();
  const userId = session?.user.id;
  const tokens = useClearLensTokens();
  const clearDetailStyles = useMemo(() => makeClearDetailStyles(tokens), [tokens]);

  if (showFirstLoad) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <View style={clearDetailStyles.centered}>
          <ActivityIndicator size="large" color={tokens.colors.emerald} />
        </View>
      </ClearLensScreen>
    );
  }

  if (isError) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <View style={clearDetailStyles.centered}>
          <Ionicons name="alert-circle-outline" size={40} color={tokens.colors.textTertiary} />
          <Text style={clearDetailStyles.errorText}>Couldn&apos;t load fund data</Text>
        </View>
      </ClearLensScreen>
    );
  }
  // Defensive: `showFirstLoad` already gates on `data === undefined`, so
  // the remainder of this component can treat `data` as defined.
  if (!data) return null;

  const latestNavDate = navHistory[navHistory.length - 1]?.date ?? null;
  const todayIso = new Date().toISOString().split('T')[0];
  const navIsStale = latestNavDate !== null && latestNavDate !== todayIso;
  const gain = data.currentValue !== null ? data.currentValue - data.investedAmount : null;
  const gainPct = gain !== null && data.investedAmount > 0 ? (gain / data.investedAmount) * 100 : null;
  const hasSignalRow = (gain !== null && gainPct !== null) || Number.isFinite(data.fundXirr);
  const hasRealizedActivity = data.realizedAmount > 0 || data.redeemedUnits > 0;

  return (
    <ClearLensScreen>
      <ClearLensHeader onPressBack={() => router.back()} />
      <ScrollView contentContainerStyle={clearDetailStyles.scroll} showsVerticalScrollIndicator={false}>
        <ClearLensCard style={clearDetailStyles.heroCard}>
          <View style={clearDetailStyles.heroTitleRow}>
            <View style={clearDetailStyles.heroTitleBlock}>
              <Text style={clearDetailStyles.fundName}>{data.schemeName}</Text>
              <Text style={clearDetailStyles.category}>{data.schemeCategory || 'Fund'}</Text>
            </View>
          </View>

          <View style={clearDetailStyles.statsRow}>
            <View style={clearDetailStyles.statCell}>
              <Text style={clearDetailStyles.statLabel} numberOfLines={1}>Current value</Text>
              <Text style={clearDetailStyles.statValue}>
                {data.currentValue !== null ? formatCurrency(data.currentValue) : 'NAV pending'}
              </Text>
              {navIsStale && latestNavDate && (
                <Text style={clearDetailStyles.statHint}>as of {formatNavDate(latestNavDate)}</Text>
              )}
            </View>
            <View style={clearDetailStyles.statCell}>
              <Text style={clearDetailStyles.statLabel} numberOfLines={1}>Cost basis</Text>
              <Text style={clearDetailStyles.statValue}>{formatCurrency(data.investedAmount)}</Text>
              {hasRealizedActivity && (
                <Text style={clearDetailStyles.statHint}>after redemptions</Text>
              )}
            </View>
            <View style={clearDetailStyles.statCell}>
              <Text style={clearDetailStyles.statLabel} numberOfLines={1}>Units</Text>
              <Text style={clearDetailStyles.statValue}>{data.currentUnits.toFixed(3)}</Text>
            </View>
          </View>

          {hasSignalRow && (
            <View style={clearDetailStyles.signalBox}>
              {gain !== null && gainPct !== null && (
                <View style={clearDetailStyles.signalCell}>
                  <Text style={clearDetailStyles.statLabel}>Gain</Text>
                  <Text style={[clearDetailStyles.signalValue, { color: gain >= 0 ? tokens.colors.emeraldDeep : tokens.colors.negative }]}>
                    {formatClearLensCurrencyDelta(gain)}
                    <Text style={clearDetailStyles.signalInline}> ({formatClearLensPercentDelta(gainPct, 1)})</Text>
                  </Text>
                </View>
              )}
              {gain !== null && gainPct !== null && Number.isFinite(data.fundXirr) && (
                <View style={clearDetailStyles.signalDivider} />
              )}
              {Number.isFinite(data.fundXirr) && (
                <View style={clearDetailStyles.signalCell}>
                  <Text style={clearDetailStyles.statLabel}>XIRR</Text>
                  <View style={clearDetailStyles.xirrSignalLine}>
                    <Text style={[clearDetailStyles.signalValue, { color: data.fundXirr >= 0 ? tokens.colors.emeraldDeep : tokens.colors.negative }]}>
                      {formatXirr(data.fundXirr)}
                    </Text>
                    <Text style={clearDetailStyles.xirrHint}>p.a.</Text>
                  </View>
                </View>
              )}
            </View>
          )}

          {hasRealizedActivity && (
            <View style={clearDetailStyles.realizedBox}>
              <View style={clearDetailStyles.realizedCell}>
                <Text style={clearDetailStyles.statLabel}>Redeemed</Text>
                <Text style={clearDetailStyles.realizedValue}>{formatCurrency(data.realizedAmount)}</Text>
              </View>
              <View style={clearDetailStyles.signalDivider} />
              <View style={clearDetailStyles.realizedCell}>
                <Text style={clearDetailStyles.statLabel}>Booked P&amp;L</Text>
                <Text
                  style={[
                    clearDetailStyles.realizedValue,
                    { color: data.realizedGain >= 0 ? tokens.colors.emeraldDeep : tokens.colors.negative },
                  ]}
                >
                  {formatClearLensCurrencyDelta(data.realizedGain)}
                </Text>
              </View>
            </View>
          )}

          <TouchableOpacity
            style={clearDetailStyles.transactionsAction}
            onPress={() => router.push(`/money-trail?fundId=${data.id}`)}
            activeOpacity={0.76}
          >
            <Ionicons name="receipt-outline" size={18} color={tokens.colors.emeraldDeep} />
            <Text style={clearDetailStyles.transactionsActionText}>View fund transactions</Text>
            <Ionicons name="arrow-forward" size={16} color={tokens.colors.emeraldDeep} />
          </TouchableOpacity>
        </ClearLensCard>

        <ClearLensSegmentedControl
          selected={activeTab}
          onChange={setActiveTab}
          options={[
            { value: 'performance', label: 'Performance' },
            { value: 'nav', label: 'NAV & Facts' },
            { value: 'composition', label: 'Mix & Weight' },
          ]}
        />

        {activeTab === 'performance' && (
          <>
            <PerformanceTab
              navHistory={navHistory}
              fundBenchmarkIndex={data.benchmarkIndex ?? null}
              fundBenchmarkSymbol={data.benchmarkSymbol ?? null}
              fundRef={{ id: data.id, schemeCode: data.schemeCode }}
              userId={userId}
            />
            <GrowthConsistencyChart navHistory={navHistory} />
          </>
        )}

        {activeTab === 'nav' && (
          <>
            <NavHistoryTab navHistory={navHistory} />
            <TechnicalDetailsCard
              expenseRatio={data.expenseRatio}
              aumCr={data.aumCr}
              minSipAmount={data.minSipAmount}
              fundMetaSyncedAt={data.fundMetaSyncedAt}
              schemeCode={data.schemeCode}
              isin={data.isin}
              launchDate={data.launchDate}
              exitLoad={data.exitLoad}
              minLumpsum={data.minLumpsum}
              minAdditional={data.minAdditional}
              planType={data.planType}
              amcName={data.amcName}
              riskLabel={data.riskLabel}
              schemeCategory={data.schemeCategory}
              declaredBenchmarkName={data.declaredBenchmarkName}
              benchmarkIndex={data.benchmarkIndex}
              fundManager={data.fundManager}
              portfolioTurnover={data.portfolioTurnover}
              terDate={data.terDate}
              periodReturns={data.periodReturns}
            />
          </>
        )}

        {activeTab === 'composition' && (
          <>
            <FundCompositionTab schemeCode={data.schemeCode} />
            <PortfolioHealthDonut fundId={data.id} currentValue={data.currentValue} />
          </>
        )}

        <PortfolioDisclaimer />
      </ScrollView>
    </ClearLensScreen>
  );
}

export default function FundDetailScreen() {
  return (
    <ResponsiveRouteFrame>
      <Stack.Screen options={{ headerShown: false, title: '' }} />
      <ClearLensFundDetailScreen />
    </ResponsiveRouteFrame>
  );
}

function makeClearDetailStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
  scroll: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingBottom: ClearLensSpacing.xxl,
    gap: ClearLensSpacing.md,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: ClearLensSpacing.md,
  },
  errorText: {
    ...ClearLensTypography.body,
    color: cl.textSecondary,
  },
  heroCard: {
    gap: ClearLensSpacing.md,
  },
  heroTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: ClearLensSpacing.sm,
  },
  heroTitleBlock: {
    flex: 1,
    gap: 5,
  },
  fundName: {
    ...ClearLensTypography.h2,
    color: cl.navy,
  },
  category: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
    fontFamily: ClearLensFonts.semiBold,
  },
  statsRow: {
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
  },
  statCell: {
    flex: 1,
    gap: 4,
  },
  statLabel: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    textTransform: 'uppercase',
    fontSize: 10,
    letterSpacing: 0.7,
  },
  statValue: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  statHint: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    fontStyle: 'italic',
  },
  gainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    flexWrap: 'wrap',
  },
  gainValue: {
    ...ClearLensTypography.h3,
  },
  signalBox: {
    minHeight: 56,
    padding: ClearLensSpacing.sm,
    borderRadius: ClearLensRadii.md,
    backgroundColor: tokens.semantic.sentiment.positiveSurface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  signalCell: {
    flex: 1,
    gap: 3,
  },
  signalDivider: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: cl.mint,
  },
  signalValue: {
    ...ClearLensTypography.h3,
  },
  signalInline: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.medium,
  },
  realizedBox: {
    minHeight: 56,
    padding: ClearLensSpacing.sm,
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.surfaceSoft,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  realizedCell: {
    flex: 1,
    gap: 3,
  },
  realizedValue: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  transactionsAction: {
    minHeight: 46,
    borderRadius: ClearLensRadii.md,
    borderWidth: 1,
    borderColor: cl.borderLight,
    backgroundColor: cl.surfaceSoft,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: ClearLensSpacing.sm,
  },
  transactionsActionText: {
    ...ClearLensTypography.bodySmall,
    color: cl.emeraldDeep,
    fontFamily: ClearLensFonts.bold,
  },
  xirrSignalLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: ClearLensSpacing.xs,
    flexWrap: 'wrap',
  },
  xirrRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.xs,
    flexWrap: 'wrap',
  },
  xirrValue: {
    ...ClearLensTypography.h3,
  },
  xirrHint: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
  },
  benchmarkPill: {
    minHeight: 40,
    alignSelf: 'flex-end',
    marginTop: -ClearLensSpacing.xs,
    paddingHorizontal: ClearLensSpacing.md,
    borderRadius: ClearLensRadii.full,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    backgroundColor: tokens.semantic.sentiment.positiveSurface,
  },
  benchmarkPillNegative: {
    backgroundColor: tokens.semantic.sentiment.negativeSurface,
  },
  benchmarkPillText: {
    ...ClearLensTypography.bodySmall,
    color: tokens.semantic.sentiment.positiveText,
    fontFamily: ClearLensFonts.semiBold,
  },
  benchmarkPillTextNegative: {
    color: tokens.semantic.sentiment.negativeText,
  },
  noteCard: {
    marginHorizontal: ClearLensSpacing.md,
  },
  noteText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
  },
});
}

function makeStyles(colors: ClearLensCompatibleTokens) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },

    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
    errorText: { ...ClearLensTypography.body, color: colors.textSecondary },
    backLink: { color: colors.primary, fontSize: 14, fontWeight: '600' as const },

    // ── Fund header ──
    fundHeader: {
      backgroundColor: colors.surface,
      margin: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
      gap: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    fundName: { fontSize: 17, fontWeight: '700' as const, color: colors.textPrimary, lineHeight: 24 },
    fundCategory: { ...ClearLensTypography.bodySmall, color: colors.textTertiary, marginBottom: 6, fontWeight: '600' as const },

    holdingRow: { flexDirection: 'row', marginTop: 2 },
    holdingStat: { flex: 1, alignItems: 'center', gap: 4 },
    holdingValue: { fontSize: 15, fontWeight: '800' as const, color: colors.textPrimary },
    holdingValuePending: { fontSize: 13, fontWeight: '500' as const, color: colors.textTertiary, fontStyle: 'italic' },
    navStaleLabel: { fontSize: 11, color: colors.textTertiary, fontStyle: 'italic' },

    gainRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
    gainValue: { fontSize: 14, fontWeight: '700' as const },

    xirrHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, flexWrap: 'wrap' },
    xirrHeaderValue: { fontSize: 14, fontWeight: '700' as const },
    xirrHeaderHint: { fontSize: 11, color: colors.textTertiary, fontWeight: '600' as const },

    // ── Tab bar ──
    tabBar: {
      flexDirection: 'row',
      marginHorizontal: ClearLensSpacing.md,
      backgroundColor: colors.borderLight,
      borderRadius: ClearLensRadii.md,
      padding: 4,
      marginBottom: ClearLensSpacing.xs,
    },
    tab: {
      flex: 1,
      paddingVertical: 9,
      alignItems: 'center',
      borderRadius: ClearLensRadii.sm,
    },
    tabActive: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    tabText: { fontSize: 13, fontWeight: '600' as const, color: colors.textTertiary },
    tabTextActive: { color: colors.textPrimary, fontWeight: '700' as const },

    // ── Tab content ──
    tabContent: { paddingHorizontal: ClearLensSpacing.md, gap: 14 },

    // XIRR card
    xirrCard: {
      backgroundColor: colors.surface,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
      gap: ClearLensSpacing.md,
      marginTop: ClearLensSpacing.sm,
      borderWidth: 1,
      borderColor: colors.border,
    },
    comparisonRow: { flexDirection: 'row', alignItems: 'flex-start' },
    comparisonCol: { flex: 1, gap: 4 },
    comparisonHint: {
      fontSize: 11,
      lineHeight: 16,
      color: colors.textTertiary,
      fontWeight: '600' as const,
    },
    xirrDivider: { width: 1, backgroundColor: colors.borderLight, marginHorizontal: 12 },
    xirrValue: { fontSize: 22, fontWeight: '800' as const, color: colors.textPrimary, letterSpacing: -0.5 },
    verdictRow: {
      marginTop: 10,
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: colors.borderLight,
    },
    verdictText: { fontSize: 13, fontWeight: '600' as const },

    // Chart
    chartCard: {
      backgroundColor: colors.surface,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
      gap: 10,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: colors.border,
    },
    chartWrap: {
      alignItems: 'center',
      overflow: 'hidden',
    },
    chartLegendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    legendDot: { width: 10, height: 10, borderRadius: 5 },
    legendLabel: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' as const },
    // Header above the chart — title + subtitle on the left, "vs <benchmark>"
    // pill on the right, mirroring the Portfolio "How your money grew" card.
    chartHeaderRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: ClearLensSpacing.sm,
    },
    chartHeaderCopy: { flex: 1, gap: 2, minWidth: 0 },
    chartHeaderTitle: { fontSize: 16, fontWeight: '700' as const, color: colors.textPrimary },
    chartHeaderSubtitle: { fontSize: 12, color: colors.textSecondary },
    chartHeaderBadge: {
      paddingHorizontal: ClearLensSpacing.sm,
      paddingVertical: 4,
      borderRadius: ClearLensRadii.full,
      backgroundColor: colors.surfaceAlt,
      borderWidth: 1,
      borderColor: colors.border,
    },
    chartHeaderBadgeText: { fontSize: 12, color: colors.textPrimary, fontWeight: '600' as const },

    returnSummary: { gap: 6, marginTop: 4 },
    summaryDateLabel: { fontSize: 11, color: colors.textTertiary, marginBottom: 2 },
    returnRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    returnLabel: { fontSize: 13, color: colors.textSecondary, fontWeight: '600' as const },
    returnVal: { fontSize: 14, color: colors.textPrimary, fontWeight: '700' as const },

    navStatsRow: { flexDirection: 'row' },
    navStat: { flex: 1, alignItems: 'center', gap: 3 },
    navStatValue: { fontSize: 13, fontWeight: '700' as const, color: colors.textPrimary },

    statLabel: { ...ClearLensTypography.caption, color: colors.textTertiary, textTransform: 'uppercase' },

    windowRow: { flexDirection: 'row', gap: 6 },
    // Inactive pill: subtle surface lift + hairline border so it reads as a
    // discrete chip in both schemes. The previous `borderLight` background
    // matched the dark-mode page bg almost exactly, leaving the unselected
    // pills feeling like floating text.
    windowPill: {
      flex: 1,
      paddingVertical: 6,
      borderRadius: ClearLensRadii.full,
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    windowPillActive: { backgroundColor: colors.primaryLight, borderWidth: 1, borderColor: colors.primary },
    windowPillText: { fontSize: 12, fontWeight: '600' as const, color: colors.textTertiary },
    windowPillTextActive: { color: colors.primary, fontWeight: '700' as const },

    chartAxisLabel: { fontSize: 9, color: colors.textTertiary },

    chartExplainer: {
      fontSize: 11,
      color: colors.textTertiary,
      fontStyle: 'italic',
      textAlign: 'center',
      lineHeight: 16,
    },
    noBenchmarkNote: {
      fontSize: 12,
      color: colors.textTertiary,
      textAlign: 'center',
      marginTop: 2,
    },
    benchmarkDisclosure: {
      fontSize: 11,
      color: colors.textTertiary,
      textAlign: 'center',
      lineHeight: 15,
      paddingHorizontal: 12,
      paddingTop: 12,
    },

    benchmarkSelectorContent: {
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: 0,
    },
    benchmarkPill: {
      paddingVertical: 5,
      paddingHorizontal: 10,
      borderRadius: ClearLensRadii.full,
      backgroundColor: colors.borderLight,
    },
    benchmarkPillActive: { backgroundColor: colors.primaryLight, borderWidth: 1, borderColor: colors.primary },
    benchmarkPillText: { fontSize: 11, fontWeight: '600' as const, color: colors.textTertiary },
    benchmarkPillTextActive: { color: colors.primary, fontWeight: '700' as const },

    pointerLabel: {
      backgroundColor: colors.surface,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 5,
      borderWidth: 1,
      borderColor: colors.borderLight,
      gap: 2,
    },
    pointerDate: { fontSize: 10, color: colors.textTertiary, fontWeight: '600' as const },
    pointerSeriesText: { fontSize: 11, color: colors.textSecondary },

    noData: { padding: 40, alignItems: 'center', gap: 10 },
    noDataText: { ...ClearLensTypography.body, color: colors.textTertiary, textAlign: 'center' },

    bottomPad: { height: 32 },
  });
}
