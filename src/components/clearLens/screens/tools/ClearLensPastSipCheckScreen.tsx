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
import { supabase } from '@/src/lib/supabase';
import { BENCHMARK_OPTIONS, useAppStore } from '@/src/store/appStore';
import { fetchPerformanceTimeline } from '@/src/hooks/usePerformanceTimeline';
import {
  buildPastSipChartSeries,
  simulatePastSip,
  type PastSipDuration,
  type PastSipChartPoint,
} from '@/src/utils/pastSipCheck';
import { formatCurrency } from '@/src/utils/formatting';
import { formatXirr } from '@/src/utils/xirr';

const DURATION_OPTIONS: { value: PastSipDuration; label: string }[] = [
  { value: '1Y', label: '1Y' },
  { value: '3Y', label: '3Y' },
  { value: '5Y', label: '5Y' },
  { value: 'All', label: 'All' },
];

interface UserFund {
  id: string;
  name: string;
  category: string | null;
}

async function fetchUserHoldings(userId: string): Promise<UserFund[]> {
  const { data, error } = await supabase
    .from('fund')
    .select('id, scheme_name, scheme_category')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('scheme_name', { ascending: true });
  if (error) throw error;
  return (data ?? [])
    .filter((row) => row.id && row.scheme_name)
    .map((row) => ({
      id: row.id as string,
      name: row.scheme_name as string,
      category: (row.scheme_category as string | null) ?? null,
    }));
}

