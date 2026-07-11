import { lazy, Suspense, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useIsRestoring } from '@tanstack/react-query';
import { useFundDetail, useFundNavHistory } from '@/src/hooks/useFundDetail';
import { useCachedFundCard } from '@/src/hooks/usePortfolio';
import { useSession } from '@/src/hooks/useSession';
import { useTrackInsightViewed } from '@/src/hooks/useTrackInsightViewed';
import type { FundRef } from '@/src/hooks/usePortfolioTimeline';
import { formatXirr } from '@/src/utils/xirr';
import { formatCurrency } from '@/src/utils/formatting';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensCard,
  ClearLensHeader,
  ClearLensScreen,
  ClearLensSegmentedControl,
} from '@/src/components/clearLens/ClearLensPrimitives';
import { PortfolioDisclaimer } from '@/src/components/clearLens/PortfolioDisclaimer';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import {
  formatClearLensCurrencyDelta,
  formatClearLensPercentDelta,
} from '@/src/utils/clearLensFormat';
import { isMaturedScheme } from '@/src/utils/navUtils';
import { ResponsiveRouteFrame } from '@/src/components/responsive';
import { formatNavDate } from '@/src/components/clearLens/fund-detail/fundDetailTabShared';
import {
  getMountedFundDetailModule,
  resolveFundDetailEntryState,
  usePerformanceChartReadiness,
  type FundDetailTab,
} from '@/src/components/clearLens/fund-detail/fundDetailTransition';

const FundDetailPerformanceContent = lazy(
  () => import('@/src/components/clearLens/fund-detail/FundDetailPerformanceContent'),
);
const FundDetailNavContent = lazy(
  () => import('@/src/components/clearLens/fund-detail/FundDetailNavContent'),
);
const FundDetailCompositionContent = lazy(
  () => import('@/src/components/clearLens/fund-detail/FundDetailCompositionContent'),
);

