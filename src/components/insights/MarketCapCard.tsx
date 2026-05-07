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
import type { MarketCapMix } from '@/src/types/app';

interface Props {
  totalValue: number;
  equityPct: number;
  marketCapMix: MarketCapMix;
}

const CAP_COLORS = {
  large: '#3b82f6',
  mid: '#14b8a6',
  small: '#22c55e',
  notClassified: '#cbd5e1',
};

export function MarketCapCard({ totalValue, equityPct, marketCapMix }: Props) {
  const { compatible: colors } = useClearLensTokens();
  const equityValue = (equityPct / 100) * totalValue;

  const rows = [
    { label: 'Large Cap', color: CAP_COLORS.large, pct: marketCapMix.large },
    { label: 'Mid Cap', color: CAP_COLORS.mid, pct: marketCapMix.mid },
    { label: 'Small Cap', color: CAP_COLORS.small, pct: marketCapMix.small },
  ];
  if (marketCapMix.notClassified > 0.5) {
    rows.push({ label: 'Not Classified', color: CAP_COLORS.notClassified, pct: marketCapMix.notClassified });
  }

  const pieData = rows
    .filter((r) => r.pct > 0)
    .map((r) => ({ value: r.pct, color: r.color }));

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>Market Cap Mix</Text>

      <View style={styles.chartRow}>
        {/* Donut */}
        <PieChart
          data={pieData}
          donut
          radius={52}
          innerRadius={34}
          strokeWidth={0}
          focusOnPress={false}
        />

        {/* Legend */}
        <View style={styles.legend}>
          {rows.map((r) => (
            <View key={r.label} style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: r.color }]} />
              <Text style={[styles.legendLabel, { color: colors.textSecondary }]}>
                {r.label}
              </Text>
              <Text style={[styles.legendPct, { color: colors.textPrimary }]}>
                {r.pct.toFixed(1)}%
              </Text>
            </View>
          ))}
        </View>
      </View>

      {/* Table */}
      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      <View style={styles.tableHeader}>
        <Text style={[styles.colHeader, { color: colors.textTertiary }]}>Capitalisation</Text>
        <Text style={[styles.colHeaderValue, { color: colors.textTertiary }]}>Value</Text>
        <Text style={[styles.colHeaderPct, { color: colors.textTertiary }]}>% of equity</Text>
      </View>

      {rows.map((r) => (
        <View key={r.label} style={[styles.tableRow, { borderTopColor: colors.borderLight }]}>
          <Text style={[styles.rowLabel, { color: colors.textPrimary, flex: 1 }]}>{r.label}</Text>
          <Text style={[styles.rowValue, { color: colors.textPrimary }]}>
            {formatCurrency((r.pct / 100) * equityValue)}
          </Text>
          <Text style={[styles.rowPct, { color: colors.textPrimary }]}>
            {r.pct.toFixed(1)}%
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
    gap: ClearLensSpacing.lg,
    marginBottom: ClearLensSpacing.md,
  },
  legend: {
    flex: 1,
    gap: ClearLensSpacing.xs,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.xs,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    ...ClearLensTypography.bodySmall,
    flex: 1,
    fontWeight: '600',
  },
  legendPct: {
    ...ClearLensTypography.bodySmall,
    fontWeight: '700',
  },
  divider: {
    height: 1,
    marginBottom: ClearLensSpacing.sm,
  },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: ClearLensSpacing.xs,
    gap: ClearLensSpacing.sm,
  },
  colHeader: {
    ...ClearLensTypography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
    flex: 1,
  },
  colHeaderValue: {
    ...ClearLensTypography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
    width: 92,
    textAlign: 'right',
  },
  colHeaderPct: {
    ...ClearLensTypography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
    width: 78,
    textAlign: 'right',
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: ClearLensSpacing.sm + 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: ClearLensSpacing.sm,
  },
  rowLabel: {
    ...ClearLensTypography.body,
    fontWeight: '600',
  },
  rowValue: {
    ...ClearLensTypography.body,
    fontWeight: '700',
    width: 92,
    textAlign: 'right',
  },
  rowPct: {
    ...ClearLensTypography.body,
    fontWeight: '700',
    width: 78,
    textAlign: 'right',
  },
});
