import { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PieChart } from 'react-native-gifted-charts';
import { useFundComposition } from '@/src/hooks/useFundComposition';
import { useCachedPortfolioWeight } from '@/src/hooks/usePortfolio';
import { formatCurrency } from '@/src/utils/formatting';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensCompatibleTokens,
} from '@/src/constants/clearLensTheme';
import { makeFundDetailTabStyles } from './fundDetailTabShared';

function ordinalRank(rank: number): string {
  if (rank === 1) return 'Largest position';
  if (rank === 2) return '2nd largest';
  if (rank === 3) return '3rd largest';
  return `${rank}th largest`;
}
function PortfolioHealthDonut({
  fundId,
  currentValue,
  userId,
}: {
  fundId: string;
  currentValue: number | null;
  userId: string | undefined;
}) {
  const { compatible: colors } = useClearLensTokens();
  const ds = useMemo(() => makeDonutStyles(colors), [colors]);
  const weight = useCachedPortfolioWeight(userId, fundId, currentValue);

  if (!weight) return null;

  const fundPct = weight.percentage;
  const restPct = 100 - fundPct;
  const rankLabel = weight.rank !== null ? ordinalRank(weight.rank) : null;

  const donutData = [
    { value: fundPct, color: colors.primary },
    { value: Math.max(restPct, 0), color: colors.borderLight },
  ];

  return (
    <View style={ds.card}>
      <Text style={ds.title}>Portfolio Weight</Text>
      <View style={ds.content}>
        <PieChart
          data={donutData}
          donut
          radius={56}
          innerRadius={38}
          innerCircleColor={colors.surface}
          centerLabelComponent={() => (
            <View style={ds.centerLabel}>
              <Text style={ds.centerPct}>{fundPct.toFixed(1)}%</Text>
            </View>
          )}
        />
        <View style={ds.info}>
          <Text style={ds.infoValue}>{fundPct.toFixed(1)}%</Text>
          <Text style={ds.infoLabel}>of portfolio</Text>
          {rankLabel && (
            <Text style={ds.rankLabel}>{rankLabel}</Text>
          )}
          <Text style={ds.totalLabel}>
            Total: {formatCurrency(weight.totalValue)}
          </Text>
        </View>
      </View>
      <View style={ds.legend}>
        <View style={ds.legendItem}>
          <View style={[ds.legendDot, { backgroundColor: colors.primary }]} />
          <Text style={ds.legendText}>This fund</Text>
        </View>
        <View style={ds.legendItem}>
          <View style={[ds.legendDot, { backgroundColor: colors.borderLight }]} />
          <Text style={ds.legendText}>Rest of portfolio</Text>
        </View>
      </View>
    </View>
  );
}

function makeDonutStyles(colors: ClearLensCompatibleTokens) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
      marginHorizontal: ClearLensSpacing.md,
      marginTop: ClearLensSpacing.md,
      borderWidth: 1,
      borderColor: colors.border,
      // The donut + info pair is compact; on desktop the parent frame is
      // ~920 px wide so capping the card keeps the content from drifting
      // in a sea of whitespace.
      maxWidth: 460,
      alignSelf: 'flex-start',
    },
    title: {
      ...ClearLensTypography.label,
      color: colors.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: ClearLensSpacing.sm,
    },
    content: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.md,
    },
    centerLabel: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    centerPct: {
      fontSize: 14,
      fontWeight: '700' as const,
      color: colors.primary,
    },
    info: {
      flex: 1,
      gap: 4,
    },
    infoValue: {
      fontSize: 28,
      fontWeight: '700' as const,
      color: colors.primary,
      lineHeight: 32,
    },
    infoLabel: {
      ...ClearLensTypography.bodySmall,
      color: colors.textTertiary,
    },
    rankLabel: {
      ...ClearLensTypography.body,
      color: colors.textSecondary,
      fontWeight: '600' as const,
      marginTop: 2,
    },
    totalLabel: {
      ...ClearLensTypography.caption,
      color: colors.textTertiary,
      marginTop: 4,
    },
    legend: {
      flexDirection: 'row',
      gap: ClearLensSpacing.md,
      marginTop: ClearLensSpacing.sm,
    },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    legendDot: { width: 8, height: 8, borderRadius: 4 },
    legendText: { ...ClearLensTypography.caption, color: colors.textTertiary },
  });
}

