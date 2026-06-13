import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Dimensions,
  type GestureResponderEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { AppOverflowMenu } from '@/src/components/AppOverflowMenu';
import {
  ClearLensCard,
  ClearLensHeader,
  ClearLensPill,
  ClearLensScreen,
} from '@/src/components/clearLens/ClearLensPrimitives';
import { useIsRestoring, useQueryClient } from '@tanstack/react-query';
import { usePortfolio, type FundCardData } from '@/src/hooks/usePortfolio';
import { useUserFunds } from '@/src/hooks/useUserFunds';
import { syncDeltaForUser } from '@/src/lib/db/sync';
import { useImportPortfolioPress } from '@/src/hooks/useImportPortfolioPress';
import { useTrackInsightViewed } from '@/src/hooks/useTrackInsightViewed';
import { usePortfolioInsights } from '@/src/hooks/usePortfolioInsights';
import {
  useInvestmentVsBenchmarkTimeline,
  type InvestmentVsBenchmarkPoint,
} from '@/src/hooks/useInvestmentVsBenchmarkTimeline';
import { useMoneyTrail } from '@/src/hooks/useMoneyTrail';
import type { FundRef } from '@/src/hooks/usePortfolioTimeline';
import { navStaleness, type TimeWindow } from '@/src/utils/navUtils';
import { useSession } from '@/src/hooks/useSession';
import { BENCHMARK_OPTIONS, useAppStore } from '@/src/store/appStore';
import { BENCHMARK_DISCLOSURE } from '@/src/utils/benchmarkSymbolMap';
import { MoneyTrailPreviewCard } from '@/src/components/clearLens/MoneyTrailPreviewCard';
import { PortfolioDisclaimer } from '@/src/components/clearLens/PortfolioDisclaimer';
import { formatCurrency } from '@/src/utils/formatting';
import { formatXirr } from '@/src/utils/xirr';
import { parseFundName } from '@/src/utils/fundName';
import {
  ClearLensColors,
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensSemanticColors,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  formatClearLensCurrencyDelta,
  formatClearLensPercentDelta,
} from '@/src/utils/clearLensFormat';
import { useResponsiveLayout } from '@/src/components/responsive';
import { ClearLensPortfolioScreenDesktop } from '@/src/components/clearLens/screens/desktop/ClearLensPortfolioScreenDesktop';

const SCREEN_WIDTH = Dimensions.get('window').width;
const CHART_WIDTH = SCREEN_WIDTH - ClearLensSpacing.md * 2 - ClearLensSpacing.md * 2;
const JOURNEY_Y_AXIS_WIDTH = 54;
const JOURNEY_CHART_HEIGHT = 178;
const JOURNEY_X_AXIS_HEIGHT = 24;
const JOURNEY_CHART_TOP_PADDING = 10;
const JOURNEY_CHART_RIGHT_PADDING = 6;
const JOURNEY_TOOLTIP_WIDTH = 226;
const JOURNEY_TOOLTIP_HEIGHT = 112;
const JOURNEY_WINDOWS: TimeWindow[] = ['1M', '3M', '6M', '1Y', '3Y', 'All'];
const CLEAR_LENS_RED = ClearLensSemanticColors.sentiment.negative;

function toneForValue(value: number): 'positive' | 'negative' {
  return value >= 0 ? 'positive' : 'negative';
}

function toneColor(tone: 'positive' | 'negative') {
  return tone === 'positive' ? ClearLensColors.emerald : CLEAR_LENS_RED;
}

function formatSignedChange(amount: number, pct: number): string {
  return `${formatClearLensCurrencyDelta(amount)} (${formatClearLensPercentDelta(pct)})`;
}

export function PortfolioHero({
  totalValue,
  totalInvested,
  dailyChangeAmount,
  dailyChangePct,
  xirr,
  latestNavDate,
}: {
  totalValue: number;
  totalInvested: number;
  dailyChangeAmount: number;
  dailyChangePct: number;
  xirr: number;
  latestNavDate?: string | null;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const gain = totalValue - totalInvested;
  const gainPct = totalInvested > 0 ? (gain / totalInvested) * 100 : 0;
  const gainColor = toneColor(toneForValue(gain));
  const dailyColor = toneColor(toneForValue(dailyChangeAmount));
  const navStamp = navStaleness(latestNavDate ?? null);

  return (
    <ClearLensCard style={styles.heroCard}>
      <Text style={styles.heroLabel}>Your portfolio value</Text>
      <Text style={styles.heroValue}>{formatCurrency(totalValue)}</Text>

      <Text style={styles.heroToday}>
        Today{' '}
        <Text style={[styles.heroTodayValue, { color: dailyColor }]}>
          {formatSignedChange(dailyChangeAmount, dailyChangePct)}
        </Text>
      </Text>

      {navStamp.label !== '' && (
        <Text
          style={[
            styles.heroNavStamp,
            navStamp.critical && styles.heroNavStampCritical,
          ]}
        >
          NAV {navStamp.label}
        </Text>
      )}

      <View style={styles.heroBottomRow}>
        <View style={styles.heroBottomMetric}>
          <Text style={styles.heroBottomLabel}>Overall gain</Text>
          <Text style={[styles.heroBottomValue, { color: gainColor }]}>
            {formatClearLensCurrencyDelta(gain)} ({formatClearLensPercentDelta(gainPct, 1)})
          </Text>
        </View>
        <View style={styles.heroDivider} />
        <View style={styles.heroBottomMetric}>
          <Text style={styles.heroBottomLabel}>Your real return (XIRR)</Text>
          <Text style={styles.heroXirrValue}>{formatXirr(xirr)} p.a.</Text>
        </View>
      </View>
    </ClearLensCard>
  );
}

function NavUnavailableNote({ count }: { count: number }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.navUnavailableNote}>
      <Ionicons name="information-circle-outline" size={14} color={tokens.colors.textTertiary} />
      <Text style={styles.navUnavailableNoteText}>
        {count === 1
          ? '1 fund excluded from totals — NAV unavailable'
          : `${count} funds excluded from totals — NAV unavailable`}
      </Text>
    </View>
  );
}

