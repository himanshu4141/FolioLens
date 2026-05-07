import { useMemo } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ClearLensCard } from '@/src/components/clearLens/ClearLensPrimitives';
import { usePortfolio, type FundCardData } from '@/src/hooks/usePortfolio';
import { usePortfolioInsights } from '@/src/hooks/usePortfolioInsights';
import { useAppStore, type FundsSortOption } from '@/src/store/appStore';
import { formatCurrency } from '@/src/utils/formatting';
import { formatXirr } from '@/src/utils/xirr';
import { parseFundName } from '@/src/utils/fundName';
import { MaxContentWidth } from '@/src/components/responsive';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensSemanticColors,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  formatClearLensCurrencyDelta,
  formatClearLensPercentDelta,
} from '@/src/utils/clearLensFormat';

type SortOption = FundsSortOption;

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'currentValue', label: 'Current value' },
  { value: 'invested', label: 'Invested' },
  { value: 'xirr', label: 'XIRR' },
  { value: 'benchmarkLead', label: 'Lead vs benchmark' },
  { value: 'dailyChange', label: '1 day change' },
  { value: 'alphabetical', label: 'Alphabetical' },
];

const CLEAR_LENS_RED = ClearLensSemanticColors.sentiment.negative;

function sortableNumber(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

export function ClearLensFundsScreenDesktop() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const router = useRouter();
  const {
    defaultBenchmarkSymbol,
    fundsSortBy: sortBy,
    setFundsSortBy: setSortBy,
    fundsSearchQuery: searchQuery,
    setFundsSearchQuery: setSearchQuery,
  } = useAppStore();

  const { data, isLoading } = usePortfolio(defaultBenchmarkSymbol);
  const fundCards = useMemo(() => data?.fundCards ?? [], [data?.fundCards]);
  const summary = data?.summary ?? null;
  const { insights } = usePortfolioInsights(fundCards);
  const benchmarkXirr = summary?.marketXirr ?? 0;

  const allocationPctByFundId = useMemo(() => {
    const map = new Map<string, number>();
    const totalValue = summary?.totalValue ?? 0;
    if (totalValue > 0) {
      for (const fund of fundCards) {
        if (fund.currentValue != null) {
          map.set(fund.id, (fund.currentValue / totalValue) * 100);
        }
      }
    }
    for (const item of insights?.fundAllocation ?? []) map.set(item.fundId, item.pct);
    return map;
  }, [fundCards, insights?.fundAllocation, summary?.totalValue]);

  const sortedFunds = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const funds = fundCards.filter((fund) => {
      if (!query) return true;
      return fund.schemeName.toLowerCase().includes(query) || fund.schemeCategory.toLowerCase().includes(query);
    });

    return [...funds].sort((a, b) => {
      switch (sortBy) {
        case 'invested':
          return sortableNumber(b.investedAmount) - sortableNumber(a.investedAmount);
        case 'xirr':
          return sortableNumber(b.returnXirr) - sortableNumber(a.returnXirr);
        case 'benchmarkLead':
          return sortableNumber(b.returnXirr - benchmarkXirr) - sortableNumber(a.returnXirr - benchmarkXirr);
        case 'dailyChange':
          return sortableNumber(b.dailyChangePct) - sortableNumber(a.dailyChangePct);
        case 'alphabetical':
          return parseFundName(a.schemeName).base.localeCompare(parseFundName(b.schemeName).base);
        case 'currentValue':
        default:
          return sortableNumber(b.currentValue) - sortableNumber(a.currentValue);
      }
    });
  }, [benchmarkXirr, fundCards, searchQuery, sortBy]);

  const fundsWithValue = useMemo(
    () => fundCards.filter((fund) => fund.currentValue != null && fund.currentValue > 0),
    [fundCards],
  );
  const valueSortedFunds = useMemo(
    () => [...fundsWithValue].sort((a, b) => sortableNumber(b.currentValue) - sortableNumber(a.currentValue)),
    [fundsWithValue],
  );
  const allocationSegments = useMemo(
    () =>
      valueSortedFunds.map((fund, index) => ({
        id: fund.id,
        pct: allocationPctByFundId.get(fund.id) ?? 0,
        color: ClearLensSemanticColors.fundAllocation[
          index % ClearLensSemanticColors.fundAllocation.length
        ],
      })).filter((segment) => segment.pct > 0),
    [allocationPctByFundId, valueSortedFunds],
  );
  const largestFund = valueSortedFunds[0] ?? null;
  const largestPct = largestFund ? allocationPctByFundId.get(largestFund.id) ?? null : null;
  const top3Pct = valueSortedFunds
    .slice(0, 3)
    .reduce((sum, fund) => sum + (allocationPctByFundId.get(fund.id) ?? 0), 0);

  // Today's mover within the user's funds — leaderboard / laggard for the day,
  // not a portfolio metric.
  const fundsWithDaily = useMemo(
    () => fundCards.filter((fund) => fund.dailyChangePct != null),
    [fundCards],
  );
  const dailySorted = useMemo(
    () => [...fundsWithDaily].sort((a, b) => (b.dailyChangePct ?? 0) - (a.dailyChangePct ?? 0)),
    [fundsWithDaily],
  );
  const todaysBest = dailySorted[0] ?? null;
  const todaysWorst = dailySorted.length > 1 ? dailySorted[dailySorted.length - 1] : null;

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={tokens.colors.emerald} />
      </View>
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
          <Text style={styles.eyebrow}>Funds</Text>
          <Text style={styles.title}>Your Funds</Text>
          <Text style={styles.subtitle}>
            How your {fundCards.length} holding{fundCards.length === 1 ? '' : 's'} stack up — concentration, daily movers, and per-fund metrics.
          </Text>
        </View>

        {summary && fundCards.length > 0 && (
          <ClearLensCard style={styles.summaryCard}>
            <Text style={styles.summaryEyebrow}>Allocation overview</Text>

            {allocationSegments.length > 0 && (
              <View style={styles.allocationStrip}>
                {allocationSegments.map((segment) => (
                  <View
                    key={segment.id}
                    style={[
                      styles.allocationSegment,
                      // Floor at 4 so sub-1% slivers don't disappear in dark.
                      { flex: Math.max(segment.pct, 4), backgroundColor: segment.color },
                    ]}
                  />
                ))}
              </View>
            )}

            <View style={styles.summaryGrid}>
              <SummaryMetric label="Holdings" value={String(fundCards.length)} />
              <View style={styles.summaryDivider} />
              <SummaryMetric
                label="Top 3 concentration"
                value={`${top3Pct.toFixed(1)}%`}
              />
              <View style={styles.summaryDivider} />
              <View style={styles.summaryMetricWide}>
                <Text style={styles.summaryLabel}>Largest holding</Text>
                {largestFund ? (
                  <>
                    <Text style={styles.summaryValue} numberOfLines={1}>
                      {parseFundName(largestFund.schemeName).base}
                    </Text>
                    <Text style={styles.summarySub} numberOfLines={1}>
                      {largestPct != null ? `${largestPct.toFixed(1)}% of portfolio` : '—'}
                    </Text>
                  </>
                ) : (
                  <Text style={styles.summaryValue}>—</Text>
                )}
              </View>
            </View>

            {(todaysBest || todaysWorst) && (
              <View style={styles.summaryMoversRow}>
                {todaysBest && (
                  <MoverChip
                    label="Today's best"
                    fund={todaysBest}
                    tone="positive"
                  />
                )}
                {todaysWorst && todaysWorst.id !== todaysBest?.id && (
                  <MoverChip
                    label="Today's worst"
                    fund={todaysWorst}
                    tone="negative"
                  />
                )}
              </View>
            )}
          </ClearLensCard>
        )}

        <View style={styles.controls}>
          <View style={styles.searchBox}>
            <Ionicons name="search-outline" size={18} color={tokens.colors.textTertiary} />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search funds"
              placeholderTextColor={tokens.colors.textTertiary}
              style={styles.searchInput}
            />
          </View>
          <View style={styles.sortRow}>
            {SORT_OPTIONS.map((option) => (
              <TouchableOpacity
                key={option.value}
                style={[styles.sortChip, sortBy === option.value && styles.sortChipActive]}
                onPress={() => setSortBy(option.value)}
                activeOpacity={0.78}
              >
                <Text
                  style={[
                    styles.sortChipText,
                    sortBy === option.value && styles.sortChipTextActive,
                  ]}
                >
                  {option.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={styles.listHeader}>
          <Text style={styles.listTitle}>{sortedFunds.length} fund{sortedFunds.length === 1 ? '' : 's'}</Text>
          <Text style={styles.listMeta}>Click a card to open the detail page</Text>
        </View>

        <View style={styles.grid}>
          {sortedFunds.map((fund) => (
            <FundDesktopCard
              key={fund.id}
              fund={fund}
              portfolioPct={allocationPctByFundId.get(fund.id) ?? null}
              benchmarkXirr={benchmarkXirr}
              onOpen={() => router.push(`/fund/${fund.id}`)}
            />
          ))}
          {sortedFunds.length === 0 && (
            <ClearLensCard style={styles.emptyCard}>
              <Ionicons name="search-outline" size={28} color={tokens.colors.textTertiary} />
              <Text style={styles.emptyText}>No funds match your search.</Text>
            </ClearLensCard>
          )}
        </View>
      </View>
    </ScrollView>
  );
}

function SummaryMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'negative';
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const valueColor =
    tone === 'positive' ? tokens.colors.emerald : tone === 'negative' ? CLEAR_LENS_RED : tokens.colors.navy;
  return (
    <View style={styles.summaryMetric}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={[styles.summaryValue, { color: valueColor }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function MoverChip({
  label,
  fund,
  tone,
}: {
  label: string;
  fund: FundCardData;
  tone: 'positive' | 'negative';
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const color = tone === 'positive' ? tokens.colors.emerald : CLEAR_LENS_RED;
  const surface = tone === 'positive'
    ? tokens.semantic.sentiment.positiveSurface
    : tokens.semantic.sentiment.negativeSurface;
  const pct = fund.dailyChangePct ?? 0;
  return (
    <View style={[styles.moverChip, { backgroundColor: surface }]}>
      <Text style={[styles.moverChipLabel, { color }]} numberOfLines={1}>{label}</Text>
      <Text style={styles.moverChipName} numberOfLines={1}>{parseFundName(fund.schemeName).base}</Text>
      <Text style={[styles.moverChipDelta, { color }]}>{formatClearLensPercentDelta(pct)}</Text>
    </View>
  );
}

function FundDesktopCard({
  fund,
  portfolioPct,
  benchmarkXirr,
  onOpen,
}: {
  fund: FundCardData;
  portfolioPct: number | null;
  benchmarkXirr: number;
  onOpen: () => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const { base, planBadge } = parseFundName(fund.schemeName);
  const dailyColor = (fund.dailyChangePct ?? 0) >= 0 ? tokens.colors.emerald : CLEAR_LENS_RED;
  const alphaPpRaw = (fund.returnXirr - benchmarkXirr) * 100;
  // Round before sign-deciding so a value that rounds to 0.0 renders neutrally
  // ("±0.0 pp") rather than negative ("-0.0 pp") with a red badge.
  const alphaPp = Math.round(alphaPpRaw * 10) / 10;
  const ahead = alphaPp >= 0;
  const xirrColor = ahead ? tokens.colors.emerald : CLEAR_LENS_RED;
  const alphaSign = alphaPp > 0 ? '+' : alphaPp < 0 ? '' : '±';
  const isDebtLike = /debt|liquid|gilt|income|overnight|money market|ultra short/i.test(fund.schemeCategory);
  const accentColor = isDebtLike
    ? tokens.semantic.asset.debt
    : tokens.semantic.asset.equity;
  const gain = fund.currentValue != null ? fund.currentValue - fund.investedAmount : null;
  const gainPct = gain != null && fund.investedAmount > 0 ? (gain / fund.investedAmount) * 100 : null;
  const gainColor = (gain ?? 0) >= 0 ? tokens.colors.emerald : CLEAR_LENS_RED;

  return (
    <TouchableOpacity onPress={onOpen} activeOpacity={0.78} style={styles.cardOuter}>
      <ClearLensCard style={[styles.fundCard, { borderLeftColor: accentColor }]}>
        {/* Title row */}
        <View style={styles.cardTop}>
          <View style={styles.cardName}>
            <Text style={styles.cardTitle} numberOfLines={2}>{base}</Text>
            <Text style={styles.cardMeta} numberOfLines={1}>
              {fund.schemeCategory}{planBadge ? ` · ${planBadge}` : ''}
              {portfolioPct != null ? ` · ${portfolioPct.toFixed(1)}% of portfolio` : ''}
            </Text>
          </View>
          <View
            style={[
              styles.alphaBadge,
              { backgroundColor: ahead ? tokens.semantic.sentiment.positiveSurface : tokens.semantic.sentiment.negativeSurface },
            ]}
          >
            <Text style={[styles.alphaBadgeText, { color: xirrColor }]}>
              {alphaSign}{Math.abs(alphaPp).toFixed(1)} pp vs benchmark
            </Text>
          </View>
        </View>

        {/* Primary metric — current value */}
        <View style={styles.primaryRow}>
          <View style={styles.primaryValueBlock}>
            <Text style={styles.primaryLabel}>Current value</Text>
            <Text style={styles.primaryValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
              {fund.currentValue != null ? formatCurrency(fund.currentValue) : 'NAV pending'}
            </Text>
          </View>

          {/* Secondary stats — smaller, equally spaced */}
          <View style={styles.secondaryStats}>
            <SecondaryStat
              label="XIRR"
              value={formatXirr(fund.returnXirr)}
              valueColor={xirrColor}
            />
            <SecondaryStat
              label="Today"
              value={fund.dailyChangePct != null ? formatClearLensPercentDelta(fund.dailyChangePct) : '—'}
              valueColor={dailyColor}
            />
          </View>
        </View>

        {/* Footer — explicit Invested vs Gain split */}
        <View style={styles.cardFooter}>
          <View style={styles.footerCell}>
            <Text style={styles.footerLabel}>Invested</Text>
            <Text style={styles.footerValue} numberOfLines={1}>{formatCurrency(fund.investedAmount)}</Text>
          </View>
          <View style={styles.footerDivider} />
          <View style={styles.footerCell}>
            <Text style={styles.footerLabel}>Gain</Text>
            {gain != null ? (
              <Text style={[styles.footerValue, { color: gainColor }]} numberOfLines={1}>
                {formatClearLensCurrencyDelta(gain)}
                {gainPct != null ? ` (${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%)` : ''}
              </Text>
            ) : (
              <Text style={styles.footerValue}>—</Text>
            )}
          </View>
          <Ionicons name="chevron-forward" size={16} color={tokens.colors.textTertiary} />
        </View>
      </ClearLensCard>
    </TouchableOpacity>
  );
}

function SecondaryStat({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.secondaryStat}>
      <Text style={styles.secondaryLabel}>{label}</Text>
      <Text
        style={[styles.secondaryValue, { color: valueColor ?? tokens.colors.navy }]}
        numberOfLines={1}
      >
        {value}
      </Text>
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
  summaryCard: {
    paddingVertical: ClearLensSpacing.md,
    gap: ClearLensSpacing.md,
  },
  summaryEyebrow: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    textTransform: 'uppercase',
  },
  allocationStrip: {
    height: 12,
    borderRadius: ClearLensRadii.full,
    overflow: 'hidden',
    flexDirection: 'row',
    backgroundColor: cl.surfaceSoft,
  },
  allocationSegment: {
    height: '100%',
  },
  summaryGrid: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  summaryMetric: {
    flex: 1,
    gap: 4,
    paddingHorizontal: ClearLensSpacing.sm,
  },
  summaryMetricWide: {
    flex: 2,
    gap: 4,
    paddingHorizontal: ClearLensSpacing.sm,
    minWidth: 0,
  },
  summaryLabel: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    textTransform: 'uppercase',
  },
  summaryValue: {
    ...ClearLensTypography.h3,
    fontFamily: ClearLensFonts.bold,
    color: cl.navy,
  },
  summarySub: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  summaryDivider: {
    width: 1,
    backgroundColor: cl.borderLight,
    marginHorizontal: ClearLensSpacing.sm,
  },
  summaryMoversRow: {
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
  },
  moverChip: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: ClearLensSpacing.md,
    paddingVertical: ClearLensSpacing.sm,
    borderRadius: ClearLensRadii.md,
    gap: 2,
  },
  moverChipLabel: {
    ...ClearLensTypography.label,
    textTransform: 'uppercase',
    fontFamily: ClearLensFonts.bold,
  },
  moverChipName: {
    ...ClearLensTypography.bodySmall,
    color: cl.textPrimary,
    fontFamily: ClearLensFonts.semiBold,
  },
  moverChipDelta: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.bold,
  },
  controls: {
    gap: ClearLensSpacing.sm,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    paddingHorizontal: ClearLensSpacing.md,
    paddingVertical: 10,
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.surface,
    borderWidth: 1,
    borderColor: cl.border,
  },
  searchInput: {
    flex: 1,
    ...ClearLensTypography.body,
    color: cl.navy,
    outlineWidth: 0,
  } as never,
  sortRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  sortChip: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingVertical: 8,
    borderRadius: ClearLensRadii.full,
    backgroundColor: cl.surfaceSoft,
    borderWidth: 1,
    borderColor: cl.border,
  },
  sortChipActive: {
    backgroundColor: cl.mint50,
    borderColor: cl.emerald,
  },
  sortChipText: {
    ...ClearLensTypography.caption,
    fontFamily: ClearLensFonts.semiBold,
    color: cl.textSecondary,
  },
  sortChipTextActive: {
    color: cl.emeraldDeep,
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: ClearLensSpacing.sm,
  },
  listTitle: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  listMeta: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: ClearLensSpacing.md,
  },
  cardOuter: {
    flexBasis: 0,
    flexGrow: 1,
    minWidth: 360,
  },
  fundCard: {
    gap: ClearLensSpacing.sm,
    borderLeftWidth: 3,
    minHeight: 180,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: ClearLensSpacing.sm,
  },
  cardName: {
    flex: 1,
    gap: 3,
  },
  cardTitle: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  cardMeta: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  alphaBadge: {
    paddingHorizontal: ClearLensSpacing.sm,
    paddingVertical: 4,
    borderRadius: ClearLensRadii.full,
  },
  alphaBadgeText: {
    ...ClearLensTypography.caption,
    fontFamily: ClearLensFonts.bold,
  },
  primaryRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.md,
    marginTop: ClearLensSpacing.sm,
  },
  primaryValueBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  primaryLabel: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    textTransform: 'uppercase',
  },
  primaryValue: {
    fontFamily: ClearLensFonts.extraBold,
    fontSize: 28,
    lineHeight: 32,
    color: cl.navy,
  },
  secondaryStats: {
    flexDirection: 'row',
    gap: ClearLensSpacing.lg,
    alignItems: 'flex-end',
  },
  secondaryStat: {
    gap: 2,
    alignItems: 'flex-end',
  },
  secondaryLabel: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    textTransform: 'uppercase',
  },
  secondaryValue: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.bold,
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.md,
    marginTop: 'auto',
    paddingTop: ClearLensSpacing.sm,
    borderTopWidth: 1,
    borderTopColor: cl.borderLight,
  },
  footerCell: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  footerDivider: {
    width: 1,
    height: 28,
    backgroundColor: cl.borderLight,
  },
  footerLabel: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    textTransform: 'uppercase',
  },
  footerValue: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.bold,
    color: cl.navy,
  },
  emptyCard: {
    width: '100%',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    paddingVertical: ClearLensSpacing.xl,
  },
  emptyText: {
    ...ClearLensTypography.body,
    color: cl.textSecondary,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: ClearLensSpacing.xl,
  },
});
}