// ---------------------------------------------------------------------------
// Fund Composition Tab
// ---------------------------------------------------------------------------

function FundCompositionTab({
  schemeCode,
  isFocused,
}: {
  schemeCode: number;
  isFocused: boolean;
}) {
  const { compatible: colors } = useClearLensTokens();
  const tokens = useClearLensTokens();
  const s = useMemo(() => makeFundDetailTabStyles(colors), [colors]);
  const cs = useMemo(() => makeCompStyles(colors), [colors]);
  const { composition, isLoading } = useFundComposition(schemeCode, { enabled: isFocused });
  const compAssetColors = useMemo(
    () => ({
      equity: tokens.semantic.asset.equity,
      debt: tokens.semantic.asset.debt,
      cash: tokens.semantic.asset.cash,
      other: tokens.semantic.asset.other,
    }),
    [tokens.semantic.asset],
  );
  const compCapColors = useMemo(
    () => ({
      large: tokens.semantic.marketCap.large,
      mid: tokens.semantic.marketCap.mid,
      small: tokens.semantic.marketCap.small,
      other: tokens.semantic.marketCap.other,
    }),
    [tokens.semantic.marketCap],
  );

  if (isLoading) {
    return (
      <View style={[s.tabContent, { alignItems: 'center', paddingTop: 40 }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!composition) {
    return (
      <View style={s.tabContent}>
        <View style={s.noData}>
          <Ionicons name="pie-chart-outline" size={32} color={colors.textTertiary} />
          <Text style={s.noDataText}>No composition data available for this fund.</Text>
        </View>
      </View>
    );
  }

  const hasMarketCap = composition.largeCapPct !== null && composition.equityPct > 5;
  const sectors = composition.sectorAllocation
    ? Object.entries(composition.sectorAllocation).sort(([, a], [, b]) => b - a).slice(0, 8)
    : null;
  const holdings = composition.topHoldings?.slice(0, 10) ?? null;

  return (
    <View style={s.tabContent}>
      {/* Asset Mix */}
      <View style={[s.chartCard, { gap: ClearLensSpacing.sm }]}>
        <Text style={cs.cardTitle}>Asset Mix</Text>
        <View style={cs.stackedBar}>
          {composition.equityPct > 0.5 && (
            <View style={[cs.barSeg, { flex: composition.equityPct, backgroundColor: compAssetColors.equity }]} />
          )}
          {composition.debtPct > 0.5 && (
            <View style={[cs.barSeg, { flex: composition.debtPct, backgroundColor: compAssetColors.debt }]} />
          )}
          {composition.cashPct > 0.5 && (
            <View style={[cs.barSeg, { flex: composition.cashPct, backgroundColor: compAssetColors.cash }]} />
          )}
          {composition.otherPct > 0.5 && (
            <View style={[cs.barSeg, { flex: composition.otherPct, backgroundColor: compAssetColors.other }]} />
          )}
        </View>
        <View style={cs.assetRow}>
          {composition.equityPct > 0 && (
            <View style={cs.assetItem}>
              <View style={[cs.assetDot, { backgroundColor: compAssetColors.equity }]} />
              <Text style={cs.assetLabel}>Equity</Text>
              <Text style={cs.assetValue}>{composition.equityPct.toFixed(1)}%</Text>
            </View>
          )}
          {composition.debtPct > 0 && (
            <View style={cs.assetItem}>
              <View style={[cs.assetDot, { backgroundColor: compAssetColors.debt }]} />
              <Text style={cs.assetLabel}>Debt</Text>
              <Text style={cs.assetValue}>{composition.debtPct.toFixed(1)}%</Text>
            </View>
          )}
          {composition.cashPct > 0 && (
            <View style={cs.assetItem}>
              <View style={[cs.assetDot, { backgroundColor: compAssetColors.cash }]} />
              <Text style={cs.assetLabel}>Cash</Text>
              <Text style={cs.assetValue}>{composition.cashPct.toFixed(1)}%</Text>
            </View>
          )}
          {composition.otherPct > 0 && (
            <View style={cs.assetItem}>
              <View style={[cs.assetDot, { backgroundColor: compAssetColors.other }]} />
              <Text style={cs.assetLabel}>Other</Text>
              <Text style={cs.assetValue}>{composition.otherPct.toFixed(1)}%</Text>
            </View>
          )}
        </View>
      </View>

      {/* Market Cap Mix */}
      {hasMarketCap && (
        <View style={[s.chartCard, { gap: ClearLensSpacing.sm }]}>
          <Text style={cs.cardTitle}>Market Cap Mix</Text>
          {composition.source !== 'amfi' && (
            <Text style={cs.capDisclosure}>
              Showing SEBI category average — this fund hasn’t disclosed enough holdings yet.
            </Text>
          )}
          <View style={cs.stackedBar}>
            {(composition.largeCapPct ?? 0) > 0.5 && (
              <View style={[cs.barSeg, { flex: composition.largeCapPct!, backgroundColor: compCapColors.large }]} />
            )}
            {(composition.midCapPct ?? 0) > 0.5 && (
              <View style={[cs.barSeg, { flex: composition.midCapPct!, backgroundColor: compCapColors.mid }]} />
            )}
            {(composition.smallCapPct ?? 0) > 0.5 && (
              <View style={[cs.barSeg, { flex: composition.smallCapPct!, backgroundColor: compCapColors.small }]} />
            )}
            {(composition.notClassifiedPct ?? 0) > 0.5 && (
              <View style={[cs.barSeg, { flex: composition.notClassifiedPct!, backgroundColor: compCapColors.other }]} />
            )}
          </View>
          <View style={cs.assetRow}>
            {(composition.largeCapPct ?? 0) > 0 && (
              <View style={cs.assetItem}>
                <View style={[cs.assetDot, { backgroundColor: compCapColors.large }]} />
                <Text style={cs.assetLabel}>Large</Text>
                <Text style={cs.assetValue}>{composition.largeCapPct!.toFixed(1)}%</Text>
              </View>
            )}
            {(composition.midCapPct ?? 0) > 0 && (
              <View style={cs.assetItem}>
                <View style={[cs.assetDot, { backgroundColor: compCapColors.mid }]} />
                <Text style={cs.assetLabel}>Mid</Text>
                <Text style={cs.assetValue}>{composition.midCapPct!.toFixed(1)}%</Text>
              </View>
            )}
            {(composition.smallCapPct ?? 0) > 0 && (
              <View style={cs.assetItem}>
                <View style={[cs.assetDot, { backgroundColor: compCapColors.small }]} />
                <Text style={cs.assetLabel}>Small</Text>
                <Text style={cs.assetValue}>{composition.smallCapPct!.toFixed(1)}%</Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Sector Breakdown */}
      <View style={[s.chartCard, { gap: ClearLensSpacing.xs }]}>
        <Text style={[cs.cardTitle, { marginBottom: ClearLensSpacing.xs }]}>Sector Breakdown</Text>
        {sectors && sectors.length > 0 ? (
          sectors.map(([sector, pct]) => (
            <View key={sector} style={cs.sectorRow}>
              <Text style={cs.sectorName} numberOfLines={1}>{sector}</Text>
              <View style={cs.sectorBarWrap}>
                <View
                  style={[cs.sectorBar, {
                    width: `${Math.min(pct, 30) / 30 * 100}%`,
                    backgroundColor: colors.primary + '66',
                  }]}
                />
              </View>
              <Text style={cs.sectorPct}>{pct.toFixed(1)}%</Text>
            </View>
          ))
        ) : (
          <View style={cs.emptySlot}>
            <Ionicons name="grid-outline" size={24} color={colors.textTertiary} />
            <Text style={cs.emptySlotText}>Syncs from AMFI monthly disclosures</Text>
          </View>
        )}
      </View>

      {/* Top Holdings */}
      <View style={[s.chartCard, { gap: 0, overflow: 'hidden' }]}>
        <Text style={[cs.cardTitle, { marginBottom: ClearLensSpacing.xs }]}>Top Holdings</Text>
        {holdings && holdings.length > 0 ? (
          holdings.map((h, i) => (
            <View
              key={h.isin || h.name}
              style={[cs.holdingRow, i > 0 && { borderTopWidth: 1, borderTopColor: colors.borderLight }]}
            >
              <Text style={cs.holdingRank}>{i + 1}</Text>
              <View style={cs.holdingInfo}>
                <Text style={cs.holdingName} numberOfLines={1}>{h.name}</Text>
                <Text style={cs.holdingSector}>{h.sector}</Text>
              </View>
              <Text style={cs.holdingPct}>{h.pctOfNav.toFixed(1)}%</Text>
            </View>
          ))
        ) : (
          <View style={cs.emptySlot}>
            <Ionicons name="list-outline" size={24} color={colors.textTertiary} />
            <Text style={cs.emptySlotText}>Syncs from AMFI monthly disclosures</Text>
          </View>
        )}
      </View>

      <Text style={cs.footer}>
        {composition.source === 'amfi' ? 'AMFI disclosure' : 'Estimated from fund category'} ·{' '}
        {new Date(composition.portfolioDate).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}
      </Text>
    </View>
  );
}

function makeCompStyles(colors: ClearLensCompatibleTokens) {
  return StyleSheet.create({
    cardTitle: {
      fontSize: 11,
      fontWeight: '700' as const,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      color: colors.textTertiary,
    },
    capDisclosure: {
      fontSize: 12,
      lineHeight: 16,
      color: colors.textSecondary,
      fontStyle: 'italic' as const,
    },
    stackedBar: {
      flexDirection: 'row',
      height: 10,
      borderRadius: ClearLensRadii.full,
      overflow: 'hidden',
    },
    barSeg: { height: '100%' },
    assetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: ClearLensSpacing.sm },
    assetItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    assetDot: { width: 8, height: 8, borderRadius: 4 },
    assetLabel: { fontSize: 12, color: colors.textTertiary, fontWeight: '600' as const },
    assetValue: { fontSize: 13, fontWeight: '700' as const, color: colors.textPrimary },
    sectorRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      paddingVertical: 4,
    },
    sectorName: { flex: 1, fontSize: 13, color: colors.textPrimary, fontWeight: '600' as const },
    sectorBarWrap: {
      width: 80,
      height: 6,
      backgroundColor: colors.borderLight,
      borderRadius: 3,
      overflow: 'hidden',
    },
    sectorBar: { height: '100%', borderRadius: 3 },
    sectorPct: {
      fontSize: 12,
      fontWeight: '600' as const,
      minWidth: 42,
      textAlign: 'right',
      color: colors.textSecondary,
    },
    holdingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      gap: ClearLensSpacing.sm,
    },
    holdingRank: {
      fontSize: 12,
      fontWeight: '600' as const,
      minWidth: 18,
      textAlign: 'center',
      color: colors.textTertiary,
    },
    holdingInfo: { flex: 1, gap: 2 },
    holdingName: { fontSize: 13, fontWeight: '600' as const, color: colors.textPrimary },
    holdingSector: { fontSize: 11, color: colors.textTertiary, fontWeight: '500' as const },
    holdingPct: {
      fontSize: 13,
      fontWeight: '700' as const,
      minWidth: 48,
      textAlign: 'right',
      color: colors.textPrimary,
    },
    emptySlot: { alignItems: 'center', paddingVertical: ClearLensSpacing.md, gap: 6 },
    emptySlotText: { fontSize: 12, color: colors.textTertiary, textAlign: 'center' },
    footer: {
      fontSize: 11,
      color: colors.textTertiary,
      textAlign: 'center',
      fontStyle: 'italic',
      paddingBottom: ClearLensSpacing.sm,
    },
  });
}



interface FundDetailCompositionContentProps {
  schemeCode: number;
  fundId: string;
  currentValue: number | null;
  userId?: string;
  isFocused: boolean;
}

export default function FundDetailCompositionContent({
  schemeCode,
  fundId,
  currentValue,
  userId,
  isFocused,
}: FundDetailCompositionContentProps) {
  return (
    <>
      <FundCompositionTab schemeCode={schemeCode} isFocused={isFocused} />
      <PortfolioHealthDonut
        fundId={fundId}
        currentValue={currentValue}
        userId={userId}
      />
    </>
  );
}