function FundDetailTabLoading({ label }: { label: string }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeClearDetailStyles(tokens), [tokens]);

  return (
    <ClearLensCard style={styles.navUnavailableCard}>
      <ActivityIndicator size="small" color={tokens.colors.emeraldDeep} />
      <Text style={styles.navUnavailableCardTitle}>{label}</Text>
    </ClearLensCard>
  );
}
function ClearLensFundDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useTrackInsightViewed('fund_detail', id ?? null);
  const router = useRouter();
  const isFocused = useIsFocused();
  const [activeTab, setActiveTab] = useState<FundDetailTab>('performance');
  const cachedFund = useCachedFundCard(id);
  const { data, isLoading, isError, isSuccess } = useFundDetail(id, { enabled: isFocused });
  // Full NAV history is fetched in parallel as a background query. The
  // header card / metadata / XIRR render off `data` (small fetch), and
  // the charts gate on `navHistory.length > 1` so they show their own
  // empty/skeleton state until the paginated history arrives.
  const schemeCode = data?.schemeCode ?? cachedFund?.schemeCode;
  const { data: navHistoryFull } = useFundNavHistory(schemeCode, { enabled: isFocused });
  const navHistory = navHistoryFull ?? data?.navHistory ?? cachedFund?.navHistory30d ?? [];
  // See ClearLensPortfolioScreen for rationale — `useIsRestoring` keeps
  // the "Couldn't load fund data" / spinner branches from racing the
  // persister rehydrate.
  const isRestoring = useIsRestoring();
  const entryState = resolveFundDetailEntryState({
    isRestoring,
    isLoading,
    isError,
    isSuccess,
    hasDetail: !!data,
    hasCachedFund: !!cachedFund,
  });
  const { session } = useSession();
  const userId = session?.user.id;
  const tokens = useClearLensTokens();
  const clearDetailStyles = useMemo(() => makeClearDetailStyles(tokens), [tokens]);
  const fundRef = useMemo<FundRef | undefined>(
    () => data ? { id: data.id, schemeCode: data.schemeCode } : undefined,
    [data],
  );
  const chartsReady = usePerformanceChartReadiness(isFocused, activeTab);

  if (entryState === 'loading') {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <View style={clearDetailStyles.centered}>
          <ActivityIndicator size="large" color={tokens.colors.emerald} />
        </View>
      </ClearLensScreen>
    );
  }

  if (entryState === 'error') {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <View style={clearDetailStyles.centered}>
          <Ionicons name="alert-circle-outline" size={40} color={tokens.colors.textTertiary} />
          <Text style={clearDetailStyles.errorText}>Couldn&apos;t load fund data</Text>
        </View>
      </ClearLensScreen>
    );
  }
  const hero = data ?? cachedFund;
  if (!hero) return null;

  const latestNavDate = navHistory[navHistory.length - 1]?.date ?? null;
  const todayIso = new Date().toISOString().split('T')[0];
  const isMatured = isMaturedScheme(hero.schemeActive, hero.schemeName);
  // Matured schemes have intentionally frozen NAV — suppress the stale label.
  const navIsStale = !isMatured && latestNavDate !== null && latestNavDate !== todayIso;
  const navUnavailable = hero.currentValue === null;
  const gain = hero.currentValue !== null ? hero.currentValue - hero.investedAmount : null;
  const gainPct = gain !== null && hero.investedAmount > 0 ? (gain / hero.investedAmount) * 100 : null;
  const heroXirr = 'fundXirr' in hero ? hero.fundXirr : hero.returnXirr;
  const hasSignalRow = (gain !== null && gainPct !== null) || Number.isFinite(heroXirr);
  const hasRealizedActivity = hero.realizedAmount > 0 || hero.redeemedUnits > 0;
  const mountedModule = getMountedFundDetailModule({
    activeTab,
    hasDetail: !!data,
    navUnavailable,
    performanceReady: chartsReady,
  });

  return (
    <ClearLensScreen>
      <ClearLensHeader onPressBack={() => router.back()} />
      <ScrollView contentContainerStyle={clearDetailStyles.scroll} showsVerticalScrollIndicator={false}>
        <ClearLensCard style={clearDetailStyles.heroCard}>
          <View style={clearDetailStyles.heroTitleRow}>
            <View style={clearDetailStyles.heroTitleBlock}>
              <Text style={clearDetailStyles.fundName}>{hero.schemeName}</Text>
              <Text style={clearDetailStyles.category}>{hero.schemeCategory || 'Fund'}</Text>
            </View>
            {isMatured && (
              <View style={clearDetailStyles.maturedBadge}>
                <Text style={clearDetailStyles.maturedBadgeText}>Matured</Text>
              </View>
            )}
          </View>

          {navUnavailable && (
            <View style={clearDetailStyles.navUnavailableBanner}>
              <Ionicons name="information-circle-outline" size={16} color={tokens.colors.textTertiary} />
              <Text style={clearDetailStyles.navUnavailableText}>
                NAV data unavailable for this scheme. Units and cost are shown below; this fund is excluded from portfolio totals.
              </Text>
            </View>
          )}

          <View style={clearDetailStyles.statsRow}>
            <View style={clearDetailStyles.statCell}>
              <Text style={clearDetailStyles.statLabel} numberOfLines={1}>Current value</Text>
              <Text style={clearDetailStyles.statValue}>
                {hero.currentValue !== null ? formatCurrency(hero.currentValue) : '—'}
              </Text>
              {navIsStale && latestNavDate && (
                <Text style={clearDetailStyles.statHint}>as of {formatNavDate(latestNavDate)}</Text>
              )}
              {isMatured && latestNavDate && (
                <Text style={clearDetailStyles.statHint}>maturity NAV {formatNavDate(latestNavDate)}</Text>
              )}
            </View>
            <View style={clearDetailStyles.statCell}>
              <Text style={clearDetailStyles.statLabel} numberOfLines={1}>Cost basis</Text>
              <Text style={clearDetailStyles.statValue}>{formatCurrency(hero.investedAmount)}</Text>
              {hasRealizedActivity && (
                <Text style={clearDetailStyles.statHint}>after redemptions</Text>
              )}
            </View>
            <View style={clearDetailStyles.statCell}>
              <Text style={clearDetailStyles.statLabel} numberOfLines={1}>Units</Text>
              <Text style={clearDetailStyles.statValue}>{hero.currentUnits.toFixed(3)}</Text>
            </View>
          </View>

          {hasSignalRow && (
            <View style={clearDetailStyles.signalBox}>
              {gain !== null && gainPct !== null && (
                <View style={clearDetailStyles.signalCell}>
                  <Text style={clearDetailStyles.statLabel}>Gain</Text>
                  <Text style={[clearDetailStyles.signalValue, { color: gain >= 0 ? tokens.colors.emeraldDeep : tokens.colors.negative }]}>
                    {formatClearLensCurrencyDelta(gain)}
                    <Text style={clearDetailStyles.signalInline}> ({formatClearLensPercentDelta(gainPct, 1)})</Text>
                  </Text>
                </View>
              )}
              {gain !== null && gainPct !== null && Number.isFinite(heroXirr) && (
                <View style={clearDetailStyles.signalDivider} />
              )}
              {Number.isFinite(heroXirr) && (
                <View style={clearDetailStyles.signalCell}>
                  <Text style={clearDetailStyles.statLabel}>XIRR</Text>
                  <View style={clearDetailStyles.xirrSignalLine}>
                    <Text style={[clearDetailStyles.signalValue, { color: heroXirr >= 0 ? tokens.colors.emeraldDeep : tokens.colors.negative }]}>
                      {formatXirr(heroXirr)}
                    </Text>
                    <Text style={clearDetailStyles.xirrHint}>p.a.</Text>
                  </View>
                </View>
              )}
            </View>
          )}

          {hasRealizedActivity && (
            <View style={clearDetailStyles.realizedBox}>
              <View style={clearDetailStyles.realizedCell}>
                <Text style={clearDetailStyles.statLabel}>Redeemed</Text>
                <Text style={clearDetailStyles.realizedValue}>{formatCurrency(hero.realizedAmount)}</Text>
              </View>
              <View style={clearDetailStyles.signalDivider} />
              <View style={clearDetailStyles.realizedCell}>
                <Text style={clearDetailStyles.statLabel}>Booked P&amp;L</Text>
                <Text
                  style={[
                    clearDetailStyles.realizedValue,
                    { color: hero.realizedGain >= 0 ? tokens.colors.emeraldDeep : tokens.colors.negative },
                  ]}
                >
                  {formatClearLensCurrencyDelta(hero.realizedGain)}
                </Text>
              </View>
            </View>
          )}

          <TouchableOpacity
            style={clearDetailStyles.transactionsAction}
            onPress={() => router.push(`/money-trail?fundId=${hero.id}`)}
            activeOpacity={0.76}
          >
            <Ionicons name="receipt-outline" size={18} color={tokens.colors.emeraldDeep} />
            <Text style={clearDetailStyles.transactionsActionText}>View fund transactions</Text>
            <Ionicons name="arrow-forward" size={16} color={tokens.colors.emeraldDeep} />
          </TouchableOpacity>
        </ClearLensCard>

        <ClearLensSegmentedControl
          selected={activeTab}
          onChange={setActiveTab}
          options={[
            { value: 'performance', label: 'Performance' },
            { value: 'nav', label: 'NAV & Facts' },
            { value: 'composition', label: 'Mix & Weight' },
          ]}
        />

        {activeTab === 'performance' && !data && (
          <ClearLensCard style={clearDetailStyles.navUnavailableCard}>
            <ActivityIndicator size="small" color={tokens.colors.emeraldDeep} />
            <Text style={clearDetailStyles.navUnavailableCardTitle}>Loading performance</Text>
          </ClearLensCard>
        )}

        {activeTab === 'performance' && data && (
          navUnavailable ? (
            <ClearLensCard style={clearDetailStyles.navUnavailableCard}>
              <Ionicons name="bar-chart-outline" size={32} color={tokens.colors.textTertiary} />
              <Text style={clearDetailStyles.navUnavailableCardTitle}>NAV unavailable for this scheme</Text>
              <Text style={clearDetailStyles.navUnavailableCardBody}>
                Performance charts require NAV history, which hasn&apos;t been synced for this scheme yet.
                The data above shows your units and cost basis.
              </Text>
            </ClearLensCard>
          ) : mountedModule === 'performance' ? (
            <Suspense fallback={<FundDetailTabLoading label="Loading performance" />}>
              <FundDetailPerformanceContent
                navHistory={navHistory}
                fundBenchmarkIndex={data.benchmarkIndex ?? null}
                fundBenchmarkSymbol={data.benchmarkSymbol ?? null}
                fundRef={fundRef}
                userId={userId}
                isFocused={isFocused}
              />
            </Suspense>
          ) : (
            <ClearLensCard style={clearDetailStyles.navUnavailableCard}>
              <ActivityIndicator size="small" color={tokens.colors.emeraldDeep} />
              <Text style={clearDetailStyles.navUnavailableCardTitle}>Preparing charts</Text>
            </ClearLensCard>
          )
        )}

        {activeTab === 'nav' && !data && (
          <ClearLensCard style={clearDetailStyles.navUnavailableCard}>
            <ActivityIndicator size="small" color={tokens.colors.emeraldDeep} />
            <Text style={clearDetailStyles.navUnavailableCardTitle}>Loading fund facts</Text>
          </ClearLensCard>
        )}

        {mountedModule === 'nav' && data && (
          <>
            <Suspense fallback={<FundDetailTabLoading label="Loading fund facts" />}>
              <FundDetailNavContent navHistory={navHistory} data={data} />
            </Suspense>
          </>
        )}

        {activeTab === 'composition' && !data && (
          <ClearLensCard style={clearDetailStyles.navUnavailableCard}>
            <ActivityIndicator size="small" color={tokens.colors.emeraldDeep} />
            <Text style={clearDetailStyles.navUnavailableCardTitle}>Loading portfolio mix</Text>
          </ClearLensCard>
        )}

        {mountedModule === 'composition' && data && (
          <>
            <Suspense fallback={<FundDetailTabLoading label="Loading portfolio mix" />}>
              <FundDetailCompositionContent
                schemeCode={data.schemeCode}
                fundId={data.id}
                currentValue={data.currentValue}
                userId={userId}
                isFocused={isFocused}
              />
            </Suspense>
          </>
        )}

        <PortfolioDisclaimer />
      </ScrollView>
    </ClearLensScreen>
  );
}