export function BenchmarkComparisonCard({
  xirr,
  marketXirr,
  benchmarkSymbol,
  onBenchmarkChange,
}: {
  xirr: number;
  marketXirr: number;
  benchmarkSymbol: string;
  onBenchmarkChange: (symbol: string) => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const benchmarkLabel = BENCHMARK_OPTIONS.find((option) => option.symbol === benchmarkSymbol)?.label ?? benchmarkSymbol;
  const difference = Number.isFinite(xirr) && Number.isFinite(marketXirr) ? (xirr - marketXirr) * 100 : null;
  const ahead = difference === null || difference >= 0;

  return (
    <View style={styles.benchmarkWrap}>
      {difference !== null && (
        <View style={[styles.marketStatusPill, !ahead && styles.marketStatusPillNegative]}>
          <Ionicons
            name={ahead ? 'trending-up' : 'trending-down'}
            size={18}
            color={ahead ? tokens.colors.emerald : CLEAR_LENS_RED}
          />
          <Text style={[styles.marketStatusText, !ahead && styles.marketStatusTextNegative]}>
            You are {ahead ? 'ahead of' : 'behind'} {benchmarkLabel} by {Math.abs(difference).toFixed(1)}%
          </Text>
        </View>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow}>
        {BENCHMARK_OPTIONS.map((option) => (
          <ClearLensPill
            key={option.symbol}
            label={option.label}
            active={option.symbol === benchmarkSymbol}
            onPress={() => onBenchmarkChange(option.symbol)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function formatAxisCurrency(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 10000000) return `₹${trimNumber(value / 10000000)}Cr`;
  if (value >= 100000) return `₹${trimNumber(value / 100000)}L`;
  if (value >= 1000) return `₹${trimNumber(value / 1000)}K`;
  return `₹${Math.round(value)}`;
}

function trimNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '');
}

function formatTooltipCurrency(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}

function formatJourneyDate(date: string, window: TimeWindow): string {
  const [year, month, day] = date.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabel = months[Number(month) - 1] ?? month;

  if (window === '1M' || window === '3M') return `${Number(day)} ${monthLabel}`;
  if (window === '1Y') return `${monthLabel} '${year.slice(2)}`;
  if (window === '3Y') return `${monthLabel} '${year.slice(2)}`;
  return year;
}

function formatJourneyTooltipDate(date: string): string {
  const [year, month, day] = date.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabel = months[Number(month) - 1] ?? month;
  return `${day}-${monthLabel}-${year}`;
}

function buildJourneyXAxisLabels(points: InvestmentVsBenchmarkPoint[], window: TimeWindow): string[] {
  if (points.length === 0) return [];

  const labelCount = window === '1Y' || window === '3Y' ? 4 : 5;
  const labels = new Array<string>(points.length).fill('');
  if (points.length <= labelCount) {
    return points.map((point) => formatJourneyDate(point.date, window));
  }

  const step = (points.length - 1) / (labelCount - 1);
  let previousLabel = '';
  for (let index = 0; index < labelCount; index += 1) {
    const pointIndex = Math.min(Math.round(index * step), points.length - 1);
    const label = formatJourneyDate(points[pointIndex].date, window);
    if (label !== previousLabel || index === labelCount - 1) {
      labels[pointIndex] = label;
      previousLabel = label;
    }
  }
  return labels;
}

function getNiceChartBounds(values: number[]): { yMin: number; yMax: number; range: number } {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) return { yMin: 0, yMax: 1, range: 1 };

  const min = Math.min(...finiteValues);
  const max = Math.max(...finiteValues);
  const rawRange = Math.max(max - min, max * 0.08, 1);
  const roughStep = rawRange / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const step = normalized <= 1 ? magnitude : normalized <= 2 ? magnitude * 2 : normalized <= 5 ? magnitude * 5 : magnitude * 10;
  const paddedMin = min - step * 0.75;
  const paddedMax = max + step * 0.75;
  const yMin = Math.max(0, Math.floor(paddedMin / step) * step);
  const yMax = Math.max(step, Math.ceil(paddedMax / step) * step);

  return { yMin, yMax, range: Math.max(yMax - yMin, step) };
}

function rangePillLabel(window: TimeWindow): string {
  return window === 'All' ? 'All' : window;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getCurrencyLevelTicks(minValue: number, maxValue: number, maxTicks = 7): number[] {
  const safeMin = Math.max(1, minValue);
  const safeMax = Math.max(safeMin * 1.01, maxValue);
  const ticks: number[] = [];
  const startPower = Math.floor(Math.log10(safeMin)) - 1;
  const endPower = Math.ceil(Math.log10(safeMax)) + 1;

  for (let power = startPower; power <= endPower; power += 1) {
    const base = 10 ** power;
    for (const factor of [1, 2, 4]) {
      const tick = factor * base;
      if (tick >= safeMin * 0.8 && tick <= safeMax * 1.25) {
        ticks.push(tick);
      }
    }
  }

  const uniqueTicks = [...new Set(ticks)].sort((a, b) => a - b);
  if (uniqueTicks.length <= maxTicks) return uniqueTicks;

  const limited: number[] = [];
  const step = (uniqueTicks.length - 1) / (maxTicks - 1);
  for (let index = 0; index < maxTicks; index += 1) {
    const tick = uniqueTicks[Math.round(index * step)];
    if (tick !== undefined && !limited.includes(tick)) limited.push(tick);
  }
  return limited;
}

function getJourneyScale(values: number[]) {
  const finiteValues = values.filter((value) => Number.isFinite(value) && value > 0);
  if (finiteValues.length === 0) {
    return {
      mode: 'linear' as const,
      min: 0,
      max: 1,
      ticks: [0, 0.25, 0.5, 0.75, 1],
    };
  }

  const minValue = Math.min(...finiteValues);
  const maxValue = Math.max(...finiteValues);
  const shouldUseLogScale = maxValue / Math.max(minValue, 1) >= 8;

  if (shouldUseLogScale) {
    const ticks = getCurrencyLevelTicks(minValue, maxValue);
    const min = ticks[0] ?? minValue;
    const max = ticks[ticks.length - 1] ?? maxValue;
    return {
      mode: 'log' as const,
      min,
      max: Math.max(max, min * 1.01),
      ticks,
    };
  }

  const { yMin, yMax } = getNiceChartBounds(finiteValues);
  const step = (yMax - yMin) / 4;
  return {
    mode: 'linear' as const,
    min: yMin,
    max: yMax,
    ticks: Array.from({ length: 5 }, (_, index) => yMin + step * index),
  };
}

function getScaledY(
  value: number,
  scale: ReturnType<typeof getJourneyScale>,
  plotHeight: number,
): number {
  if (scale.mode === 'log') {
    const minLog = Math.log10(Math.max(scale.min, 1));
    const maxLog = Math.log10(Math.max(scale.max, scale.min + 1));
    const valueLog = Math.log10(clamp(value, scale.min, scale.max));
    const ratio = (maxLog - valueLog) / Math.max(maxLog - minLog, 0.0001);
    return JOURNEY_CHART_TOP_PADDING + ratio * plotHeight;
  }

  const ratio = (scale.max - clamp(value, scale.min, scale.max)) / Math.max(scale.max - scale.min, 1);
  return JOURNEY_CHART_TOP_PADDING + ratio * plotHeight;
}

function getChartX(index: number, pointCount: number, plotWidth: number): number {
  if (pointCount <= 1) return JOURNEY_Y_AXIS_WIDTH;
  return JOURNEY_Y_AXIS_WIDTH + (index / (pointCount - 1)) * plotWidth;
}

function buildJourneyPath(
  points: InvestmentVsBenchmarkPoint[],
  valueForPoint: (point: InvestmentVsBenchmarkPoint) => number,
  scale: ReturnType<typeof getJourneyScale>,
  plotWidth: number,
): string {
  return points
    .map((point, index) => {
      const command = index === 0 ? 'M' : 'L';
      return `${command}${getChartX(index, points.length, plotWidth).toFixed(2)} ${getScaledY(
        valueForPoint(point),
        scale,
        JOURNEY_CHART_HEIGHT,
      ).toFixed(2)}`;
    })
    .join(' ');
}

export function InvestmentVsBenchmarkChart({
  funds,
  userId,
  benchmarkSymbol,
}: {
  funds: FundRef[];
  userId: string | undefined;
  benchmarkSymbol: string;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  // Window selection lives in the store so it survives the desktop ↔ mobile
  // screen swap (Portfolio has separate Mobile / Desktop component variants).
  const window = useAppStore((s) => s.portfolioChartWindow);
  const setWindow = useAppStore((s) => s.setPortfolioChartWindow);
  const [chartInnerWidth, setChartInnerWidth] = useState(CHART_WIDTH);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const { points, isLoading, error } = useInvestmentVsBenchmarkTimeline(
    funds,
    userId,
    benchmarkSymbol,
    window,
  );
  const benchmarkLabel = BENCHMARK_OPTIONS.find((option) => option.symbol === benchmarkSymbol)?.label ?? benchmarkSymbol;
  const xAxisLabels = useMemo(() => buildJourneyXAxisLabels(points, window), [points, window]);

  useEffect(() => {
    setActiveIndex(null);
  }, [benchmarkSymbol, window]);

  const chartWidth = Math.max(260, chartInnerWidth);
  const plotWidth = Math.max(180, chartWidth - JOURNEY_Y_AXIS_WIDTH - JOURNEY_CHART_RIGHT_PADDING);
  const svgHeight = JOURNEY_CHART_TOP_PADDING + JOURNEY_CHART_HEIGHT;
  const frameHeight = svgHeight + JOURNEY_X_AXIS_HEIGHT;

  // Memoize the scale + path strings by `points` so dragging the tooltip
  // (which updates `activeIndex` rapidly via `onResponderMove`) doesn't
  // re-iterate all points every frame to rebuild three `d=` strings. Before
  // this, panning a 90-point timeline on a mid-range Android caused
  // perceptible drag-stutter; with memoization the move handler only
  // re-renders the tooltip layer.
  const journeyScale = useMemo(() => {
    const values = points.flatMap((point) => [
      point.investedValue,
      point.portfolioValue,
      point.benchmarkValue,
    ]);
    return getJourneyScale(values);
  }, [points]);
  const portfolioPath = useMemo(
    () => buildJourneyPath(points, (point) => point.portfolioValue, journeyScale, plotWidth),
    [points, journeyScale, plotWidth],
  );
  const benchmarkPath = useMemo(
    () => buildJourneyPath(points, (point) => point.benchmarkValue, journeyScale, plotWidth),
    [points, journeyScale, plotWidth],
  );
  const investedPath = useMemo(
    () => buildJourneyPath(points, (point) => point.investedValue, journeyScale, plotWidth),
    [points, journeyScale, plotWidth],
  );

  if (!isLoading && points.length < 2) return null;

  const activeIndexForRender = activeIndex !== null && points.length > 0
    ? Math.round(clamp(activeIndex, 0, points.length - 1))
    : null;
  const activePoint = activeIndexForRender !== null ? points[activeIndexForRender] : null;
  const activeX = activeIndexForRender !== null ? getChartX(activeIndexForRender, points.length, plotWidth) : 0;
  const activePortfolioY = activePoint
    ? getScaledY(activePoint.portfolioValue, journeyScale, JOURNEY_CHART_HEIGHT)
    : JOURNEY_CHART_TOP_PADDING;
  const tooltipLeft = clamp(
    activeX > chartWidth / 2 ? activeX - JOURNEY_TOOLTIP_WIDTH - 10 : activeX + 10,
    4,
    chartWidth - JOURNEY_TOOLTIP_WIDTH - 4,
  );
  const tooltipTop = clamp(
    activePortfolioY - JOURNEY_TOOLTIP_HEIGHT / 2,
    4,
    frameHeight - JOURNEY_TOOLTIP_HEIGHT - JOURNEY_X_AXIS_HEIGHT,
  );

  function updateActivePoint(event: GestureResponderEvent) {
    if (points.length < 2) return;
    const localX = event.nativeEvent.locationX;
    const ratio = clamp((localX - JOURNEY_Y_AXIS_WIDTH) / plotWidth, 0, 1);
    const next = Math.round(ratio * (points.length - 1));
    // `onResponderMove` fires every pointer sample (often 60+/s). Skip the
    // state update when the snapped index hasn't changed so we don't spam
    // React with no-op renders on a long horizontal drag.
    setActiveIndex((prev) => (prev === next ? prev : next));
  }

  return (
    <ClearLensCard style={styles.journeyCard}>
      <View style={styles.journeyHeader}>
        <View>
          <Text style={styles.sectionTitle}>How your money grew</Text>
          <Text style={styles.journeySubtitle}>
            See how your investments have grown.
          </Text>
        </View>
        <View style={styles.chartBenchmarkBadge}>
          <Text style={styles.chartBenchmarkText}>vs {benchmarkLabel}</Text>
        </View>
      </View>
      {isLoading ? (
        <View style={styles.chartLoading}>
          <ActivityIndicator size="small" color={tokens.colors.emerald} />
        </View>
      ) : error ? (
        <View style={styles.chartLoading}>
          <Text style={styles.errorText}>Could not load investment journey.</Text>
        </View>
      ) : (
        <>
          <View style={styles.legendWrap}>
            <Legend color={tokens.semantic.chart.invested} label="Amount invested" />
            <Legend color={tokens.semantic.chart.portfolio} label="Portfolio value" />
            <Legend color={tokens.semantic.chart.benchmark} label={`If invested in ${benchmarkLabel}`} />
          </View>
          <View
            style={styles.journeyChartFrame}
            onLayout={(event) => setChartInnerWidth(event.nativeEvent.layout.width)}
          >
            <Svg
              width={chartWidth}
              height={svgHeight}
              style={styles.journeySvg}
            >
              {journeyScale.ticks.map((tick) => {
                const y = getScaledY(tick, journeyScale, JOURNEY_CHART_HEIGHT);
                return (
                  <Line
                    key={`rule-${tick}`}
                    x1={JOURNEY_Y_AXIS_WIDTH}
                    x2={JOURNEY_Y_AXIS_WIDTH + plotWidth}
                    y1={y}
                    y2={y}
                    stroke={tokens.colors.borderLight}
                    strokeWidth={1}
                  />
                );
              })}
              <Line
                x1={JOURNEY_Y_AXIS_WIDTH}
                x2={JOURNEY_Y_AXIS_WIDTH + plotWidth}
                y1={JOURNEY_CHART_TOP_PADDING + JOURNEY_CHART_HEIGHT}
                y2={JOURNEY_CHART_TOP_PADDING + JOURNEY_CHART_HEIGHT}
                stroke={tokens.colors.border}
                strokeWidth={1}
              />
              <Path
                d={investedPath}
                stroke={tokens.semantic.chart.invested}
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
                opacity={0.72}
              />
              <Path
                d={benchmarkPath}
                stroke={tokens.semantic.chart.benchmark}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
                opacity={0.86}
              />
              <Path
                d={portfolioPath}
                stroke={tokens.semantic.chart.portfolio}
                strokeWidth={3.2}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
              {activePoint && (
                <>
                  <Line
                    x1={activeX}
                    x2={activeX}
                    y1={JOURNEY_CHART_TOP_PADDING}
                    y2={JOURNEY_CHART_TOP_PADDING + JOURNEY_CHART_HEIGHT}
                    stroke={tokens.colors.slate}
                    strokeWidth={1}
                    opacity={0.42}
                  />
                  <Circle
                    cx={activeX}
                    cy={getScaledY(activePoint.investedValue, journeyScale, JOURNEY_CHART_HEIGHT)}
                    r={4.5}
                    fill={tokens.semantic.chart.invested}
                    stroke={tokens.colors.surface}
                    strokeWidth={2}
                  />
                  <Circle
                    cx={activeX}
                    cy={getScaledY(activePoint.benchmarkValue, journeyScale, JOURNEY_CHART_HEIGHT)}
                    r={4.5}
                    fill={tokens.semantic.chart.benchmark}
                    stroke={tokens.colors.surface}
                    strokeWidth={2}
                  />
                  <Circle
                    cx={activeX}
                    cy={activePortfolioY}
                    r={5}
                    fill={tokens.semantic.chart.portfolio}
                    stroke={tokens.colors.surface}
                    strokeWidth={2}
                  />
                </>
              )}
            </Svg>

            {journeyScale.ticks.map((tick) => (
              <Text
                key={`axis-${tick}`}
                style={[
                  styles.yAxisLabel,
                  { top: getScaledY(tick, journeyScale, JOURNEY_CHART_HEIGHT) - 8 },
                ]}
              >
                {formatAxisCurrency(tick)}
              </Text>
            ))}

            {xAxisLabels.map((label, index) => {
              if (!label) return null;
              const x = getChartX(index, points.length, plotWidth);
              return (
                <Text
                  key={`${label}-${index}`}
                  style={[
                    styles.xAxisLabel,
                    {
                      left: clamp(x - 27, JOURNEY_Y_AXIS_WIDTH, chartWidth - 54),
                      top: JOURNEY_CHART_TOP_PADDING + JOURNEY_CHART_HEIGHT + 6,
                    },
                  ]}
                >
                  {label}
                </Text>
              );
            })}

            {activePoint && (
              <View
                pointerEvents="none"
                style={[
                  styles.pointerLabel,
                  {
                    left: tooltipLeft,
                    top: tooltipTop,
                  },
                ]}
              >
                <Text style={styles.pointerDate}>{formatJourneyTooltipDate(activePoint.date)}</Text>
                <PointerRow color={tokens.semantic.chart.invested} label="Invested" value={activePoint.investedValue} />
                <PointerRow color={tokens.semantic.chart.portfolio} label="Portfolio" value={activePoint.portfolioValue} />
                <PointerRow color={tokens.semantic.chart.benchmark} label={benchmarkLabel} value={activePoint.benchmarkValue} />
              </View>
            )}

            <View
              style={styles.chartTouchLayer}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderGrant={updateActivePoint}
              onResponderMove={updateActivePoint}
            />
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rangePillRow}>
            {JOURNEY_WINDOWS.map((option) => (
              <TouchableOpacity
                key={option}
                style={[styles.rangePill, window === option && styles.rangePillActive]}
                onPress={() => setWindow(option)}
                activeOpacity={0.75}
              >
                <Text style={[styles.rangePillText, window === option && styles.rangePillTextActive]}>
                  {rangePillLabel(option)}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <Text style={styles.benchmarkDisclosure}>{BENCHMARK_DISCLOSURE}</Text>
        </>
      )}
    </ClearLensCard>
  );
}

function PointerRow({ color, label, value }: { color: string; label: string; value: number }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.pointerRow}>
      <Text style={[styles.pointerSeries, { color }]}>●</Text>
      <Text style={styles.pointerText}>{label}</Text>
      <Text style={styles.pointerValue}>{formatTooltipCurrency(value)}</Text>
    </View>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

export function MoversRow({ fundCards }: { fundCards: FundCardData[] }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const withDailyChange = fundCards.filter((fund) => fund.dailyChangePct !== null && fund.currentValue !== null);
  if (withDailyChange.length < 2) return null;

  const sorted = [...withDailyChange].sort((a, b) => (a.dailyChangePct ?? 0) - (b.dailyChangePct ?? 0));
  const worst = sorted[0];
  const best = sorted[sorted.length - 1];

  return (
    <View style={styles.moversGrid}>
      <MoverCard title="Today's best" fund={best} positive />
      <MoverCard title="Today's worst" fund={worst} positive={false} />
    </View>
  );
}

function MoverCard({
  title,
  fund,
  positive,
}: {
  title: string;
  fund: FundCardData;
  positive: boolean;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const { base } = parseFundName(fund.schemeName);
  const pct = fund.dailyChangePct ?? 0;
  const amount = fund.dailyChangeAmount ?? 0;
  const color = toneColor(toneForValue(amount || pct));

  return (
    <ClearLensCard style={[
      styles.moverCard,
      positive ? styles.moverCardPositive : styles.moverCardNegative,
    ]}>
      <View style={styles.moverCopyBlock}>
        <Text style={[styles.metricLabel, positive ? styles.moverPositiveLabel : styles.moverNegativeLabel]}>{title}</Text>
        <Text style={styles.moverName} numberOfLines={2}>{base}</Text>
      </View>
      <View style={styles.moverStatsRow}>
        <Text
          style={[styles.moverPct, { color }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.82}
        >
          {formatClearLensPercentDelta(pct)}
        </Text>
        <Text
          style={[styles.moverAmount, { color }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.82}
        >
          {formatClearLensCurrencyDelta(amount)}
        </Text>
      </View>
    </ClearLensCard>
  );
}

export function AssetAllocationPreview({
  totalValue,
  equityPct,
  debtPct,
  cashPct,
}: {
  totalValue: number;
  equityPct: number;
  debtPct: number;
  cashPct: number;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const rows = [
    { label: 'Equity', pct: equityPct, color: tokens.semantic.asset.equity },
    { label: 'Debt', pct: debtPct, color: tokens.semantic.asset.debt },
    { label: 'Cash & Others', pct: cashPct, color: tokens.semantic.asset.cash },
  ];

  return (
    <ClearLensCard style={styles.sectionCard}>
      <Text style={styles.sectionTitle}>Asset allocation</Text>
      <View style={styles.allocationBar}>
        {rows.map((row) => (
          row.pct > 0 ? (
            <View
              key={row.label}
              // Floor the flex value at 4 so a sliver-thin segment (e.g. 3%
              // Cash) still renders as a recognisable chip rather than a
              // hairline that disappears in dark mode.
              style={[styles.allocationSegment, { flex: Math.max(row.pct, 4), backgroundColor: row.color }]}
            />
          ) : null
        ))}
      </View>
      <View style={styles.allocationRows}>
        {rows.map((row) => (
          <View key={row.label} style={styles.allocationRow}>
            <View style={styles.allocationLabelWrap}>
              <View style={[styles.allocationDot, { backgroundColor: row.color }]} />
              <Text style={styles.allocationLabel}>{row.label}</Text>
            </View>
            <Text style={styles.allocationValue}>{row.pct.toFixed(1)}%</Text>
            <Text style={styles.allocationMoney}>{formatCurrency((row.pct / 100) * totalValue)}</Text>
          </View>
        ))}
      </View>
    </ClearLensCard>
  );
}

export function EntryRows({
  onInsights,
  onFunds,
  onTools,
}: {
  onInsights: () => void;
  onFunds: () => void;
  onTools: () => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.entryRows}>
      <EntryRow
        icon="analytics-outline"
        title="Portfolio Insights"
        subtitle="See allocation, sectors, and top holdings"
        onPress={onInsights}
      />
      <EntryRow
        icon="list-outline"
        title="Your Funds"
        subtitle="Search, sort, and open every holding"
        onPress={onFunds}
      />
      <EntryRow
        icon="construct-outline"
        title="Tools"
        subtitle="Plan, compare, and explore your funds"
        onPress={onTools}
      />
    </View>
  );
}

function EntryRow({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <TouchableOpacity style={styles.entryRow} onPress={onPress} activeOpacity={0.76}>
      <View style={styles.entryIcon}>
        <Ionicons name={icon} size={19} color={tokens.colors.emerald} />
      </View>
      <View style={styles.entryCopy}>
        <Text style={styles.entryTitle}>{title}</Text>
        <Text style={styles.entrySubtitle}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={tokens.colors.textTertiary} />
    </TouchableOpacity>
  );
}

export function PortfolioEmptyState({ onImport }: { onImport: () => void }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyIcon}>
        <Ionicons name="cloud-upload-outline" size={32} color={tokens.colors.emerald} />
      </View>
      <Text style={styles.emptyTitle}>Import your portfolio</Text>
      <Text style={styles.emptyText}>
        Add your CAS once. FolioLens will show SIP-aware returns, benchmark clarity, and your real progress.
      </Text>
      <TouchableOpacity style={styles.primaryButton} onPress={onImport} activeOpacity={0.82}>
        <Text style={styles.primaryButtonText}>Import CAS</Text>
      </TouchableOpacity>
    </View>
  );
}

export function ClearLensPortfolioScreen() {
  useTrackInsightViewed('home');
  const { layout } = useResponsiveLayout();
  if (layout === 'desktop') return <ClearLensPortfolioScreenDesktop />;
  return <ClearLensPortfolioScreenMobile />;
}

function ClearLensPortfolioScreenMobile() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const router = useRouter();
  const handleImportPress = useImportPortfolioPress();
  const { session } = useSession();
  const userId = session?.user.id;
  const accountMetadata = session?.user.user_metadata as { full_name?: string; name?: string } | undefined;
  const accountLabel = accountMetadata?.full_name ?? accountMetadata?.name ?? session?.user.email ?? null;
  const { defaultBenchmarkSymbol, setDefaultBenchmarkSymbol } = useAppStore();
  const [overflowOpen, setOverflowOpen] = useState(false);

  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch, isRefetching } = usePortfolio(defaultBenchmarkSymbol);
  // The RefreshControl spinner is normally driven by `isRefetching`, but
  // the SQLite sync runs *before* the React Query refetch — during that
  // window `isRefetching` is false and the spinner would snap closed
  // mid-pull. This local flag keeps it up across the whole operation.
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);

  // Pull-to-refresh has to do more than `refetch()`. Portfolio reads
  // transactions from a SQLite read-through cache, and the React Query
  // entry that fronts it has its own staleTime. So a plain refetch may
  // hand back the same stale rows we already had. The right sequence is:
  //   1. Pull fresh transactions / NAVs into SQLite from Supabase
  //      (`syncDeltaForUser`). This is the only step that detects
  //      server-side changes (e.g. a CAS uploaded from web).
  //   2. Invalidate every React Query entry so screens that derive from
  //      transactions (portfolio totals, money trail, timelines)
  //      recompute against the freshly-synced rows.
  //   3. Refetch the portfolio query so the on-screen value updates
  //      now, not on the next mount.
  // Web has no SQLite layer; the sync call is a no-op there.
  const handleRefresh = useCallback(async () => {
    setIsManualRefreshing(true);
    try {
      if (!userId) {
        await refetch();
        return;
      }
      if (Platform.OS !== 'web') {
        try {
          await syncDeltaForUser(userId);
        } catch (err) {
          console.warn('[portfolio] delta sync failed', err);
        }
      }
      await queryClient.invalidateQueries();
      await refetch();
    } finally {
      setIsManualRefreshing(false);
    }
  }, [refetch, queryClient, userId]);
  // `useIsRestoring` is true while the `PersistQueryClientProvider`
  // rehydrates the cache from AsyncStorage. During that window React
  // Query pauses fetching (`fetchStatus: 'paused'`), so `isLoading` is
  // false even though we have no data yet — the chain below was falling
  // through to the empty-state branch and flashing the "Import CAS"
  // button before the real data landed. Gating on this flag closes that
  // 0.5–1s flicker window.
  const isRestoring = useIsRestoring();
  const showFirstLoad = isRestoring || isLoading || data === undefined;
  const fundCards = useMemo(() => data?.fundCards ?? [], [data?.fundCards]);
  const summary = data?.summary ?? null;
  // The chart needs every fund the user has ever transacted in, not just the
  // ones with current holdings. Close-ended NFOs that have matured (and any
  // other fully-redeemed fund) get filtered out of `fundCards` by
  // `usePortfolio`'s netUnits guard, which made their lifetime invested /
  // portfolio values invisible on the chart. `useUserFunds` returns the
  // full roster; `is_active=false` covers CAS-imported "never owned"
  // (zero-balance, zero-txn) rows that should stay excluded.
  const { data: userFunds } = useUserFunds();
  const fundRefs: FundRef[] = useMemo(
    () =>
      (userFunds ?? [])
        .filter((fund) => fund.is_active === true && fund.id != null && fund.scheme_code != null)
        .map((fund) => ({ id: fund.id as string, schemeCode: fund.scheme_code as number })),
    [userFunds],
  );
  const { insights, isLoading: insightsLoading } = usePortfolioInsights(fundCards);
  const { data: moneyTrailData, isLoading: moneyTrailLoading } = useMoneyTrail();

  return (
    <ClearLensScreen>
      <ClearLensHeader
        onPressMenu={() => setOverflowOpen(true)}
        showTagline
        accountLabel={accountLabel}
      />
      <AppOverflowMenu
        visible={overflowOpen}
        onClose={() => setOverflowOpen(false)}
        onImport={handleImportPress}
        onMoneyTrail={() => router.push('/money-trail')}
        onSettings={() => router.push('/(tabs)/settings')}
        onTools={() => router.push('/tools' as never)}
        hasPortfolio={!!summary && fundCards.length > 0}
      />

      {showFirstLoad ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={tokens.colors.emerald} />
        </View>
      ) : isError ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>Failed to load portfolio.</Text>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => refetch()}>
            <Text style={styles.secondaryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : !summary || fundCards.length === 0 ? (
        <PortfolioEmptyState onImport={handleImportPress} />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={isManualRefreshing || isRefetching}
              onRefresh={handleRefresh}
              tintColor={tokens.colors.emerald}
            />
          }
        >
          <PortfolioHero
            totalValue={summary.totalValue}
            totalInvested={summary.totalInvested}
            dailyChangeAmount={summary.dailyChangeAmount}
            dailyChangePct={summary.dailyChangePct}
            xirr={summary.xirr}
            latestNavDate={summary.latestNavDate}
          />

          {summary.navUnavailableCount > 0 && (
            <NavUnavailableNote count={summary.navUnavailableCount} />
          )}

          <BenchmarkComparisonCard
            xirr={summary.xirr}
            marketXirr={summary.marketXirr}
            benchmarkSymbol={defaultBenchmarkSymbol}
            onBenchmarkChange={setDefaultBenchmarkSymbol}
          />

          <InvestmentVsBenchmarkChart
            funds={fundRefs}
            userId={userId}
            benchmarkSymbol={defaultBenchmarkSymbol}
          />

          {moneyTrailData ? (
            <MoneyTrailPreviewCard
              annualFlows={moneyTrailData.annualFlows}
              onPress={() => router.push('/money-trail')}
            />
          ) : moneyTrailLoading ? (
            <ClearLensCard style={styles.sectionCard}>
              <ActivityIndicator size="small" color={tokens.colors.emerald} />
            </ClearLensCard>
          ) : null}

          <MoversRow fundCards={fundCards} />

          {insights && (
            <AssetAllocationPreview
              totalValue={insights.totalValue}
              equityPct={insights.assetMix.equity}
              debtPct={insights.assetMix.debt}
              cashPct={insights.assetMix.cash + insights.assetMix.other}
            />
          )}

          {!insights && insightsLoading && (
            <ClearLensCard style={styles.sectionCard}>
              <ActivityIndicator size="small" color={tokens.colors.emerald} />
            </ClearLensCard>
          )}

          <EntryRows
            onInsights={() => router.push('/portfolio-insights')}
            onFunds={() => router.push('/funds')}
            onTools={() => router.push('/tools' as never)}
          />

          <PortfolioDisclaimer />
        </ScrollView>
      )}
    </ClearLensScreen>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
  scrollContent: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingBottom: ClearLensSpacing.xxl,
    gap: ClearLensSpacing.md,
  },
  heroCard: {
    gap: ClearLensSpacing.sm,
    backgroundColor: cl.heroSurface,
    borderColor: cl.heroSurface,
    padding: ClearLensSpacing.lg,
  },
  heroLabel: {
    ...ClearLensTypography.label,
    color: cl.mint,
  },
  heroValue: {
    ...ClearLensTypography.hero,
    color: cl.textOnDark,
  },
  heroToday: {
    ...ClearLensTypography.bodySmall,
    color: cl.textOnDark,
    fontFamily: ClearLensFonts.semiBold,
  },
  heroTodayValue: {
    fontFamily: ClearLensFonts.bold,
  },
  heroNavStamp: {
    ...ClearLensTypography.caption,
    color: cl.mint,
    marginTop: 4,
    opacity: 0.85,
  },
  heroNavStampCritical: {
    color: CLEAR_LENS_RED,
    opacity: 1,
  },
  navUnavailableNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.xs,
    paddingHorizontal: ClearLensSpacing.sm,
    paddingVertical: ClearLensSpacing.xs,
    backgroundColor: cl.background,
    borderRadius: ClearLensRadii.sm,
    borderWidth: 1,
    borderColor: cl.borderLight,
  },
  navUnavailableNoteText: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    flex: 1,
  },
  heroBottomRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: ClearLensSpacing.sm,
  },
  heroBottomMetric: {
    flex: 1,
    gap: 4,
  },
  heroDivider: {
    width: 1,
    marginHorizontal: ClearLensSpacing.md,
    backgroundColor: tokens.semantic.overlay.darkDivider,
  },
  heroBottomLabel: {
    ...ClearLensTypography.caption,
    color: cl.textOnDarkMuted,
  },
  heroBottomValue: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.bold,
  },
  heroXirrValue: {
    ...ClearLensTypography.h3,
    color: cl.textOnDark,
  },
  metricLabel: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    textTransform: 'uppercase',
  },
  metricValue: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.bold,
    fontWeight: '700',
  },
  sectionCard: {
    gap: ClearLensSpacing.md,
  },
  benchmarkWrap: {
    gap: ClearLensSpacing.sm,
  },
  marketStatusPill: {
    minHeight: 42,
    borderRadius: ClearLensRadii.md,
    paddingHorizontal: ClearLensSpacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    backgroundColor: tokens.semantic.sentiment.positiveSurface,
  },
  marketStatusPillNegative: {
    backgroundColor: tokens.semantic.sentiment.negativeSurface,
  },
  marketStatusText: {
    ...ClearLensTypography.bodySmall,
    flex: 1,
    color: tokens.semantic.sentiment.positiveText,
    fontFamily: ClearLensFonts.semiBold,
  },
  marketStatusTextNegative: {
    color: tokens.semantic.sentiment.negativeText,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.sm,
  },
  sectionTitle: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  sectionMeta: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  compareGrid: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: ClearLensSpacing.sm,
  },
  compareCell: {
    flex: 1,
    gap: 5,
  },
  compareDivider: {
    width: 1,
    backgroundColor: cl.borderLight,
  },
  compareValue: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  pillRow: {
    gap: ClearLensSpacing.sm,
  },
  journeyCard: {
    gap: ClearLensSpacing.md,
    overflow: 'hidden',
  },
  journeyHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.sm,
  },
  journeySubtitle: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    marginTop: 2,
  },
  chartBenchmarkBadge: {
    minHeight: 34,
    paddingHorizontal: ClearLensSpacing.sm,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.surfaceSoft,
    borderWidth: 1,
    borderColor: cl.borderLight,
  },
  chartBenchmarkText: {
    ...ClearLensTypography.caption,
    color: cl.navy,
    fontFamily: ClearLensFonts.semiBold,
  },
  rangePillRow: {
    gap: 6,
    paddingRight: ClearLensSpacing.xs,
  },
  rangePill: {
    minHeight: 36,
    minWidth: 44,
    paddingHorizontal: 12,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.surface,
    // Hairline border so the inactive chip reads as a discrete control in
    // dark mode (where `surfaceSoft` was almost identical to the page bg).
    borderWidth: 1,
    borderColor: cl.border,
  },
  rangePillActive: {
    backgroundColor: cl.heroSurface,
    borderColor: cl.heroSurface,
  },
  rangePillText: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.semiBold,
    color: cl.textTertiary,
  },
  rangePillTextActive: {
    color: cl.textOnDark,
  },
  benchmarkDisclosure: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    paddingHorizontal: ClearLensSpacing.xs,
    paddingTop: ClearLensSpacing.sm,
    lineHeight: 16,
  },
  chartLoading: {
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
  },
  journeyChartFrame: {
    height: JOURNEY_CHART_TOP_PADDING + JOURNEY_CHART_HEIGHT + JOURNEY_X_AXIS_HEIGHT,
    position: 'relative',
    overflow: 'hidden',
  },
  journeySvg: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  yAxisLabel: {
    ...ClearLensTypography.caption,
    position: 'absolute',
    left: 0,
    width: JOURNEY_Y_AXIS_WIDTH - 7,
    textAlign: 'right',
    color: cl.textTertiary,
    fontSize: 10,
  },
  xAxisLabel: {
    ...ClearLensTypography.caption,
    position: 'absolute',
    width: 54,
    textAlign: 'center',
    color: cl.textTertiary,
    fontSize: 10,
  },
  chartTouchLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  pointerLabel: {
    position: 'absolute',
    width: JOURNEY_TOOLTIP_WIDTH,
    minHeight: JOURNEY_TOOLTIP_HEIGHT,
    padding: ClearLensSpacing.sm,
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.surface,
    borderWidth: 1,
    borderColor: cl.border,
    gap: 4,
    ...ClearLensShadow,
    shadowOpacity: 0.09,
    elevation: 4,
  },
  pointerDate: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.semiBold,
    marginBottom: 2,
  },
  pointerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pointerSeries: {
    width: 10,
    fontSize: 11,
    lineHeight: 14,
  },
  pointerText: {
    ...ClearLensTypography.caption,
    flex: 1,
    color: cl.textSecondary,
  },
  pointerValue: {
    ...ClearLensTypography.caption,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  chartAxis: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    fontSize: 10,
  },
  legendWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: ClearLensSpacing.md,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendText: {
    ...ClearLensTypography.caption,
    color: cl.textSecondary,
  },
  moversGrid: {
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
  },
  moverCard: {
    flex: 1,
    minHeight: 132,
    justifyContent: 'space-between',
    gap: ClearLensSpacing.sm,
    borderLeftWidth: 3,
  },
  moverCardPositive: {
    borderLeftColor: cl.emerald,
    backgroundColor: cl.surface,
  },
  moverCardNegative: {
    borderLeftColor: CLEAR_LENS_RED,
    backgroundColor: cl.surface,
  },
  moverPositiveLabel: {
    color: tokens.semantic.sentiment.positiveText,
  },
  moverNegativeLabel: {
    color: tokens.semantic.sentiment.negativeText,
  },
  moverCopyBlock: {
    gap: ClearLensSpacing.xs,
  },
  moverName: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.semiBold,
    color: cl.navy,
    minHeight: 40,
  },
  moverStatsRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.xs,
  },
  moverPct: {
    ...ClearLensTypography.body,
    fontFamily: ClearLensFonts.bold,
    flexShrink: 1,
  },
  moverAmount: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.bold,
    flexShrink: 1,
    textAlign: 'right',
  },
  allocationBar: {
    height: 12,
    borderRadius: ClearLensRadii.full,
    overflow: 'hidden',
    flexDirection: 'row',
    backgroundColor: cl.surfaceSoft,
  },
  allocationSegment: {
    height: '100%',
  },
  allocationRows: {
    gap: ClearLensSpacing.sm,
  },
  allocationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  allocationLabelWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  allocationDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  allocationLabel: {
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
  },
  allocationValue: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.bold,
    color: cl.navy,
    minWidth: 54,
    textAlign: 'right',
  },
  allocationMoney: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
    minWidth: 72,
    textAlign: 'right',
  },
  entryRows: {
    gap: ClearLensSpacing.sm,
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    padding: ClearLensSpacing.md,
    borderRadius: ClearLensRadii.lg,
    backgroundColor: cl.surface,
    borderWidth: 1,
    borderColor: cl.border,
    ...ClearLensShadow,
  },
  entryIcon: {
    width: 40,
    height: 40,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.semantic.sentiment.positiveSurface,
  },
  entryCopy: {
    flex: 1,
    gap: 2,
  },
  entryTitle: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  entrySubtitle: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: ClearLensSpacing.md,
    padding: ClearLensSpacing.xl,
  },
  errorText: {
    ...ClearLensTypography.body,
    color: cl.textSecondary,
  },
  banner: {
    backgroundColor: tokens.semantic.sentiment.positiveSurface,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: cl.mint,
    paddingHorizontal: ClearLensSpacing.md,
    paddingVertical: ClearLensSpacing.sm,
  },
  bannerText: {
    ...ClearLensTypography.bodySmall,
    color: cl.slate,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: ClearLensSpacing.xl,
    gap: ClearLensSpacing.md,
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.semantic.sentiment.positiveSurface,
  },
  emptyTitle: {
    ...ClearLensTypography.h2,
    color: cl.navy,
    textAlign: 'center',
  },
  emptyText: {
    ...ClearLensTypography.body,
    color: cl.textSecondary,
    textAlign: 'center',
  },
  primaryButton: {
    minHeight: 46,
    paddingHorizontal: ClearLensSpacing.xl,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.emerald,
  },
  primaryButtonText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textOnDark,
    fontFamily: ClearLensFonts.bold,
  },
  secondaryButton: {
    minHeight: 42,
    paddingHorizontal: ClearLensSpacing.lg,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.surface,
    borderWidth: 1,
    borderColor: cl.border,
  },
  secondaryButtonText: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
});
}