export function ClearLensPastSipCheckScreen() {
  const router = useRouter();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const { width: windowWidth } = useWindowDimensions();
  const { session } = useSession();
  const userId = session?.user.id;
  const { defaultBenchmarkSymbol } = useAppStore();

  const [selectedFundId, setSelectedFundId] = useState<string | null>(null);
  const [amountStr, setAmountStr] = useState<string>('10000');
  const [duration, setDuration] = useState<PastSipDuration>('3Y');
  const [benchmarkSymbol, setBenchmarkSymbol] = useState<string>(defaultBenchmarkSymbol);
  const [pickerOpen, setPickerOpen] = useState(false);

  const holdings = useQuery({
    queryKey: ['past-sip-check-holdings', userId],
    queryFn: () => (userId ? fetchUserHoldings(userId) : Promise.resolve([] as UserFund[])),
    enabled: !!userId,
    staleTime: 60_000,
  });

  // Auto-pick the first holding once data arrives
  useEffect(() => {
    if (!selectedFundId && (holdings.data?.length ?? 0) > 0) {
      setSelectedFundId(holdings.data![0].id);
    }
  }, [holdings.data, selectedFundId]);

  const selectedFund = holdings.data?.find((f) => f.id === selectedFundId) ?? null;
  const benchmarkLabel =
    BENCHMARK_OPTIONS.find((b) => b.symbol === benchmarkSymbol)?.label ?? benchmarkSymbol;

  const timeline = useQuery({
    queryKey: ['past-sip-check-timeline', selectedFundId, benchmarkSymbol],
    enabled: !!selectedFund,
    queryFn: () =>
      fetchPerformanceTimeline(
        selectedFund ? [{ id: selectedFund.id, name: selectedFund.name }] : [],
        [{ symbol: benchmarkSymbol, name: benchmarkLabel }],
      ),
    staleTime: 5 * 60 * 1000,
  });

  const monthlyAmount = parseRupees(amountStr);

  const fundEntry = timeline.data?.entries.find((e) => e.type === 'fund' && e.id === selectedFundId);
  const benchmarkEntry = timeline.data?.entries.find((e) => e.type === 'index' && e.id === benchmarkSymbol);

  const fundResult = useMemo(() => {
    if (!fundEntry) return null;
    return simulatePastSip({
      navSeries: fundEntry.history,
      monthlyAmount,
      duration,
    });
  }, [fundEntry, monthlyAmount, duration]);

  const benchmarkResult = useMemo(() => {
    if (!benchmarkEntry) return null;
    return simulatePastSip({
      navSeries: benchmarkEntry.history,
      monthlyAmount,
      duration,
    });
  }, [benchmarkEntry, monthlyAmount, duration]);

  const chartPoints = useMemo(
    () => (fundResult ? buildPastSipChartSeries(fundResult, benchmarkResult) : []),
    [fundResult, benchmarkResult],
  );

  const chartWidth = windowWidth - ClearLensSpacing.md * 2;

  // -------------------------------------------------------------------------
  // Empty / loading states
  // -------------------------------------------------------------------------
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

  if (holdings.isLoading) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <View style={styles.center}>
          <Text style={styles.helperText}>Loading your funds…</Text>
        </View>
      </ClearLensScreen>
    );
  }

  if ((holdings.data?.length ?? 0) === 0) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <View style={styles.center}>
          <View style={styles.emptyIcon}>
            <Ionicons name="time-outline" size={36} color={tokens.colors.textTertiary} />
          </View>
          <Text style={styles.emptyTitle}>No funds yet</Text>
          <Text style={styles.emptySubtitle}>
            Past SIP Check uses your existing holdings. Import a CAS or sync to bring funds in,
            then come back here.
          </Text>
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
              See how a monthly SIP into one of your funds would have performed compared to a benchmark.
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
                  {selectedFund ? selectedFund.name : 'Pick a fund'}
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
                options={DURATION_OPTIONS}
                selected={duration}
                onChange={setDuration}
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
          {timeline.isLoading ? (
            <View style={styles.center}>
              <Text style={styles.helperText}>Crunching NAV history…</Text>
            </View>
          ) : timeline.isError ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>
                Couldn&apos;t load NAV history. Pull down to retry.
              </Text>
            </View>
          ) : fundResult && fundResult.hasEnoughData ? (
            <ResultSection
              fundName={selectedFund?.name ?? ''}
              benchmarkLabel={benchmarkLabel}
              fundResult={fundResult}
              benchmarkResult={benchmarkResult}
              chartPoints={chartPoints}
              chartWidth={chartWidth}
            />
          ) : fundResult ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>
                Not enough NAV history for this fund to run a meaningful simulation. Try a shorter
                duration or pick a different fund.
              </Text>
            </View>
          ) : null}

          <Text style={styles.disclaimer}>
            Results are estimates only. Simulated SIPs use the 1st of each month and the next
            available NAV. Past performance is not indicative of future returns.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      <FundPicker
        visible={pickerOpen}
        funds={holdings.data ?? []}
        selectedId={selectedFundId}
        onSelect={(id) => {
          setSelectedFundId(id);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
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
}: {
  fundName: string;
  benchmarkLabel: string;
  fundResult: ReturnType<typeof simulatePastSip>;
  benchmarkResult: ReturnType<typeof simulatePastSip> | null;
  chartPoints: PastSipChartPoint[];
  chartWidth: number;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

  const isAhead =
    benchmarkResult &&
    Number.isFinite(fundResult.xirr) &&
    Number.isFinite(benchmarkResult.xirr) &&
    fundResult.xirr > benchmarkResult.xirr;

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

      <View style={styles.banner}>
        <Text style={styles.bannerLabel}>Worth today</Text>
        <Text style={styles.bannerValue}>{formatCurrency(fundResult.currentValue)}</Text>
        <Text style={styles.bannerSubtitle}>
          on {formatCurrency(fundResult.totalInvested)} invested in {fundName}
        </Text>
      </View>

      <View style={styles.card}>
        <Row label="Total invested" value={formatCurrency(fundResult.totalInvested)} />
        <RowDivider />
        <Row label="Current value" value={formatCurrency(fundResult.currentValue)} highlight />
        <RowDivider />
        <Row
          label="Gain"
          value={`${formatCurrency(fundResult.gain)} (${fundResult.gainPct >= 0 ? '+' : ''}${fundResult.gainPct.toFixed(1)}%)`}
          tone={fundResult.gain >= 0 ? 'positive' : 'negative'}
        />
        <RowDivider />
        <Row
          label="XIRR (annualised)"
          value={Number.isFinite(fundResult.xirr) ? formatXirr(fundResult.xirr) : '—'}
          tone={Number.isFinite(fundResult.xirr) && fundResult.xirr >= 0 ? 'positive' : 'negative'}
        />
        <RowDivider />
        <Row label="Installments" value={String(fundResult.installments.length)} />
      </View>

      {benchmarkResult ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>vs {benchmarkLabel}</Text>
          <Row
            label="Benchmark XIRR"
            value={Number.isFinite(benchmarkResult.xirr) ? formatXirr(benchmarkResult.xirr) : '—'}
          />
          <RowDivider />
          <Row
            label="Benchmark current value"
            value={formatCurrency(benchmarkResult.currentValue)}
          />
          <RowDivider />
          {xirrDeltaPp != null ? (
            <Row
              label={isAhead ? 'Ahead of benchmark' : 'Behind benchmark'}
              value={`${xirrDeltaPp.toFixed(1)}% pp`}
              tone={isAhead ? 'positive' : 'negative'}
            />
          ) : (
            <Row label="Benchmark comparison" value="—" />
          )}
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
// Fund picker
// ---------------------------------------------------------------------------

function FundPicker({
  visible,
  funds,
  selectedId,
  onSelect,
  onClose,
}: {
  visible: boolean;
  funds: UserFund[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Pick a fund</Text>
          <ScrollView style={styles.sheetList}>
            {funds.map((fund, idx) => (
              <TouchableOpacity
                key={fund.id}
                style={[styles.sheetOption, idx > 0 && styles.sheetDivider]}
                onPress={() => onSelect(fund.id)}
                activeOpacity={0.76}
              >
                <View style={styles.sheetOptionLeft}>
                  <Text style={styles.sheetRowText} numberOfLines={2}>{fund.name}</Text>
                  {fund.category ? <Text style={styles.sheetRowSub}>{fund.category}</Text> : null}
                </View>
                <View style={[styles.radioOuter, fund.id === selectedId && styles.radioOuterActive]}>
                  {fund.id === selectedId && <View style={styles.radioInner} />}
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
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

function Row({
  label,
  value,
  highlight,
  tone,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  tone?: 'positive' | 'negative';
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const cl = tokens.colors;
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[
        styles.rowValue,
        highlight && styles.rowValueHighlight,
        tone === 'positive' && { color: cl.positive },
        tone === 'negative' && { color: cl.negative },
      ]}>
        {value}
      </Text>
    </View>
  );
}

function RowDivider() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return <View style={styles.rowDivider} />;
}

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

    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: 12,
    },
    rowLabel: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      flex: 1,
    },
    rowValue: {
      fontFamily: ClearLensFonts.semiBold,
      fontSize: 14,
      color: cl.navy,
      textAlign: 'right',
    },
    rowValueHighlight: {
      fontSize: 16,
      color: cl.emerald,
    },
    rowDivider: {
      height: 1,
      backgroundColor: cl.borderLight,
      marginHorizontal: ClearLensSpacing.md,
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
  });
}
