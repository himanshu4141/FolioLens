import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { PieChart } from 'react-native-gifted-charts';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensSpacing,
  ClearLensRadii,
  ClearLensTypography,
} from '@/src/constants/clearLensTheme';
import { formatCurrency } from '@/src/utils/formatting';

interface SectorRow {
  sector: string;
  weight: number;
  value: number;
}

interface Props {
  sectors: SectorRow[];
  totalValue: number;
}

// Fixed colour palette for consistent sector-to-colour mapping across renders
const SECTOR_COLORS = [
  '#3b82f6', // Financial — blue
  '#f97316', // Consumer Disc. — orange
  '#22c55e', // Healthcare — green
  '#14b8a6', // Industrials — teal
  '#a855f7', // Technology — purple
  '#ef4444', // Energy & Utilities — red
  '#8b5cf6', // Materials — violet
  '#84cc16', // Consumer Staples — lime
  '#06b6d4', // Telecom — cyan
  '#f59e0b', // Real Estate — amber
  '#ec4899', // Others — pink
  '#6366f1', // Diversified — indigo
];

export function SectorCard({ sectors }: Props) {
  const { compatible: colors } = useClearLensTokens();

  const coloredSectors = sectors.map((s, i) => ({
    ...s,
    color: SECTOR_COLORS[i % SECTOR_COLORS.length],
  }));

  const pieData = coloredSectors.map((s) => ({ value: s.weight, color: s.color }));

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>Sector Break-up</Text>

      {/* Donut + legend grid */}
      <View style={styles.chartRow}>
        <PieChart
          data={pieData}
          donut
          radius={56}
          innerRadius={36}
          strokeWidth={0}
          focusOnPress={false}
        />
        <View style={styles.legendGrid}>
          {coloredSectors.slice(0, 8).map((s) => (
            <View key={s.sector} style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: s.color }]} />
              <Text style={[styles.legendText, { color: colors.textSecondary }]} numberOfLines={1}>
                {s.sector} ({s.weight.toFixed(1)}%)
              </Text>
            </View>
          ))}
        </View>
      </View>

      {/* Ranked table */}
      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      <View style={styles.tableHeader}>
        <Text style={[styles.colNum, { color: colors.textTertiary }]}>#</Text>
        <Text style={[styles.colSector, { color: colors.textTertiary }]}>SECTOR</Text>
        <Text style={[styles.colWeight, { color: colors.textTertiary }]}>WEIGHT</Text>
        <Text style={[styles.colExposure, { color: colors.textTertiary }]}>₹ EXPOSURE</Text>
      </View>

      {coloredSectors.map((s, idx) => (
        <View key={s.sector} style={[styles.tableRow, { borderTopColor: colors.borderLight }]}>
          <Text style={[styles.rowNum, { color: colors.textTertiary }]}>{idx + 1}</Text>
          <View style={styles.sectorBadge}>
            <View style={[styles.badgeDot, { backgroundColor: s.color }]} />
            <Text style={[styles.badgeText, { color: s.color }]} numberOfLines={1}>
              {s.sector}
            </Text>
          </View>
          <Text style={[styles.rowWeight, { color: colors.textPrimary }]}>
            {s.weight.toFixed(1)}%
          </Text>
          <Text style={[styles.rowExposure, { color: colors.textPrimary }]}>
            {formatCurrency(s.value)}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: ClearLensRadii.lg,
    borderWidth: 1,
    padding: ClearLensSpacing.md,
    marginBottom: ClearLensSpacing.md,
  },
  cardTitle: {
    ...ClearLensTypography.h3,
    fontWeight: '700',
    marginBottom: ClearLensSpacing.md,
  },
  chartRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.md,
    marginBottom: ClearLensSpacing.md,
  },
  legendGrid: {
    flex: 1,
    gap: 4,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  legendDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    flexShrink: 0,
  },
  legendText: {
    fontSize: 12,
    fontWeight: '500',
    flex: 1,
  },
  divider: {
    height: 1,
    marginBottom: ClearLensSpacing.xs,
  },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: ClearLensSpacing.xs,
    gap: ClearLensSpacing.xs,
  },
  colNum: {
    ...ClearLensTypography.caption,
    width: 24,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  colSector: {
    ...ClearLensTypography.caption,
    flex: 1,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  colWeight: {
    ...ClearLensTypography.caption,
    width: 64,
    textAlign: 'right',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  colExposure: {
    ...ClearLensTypography.caption,
    width: 84,
    textAlign: 'right',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: ClearLensSpacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: ClearLensSpacing.xs,
  },
  rowNum: {
    ...ClearLensTypography.bodySmall,
    width: 24,
    fontWeight: '600',
  },
  sectorBadge: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  badgeText: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  rowWeight: {
    ...ClearLensTypography.bodySmall,
    fontWeight: '700',
    width: 64,
    textAlign: 'right',
  },
  rowExposure: {
    ...ClearLensTypography.body,
    fontWeight: '700',
    width: 84,
    textAlign: 'right',
  },
});
