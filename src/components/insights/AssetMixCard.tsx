import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
} from '@/src/constants/clearLensTheme';
import { formatCurrency } from '@/src/utils/formatting';
import type { AssetMix, CompositionSource } from '@/src/types/app';

interface AssetRow {
  label: string;
  color: string;
  pct: number;
  value: number;
}

interface Props {
  totalValue: number;
  assetMix: AssetMix;
  source: CompositionSource;
  dataAsOf: string;
}

const ASSET_COLORS = {
  equity: '#ef4444',
  debt: '#3b82f6',
  cash: '#f97316',
  other: '#a78bfa',
};

export function AssetMixCard({ totalValue, assetMix, source, dataAsOf }: Props) {
  const { compatible: colors } = useClearLensTokens();
  const rows: AssetRow[] = [
    { label: 'Equity', color: ASSET_COLORS.equity, pct: assetMix.equity, value: (assetMix.equity / 100) * totalValue },
    { label: 'Debt', color: ASSET_COLORS.debt, pct: assetMix.debt, value: (assetMix.debt / 100) * totalValue },
    { label: 'Cash', color: ASSET_COLORS.cash, pct: assetMix.cash, value: (assetMix.cash / 100) * totalValue },
  ];
  if (assetMix.other > 0.1) {
    rows.push({ label: 'Others', color: ASSET_COLORS.other, pct: assetMix.other, value: (assetMix.other / 100) * totalValue });
  }

  const sourceLabel = source === 'amfi'
    ? `AMFI disclosure · ${formatDate(dataAsOf)}`
    : 'Estimated · Based on fund category';

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {/* Total value row */}
      <View style={styles.totalRow}>
        <Text style={[styles.totalLabel, { color: colors.textSecondary }]}>Total Assets Value</Text>
        <Text style={[styles.totalValue, { color: colors.textPrimary }]}>{formatCurrency(totalValue)}</Text>
      </View>

      {/* Stacked bar */}
      <View style={styles.stackedBar}>
        {rows.map((r) => (
          r.pct > 0.5 ? (
            <View
              key={r.label}
              style={[styles.barSegment, { backgroundColor: r.color, flex: r.pct }]}
            />
          ) : null
        ))}
      </View>

      {/* Divider */}
      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      {/* Column headers */}
      <View style={styles.tableHeader}>
        <Text style={[styles.colHeader, { color: colors.textTertiary }]}>Asset Type</Text>
        <Text style={[styles.colHeaderRight, { color: colors.textTertiary }]}>Amount (%)</Text>
      </View>

      {/* Rows */}
      {rows.map((r) => (
        <View key={r.label} style={styles.tableRow}>
          <View style={styles.labelCell}>
            <View style={[styles.colorBar, { backgroundColor: r.color }]} />
            <Text style={[styles.rowLabel, { color: colors.textPrimary }]}>{r.label}</Text>
          </View>
          <Text style={[styles.rowAmount, { color: colors.textPrimary }]}>
            {formatCurrency(r.value)}{' '}
            <Text style={[styles.rowPct, { color: colors.textSecondary }]}>({r.pct.toFixed(1)})</Text>
          </Text>
        </View>
      ))}

      {/* Source footer */}
      {source === 'amfi' ? (
        <Text style={[styles.sourceBadge, { color: colors.textTertiary }]}>{sourceLabel}</Text>
      ) : (
        <View style={[styles.estimateFooter, { backgroundColor: colors.primaryLight }]}>
          <Ionicons name="information-circle-outline" size={12} color={colors.primary} />
          <Text style={[styles.estimateFooterText, { color: colors.primary }]}>
            Estimated from fund category · actual data loads monthly from AMFI
          </Text>
        </View>
      )}
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
  card: {
    borderRadius: ClearLensRadii.lg,
    borderWidth: 1,
    padding: ClearLensSpacing.md,
    marginBottom: ClearLensSpacing.md,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: ClearLensSpacing.sm,
  },
  totalLabel: {
    ...ClearLensTypography.body,
  },
  totalValue: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  stackedBar: {
    flexDirection: 'row',
    height: 12,
    borderRadius: ClearLensRadii.full,
    overflow: 'hidden',
    marginBottom: ClearLensSpacing.md,
  },
  barSegment: {
    height: '100%',
  },
  divider: {
    height: 1,
    marginBottom: ClearLensSpacing.sm,
  },
  tableHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: ClearLensSpacing.xs,
  },
  colHeader: {
    ...ClearLensTypography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  colHeaderRight: {
    ...ClearLensTypography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  tableRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: ClearLensSpacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'transparent',
  },
  labelCell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  colorBar: {
    width: 3,
    height: 18,
    borderRadius: 2,
  },
  rowLabel: {
    ...ClearLensTypography.body,
    fontWeight: '600',
  },
  rowAmount: {
    ...ClearLensTypography.body,
    fontWeight: '700',
  },
  rowPct: {
    ...ClearLensTypography.body,
    fontWeight: '500',
  },
  sourceBadge: {
    ...ClearLensTypography.caption,
    marginTop: ClearLensSpacing.sm,
    textAlign: 'right',
  },
  estimateFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: ClearLensSpacing.sm,
    borderRadius: ClearLensRadii.sm,
    padding: ClearLensSpacing.sm,
  },
  estimateFooterText: {
    ...ClearLensTypography.caption,
    flex: 1,
  },
});