export default function FundDetailScreen() {
  return (
    <ResponsiveRouteFrame>
      <Stack.Screen options={{ headerShown: false, title: '' }} />
      <ClearLensFundDetailScreen />
    </ResponsiveRouteFrame>
  );
}

function makeClearDetailStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
  scroll: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingBottom: ClearLensSpacing.xxl,
    gap: ClearLensSpacing.md,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: ClearLensSpacing.md,
  },
  errorText: {
    ...ClearLensTypography.body,
    color: cl.textSecondary,
  },
  heroCard: {
    gap: ClearLensSpacing.md,
  },
  heroTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: ClearLensSpacing.sm,
  },
  heroTitleBlock: {
    flex: 1,
    gap: 5,
  },
  fundName: {
    ...ClearLensTypography.h2,
    color: cl.navy,
  },
  category: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
    fontFamily: ClearLensFonts.semiBold,
  },
  statsRow: {
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
  },
  statCell: {
    flex: 1,
    gap: 4,
  },
  statLabel: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    textTransform: 'uppercase',
    fontSize: 10,
    letterSpacing: 0.7,
  },
  statValue: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  statHint: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    fontStyle: 'italic',
  },
  maturedBadge: {
    backgroundColor: cl.textTertiary + '22',
    borderRadius: ClearLensRadii.sm,
    paddingHorizontal: ClearLensSpacing.sm,
    paddingVertical: 3,
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  maturedBadgeText: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    fontFamily: ClearLensFonts.semiBold,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontSize: 10,
  },
  navUnavailableBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: ClearLensSpacing.xs,
    backgroundColor: cl.background,
    borderRadius: ClearLensRadii.sm,
    padding: ClearLensSpacing.sm,
  },
  navUnavailableText: {
    flex: 1,
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
    lineHeight: 18,
  },
  navUnavailableCard: {
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    paddingVertical: ClearLensSpacing.xl,
  },
  navUnavailableCardTitle: {
    ...ClearLensTypography.h3,
    color: cl.textSecondary,
    textAlign: 'center',
  },
  navUnavailableCardBody: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
    textAlign: 'center',
    lineHeight: 18,
    maxWidth: 320,
  },
  gainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    flexWrap: 'wrap',
  },
  gainValue: {
    ...ClearLensTypography.h3,
  },
  signalBox: {
    minHeight: 56,
    padding: ClearLensSpacing.sm,
    borderRadius: ClearLensRadii.md,
    backgroundColor: tokens.semantic.sentiment.positiveSurface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  signalCell: {
    flex: 1,
    gap: 3,
  },
  signalDivider: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: cl.mint,
  },
  signalValue: {
    ...ClearLensTypography.h3,
  },
  signalInline: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.medium,
  },
  realizedBox: {
    minHeight: 56,
    padding: ClearLensSpacing.sm,
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.surfaceSoft,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  realizedCell: {
    flex: 1,
    gap: 3,
  },
  realizedValue: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  transactionsAction: {
    minHeight: 46,
    borderRadius: ClearLensRadii.md,
    borderWidth: 1,
    borderColor: cl.borderLight,
    backgroundColor: cl.surfaceSoft,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: ClearLensSpacing.sm,
  },
  transactionsActionText: {
    ...ClearLensTypography.bodySmall,
    color: cl.emeraldDeep,
    fontFamily: ClearLensFonts.bold,
  },
  xirrSignalLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: ClearLensSpacing.xs,
    flexWrap: 'wrap',
  },
  xirrRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.xs,
    flexWrap: 'wrap',
  },
  xirrValue: {
    ...ClearLensTypography.h3,
  },
  xirrHint: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
  },
  benchmarkPill: {
    minHeight: 40,
    alignSelf: 'flex-end',
    marginTop: -ClearLensSpacing.xs,
    paddingHorizontal: ClearLensSpacing.md,
    borderRadius: ClearLensRadii.full,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    backgroundColor: tokens.semantic.sentiment.positiveSurface,
  },
  benchmarkPillNegative: {
    backgroundColor: tokens.semantic.sentiment.negativeSurface,
  },
  benchmarkPillText: {
    ...ClearLensTypography.bodySmall,
    color: tokens.semantic.sentiment.positiveText,
    fontFamily: ClearLensFonts.semiBold,
  },
  benchmarkPillTextNegative: {
    color: tokens.semantic.sentiment.negativeText,
  },
  noteCard: {
    marginHorizontal: ClearLensSpacing.md,
  },
  noteText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
  },
});
}
