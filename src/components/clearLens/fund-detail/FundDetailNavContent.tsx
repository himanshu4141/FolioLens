import { useCallback, useMemo, useState } from 'react';
import {
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { LineChart } from 'react-native-gifted-charts/dist/LineChart';
import type { FundDetailData, TimeWindow } from '@/src/hooks/useFundDetail';
import { filterToWindow } from '@/src/hooks/useFundDetail';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensCompatibleTokens,
} from '@/src/constants/clearLensTheme';
import {
  readBenchmarkName,
  readFundManager,
  readReturnPct,
  readRiskLabel,
} from '@/src/utils/mfdataGuards';
import {
  FUND_DETAIL_CHART_MAX,
  TimeWindowSelector,
  formatChartDate,
  formatNavDate,
  makeFundDetailTabStyles,
} from './fundDetailTabShared';

function NavHistoryTab({ navHistory }: { navHistory: { date: string; value: number }[] }) {
  const { compatible: colors } = useClearLensTokens();
  const s = useMemo(() => makeFundDetailTabStyles(colors), [colors]);
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


interface FundDetailNavContentProps {
  navHistory: { date: string; value: number }[];
  data: FundDetailData;
}

export default function FundDetailNavContent({
  navHistory,
  data,
}: FundDetailNavContentProps) {
  return (
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
  );
}
