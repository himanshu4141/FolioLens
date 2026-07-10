import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LineChart } from 'react-native-gifted-charts';
import Svg, { G, Line as SvgLine, Rect as SvgRect, Text as SvgText } from 'react-native-svg';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  filterToWindow,
  indexTo100,
  type TimeWindow,
} from '@/src/hooks/useFundDetail';
import {
  prefetchInvestmentVsBenchmarkTimeline,
  useInvestmentVsBenchmarkTimeline,
} from '@/src/hooks/useInvestmentVsBenchmarkTimeline';
import { fetchIndexHistory } from '@/src/hooks/useIndexSnapshot';
import type { FundRef } from '@/src/hooks/usePortfolioTimeline';
import { computeQuarterlyReturns } from '@/src/utils/quarterlyReturns';
import { formatCurrency } from '@/src/utils/formatting';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensCompatibleTokens,
} from '@/src/constants/clearLensTheme';
import { BENCHMARK_OPTIONS } from '@/src/store/appStore';
import {
  BENCHMARK_DISCLOSURE,
  fundDetailBenchmarkOptions,
} from '@/src/utils/benchmarkSymbolMap';
import {
  FUND_DETAIL_CHART_MAX,
  TimeWindowSelector,
  formatChartDate,
  makeFundDetailTabStyles,
} from './fundDetailTabShared';

function PerformanceTab({
  navHistory,
  fundBenchmarkIndex,
  fundBenchmarkSymbol,
  fundRef,
  userId,
  isFocused,
}: {
  navHistory: { date: string; value: number }[];
  fundBenchmarkIndex: string | null;
  fundBenchmarkSymbol: string | null;
  fundRef?: FundRef;
  userId?: string;
  isFocused: boolean;
}) {
  const { compatible: colors } = useClearLensTokens();
  const tokens = useClearLensTokens();
  const s = useMemo(() => makeFundDetailTabStyles(colors), [colors]);
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
  const queryClient = useQueryClient();
  const handleBenchmarkPrefetch = useCallback((symbol: string) => {
    if (!isFocused || !fundRef || !userId || symbol === selectedSymbol) return;
    void prefetchInvestmentVsBenchmarkTimeline(
      queryClient,
      [fundRef],
      userId,
      symbol,
      window,
    );
  }, [fundRef, isFocused, queryClient, selectedSymbol, userId, window]);
  const investmentTimeline = useInvestmentVsBenchmarkTimeline(
    fundRef ? [fundRef] : [],
    userId,
    selectedSymbol,
    window,
    { enabled: isFocused },
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
    enabled: isFocused,
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
              onPressIn={() => handleBenchmarkPrefetch(opt.symbol)}
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
            onPressIn={() => handleBenchmarkPrefetch(opt.symbol)}
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


interface FundDetailPerformanceContentProps {
  navHistory: { date: string; value: number }[];
  fundBenchmarkIndex: string | null;
  fundBenchmarkSymbol: string | null;
  fundRef?: FundRef;
  userId?: string;
  isFocused: boolean;
}

export default function FundDetailPerformanceContent(
  props: FundDetailPerformanceContentProps,
) {
  return (
    <>
      <PerformanceTab {...props} />
      <GrowthConsistencyChart navHistory={props.navHistory} />
    </>
  );
}
