import { useMemo, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Svg, { Circle } from 'react-native-svg';
import {
  ClearLensCard,
  ClearLensHeader,
  ClearLensScreen,
} from '@/src/components/clearLens/ClearLensPrimitives';
import { PortfolioDisclaimer } from '@/src/components/clearLens/PortfolioDisclaimer';
import { usePortfolio } from '@/src/hooks/usePortfolio';
import { usePortfolioInsights } from '@/src/hooks/usePortfolioInsights';
import { useTrackInsightViewed } from '@/src/hooks/useTrackInsightViewed';
import { useAppStore } from '@/src/store/appStore';
import { formatCurrency } from '@/src/utils/formatting';
import type { InsightDebtFund } from '@/src/types/app';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensSemanticColors,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';

const CLEAR_LENS_ORANGE = ClearLensSemanticColors.asset.debt;
const DONUT_SIZE = 104;
const DONUT_STROKE = 18;

function formatDisclosureDate(value: string | null | undefined): string {
  if (!value) return 'Disclosure pending';
  return new Date(value).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

function ExposureCard({
  title,
  rows,
  total,
  disclosure,
}: {
  title: string;
  rows: { label: string; pct: number; value?: number; color: string }[];
  total?: number;
  disclosure?: string;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const max = Math.max(...rows.map((row) => row.pct), 1);

  return (
    <ClearLensCard style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{title}</Text>
        {disclosure ? <Text style={styles.cardMeta}>{disclosure}</Text> : null}
      </View>
      <View style={styles.rows}>
        {rows.map((row) => (
          <View key={row.label} style={styles.exposureItem}>
            <View style={styles.exposureItemHeader}>
              <Text style={styles.rowName} numberOfLines={1}>{row.label}</Text>
              <Text style={styles.exposureValue}>
                <Text style={styles.rowPct}>{row.pct.toFixed(1)}%</Text>
                {row.value !== undefined || total !== undefined ? ` · ${formatCurrency(row.value ?? ((row.pct / 100) * (total ?? 0)))}` : ''}
              </Text>
            </View>
            <View style={styles.track}>
              <View style={[styles.trackFill, { width: `${Math.max((row.pct / max) * 100, 5)}%`, backgroundColor: row.color }]} />
            </View>
          </View>
        ))}
      </View>
    </ClearLensCard>
  );
}

function DonutMixCard({
  title,
  rows,
  total,
  disclosure,
}: {
  title: string;
  rows: { label: string; pct: number; color: string }[];
  total: number;
  disclosure?: string;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const radius = (DONUT_SIZE - DONUT_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const nonZeroRows = rows.filter((row) => row.pct > 0);
  const lead = [...nonZeroRows].sort((a, b) => b.pct - a.pct)[0];

  return (
    <ClearLensCard style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderCopy}>
          <Text style={styles.cardTitle}>{title}</Text>
          {disclosure ? <Text style={styles.cardMeta}>{disclosure}</Text> : null}
        </View>
      </View>

      <View style={styles.donutContent}>
        <View style={styles.donutWrap}>
          <Svg width={DONUT_SIZE} height={DONUT_SIZE}>
            <Circle
              cx={DONUT_SIZE / 2}
              cy={DONUT_SIZE / 2}
              r={radius}
              stroke={tokens.colors.surfaceSoft}
              strokeWidth={DONUT_STROKE}
              fill="none"
            />
            {nonZeroRows.map((row) => {
              const dash = Math.max((row.pct / 100) * circumference, 0);
              const dashOffset = -offset;
              offset += dash;
              return (
                <Circle
                  key={row.label}
                  cx={DONUT_SIZE / 2}
                  cy={DONUT_SIZE / 2}
                  r={radius}
                  stroke={row.color}
                  strokeWidth={DONUT_STROKE}
                  fill="none"
                  strokeDasharray={`${dash} ${circumference}`}
                  strokeDashoffset={dashOffset}
                  strokeLinecap="butt"
                  transform={`rotate(-90 ${DONUT_SIZE / 2} ${DONUT_SIZE / 2})`}
                />
              );
            })}
          </Svg>
          {lead && (
            <View style={styles.donutCenter}>
              <Text style={styles.donutCenterValue}>{lead.pct.toFixed(0)}%</Text>
              <Text style={styles.donutCenterLabel} numberOfLines={1}>{lead.label}</Text>
            </View>
          )}
        </View>

        <View style={styles.donutRows}>
          {rows.map((row) => (
            <View key={row.label} style={styles.donutRow}>
              <View style={styles.donutLabelWrap}>
                <View style={[styles.dot, { backgroundColor: row.color }]} />
                <Text style={styles.rowName} numberOfLines={1}>{row.label}</Text>
              </View>
              <Text style={styles.donutPct}>{row.pct.toFixed(1)}%</Text>
              <Text style={styles.donutValue}>{formatCurrency((row.pct / 100) * total)}</Text>
            </View>
          ))}
        </View>
      </View>
    </ClearLensCard>
  );
}

function HoldingsCard({
  holdings,
}: {
  holdings: { name: string; portfolioWeight: number; value: number }[];
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const [page, setPage] = useState(0);
  const visibleHoldings = holdings.slice(0, 30);
  const pageCount = Math.max(1, Math.ceil(visibleHoldings.length / 10));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageHoldings = visibleHoldings.slice(clampedPage * 10, clampedPage * 10 + 10);

  return (
    <ClearLensCard style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderCopy}>
          <Text style={styles.cardTitle}>Top holdings</Text>
          <Text style={styles.cardMeta}>Showing {clampedPage * 10 + 1}-{Math.min((clampedPage + 1) * 10, visibleHoldings.length)} of {visibleHoldings.length}</Text>
        </View>
        <Text style={styles.cardMeta}>Portfolio weight</Text>
      </View>
      <View>
        {pageHoldings.map((holding, index) => (
          <View key={`${holding.name}-${clampedPage}-${index}`} style={[styles.holdingRow, index > 0 && styles.divider]}>
            <Text style={styles.holdingRank}>{clampedPage * 10 + index + 1}</Text>
            <Text style={styles.holdingName} numberOfLines={1}>{holding.name}</Text>
            <Text style={styles.holdingPct}>{holding.portfolioWeight.toFixed(2)}%</Text>
            <Text style={styles.holdingValue}>{formatCurrency(holding.value)}</Text>
          </View>
        ))}
      </View>
      {pageCount > 1 && (
        <View style={styles.paginationRow}>
          <TouchableOpacity
            style={[styles.paginationButton, clampedPage === 0 && styles.paginationButtonDisabled]}
            disabled={clampedPage === 0}
            onPress={() => setPage((current) => Math.max(0, current - 1))}
            activeOpacity={0.75}
          >
            <Ionicons name="chevron-back" size={18} color={clampedPage === 0 ? tokens.colors.textTertiary : tokens.colors.navy} />
          </TouchableOpacity>
          <Text style={styles.pageIndicator}>{clampedPage + 1} / {pageCount}</Text>
          <TouchableOpacity
            style={[styles.paginationButton, clampedPage >= pageCount - 1 && styles.paginationButtonDisabled]}
            disabled={clampedPage >= pageCount - 1}
            onPress={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            activeOpacity={0.75}
          >
            <Ionicons name="chevron-forward" size={18} color={clampedPage >= pageCount - 1 ? tokens.colors.textTertiary : tokens.colors.navy} />
          </TouchableOpacity>
        </View>
      )}
    </ClearLensCard>
  );
}

function DebtCashCard({
  totalValue,
  debtPct,
  cashPct,
  debtFunds,
}: {
  totalValue: number;
  debtPct: number;
  cashPct: number;
  debtFunds: InsightDebtFund[];
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const rows = [
    {
      label: 'Debt',
      pct: debtPct,
      value: (debtPct / 100) * totalValue,
      color: CLEAR_LENS_ORANGE,
      icon: 'shield-checkmark-outline' as const,
    },
    {
      label: 'Cash & Others',
      pct: cashPct,
      value: (cashPct / 100) * totalValue,
      color: tokens.colors.mint,
      icon: 'wallet-outline' as const,
    },
  ];

  return (
    <ClearLensCard style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>Debt and cash details</Text>
        <Text style={styles.cardMeta}>Portfolio weight</Text>
      </View>
      <View style={styles.debtSummaryRow}>
        {rows.map((row) => (
          <View key={row.label} style={styles.debtSummaryItem}>
            <View style={[styles.debtIcon, { backgroundColor: row.color }]}>
              <Ionicons name={row.icon} size={16} color={tokens.colors.navy} />
            </View>
            <Text style={styles.debtPct}>{row.pct.toFixed(1)}%</Text>
            <Text style={styles.debtLabel}>{row.label}</Text>
            <Text style={styles.debtValue}>{formatCurrency(row.value)}</Text>
          </View>
        ))}
      </View>

      {debtFunds.length > 0 && (
        <View style={styles.debtFundList}>
          <Text style={styles.debtSectionLabel}>Funds with debt or cash exposure</Text>
          {debtFunds.slice(0, 5).map((fund, index) => (
            <View key={fund.fundId} style={[styles.debtFundRow, index > 0 && styles.divider]}>
              <View style={styles.debtFundNameBlock}>
                <Text style={styles.debtFundName} numberOfLines={1}>{fund.shortName}</Text>
                <Text style={styles.debtFundShare}>{fund.portfolioPct.toFixed(1)}% of portfolio</Text>
              </View>
              <View style={styles.debtFundMetrics}>
                <Text style={[styles.debtFundMetric, { color: CLEAR_LENS_ORANGE }]}>
                  Debt {fund.debtPct.toFixed(1)}%
                </Text>
                <Text style={styles.debtFundMetric}>
                  Cash {fund.cashPct.toFixed(1)}%
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </ClearLensCard>
  );
}

function PendingCard({ title, onSync, isSyncing }: { title: string; onSync: () => void; isSyncing: boolean }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <ClearLensCard style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.pendingText}>
        FolioLens will fill this from AMFI monthly portfolio disclosures.
      </Text>
      <TouchableOpacity style={styles.syncButton} onPress={onSync} disabled={isSyncing}>
        {isSyncing ? (
          <ActivityIndicator size="small" color={tokens.colors.emerald} />
        ) : (
          <Ionicons name="refresh-outline" size={16} color={tokens.colors.emerald} />
        )}
        <Text style={styles.syncButtonText}>{isSyncing ? 'Syncing' : 'Sync now'}</Text>
      </TouchableOpacity>
    </ClearLensCard>
  );
}

export function ClearLensPortfolioInsightsScreen() {
  useTrackInsightViewed('insights');
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const router = useRouter();
  const { defaultBenchmarkSymbol } = useAppStore();
  const { data, isLoading: portfolioLoading } = usePortfolio(defaultBenchmarkSymbol);
  const fundCards = data?.fundCards ?? [];
  const { insights, isLoading, isStale, isSyncing, triggerSync, hasNoData } =
    usePortfolioInsights(fundCards);
  const didAutoTrigger = useRef(false);
  const shouldBootstrapInsights = fundCards.length > 0 && !insights && !isLoading;

  useEffect(() => {
    if (
      !didAutoTrigger.current &&
      (hasNoData || isStale || shouldBootstrapInsights) &&
      !isSyncing
    ) {
      didAutoTrigger.current = true;
      triggerSync();
    }
  }, [hasNoData, isStale, isSyncing, shouldBootstrapInsights, triggerSync]);

  const disclosure = insights ? `AMFI disclosure: ${formatDisclosureDate(insights.dataAsOf)}` : 'AMFI disclosure';

  return (
    <ClearLensScreen>
      <ClearLensHeader onPressBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {isSyncing && (
          <View style={styles.infoBanner}>
            <ActivityIndicator size="small" color={tokens.colors.emerald} />
            <Text style={styles.infoBannerText}>Syncing composition data from AMFI disclosures.</Text>
          </View>
        )}
        {isStale && !isSyncing && (
          <TouchableOpacity style={styles.infoBanner} onPress={() => triggerSync()}>
            <Ionicons name="refresh-outline" size={16} color={tokens.colors.emerald} />
            <Text style={styles.infoBannerText}>Disclosure data may be outdated. Tap to refresh.</Text>
          </TouchableOpacity>
        )}

        {portfolioLoading || isLoading || (hasNoData && isSyncing) || (shouldBootstrapInsights && !didAutoTrigger.current) ? (
          <View style={styles.centeredCard}>
            <ActivityIndicator size="large" color={tokens.colors.emerald} />
          </View>
        ) : !insights ? (
          <ClearLensCard style={styles.emptyCard}>
            <Ionicons name="pie-chart-outline" size={36} color={tokens.colors.emerald} />
            <Text style={styles.emptyTitle}>No insights yet</Text>
            <Text style={styles.pendingText}>Load fund composition data to see allocation, sectors, and top holdings.</Text>
            <TouchableOpacity style={styles.primaryButton} onPress={() => triggerSync()}>
              <Text style={styles.primaryButtonText}>Load insights</Text>
            </TouchableOpacity>
          </ClearLensCard>
        ) : (
          <>
            <View style={styles.heroCopy}>
              <Text style={styles.heroEyebrow}>Portfolio Insights</Text>
              <Text style={styles.heroTitle}>What you own</Text>
              <Text style={styles.heroSubtitle}>
                See your portfolio mix, concentration, sectors, and top holdings in one place.
              </Text>
            </View>

            <DonutMixCard
              title="Asset allocation"
              total={insights.totalValue}
              disclosure={disclosure}
              rows={[
                { label: 'Equity', pct: insights.assetMix.equity, color: tokens.semantic.asset.equity },
                { label: 'Debt', pct: insights.assetMix.debt, color: tokens.semantic.asset.debt },
                { label: 'Cash & Others', pct: insights.assetMix.cash + insights.assetMix.other, color: tokens.semantic.asset.cash },
              ]}
            />

            {(insights.assetMix.debt >= 1 ||
              insights.assetMix.cash + insights.assetMix.other >= 1 ||
              insights.debtFunds.length > 0) && (
              <DebtCashCard
                totalValue={insights.totalValue}
                debtPct={insights.assetMix.debt}
                cashPct={insights.assetMix.cash + insights.assetMix.other}
                debtFunds={insights.debtFunds}
              />
            )}

            <DonutMixCard
              title="Market-cap mix"
              total={insights.totalValue * (insights.assetMix.equity / 100)}
              rows={[
                { label: 'Large Cap', pct: insights.marketCapMix.large, color: tokens.semantic.marketCap.large },
                { label: 'Mid Cap', pct: insights.marketCapMix.mid, color: tokens.semantic.marketCap.mid },
                { label: 'Small Cap', pct: insights.marketCapMix.small, color: tokens.semantic.marketCap.small },
              ]}
            />

            {insights.sectorBreakdown ? (
              <ExposureCard
                title="Sector exposure"
                rows={insights.sectorBreakdown.slice(0, 8).map((sector) => ({
                  label: sector.sector,
                  pct: sector.weight,
                  value: sector.value,
                  color: tokens.colors.emerald,
                }))}
              />
            ) : (
              <PendingCard title="Sector exposure" isSyncing={isSyncing} onSync={triggerSync} />
            )}

            {insights.topHoldings ? (
              <HoldingsCard holdings={insights.topHoldings} />
            ) : (
              <PendingCard title="Top holdings" isSyncing={isSyncing} onSync={triggerSync} />
            )}
          </>
        )}

        <PortfolioDisclaimer />
      </ScrollView>
    </ClearLensScreen>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
  scroll: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingBottom: ClearLensSpacing.xxl,
    gap: ClearLensSpacing.md,
  },
  heroCopy: {
    gap: 4,
  },
  heroEyebrow: {
    ...ClearLensTypography.label,
    color: cl.emerald,
    textTransform: 'uppercase',
  },
  heroTitle: {
    ...ClearLensTypography.h1,
    color: cl.navy,
  },
  heroSubtitle: {
    ...ClearLensTypography.body,
    color: cl.textSecondary,
  },
  card: {
    gap: ClearLensSpacing.md,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.sm,
  },
  cardHeaderCopy: {
    flex: 1,
    gap: 2,
  },
  cardTitle: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  cardMeta: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  stackedBar: {
    height: 12,
    borderRadius: ClearLensRadii.full,
    overflow: 'hidden',
    flexDirection: 'row',
    backgroundColor: cl.surfaceSoft,
  },
  stackedSegment: {
    height: '100%',
  },
  rows: {
    gap: ClearLensSpacing.sm,
  },
  donutContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.md,
  },
  donutWrap: {
    width: DONUT_SIZE,
    height: DONUT_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  donutCenter: {
    position: 'absolute',
    left: DONUT_STROKE,
    right: DONUT_STROKE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  donutCenterValue: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  donutCenterLabel: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  donutRows: {
    flex: 1,
    gap: ClearLensSpacing.sm,
  },
  donutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  donutLabelWrap: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  donutPct: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
    minWidth: 48,
    textAlign: 'right',
  },
  donutValue: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
    minWidth: 68,
    textAlign: 'right',
  },
  exposureItem: {
    gap: 5,
  },
  exposureItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.sm,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  rowName: {
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
    flex: 1,
  },
  exposureValue: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    fontVariant: ['tabular-nums'],
  },
  track: {
    height: 6,
    borderRadius: ClearLensRadii.full,
    overflow: 'hidden',
    backgroundColor: cl.surfaceSoft,
  },
  trackFill: {
    height: '100%',
    borderRadius: ClearLensRadii.full,
  },
  rowPct: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.bold,
    color: cl.navy,
  },
  rowValue: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
    width: 74,
    textAlign: 'right',
  },
  holdingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    paddingVertical: ClearLensSpacing.sm,
  },
  divider: {
    borderTopWidth: 1,
    borderTopColor: cl.borderLight,
  },
  holdingRank: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    width: 20,
    textAlign: 'center',
  },
  holdingName: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    flex: 1,
    fontFamily: ClearLensFonts.semiBold,
  },
  holdingPct: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
    width: 58,
    textAlign: 'right',
  },
  holdingValue: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
    width: 72,
    textAlign: 'right',
  },
  paginationRow: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: ClearLensSpacing.sm,
  },
  paginationButton: {
    width: 34,
    height: 34,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.surfaceSoft,
  },
  paginationButtonDisabled: {
    opacity: 0.45,
  },
  pageIndicator: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    fontFamily: ClearLensFonts.semiBold,
    minWidth: 36,
    textAlign: 'center',
  },
  pendingText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
  },
  debtSummaryRow: {
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
  },
  debtSummaryItem: {
    flex: 1,
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.surfaceSoft,
    padding: ClearLensSpacing.sm,
    gap: 4,
  },
  debtIcon: {
    width: 28,
    height: 28,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.85,
  },
  debtPct: {
    ...ClearLensTypography.h2,
    color: cl.navy,
  },
  debtLabel: {
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
    fontFamily: ClearLensFonts.semiBold,
  },
  debtValue: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  debtFundList: {
    gap: ClearLensSpacing.xs,
  },
  debtSectionLabel: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    textTransform: 'uppercase',
  },
  debtFundRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    paddingTop: ClearLensSpacing.sm,
  },
  debtFundNameBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  debtFundName: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.semiBold,
  },
  debtFundShare: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  debtFundMetrics: {
    alignItems: 'flex-end',
    gap: 2,
  },
  debtFundMetric: {
    ...ClearLensTypography.caption,
    color: cl.textSecondary,
    fontFamily: ClearLensFonts.semiBold,
  },
  syncButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.xs,
    alignSelf: 'flex-start',
    minHeight: 38,
    paddingHorizontal: ClearLensSpacing.md,
    borderRadius: ClearLensRadii.full,
    backgroundColor: tokens.semantic.sentiment.positiveSurface,
  },
  syncButtonText: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.bold,
    color: tokens.semantic.sentiment.positiveText,
  },
  infoBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    padding: ClearLensSpacing.md,
    borderRadius: ClearLensRadii.lg,
    backgroundColor: tokens.semantic.sentiment.positiveSurface,
  },
  infoBannerText: {
    ...ClearLensTypography.bodySmall,
    color: cl.slate,
    flex: 1,
  },
  centeredCard: {
    minHeight: 260,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCard: {
    alignItems: 'center',
    gap: ClearLensSpacing.md,
  },
  emptyTitle: {
    ...ClearLensTypography.h2,
    color: cl.navy,
    textAlign: 'center',
  },
  primaryButton: {
    minHeight: 44,
    paddingHorizontal: ClearLensSpacing.lg,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.emerald,
  },
  primaryButtonText: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.bold,
    color: cl.textOnDark,
  },
});
}
