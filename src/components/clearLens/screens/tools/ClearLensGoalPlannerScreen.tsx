import { useMemo, useCallback } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ClearLensHeader, ClearLensScreen } from '@/src/components/clearLens/ClearLensPrimitives';
import { ToolsPreviewBanner } from '@/src/components/clearLens/ToolsPreviewBanner';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { useAppStore, type SavedGoal } from '@/src/store/appStore';
import { computeGoalPlan, assumptionsToRates, yearsFromNow } from '@/src/utils/goalPlanner';
import { formatCurrency } from '@/src/utils/formatting';

export function ClearLensGoalPlannerScreen() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const router = useRouter();
  const { goals, returnAssumptions } = useAppStore();

  const rates = assumptionsToRates(returnAssumptions);

  const handleAdd = useCallback(() => {
    router.push('/tools/goal-planner/create');
  }, [router]);

  if (goals.length === 0) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <View style={styles.emptyOuter}>
          <ToolsPreviewBanner message="Add a goal to see the required monthly SIP. Sign up to save it to your account." />
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIcon}>
              <Ionicons name="flag-outline" size={36} color={tokens.colors.textTertiary} />
            </View>
            <Text style={styles.emptyTitle}>No goals yet</Text>
            <Text style={styles.emptySubtitle}>
              Add a financial goal — retirement, home, education — and see exactly how much you need to invest each month.
            </Text>
            <TouchableOpacity style={styles.addButton} onPress={handleAdd} activeOpacity={0.8}>
              <Ionicons name="add" size={18} color={tokens.colors.textOnDark} />
              <Text style={styles.addButtonText}>Add your first goal</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ClearLensScreen>
    );
  }

  return (
    <ClearLensScreen>
      <ClearLensHeader onPressBack={() => router.back()} />
      <FlatList
        data={goals}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={styles.previewBannerWrap}>
            <ToolsPreviewBanner message="Add goals to see the required monthly SIP. Sign up to save them to your account." />
          </View>
        }
        renderItem={({ item }) => (
          <GoalCard goal={item} rates={rates} />
        )}
        ListFooterComponent={
          <TouchableOpacity style={styles.addRowButton} onPress={handleAdd} activeOpacity={0.8}>
            <Ionicons name="add-circle-outline" size={18} color={tokens.colors.emerald} />
            <Text style={styles.addRowText}>Add another goal</Text>
          </TouchableOpacity>
        }
      />
    </ClearLensScreen>
  );
}

function GoalCard({
  goal,
  rates,
}: {
  goal: SavedGoal;
  rates: Record<string, number>;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const router = useRouter();
  const years = yearsFromNow(goal.targetDate);
  const plan = computeGoalPlan(
    {
      targetAmount: goal.targetAmount,
      years,
      lumpSum: goal.lumpSum,
      currentMonthly: goal.currentMonthly,
      returnPreset: goal.returnPreset,
    },
    rates,
  );

  const presetLabel = goal.returnPreset.charAt(0).toUpperCase() + goal.returnPreset.slice(1);

  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.75}
      onPress={() => router.push(`/tools/goal-planner/${goal.id}`)}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.goalName} numberOfLines={1}>{goal.name}</Text>
          <Ionicons name="chevron-forward" size={16} color={tokens.colors.textTertiary} />
        </View>
        <View style={styles.tagRow}>
          <View style={[styles.tag, plan.onTrack ? styles.tagGreen : styles.tagAmber]}>
            <Text style={[styles.tagText, plan.onTrack ? styles.tagTextGreen : styles.tagTextAmber]}>
              {plan.onTrack ? 'On track' : 'Needs attention'}
            </Text>
          </View>
          <Text style={styles.metaText}>{presetLabel} · {years > 0 ? `${Math.round(years)}y` : 'Overdue'}</Text>
        </View>
      </View>

      <View style={styles.cardMetrics}>
        <Metric label="Target" value={formatCurrency(goal.targetAmount)} />
        <View style={styles.divider} />
        <Metric label="Monthly needed" value={formatCurrency(plan.requiredMonthly)} />
        <View style={styles.divider} />
        <Metric
          label={plan.onTrack ? 'Surplus' : 'Gap'}
          value={formatCurrency(Math.abs(plan.gap))}
          tone={plan.onTrack ? 'positive' : 'negative'}
        />
      </View>
    </TouchableOpacity>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'positive' | 'negative' }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[
        styles.metricValue,
        tone === 'positive' && { color: tokens.colors.positive },
        tone === 'negative' && { color: tokens.colors.negative },
      ]}>
        {value}
      </Text>
    </View>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
  emptyOuter: {
    flex: 1,
    paddingHorizontal: ClearLensSpacing.md,
    paddingTop: ClearLensSpacing.sm,
    gap: ClearLensSpacing.sm,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: ClearLensSpacing.xl,
    gap: ClearLensSpacing.sm,
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
    marginBottom: ClearLensSpacing.md,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: cl.emerald,
    paddingHorizontal: ClearLensSpacing.lg,
    paddingVertical: ClearLensSpacing.sm + 2,
    borderRadius: ClearLensRadii.md,
    gap: ClearLensSpacing.xs,
  },
  addButtonText: {
    fontFamily: ClearLensFonts.semiBold,
    fontSize: 15,
    color: cl.textOnDark,
  },

  listContent: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingTop: ClearLensSpacing.xs,
    paddingBottom: ClearLensSpacing.xxl,
    gap: ClearLensSpacing.sm,
  },
  previewBannerWrap: {
    paddingBottom: ClearLensSpacing.sm,
  },
  card: {
    backgroundColor: cl.surface,
    borderRadius: ClearLensRadii.lg,
    borderWidth: 1,
    borderColor: cl.border,
    ...ClearLensShadow,
    overflow: 'hidden',
  },
  cardHeader: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingTop: ClearLensSpacing.md,
    paddingBottom: ClearLensSpacing.sm,
    gap: 6,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  goalName: {
    ...ClearLensTypography.h3,
    color: cl.navy,
    flex: 1,
  },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  tag: {
    paddingHorizontal: ClearLensSpacing.xs,
    paddingVertical: 2,
    borderRadius: ClearLensRadii.sm,
  },
  tagGreen: { backgroundColor: cl.positiveBg },
  tagAmber: { backgroundColor: cl.warningBg },
  tagText: {
    fontFamily: ClearLensFonts.semiBold,
    fontSize: 11,
  },
  tagTextGreen: { color: cl.positive },
  tagTextAmber: { color: cl.warning },
  metaText: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  cardMetrics: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: cl.borderLight,
  },
  metric: {
    flex: 1,
    paddingVertical: ClearLensSpacing.sm,
    paddingHorizontal: ClearLensSpacing.sm,
    gap: 2,
  },
  metricLabel: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  metricValue: {
    fontFamily: ClearLensFonts.semiBold,
    fontSize: 13,
    color: cl.navy,
  },
  divider: {
    width: 1,
    backgroundColor: cl.borderLight,
  },
  addRowButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: ClearLensSpacing.xs,
    paddingVertical: ClearLensSpacing.md,
  },
  addRowText: {
    fontFamily: ClearLensFonts.semiBold,
    fontSize: 14,
    color: cl.emerald,
  },
});
}
