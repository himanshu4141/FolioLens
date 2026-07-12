import { useMemo } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useConfirmDialog } from '@/src/hooks/useDialog';
import Svg, { G, Line as SvgLine, Path as SvgPath, Text as SvgText } from 'react-native-svg';
import { ClearLensCard, ClearLensHeader, ClearLensScreen } from '@/src/components/clearLens/ClearLensPrimitives';
import { PortfolioDisclaimer } from '@/src/components/clearLens/PortfolioDisclaimer';
import {
  RevealSection,
  StatusChip,
  ToolResultHero,
  ToolTitleBlock,
} from '@/src/components/clearLens/tools/kit';
import {
  ClearLensFonts,
  ClearLensRadii,
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

const RETURN_PRESETS: GoalReturnPreset[] = ['cautious', 'balanced', 'growth'];

export function ClearLensGoalSummaryScreen() {
  useTrackInsightViewed('goal_summary');
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();
  const { goals, returnAssumptions, deleteGoal } = useAppStore(
    useShallow((state) => ({
      goals: state.goals,
      returnAssumptions: state.returnAssumptions,
      deleteGoal: state.deleteGoal,
    })),
  );
  const showConfirm = useConfirmDialog();

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

  const chartWidth = Math.min(windowWidth, 960) - ClearLensSpacing.md * 2;

  function confirmDelete() {
    const goalId = goal!.id;
    const goalName = goal!.name;
    showConfirm({
      title: 'Delete goal',
      body: `Remove "${goalName}"? This cannot be undone.`,
      okText: 'Delete',
      cancelText: 'Cancel',
      destructive: true,
      onConfirm: () => {
        router.back();
        deleteGoal(goalId);
      },
    });
  }

  const presetLabel = goal.returnPreset.charAt(0).toUpperCase() + goal.returnPreset.slice(1);
  const presetRate = returnAssumptions[goal.returnPreset];
  const targetYear = new Date(goal.targetDate).getFullYear();
  const roundedYears = Math.round(years);

  const heroSubtitle = plan.onTrack
    ? (goal.currentMonthly > 0
        ? `Your ₹${formatCurrency(goal.currentMonthly)}/mo covers this`
        : 'On track to reach this goal')
    : `₹${formatCurrency(Math.abs(plan.gap))}/mo gap vs your current ₹${formatCurrency(goal.currentMonthly)}/mo`;

  return (
    <ClearLensScreen>
      <ClearLensHeader onPressBack={() => router.back()} />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <ToolTitleBlock
          eyebrow="Goal Planner"
          title={goal.name}
          subtitle={years > 0 ? `${roundedYears}-year goal · target by ${targetYear}` : 'Goal overdue'}
        />

        <ToolResultHero
          label="Required monthly SIP"
          value={`₹${formatCurrency(plan.requiredMonthly)}/mo`}
          subtitle={heroSubtitle}
          chip={
            <StatusChip tone={plan.onTrack ? 'mint' : 'amber'} onDark>
              {plan.onTrack ? 'On track' : 'Gap'}
            </StatusChip>
          }
        />

        {/* Key numbers */}
        <ClearLensCard style={styles.cardNoPad}>
          <Row label="Target corpus" value={formatCurrency(goal.targetAmount)} />
          <RowDivider />
          <Row label="Timeline" value={years > 0 ? `${Math.round(years)} years` : 'Overdue'} />
          <RowDivider />
          <Row label="Required monthly" value={formatCurrency(plan.requiredMonthly)} highlight />
          <RowDivider />
          <Row
            label={plan.onTrack ? 'Surplus' : 'Gap'}
            value={formatCurrency(Math.abs(plan.gap))}
            tone={plan.onTrack ? 'positive' : 'negative'}
          />
          <RowDivider />
          <View style={styles.revealWrap}>
            <RevealSection label="See the assumptions">
              <Row label="Return assumed" value={`${presetRate}% p.a. (${presetLabel})`} />
            </RevealSection>
          </View>
        </ClearLensCard>

        {/* Projection chart */}
        {series.length > 1 && (
          <ClearLensCard style={styles.cardNoPad}>
            <Text style={styles.cardTitle}>Projected path</Text>
            <View style={styles.chartLegend}>
              <LegendDot color={tokens.colors.emerald} label="Corpus" />
              <LegendDot color={tokens.colors.textTertiary} label="Invested" dashed />
            </View>
            <GoalProjectionChart
              points={series}
              chartWidth={chartWidth - ClearLensSpacing.md * 2}
            />
          </ClearLensCard>
        )}

        {/* Other scenarios */}
        <ClearLensCard style={styles.cardNoPad}>
          <Text style={styles.cardTitle}>Other scenarios</Text>
          <Text style={styles.sectionLabel}>Required SIP across return scenarios</Text>
          {RETURN_PRESETS.map((preset, idx) => {
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
          <RowDivider />
          <Text style={[styles.sectionLabel, styles.sectionLabelSpaced]}>What if you delay by 2 years?</Text>
          <DelayRows planInput={planInput} rates={rates} />
        </ClearLensCard>

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

        <PortfolioDisclaimer />
      </ScrollView>
    </ClearLensScreen>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

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

function DelayRows({
  planInput,
  rates,
}: {
  planInput: GoalPlanInput;
  rates: Record<GoalReturnPreset, number>;
}) {
  const delayedYears = Math.max(0, planInput.years - 2);
  const delayedInput: GoalPlanInput = { ...planInput, years: delayedYears };
  const base = computeGoalPlan(planInput, rates);
  const delayed = computeGoalPlan(delayedInput, rates);
  const extraPerMonth = Math.max(0, delayed.requiredMonthly - base.requiredMonthly);

  return (
    <View>
      <Row label="Current monthly (base)" value={formatCurrency(base.requiredMonthly)} />
      <RowDivider />
      <Row label="Monthly if delayed 2 years" value={formatCurrency(delayed.requiredMonthly)} />
      <RowDivider />
      <Row label="Extra cost of waiting" value={formatCurrency(extraPerMonth)} tone="negative" />
    </View>
  );
}

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
  cardNoPad: {
    padding: 0,
    overflow: 'hidden',
  },
  cardTitle: {
    ...ClearLensTypography.h3,
    color: cl.navy,
    paddingHorizontal: ClearLensSpacing.md,
    paddingTop: ClearLensSpacing.md,
    paddingBottom: ClearLensSpacing.xs,
  },
  sectionLabel: {
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
    paddingHorizontal: ClearLensSpacing.md,
    paddingBottom: ClearLensSpacing.xs,
  },
  sectionLabelSpaced: {
    paddingTop: ClearLensSpacing.sm,
  },
  revealWrap: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingVertical: ClearLensSpacing.xs,
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
