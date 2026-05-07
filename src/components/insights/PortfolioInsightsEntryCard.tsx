import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensSpacing,
  ClearLensRadii,
  ClearLensTypography,
} from '@/src/constants/clearLensTheme';
import type { PortfolioInsights } from '@/src/types/app';

interface Props {
  insights: PortfolioInsights | null;
  isLoading: boolean;
  isStale: boolean;
  isSyncing: boolean;
  onSyncPress: () => void;
}

const ASSET_COLORS = {
  equity: '#ef4444',
  debt: '#3b82f6',
  cash: '#f97316',
  other: '#a78bfa',
};

export function PortfolioInsightsEntryCard({
  insights,
  isLoading,
  isStale,
  isSyncing,
  onSyncPress,
}: Props) {
  const { compatible: colors } = useClearLensTokens();
  const router = useRouter();

  const handlePress = () => {
    router.push('/portfolio-insights');
  };

  const assetSummary =
    insights == null
      ? []
      : [
          { label: 'Equity', value: insights.assetMix.equity, color: ASSET_COLORS.equity },
          { label: 'Debt', value: insights.assetMix.debt, color: ASSET_COLORS.debt },
          { label: 'Cash', value: insights.assetMix.cash, color: ASSET_COLORS.cash },
          { label: 'Other', value: insights.assetMix.other, color: ASSET_COLORS.other },
        ]
          .filter((item) => item.value > 0.5)
          .sort((a, b) => b.value - a.value)
          .slice(0, 3);

  return (
    <View style={[styles.wrapper, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {/* Header row */}
      <TouchableOpacity style={styles.header} onPress={handlePress} activeOpacity={0.7}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>Portfolio Insights</Text>
        <View style={styles.headerRight}>
          {(isStale || isSyncing) && (
            <TouchableOpacity
              onPress={onSyncPress}
              disabled={isSyncing}
              style={styles.syncBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              {isSyncing
                ? <ActivityIndicator size="small" color={colors.primary} />
                : <Ionicons name="refresh-outline" size={16} color={colors.textTertiary} />
              }
            </TouchableOpacity>
          )}
          <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
        </View>
      </TouchableOpacity>

      <TouchableOpacity onPress={handlePress} activeOpacity={0.85}>
        {isLoading ? (
          <View style={styles.skeleton}>
            <View style={[styles.skeletonBar, { backgroundColor: colors.borderLight }]} />
            <View style={[styles.skeletonLine, { backgroundColor: colors.borderLight }]} />
          </View>
        ) : insights ? (
          <>
            {/* Stacked bar */}
            <View style={styles.stackedBar}>
              {insights.assetMix.equity > 0.5 && (
                <View style={[styles.barSeg, { flex: insights.assetMix.equity, backgroundColor: ASSET_COLORS.equity }]} />
              )}
              {insights.assetMix.debt > 0.5 && (
                <View style={[styles.barSeg, { flex: insights.assetMix.debt, backgroundColor: ASSET_COLORS.debt }]} />
              )}
              {insights.assetMix.cash > 0.5 && (
                <View style={[styles.barSeg, { flex: insights.assetMix.cash, backgroundColor: ASSET_COLORS.cash }]} />
              )}
              {insights.assetMix.other > 0.5 && (
                <View style={[styles.barSeg, { flex: insights.assetMix.other, backgroundColor: ASSET_COLORS.other }]} />
              )}
            </View>

            {/* Key stats grid */}
            <View style={styles.statsGrid}>
              {assetSummary.map((item) => (
                <StatBox
                  key={item.label}
                  label={item.label}
                  value={`${item.value.toFixed(0)}%`}
                  accentColor={item.color}
                  colors={colors}
                />
              ))}
            </View>

            {/* Data quality indicator */}
            {insights.dataSource === 'amfi' ? (
              <Text style={[styles.sourceBadge, { color: colors.textTertiary }]}>
                AMFI disclosure · {formatDate(insights.dataAsOf)}
              </Text>
            ) : (
              <View style={[styles.estimateChip, { backgroundColor: colors.primaryLight }]}>
                <Ionicons name="information-circle-outline" size={12} color={colors.primary} />
                <Text style={[styles.estimateChipText, { color: colors.primary }]}>Estimated · Tap for details</Text>
              </View>
            )}
          </>
        ) : (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
              Tap to load portfolio composition
            </Text>
          </View>
        )}
      </TouchableOpacity>
    </View>
  );
}

function StatBox({
  label,
  value,
  accentColor,
  colors,
}: {
  label: string;
  value: string;
  accentColor: string;
  colors: ReturnType<typeof useClearLensTokens>['compatible'];
}) {
  return (
    <View style={[styles.statBox, { backgroundColor: colors.surfaceAlt, borderColor: colors.borderLight }]}>
      <View style={[styles.statAccent, { backgroundColor: accentColor }]} />
      <Text style={[styles.statValue, { color: colors.textPrimary }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.textTertiary }]}>{label}</Text>
    </View>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}

const styles = StyleSheet.create({
  wrapper: {
    borderRadius: ClearLensRadii.lg,
    borderWidth: 1,
    padding: ClearLensSpacing.md,
    marginHorizontal: ClearLensSpacing.md,
    marginTop: ClearLensSpacing.md,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: ClearLensSpacing.md,
  },
  title: {
    ...ClearLensTypography.h3,
    fontWeight: '700',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.xs,
  },
  syncBtn: {
    padding: 2,
  },
  stackedBar: {
    flexDirection: 'row',
    height: 10,
    borderRadius: ClearLensRadii.full,
    overflow: 'hidden',
    marginBottom: ClearLensSpacing.md,
  },
  barSeg: {
    height: '100%',
  },
  statsGrid: {
    flexDirection: 'row',
    gap: ClearLensSpacing.xs,
    marginBottom: ClearLensSpacing.md,
  },
  statBox: {
    flex: 1,
    borderRadius: ClearLensRadii.sm,
    borderWidth: 1,
    paddingVertical: ClearLensSpacing.sm,
    paddingHorizontal: ClearLensSpacing.xs,
    alignItems: 'center',
    gap: 3,
  },
  statAccent: {
    width: 16,
    height: 3,
    borderRadius: 2,
    marginBottom: 2,
  },
  statValue: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  statLabel: {
    ...ClearLensTypography.bodySmall,
    fontWeight: '600',
  },
  sourceBadge: {
    ...ClearLensTypography.bodySmall,
    fontWeight: '600',
  },
  estimateChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    alignSelf: 'flex-start',
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 6,
  },
  estimateChipText: {
    ...ClearLensTypography.bodySmall,
    fontWeight: '600',
  },
  skeleton: {
    gap: ClearLensSpacing.sm,
  },
  skeletonBar: {
    height: 10,
    borderRadius: ClearLensRadii.full,
  },
  skeletonLine: {
    height: 14,
    borderRadius: ClearLensRadii.sm,
    width: '60%',
  },
  emptyState: {
    paddingVertical: ClearLensSpacing.sm,
  },
  emptyText: {
    ...ClearLensTypography.bodySmall,
  },
});
