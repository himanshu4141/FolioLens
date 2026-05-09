import { useMemo, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
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
import { useAppStore, type GoalReturnPreset } from '@/src/store/appStore';
import { useTrackInsightViewed } from '@/src/hooks/useTrackInsightViewed';
import {
  buildGoalProjectionSeries,
  computeGoalPlan,
  assumptionsToRates,
  yearsFromNow,
  type GoalPlanInput,
  type ProjectionPoint,
} from '@/src/utils/goalPlanner';
import { formatCurrency } from '@/src/utils/formatting';

type TabKey = 'estimate' | 'scenarios';

const TAB_OPTIONS: { value: TabKey; label: string }[] = [
  { value: 'estimate', label: 'Best Estimate' },
  { value: 'scenarios', label: 'Scenarios' },
];

export function ClearLensGoalSummaryScreen() {
  useTrackInsightViewed('goal_summary');
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();
  const { goals, returnAssumptions, deleteGoal } = useAppStore();
  const [tab, setTab] = useState<TabKey>('estimate');

  const goal = goals.find((g) => g.id === id);

  if (!goal) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <View style={styles.center}>
          <Text style={styles.notFoundText}>Goal not found.</Text>
        </View>
      </ClearLensScreen>
    );
  }

  const rates = assumptionsToRates(returnAssumptions);
  const years = yearsFromNow(goal.targetDate);

  const planInput: GoalPlanInput = {
    targetAmount: goal.targetAmount,
    years,
    lumpSum: goal.lumpSum,
    currentMonthly: goal.currentMonthly,
    returnPreset: goal.returnPreset,
  };

  const plan = computeGoalPlan(planInput, rates);
  const series = buildGoalProjectionSeries(planInput, plan.requiredMonthly, rates);

  const chartWidth = windowWidth - ClearLensSpacing.md * 2;

  function confirmDelete() {
    const goalId = goal!.id;
    Alert.alert(
      'Delete goal',
      `Remove "${goal!.name}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            router.back();
            deleteGoal(goalId);
          },
        },
      ],
    );
  }

  const presetLabel = goal.returnPreset.charAt(0).toUpperCase() + goal.returnPreset.slice(1);

  return (
    <ClearLensScreen>
      <ClearLensHeader
        title={goal.name}
        onPressBack={() => router.back()}
      />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Tab toggle */}
        <View style={styles.tabRow}>
          <ClearLensSegmentedControl
            options={TAB_OPTIONS}
            selected={tab}
            onChange={setTab}
          />
        </View>

        {tab === 'estimate' ? (
          <EstimateTab
            goal={{ targetAmount: goal.targetAmount, currentMonthly: goal.currentMonthly }}
            plan={plan}
            series={series}
            years={years}
            presetLabel={presetLabel}
            presetRate={returnAssumptions[goal.returnPreset]}
            chartWidth={chartWidth}
          />
        ) : (
          <ScenariosTab
            planInput={planInput}
            rates={rates}
            returnAssumptions={returnAssumptions}
          />
        )}

        <View style={styles.actionRows}>
          <TouchableOpacity
            style={styles.editRow}
            onPress={() => router.push({ pathname: '/tools/goal-planner/create', params: { editId: goal.id } })}
            activeOpacity={0.75}
          >
            <Text style={styles.editText}>Edit goal</Text>
            <Ionicons name="chevron-forward" size={14} color={tokens.colors.emerald} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.deleteRow} onPress={confirmDelete} activeOpacity={0.75}>
            <Ionicons name="trash-outline" size={14} color={tokens.colors.negative} />
            <Text style={styles.deleteText}>Delete goal</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.disclaimer}>
          Results are estimates only. Assumed return: {returnAssumptions[goal.returnPreset]}% p.a. ({presetLabel}). Past performance is not indicative of future returns.
        </Text>
      </ScrollView>
    </ClearLensScreen>
  );
}

// ---------------------------------------------------------------------------
// Best Estimate tab
// ---------------------------------------------------------------------------

function EstimateTab({
  goal,
  plan,
  series,
  years,
  presetLabel,
  presetRate,
  chartWidth,
}: {
  goal: { targetAmount: number; currentMonthly: number };
  plan: ReturnType<typeof computeGoalPlan>;
  series: ProjectionPoint[];
  years: number;
  presetLabel: string;
  presetRate: number;
  chartWidth: number;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const gapAbs = Math.abs(plan.gap);

  return (
    <>
      {/* Status banner */}
      <View style={[styles.banner, plan.onTrack ? styles.bannerGreen : styles.bannerAmber]}>
        <Ionicons
          name={plan.onTrack ? 'checkmark-circle' : 'alert-circle'}
          size={20}
          color={plan.onTrack ? tokens.colors.positive : tokens.colors.warning}
        />
        <Text style={[styles.bannerText, plan.onTrack ? styles.bannerTextGreen : styles.bannerTextAmber]}>
          {plan.onTrack
            ? `You are on track — investing ₹${formatCurrency(plan.requiredMonthly)}/mo is enough`
            : `Invest ₹${formatCurrency(plan.requiredMonthly)}/mo to reach your goal`}
        </Text>
      </View>

      {/* Key numbers */}
      <View style={styles.card}>
        <Row label="Target corpus" value={formatCurrency(goal.targetAmount)} />
        <RowDivider />
        <Row label="Timeline" value={years > 0 ? `${Math.round(years)} years` : 'Overdue'} />
        <RowDivider />
        <Row label="Return assumed" value={`${presetRate}% p.a. (${presetLabel})`} />
        <RowDivider />
        <Row label="Required monthly" value={formatCurrency(plan.requiredMonthly)} highlight />
        <RowDivider />
        <Row
          label={plan.onTrack ? 'Surplus' : 'Gap'}
          value={formatCurrency(gapAbs)}
          tone={plan.onTrack ? 'positive' : 'negative'}
        />
      </View>

      {/* Projection chart */}
      {series.length > 1 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Projected path</Text>
          <View style={styles.chartLegend}>
            <LegendDot color={tokens.colors.emerald} label="Corpus" />
            <LegendDot color={tokens.colors.navy} label="Invested" dashed />
          </View>
          <GoalProjectionChart
            points={series}
            chartWidth={chartWidth - ClearLensSpacing.md * 2}
          />
        </View>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Scenarios tab
// ---------------------------------------------------------------------------

function ScenariosTab({
  planInput,
  rates,
  returnAssumptions,
}: {
  planInput: GoalPlanInput;
  rates: Record<GoalReturnPreset, number>;
  returnAssumptions: { cautious: number; balanced: number; growth: number };
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const presets: GoalReturnPreset[] = ['cautious', 'balanced', 'growth'];

  return (
    <>
      <Text style={styles.sectionLabel}>How does the required SIP change across return scenarios?</Text>
      <View style={styles.card}>
        {presets.map((preset, idx) => {
          const input: GoalPlanInput = { ...planInput, returnPreset: preset };
          const result = computeGoalPlan(input, rates);
          const label = preset.charAt(0).toUpperCase() + preset.slice(1);
          const rate = returnAssumptions[preset];
          return (
            <View key={preset}>
              {idx > 0 && <RowDivider />}
              <ScenarioRow
                label={label}
                rate={rate}
                requiredMonthly={result.requiredMonthly}
                isSelected={preset === planInput.returnPreset}
              />
            </View>
          );
        })}
      </View>

      {/* Delay scenario */}
      <Text style={styles.sectionLabel}>What if you delay by 2 years?</Text>
      <DelayScenarioCard planInput={planInput} rates={rates} />
    </>
  );
}

function ScenarioRow({
  label,
  rate,
  requiredMonthly,
  isSelected,
}: {
  label: string;
  rate: number;
  requiredMonthly: number;
  isSelected: boolean;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={[styles.scenarioRow, isSelected && styles.scenarioRowSelected]}>
      <View style={styles.scenarioLeft}>
        <Text style={styles.scenarioLabel}>{label}</Text>
        <Text style={styles.scenarioRate}>{rate}% p.a.</Text>
      </View>
      <View style={styles.scenarioRight}>
        <Text style={styles.scenarioSip}>{formatCurrency(requiredMonthly)}<Text style={styles.scenarioMo}>/mo</Text></Text>
        {isSelected && (
          <View style={styles.selectedBadge}>
            <Text style={styles.selectedBadgeText}>Your plan</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function DelayScenarioCard({
  planInput,
  rates,
}: {
  planInput: GoalPlanInput;
  rates: Record<GoalReturnPreset, number>;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const delayedYears = Math.max(0, planInput.years - 2);
  const delayedInput: GoalPlanInput = { ...planInput, years: delayedYears };
  const base = computeGoalPlan(planInput, rates);
  const delayed = computeGoalPlan(delayedInput, rates);
  const extraPerMonth = Math.max(0, delayed.requiredMonthly - base.requiredMonthly);

  return (
    <View style={styles.card}>
      <Row label="Current monthly (base)" value={formatCurrency(base.requiredMonthly)} />
      <RowDivider />
      <Row label="Monthly if delayed 2 years" value={formatCurrency(delayed.requiredMonthly)} />
      <RowDivider />
      <Row label="Extra cost of waiting" value={formatCurrency(extraPerMonth)} tone="negative" />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
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
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[
        styles.rowValue,
        highlight && styles.rowValueHighlight,
        tone === 'positive' && { color: tokens.colors.positive },
        tone === 'negative' && { color: tokens.colors.negative },
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

function LegendDot({
  color,
  label,
  dashed,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.legendItem}>
      <View style={[
        styles.legendLine,
        { backgroundColor: dashed ? 'transparent' : color, borderColor: color, borderStyle: dashed ? 'dashed' : 'solid' },
      ]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Projection chart
// ---------------------------------------------------------------------------

function GoalProjectionChart({
  points,
  chartWidth,
}: {
  points: ProjectionPoint[];
  chartWidth: number;
}) {
  const tokens = useClearLensTokens();
  // `invested` is rendered as a baseline reference line. `c.navy` flips to
  // near-white in dark, which collides with the corpus colour we want to lead
  // with — use the dark-stable hero surface tinted text colour instead.
  const investedStroke = tokens.colors.textTertiary;
  const chartHeight = 180;
  const plotTop = 12;
  const plotBottom = 28;
  const plotLeft = 48;
  const plotRight = 8;
  const plotWidth = Math.max(1, chartWidth - plotLeft - plotRight);
  const plotHeight = Math.max(1, chartHeight - plotTop - plotBottom);

  const allValues = points.flatMap((p) => [p.invested, p.corpus]);
  const yMax = Math.max(1, Math.max(...allValues) * 1.1);

  function xFor(index: number): number {
    return plotLeft + (points.length <= 1 ? 0 : (index / (points.length - 1)) * plotWidth);
  }

  function yFor(value: number): number {
    return plotTop + plotHeight - (Math.max(0, value) / yMax) * plotHeight;
  }

  function pathFor(values: number[]): string {
    return values
      .map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(v).toFixed(1)}`)
      .join(' ');
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
        stroke={investedStroke}
        strokeWidth={1.5}
        strokeDasharray="4 3"
        fill="none"
        opacity={0.5}
      />

      <SvgPath
        d={pathFor(points.map((p) => p.corpus))}
        stroke={tokens.colors.emerald}
        strokeWidth={2}
        fill="none"
      />

      {points.map((p, i) => {
        if (i % labelEvery !== 0 && i !== points.length - 1) return null;
        const yearLabel = Math.round(p.month / 12);
        return (
          <SvgText
            key={`xlabel-${i}`}
            x={xFor(i)}
            y={chartHeight - 6}
            textAnchor="middle"
            fontSize={9}
            fill={tokens.colors.textTertiary}
          >
            {yearLabel === 0 ? 'Now' : `${yearLabel}y`}
          </SvgText>
        );
      })}
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCompact(value: number): string {
  if (value >= 1_00_00_000) return `${(value / 1_00_00_000).toFixed(0)}Cr`;
  if (value >= 1_00_000) return `${(value / 1_00_000).toFixed(0)}L`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return value === 0 ? '0' : Math.round(value).toString();
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
  },
  notFoundText: {
    ...ClearLensTypography.body,
    color: cl.textTertiary,
  },
  tabRow: {
    paddingBottom: ClearLensSpacing.xs,
  },
  sectionLabel: {
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
    marginTop: ClearLensSpacing.xs,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.xs,
    padding: ClearLensSpacing.sm,
    borderRadius: ClearLensRadii.md,
    borderWidth: 1,
  },
  bannerGreen: {
    backgroundColor: cl.positiveBg,
    borderColor: cl.positive,
  },
  bannerAmber: {
    backgroundColor: cl.warningBg,
    borderColor: cl.amber,
  },
  bannerText: {
    ...ClearLensTypography.bodySmall,
    flex: 1,
    lineHeight: 18,
  },
  bannerTextGreen: { color: cl.positive },
  bannerTextAmber: { color: cl.warning },

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
    paddingBottom: ClearLensSpacing.xs,
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

  scenarioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: ClearLensSpacing.md,
    paddingVertical: 14,
  },
  scenarioRowSelected: {
    backgroundColor: cl.surfaceSoft,
  },
  scenarioLeft: { gap: 2 },
  scenarioLabel: {
    ...ClearLensTypography.body,
    color: cl.navy,
  },
  scenarioRate: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  scenarioRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.xs,
  },
  scenarioSip: {
    fontFamily: ClearLensFonts.semiBold,
    fontSize: 15,
    color: cl.navy,
  },
  scenarioMo: {
    fontFamily: ClearLensFonts.regular,
    fontSize: 12,
    color: cl.textTertiary,
  },
  selectedBadge: {
    backgroundColor: cl.emerald,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: ClearLensRadii.sm,
  },
  selectedBadgeText: {
    fontFamily: ClearLensFonts.semiBold,
    fontSize: 10,
    color: cl.textOnDark,
  },

  chartLegend: {
    flexDirection: 'row',
    gap: ClearLensSpacing.md,
    paddingHorizontal: ClearLensSpacing.md,
    paddingBottom: ClearLensSpacing.xs,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.xs,
  },
  legendLine: {
    width: 16,
    height: 2,
    borderWidth: 1,
  },
  legendLabel: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },

  actionRows: {
    gap: ClearLensSpacing.xs,
  },
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: ClearLensSpacing.xs,
    paddingVertical: ClearLensSpacing.sm,
  },
  editText: {
    fontFamily: ClearLensFonts.semiBold,
    fontSize: 14,
    color: cl.emerald,
  },
  deleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: ClearLensSpacing.xs,
    paddingVertical: ClearLensSpacing.sm,
  },
  deleteText: {
    fontFamily: ClearLensFonts.medium,
    fontSize: 14,
    color: cl.negative,
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
