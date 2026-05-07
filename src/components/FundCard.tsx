import { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { formatXirr } from '@/src/utils/xirr';
import { formatCurrency } from '@/src/utils/formatting';
import { parseFundName } from '@/src/utils/fundName';
import { navStaleness } from '@/src/utils/navUtils';
import { Sparkline } from '@/src/components/Sparkline';
import {
  ClearLensSpacing,
  ClearLensRadii,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import type { ClearLensCompatibleTokens } from '@/src/constants/clearLensTheme';
import type { FundCardData } from '@/src/hooks/usePortfolio';

export function categoryColor(colors: ClearLensCompatibleTokens, category: string | null): string {
  if (!category) return colors.primary;
  const cat = category.toLowerCase();
  if (cat.includes('mid cap')) return '#7c3aed';
  if (cat.includes('small cap')) return colors.negative;
  if (cat.includes('flexi cap') || cat.includes('multi cap')) return '#0891b2';
  if (cat.includes('elss')) return colors.positive;
  if (cat.includes('debt')) return colors.warning;
  if (cat.includes('hybrid')) return '#db2777';
  return colors.primary;
}

export function FundCard({
  fund,
  latestNavDate,
  onPress,
}: {
  fund: FundCardData;
  latestNavDate: string | null;
  onPress: () => void;
}) {
  const { compatible: colors } = useClearLensTokens();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const isPositiveDay = fund.dailyChangeAmount != null ? fund.dailyChangeAmount >= 0 : true;
  const accentColor = categoryColor(colors, fund.schemeCategory);
  const hasRedemptions = fund.redeemedUnits > 0;
  const isPressable = !fund.navUnavailable;
  const { base: fundBaseName, planBadge } = parseFundName(fund.schemeName);
  const cardStaleness = navStaleness(latestNavDate);

  const unrealizedGain = fund.currentValue != null ? fund.currentValue - fund.investedAmount : null;
  const unrealizedPct =
    unrealizedGain != null && fund.investedAmount > 0
      ? (unrealizedGain / fund.investedAmount) * 100
      : null;
  const unrealizedPositive = unrealizedGain != null ? unrealizedGain >= 0 : true;

  return (
    <TouchableOpacity
      style={[styles.fundCard, !isPressable && styles.fundCardDisabled]}
      onPress={onPress}
      activeOpacity={isPressable ? 0.78 : 1}
      disabled={!isPressable}
    >
      <View style={[styles.fundCardAccent, { backgroundColor: accentColor }]} />

      <View style={styles.fundCardInner}>
        <View style={styles.fundCardTop}>
          <View style={styles.fundNameBlock}>
            <Text style={styles.fundName} numberOfLines={2}>
              {fundBaseName}
            </Text>
            <Text style={[styles.fundCategory, { color: accentColor + 'cc' }]}>
              {fund.schemeCategory}
            </Text>
            {planBadge !== null && (
              <Text style={styles.fundPlanBadge}>{planBadge}</Text>
            )}
          </View>
          <View style={styles.fundValueBlock}>
            {fund.navUnavailable ? (
              <View style={styles.navPendingBadge}>
                <Text style={styles.navPendingText}>NAV pending</Text>
              </View>
            ) : (
              <>
                <Text style={styles.fundValue}>{formatCurrency(fund.currentValue!)}</Text>
                <View style={styles.dailyChangePill}>
                  <Text style={[styles.fundDailyChange, { color: isPositiveDay ? colors.positive : colors.negative }]}>
                    {fund.dailyChangePct! >= 0 ? '+' : ''}{fund.dailyChangePct!.toFixed(2)}%{' '}
                    {cardStaleness.stale ? cardStaleness.label : 'today'}
                  </Text>
                </View>
                {isFinite(fund.returnXirr) && (
                  <Text style={[styles.fundXirr, { color: fund.returnXirr >= 0 ? colors.positive : colors.negative }]}>
                    {formatXirr(fund.returnXirr)} XIRR
                  </Text>
                )}
              </>
            )}
          </View>
        </View>

        <View style={styles.fundCardBottom}>
          <View style={styles.fundMeta}>
            <Text style={styles.fundMetaLabel}>Invested</Text>
            <Text style={styles.fundMetaValue}>{formatCurrency(fund.investedAmount)}</Text>
          </View>
          <View style={styles.fundMetaDivider} />
          <View style={styles.fundMeta}>
            <Text style={styles.fundMetaLabel}>30d</Text>
            {fund.navHistory30d.length >= 2 ? (
              <Sparkline
                data={fund.navHistory30d.map((p) => p.value)}
                color={fund.returnXirr >= 0 ? colors.positive : colors.negative}
                width={72}
                height={36}
              />
            ) : (
              <Text style={styles.fundMetaValue}>
                {fund.currentNav != null ? `₹${fund.currentNav.toFixed(2)}` : '—'}
              </Text>
            )}
          </View>
          <View style={styles.fundMetaDivider} />
          <View style={styles.fundMeta}>
            <Text style={styles.fundMetaLabel}>Gain / Loss</Text>
            {unrealizedGain != null ? (
              <>
                <Text style={[styles.fundMetaValue, { color: unrealizedPositive ? colors.positive : colors.negative }]}>
                  {unrealizedPositive ? '+' : ''}{formatCurrency(Math.abs(unrealizedGain))}
                </Text>
                <Text style={[styles.fundMetaSub, { color: unrealizedPositive ? colors.positive : colors.negative }]}>
                  ({unrealizedPositive ? '+' : ''}{unrealizedPct!.toFixed(1)}%)
                </Text>
              </>
            ) : (
              <Text style={styles.fundMetaValue}>—</Text>
            )}
          </View>
        </View>

        {hasRedemptions && (
          <View style={styles.realizedRow}>
            <View style={styles.realizedItem}>
              <Text style={styles.realizedLabel}>Redeemed</Text>
              <Text style={styles.realizedValue}>{formatCurrency(fund.realizedAmount)}</Text>
            </View>
            <View style={styles.realizedItem}>
              <Text style={styles.realizedLabel}>Realized P&L</Text>
              <Text style={[styles.realizedValue, { color: fund.realizedGain >= 0 ? colors.positive : colors.negative }]}>
                {fund.realizedGain >= 0 ? '+' : ''}{formatCurrency(Math.abs(fund.realizedGain))}
              </Text>
            </View>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

function makeStyles(colors: ClearLensCompatibleTokens) {
  return StyleSheet.create({
    fundCard: {
      backgroundColor: colors.surface,
      marginHorizontal: ClearLensSpacing.md,
      marginBottom: 12,
      borderRadius: ClearLensRadii.lg,
      flexDirection: 'row',
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: colors.border,
    },
    fundCardDisabled: { opacity: 0.92 },
    fundCardAccent: { width: 4 },
    fundCardInner: { flex: 1, padding: ClearLensSpacing.md, gap: 12 },
    fundCardTop: { flexDirection: 'row', gap: 12 },
    fundNameBlock: { flex: 1, gap: 4 },
    fundName: { fontSize: 14, fontWeight: '700' as const, color: colors.textPrimary, lineHeight: 20 },
    fundCategory: { fontSize: 12, fontWeight: '600' as const },
    fundPlanBadge: { fontSize: 11, color: colors.textTertiary, fontWeight: '500' as const },
    fundValueBlock: { alignItems: 'flex-end', gap: 5, minWidth: 108 },
    fundValue: { fontSize: 17, fontWeight: '800' as const, color: colors.textPrimary, lineHeight: 22 },
    dailyChangePill: {
      backgroundColor: colors.background,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 6,
    },
    fundDailyChange: { fontSize: 12, fontWeight: '600' as const },
    fundXirr: { fontSize: 11, fontWeight: '700' as const },
    navPendingBadge: {
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    navPendingText: { fontSize: 11, fontWeight: '600' as const, color: colors.textTertiary },
    fundCardBottom: {
      flexDirection: 'row',
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: colors.borderLight,
      alignItems: 'center',
    },
    fundMeta: { flex: 1, alignItems: 'center', gap: 4 },
    fundMetaLabel: {
      fontSize: 10,
      color: colors.textTertiary,
      fontWeight: '600' as const,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    fundMetaValue: { fontSize: 13, fontWeight: '700' as const, color: colors.textSecondary },
    fundMetaDivider: { width: 1, backgroundColor: colors.borderLight, marginHorizontal: 4 },
    fundMetaSub: { fontSize: 11, fontWeight: '600' as const },
    realizedRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: colors.borderLight,
    },
    realizedItem: { gap: 3 },
    realizedLabel: {
      fontSize: 11,
      color: colors.textTertiary,
      fontWeight: '600' as const,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    realizedValue: { fontSize: 13, fontWeight: '700' as const },
  });
}
