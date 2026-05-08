import { useMemo } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import {
  AssetAllocationPreview,
  BenchmarkComparisonCard,
  EntryRows,
  InvestmentVsBenchmarkChart,
  MoversRow,
  PortfolioEmptyState,
  PortfolioHero,
} from '@/src/components/clearLens/screens/ClearLensPortfolioScreen';
import { ClearLensCard } from '@/src/components/clearLens/ClearLensPrimitives';
import { MoneyTrailPreviewCard } from '@/src/components/clearLens/MoneyTrailPreviewCard';
import { usePortfolio } from '@/src/hooks/usePortfolio';
import { usePortfolioInsights } from '@/src/hooks/usePortfolioInsights';
import { useMoneyTrail } from '@/src/hooks/useMoneyTrail';
import type { FundRef } from '@/src/hooks/usePortfolioTimeline';
import { useSession } from '@/src/hooks/useSession';
import { useAppStore } from '@/src/store/appStore';
import { MaxContentWidth } from '@/src/components/responsive';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';

export function ClearLensPortfolioScreenDesktop() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const router = useRouter();
  const { session } = useSession();
  const userId = session?.user.id;
  const { defaultBenchmarkSymbol, setDefaultBenchmarkSymbol } = useAppStore();

  const { data, isLoading, isError, refetch } = usePortfolio(defaultBenchmarkSymbol);
  const fundCards = useMemo(() => data?.fundCards ?? [], [data?.fundCards]);
  const summary = data?.summary ?? null;
  const fundRefs: FundRef[] = useMemo(
    () => fundCards.map((fund) => ({ id: fund.id, schemeCode: fund.schemeCode })),
    [fundCards],
  );
  const { insights, isLoading: insightsLoading } = usePortfolioInsights(fundCards);
  const { data: moneyTrailData, isLoading: moneyTrailLoading } = useMoneyTrail();

  if (isLoading) {
    return (
      <CenteredFrame>
        <ActivityIndicator size="large" color={tokens.colors.emerald} />
      </CenteredFrame>
    );
  }

  if (isError) {
    return (
      <CenteredFrame>
        <Text style={styles.errorText}>Failed to load portfolio.</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => refetch()} activeOpacity={0.78}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </CenteredFrame>
    );
  }

  if (!summary || fundCards.length === 0) {
    return (
      <CenteredFrame>
        <PortfolioEmptyState onImport={() => router.push('/onboarding')} />
      </CenteredFrame>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.frame}>
        <View style={styles.titleBlock}>
          <Text style={styles.eyebrow}>Portfolio</Text>
          <Text style={styles.title}>Your dashboard</Text>
          <Text style={styles.subtitle}>SIP-aware returns, benchmark clarity, and your real progress.</Text>
        </View>

        <PortfolioHero
          totalValue={summary.totalValue}
          totalInvested={summary.totalInvested}
          dailyChangeAmount={summary.dailyChangeAmount}
          dailyChangePct={summary.dailyChangePct}
          xirr={summary.xirr}
        />

        <BenchmarkComparisonCard
          xirr={summary.xirr}
          marketXirr={summary.marketXirr}
          benchmarkSymbol={defaultBenchmarkSymbol}
          onBenchmarkChange={setDefaultBenchmarkSymbol}
        />

        <View style={styles.gridTwoCol}>
          <View style={styles.gridMain}>
            <InvestmentVsBenchmarkChart
              funds={fundRefs}
              userId={userId}
              benchmarkSymbol={defaultBenchmarkSymbol}
            />

            <MoversRow fundCards={fundCards} />

            <EntryRows
              onInsights={() => router.push('/portfolio-insights')}
              onFunds={() => router.push('/funds')}
              onTools={() => router.push('/tools' as never)}
            />
          </View>

          <View style={styles.gridSide}>
            {insights ? (
              <AssetAllocationPreview
                totalValue={insights.totalValue}
                equityPct={insights.assetMix.equity}
                debtPct={insights.assetMix.debt}
                cashPct={insights.assetMix.cash + insights.assetMix.other}
              />
            ) : insightsLoading ? (
              <ClearLensCard style={styles.sidePanelLoading}>
                <ActivityIndicator size="small" color={tokens.colors.emerald} />
              </ClearLensCard>
            ) : null}

            {moneyTrailData ? (
              <MoneyTrailPreviewCard
                annualFlows={moneyTrailData.annualFlows}
                onPress={() => router.push('/money-trail')}
              />
            ) : moneyTrailLoading ? (
              <ClearLensCard style={styles.sidePanelLoading}>
                <ActivityIndicator size="small" color={tokens.colors.emerald} />
              </ClearLensCard>
            ) : null}

            <TouchableOpacity
              style={styles.exploreCard}
              onPress={() => router.push('/(tabs)/wealth-journey' as never)}
              activeOpacity={0.78}
            >
              <View style={styles.exploreIcon}>
                <Ionicons name="calculator-outline" size={18} color={tokens.colors.emerald} />
              </View>
              <View style={styles.exploreCopy}>
                <Text style={styles.exploreTitle}>Wealth Journey</Text>
                <Text style={styles.exploreSub}>Project where your portfolio is headed.</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={tokens.colors.textTertiary} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

function CenteredFrame({ children }: { children: React.ReactNode }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.centered}>
      <View style={styles.centeredCard}>{children}</View>
    </View>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: cl.background,
  },
  scrollContent: {
    paddingHorizontal: ClearLensSpacing.xl,
    paddingTop: ClearLensSpacing.xl,
    paddingBottom: ClearLensSpacing.xxl,
    alignItems: 'center',
  },
  frame: {
    width: '100%',
    maxWidth: MaxContentWidth,
    gap: ClearLensSpacing.md,
  },
  titleBlock: {
    gap: 4,
    marginBottom: ClearLensSpacing.xs,
  },
  eyebrow: {
    ...ClearLensTypography.label,
    color: cl.emerald,
    textTransform: 'uppercase',
  },
  title: {
    ...ClearLensTypography.h1,
    color: cl.navy,
  },
  subtitle: {
    ...ClearLensTypography.body,
    color: cl.textSecondary,
  },
  gridTwoCol: {
    flexDirection: 'row',
    gap: ClearLensSpacing.md,
    alignItems: 'flex-start',
  },
  gridMain: {
    flex: 2,
    gap: ClearLensSpacing.md,
    minWidth: 0,
  },
  gridSide: {
    flex: 1,
    gap: ClearLensSpacing.md,
    minWidth: 0,
  },
  sidePanelLoading: {
    minHeight: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  exploreCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    backgroundColor: cl.surface,
    borderRadius: ClearLensRadii.lg,
    borderWidth: 1,
    borderColor: cl.border,
    paddingHorizontal: ClearLensSpacing.md,
    paddingVertical: ClearLensSpacing.sm,
  },
  exploreIcon: {
    width: 36,
    height: 36,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.mint50,
  },
  exploreCopy: {
    flex: 1,
    gap: 2,
  },
  exploreTitle: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.semiBold,
  },
  exploreSub: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: ClearLensSpacing.xl,
  },
  centeredCard: {
    width: '100%',
    maxWidth: 480,
    alignItems: 'center',
    gap: ClearLensSpacing.md,
  },
  errorText: {
    ...ClearLensTypography.body,
    color: cl.textSecondary,
  },
  retryButton: {
    minHeight: 42,
    paddingHorizontal: ClearLensSpacing.lg,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.emerald,
  },
  retryButtonText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textOnDark,
    fontFamily: ClearLensFonts.bold,
  },
});
}
