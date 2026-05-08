import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Svg, { Polygon, Polyline } from 'react-native-svg';
import { AppOverflowMenu } from '@/src/components/AppOverflowMenu';
import {
  ClearLensCard,
  ClearLensHeader,
  ClearLensScreen,
} from '@/src/components/clearLens/ClearLensPrimitives';
import { usePortfolio, type FundCardData } from '@/src/hooks/usePortfolio';
import { useTrackInsightViewed } from '@/src/hooks/useTrackInsightViewed';
import { usePortfolioInsights } from '@/src/hooks/usePortfolioInsights';
import { useSession } from '@/src/hooks/useSession';
import { useAppStore } from '@/src/store/appStore';
import { formatCurrency } from '@/src/utils/formatting';
import { formatXirr } from '@/src/utils/xirr';
import { parseFundName } from '@/src/utils/fundName';
import { navStaleness } from '@/src/utils/navUtils';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensSemanticColors,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  formatClearLensCurrencyDelta,
  formatClearLensPercentDelta,
} from '@/src/utils/clearLensFormat';
import { useResponsiveLayout } from '@/src/components/responsive';
import { ClearLensFundsScreenDesktop } from '@/src/components/clearLens/screens/desktop/ClearLensFundsScreenDesktop';
import type { FundsSortOption } from '@/src/store/appStore';

// Re-export the canonical type so consumers can keep using the local name.
type SortOption = FundsSortOption;
type AllocationSegment = { id: string; pct: number; color: string };
type FundsBottomNavRoute = 'portfolio' | 'funds' | 'wealth';

const CLEAR_LENS_RED = ClearLensSemanticColors.sentiment.negative;
const CLEAR_LENS_DEBT = ClearLensSemanticColors.asset.debt;

const SORT_OPTIONS: { value: SortOption; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: 'currentValue', label: 'Current value', icon: 'trending-up-outline' },
  { value: 'invested', label: 'Invested', icon: 'calendar-outline' },
  { value: 'xirr', label: 'XIRR', icon: 'analytics-outline' },
  { value: 'benchmarkLead', label: 'Lead vs benchmark', icon: 'rocket-outline' },
  { value: 'dailyChange', label: '1 day change', icon: 'flash-outline' },
  { value: 'alphabetical', label: 'Alphabetical', icon: 'text-outline' },
];

function sortableNumber(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function FundSparkline({
  data,
  color,
  width = 260,
  height = 54,
}: {
  data: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 5;
  const linePoints = data.map((value, index) => {
    const x = (index / (data.length - 1)) * width;
    const y = height - pad - ((value - min) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const areaPoints = `0,${height} ${linePoints.join(' ')} ${width},${height}`;

  return (
    <Svg width={width} height={height}>
      <Polygon points={areaPoints} fill={color} opacity={0.12} />
      <Polyline
        points={linePoints.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function AllocationOverview({
  fundCount,
  topThreeShare,
  largestPosition,
  largestPositionPct,
  segments,
}: {
  fundCount: number;
  topThreeShare: number;
  largestPosition: string;
  largestPositionPct: number | null;
  segments: AllocationSegment[];
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <ClearLensCard style={styles.overviewCard}>
      <Text style={styles.screenEyebrow}>Allocation overview</Text>
      {segments.length > 0 && (
        <View style={styles.allocationStrip}>
          {segments.map((segment) => (
            <View
              key={segment.id}
              style={[
                styles.allocationStripSegment,
                // Floor at 4 (was 1) — a sub-1% sliver was effectively a
                // hairline in dark mode where the bg surface and the segment
                // colour fall close together. 4 still preserves visual
                // ordering across many holdings without distorting big chunks.
                { flex: Math.max(segment.pct, 4), backgroundColor: segment.color },
              ]}
            />
          ))}
        </View>
      )}
      <View style={styles.overviewGrid}>
        <View style={styles.overviewMetric}>
          <Text style={styles.overviewValue}>{fundCount}</Text>
          <Text style={styles.metricCaption}>Active funds</Text>
        </View>
        <View style={styles.overviewDivider} />
        <View style={styles.overviewMetric}>
          <Text style={styles.overviewValue}>{topThreeShare.toFixed(1)}%</Text>
          <Text style={styles.metricCaption}>In top 3 funds</Text>
        </View>
      </View>
      <View style={styles.largestBox}>
        <View style={[styles.allocationDot, { backgroundColor: tokens.colors.emerald }]} />
        <Text style={styles.largestPrefix}>Largest:</Text>
        <Text style={styles.largestName} numberOfLines={1}>{largestPosition}</Text>
        {largestPositionPct != null && (
          <Text style={styles.largestPct}>{largestPositionPct.toFixed(1)}%</Text>
        )}
      </View>
    </ClearLensCard>
  );
}

export function FundListItem({
  fund,
  portfolioPct,
  expanded,
  onToggle,
  onOpen,
  onOpenTransactions,
  latestNavDate,
}: {
  fund: FundCardData;
  portfolioPct: number | null;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onOpenTransactions: () => void;
  latestNavDate: string | null;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const { base, planBadge } = parseFundName(fund.schemeName);
  const gain = fund.currentValue != null ? fund.currentValue - fund.investedAmount : null;
  const gainPct = gain != null && fund.investedAmount > 0 ? (gain / fund.investedAmount) * 100 : null;
  const stale = navStaleness(latestNavDate);
  const isDebtLike = /debt|liquid|gilt|income|overnight|money market|ultra short/i.test(fund.schemeCategory);
  const categoryColor = isDebtLike ? CLEAR_LENS_DEBT : tokens.semantic.asset.equity;
  const dailyColor = (fund.dailyChangePct ?? 0) >= 0 ? tokens.colors.emerald : CLEAR_LENS_RED;
  const gainColor = (gain ?? 0) >= 0 ? tokens.colors.emerald : CLEAR_LENS_RED;
  const xirrColor = fund.returnXirr >= 0 ? tokens.colors.emerald : CLEAR_LENS_RED;
  const xirrLabel = Number.isFinite(fund.returnXirr) ? `${formatXirr(fund.returnXirr)} p.a.` : '—';
  const sparklineData = fund.navHistory30d.map((point) => point.value);

  return (
    <ClearLensCard style={[styles.fundCard, { borderLeftColor: categoryColor }]}>
      <View style={styles.fundTopRow}>
        <TouchableOpacity style={styles.fundMainTap} onPress={onOpen} activeOpacity={0.76}>
          <View style={styles.fundNameBlock}>
            <Text style={styles.fundName} numberOfLines={2}>{base}</Text>
            <Text style={styles.fundMeta} numberOfLines={1}>
              {fund.schemeCategory}{planBadge ? ` · ${planBadge}` : ''}
            </Text>
          </View>
          <View style={styles.valueBlock}>
            <Text style={styles.fundValue}>{fund.currentValue != null ? formatCurrency(fund.currentValue) : 'NAV pending'}</Text>
            <Text style={styles.shareText}>{portfolioPct != null ? `${portfolioPct.toFixed(1)}%` : '—'}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={styles.expandButton} onPress={onToggle} activeOpacity={0.75}>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={tokens.colors.slate} />
        </TouchableOpacity>
      </View>

      {!expanded && (
        <View style={styles.compactMetricRow}>
          <View style={styles.compactMetric}>
            <Text style={styles.compactMetricLabel}>Today</Text>
            <Text style={[styles.compactMetricValue, { color: dailyColor }]}>
              {fund.dailyChangePct != null ? formatClearLensPercentDelta(fund.dailyChangePct) : '—'}
            </Text>
          </View>
          <View style={styles.compactMetric}>
            <Text style={styles.compactMetricLabel}>XIRR</Text>
            <Text style={styles.compactMetricValue}>{xirrLabel}</Text>
          </View>
        </View>
      )}

      {expanded && (
        <View style={styles.expandedPanel}>
          {/* Every row uses the same label-left / value-right pattern so the
              two "key" metrics (Today, XIRR) align with the breakdown rows
              underneath. */}
          <View style={styles.expandedRows}>
            <MetricRow
              label="Today"
              value={fund.dailyChangePct != null ? formatClearLensPercentDelta(fund.dailyChangePct) : '—'}
              subvalue={
                fund.dailyChangeAmount != null
                  ? `${formatClearLensCurrencyDelta(fund.dailyChangeAmount)}${stale.stale ? ` · ${stale.label}` : ''}`
                  : undefined
              }
              color={dailyColor}
            />
            <MetricRow label="XIRR" value={xirrLabel} color={xirrColor} />
            <View style={styles.metricRowDivider} />
            <MetricRow label="Invested (SIP)" value={formatCurrency(fund.investedAmount)} />
            <MetricRow
              label="Gain / Loss"
              value={gain != null ? formatClearLensCurrencyDelta(gain) : '—'}
              // Gain value already carries the ▲/▼ arrow — strip the second arrow
              // off the percent so the line reads "▲ +₹11.86L (+75.4%)" instead
              // of "▲ +₹11.86L (▲ +75.4%)".
              subvalue={
                gain != null && gainPct != null
                  ? `(${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%)`
                  : undefined
              }
              color={gainColor}
            />
            {(fund.realizedAmount > 0 || fund.realizedGain !== 0) && (
              <>
                <MetricRow label="Redeemed" value={formatCurrency(fund.realizedAmount)} />
                <MetricRow
                  label="Booked P&L"
                  value={formatClearLensCurrencyDelta(fund.realizedGain)}
                  color={fund.realizedGain >= 0 ? tokens.colors.emerald : CLEAR_LENS_RED}
                />
              </>
            )}
          </View>

          {sparklineData.length >= 2 && (
            <View style={styles.sparklineBlock}>
              <Text style={styles.sparklineLabel}>NAV · last 30 days</Text>
              <View style={styles.sparklinePanel}>
                <FundSparkline data={sparklineData} color={categoryColor} />
              </View>
            </View>
          )}

          <TouchableOpacity
            style={styles.transactionsAction}
            onPress={onOpenTransactions}
            activeOpacity={0.76}
          >
            <Ionicons name="receipt-outline" size={18} color={tokens.colors.emeraldDeep} />
            <Text style={styles.transactionsActionText}>View transactions</Text>
            <Ionicons name="arrow-forward" size={16} color={tokens.colors.emeraldDeep} />
          </TouchableOpacity>
        </View>
      )}
    </ClearLensCard>
  );
}

function MetricRow({
  label,
  value,
  subvalue,
  color,
}: {
  label: string;
  value: string;
  subvalue?: string;
  color?: string;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  // The previous default of `ClearLensColors.navy` froze to the LIGHT navy
  // (#0A1430), which renders black-on-black on the dark surface. Resolve the
  // default through the live tokens so it tracks the active scheme.
  const resolvedColor = color ?? tokens.colors.textPrimary;
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricRowLabel}>{label}</Text>
      <View style={styles.metricRowValueBlock}>
        <Text style={[styles.metricRowValue, { color: resolvedColor }]} numberOfLines={1}>{value}</Text>
        {subvalue ? (
          <Text style={[styles.metricRowSubvalue, { color: resolvedColor }]} numberOfLines={1}>{subvalue}</Text>
        ) : null}
      </View>
    </View>
  );
}

function SortBottomSheet({
  visible,
  selected,
  onSelect,
  onClose,
}: {
  visible: boolean;
  selected: SortOption;
  onSelect: (value: SortOption) => void;
  onClose: () => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const [draft, setDraft] = useState<SortOption>(selected);

  useEffect(() => {
    if (visible) setDraft(selected);
  }, [selected, visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Sort by</Text>
          {SORT_OPTIONS.map((option, index) => (
            <TouchableOpacity
              key={option.value}
              style={[styles.sheetOption, index > 0 && styles.sheetDivider]}
              onPress={() => setDraft(option.value)}
              activeOpacity={0.76}
            >
              <View style={styles.sheetOptionLeft}>
                <View style={styles.sheetIcon}>
                  <Ionicons name={option.icon} size={18} color={tokens.colors.slate} />
                </View>
                <Text style={styles.sheetRowText}>{option.label}</Text>
              </View>
              <View style={[styles.radioOuter, option.value === draft && styles.radioOuterActive]}>
                {option.value === draft && <View style={styles.radioInner} />}
              </View>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={styles.applyButton}
            onPress={() => {
              onSelect(draft);
              onClose();
            }}
            activeOpacity={0.82}
          >
            <Text style={styles.applyButtonText}>Apply</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function FundsBottomNav() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const router = useRouter();
  const items: {
    route: FundsBottomNavRoute;
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
    onPress: () => void;
  }[] = [
    { route: 'portfolio', label: 'Portfolio', icon: 'pie-chart-outline', onPress: () => router.replace('/(tabs)') },
    { route: 'funds', label: 'Funds', icon: 'list-outline', onPress: () => {} },
    { route: 'wealth', label: 'Wealth Journey', icon: 'calculator-outline', onPress: () => router.replace('/(tabs)/wealth-journey') },
  ];

  return (
    <View style={styles.bottomNav}>
      {items.map((item) => {
        const active = item.route === 'funds';
        return (
          <TouchableOpacity
            key={item.route}
            style={styles.bottomNavItem}
            onPress={item.onPress}
            disabled={active}
            activeOpacity={0.75}
          >
            <Ionicons
              name={item.icon}
              size={24}
              color={active ? tokens.colors.emerald : tokens.colors.textTertiary}
            />
            <Text style={[styles.bottomNavLabel, active && styles.bottomNavLabelActive]} numberOfLines={1}>
              {item.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export function ClearLensFundsScreen({ insideTab = false }: { insideTab?: boolean }) {
  useTrackInsightViewed('funds');
  const { layout } = useResponsiveLayout();
  if (layout === 'desktop') return <ClearLensFundsScreenDesktop />;
  return <ClearLensFundsScreenMobile insideTab={insideTab} />;
}

function ClearLensFundsScreenMobile({ insideTab = false }: { insideTab?: boolean }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const router = useRouter();
  const { session } = useSession();
  const accountMetadata = session?.user.user_metadata as { full_name?: string; name?: string } | undefined;
  const accountLabel = accountMetadata?.full_name ?? accountMetadata?.name ?? session?.user.email ?? null;
  const {
    defaultBenchmarkSymbol,
    fundsSortBy: sortBy,
    setFundsSortBy: setSortBy,
    fundsSearchQuery: searchQuery,
    setFundsSearchQuery: setSearchQuery,
  } = useAppStore();
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [expandedFundId, setExpandedFundId] = useState<string | null>(null);
  const didAutoExpand = useRef(false);

  const { data, isLoading } = usePortfolio(defaultBenchmarkSymbol);
  const fundCards = useMemo(() => data?.fundCards ?? [], [data?.fundCards]);
  const summary = data?.summary ?? null;
  const { insights } = usePortfolioInsights(fundCards);

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

  const valueSortedFunds = useMemo(
    () => [...fundCards].sort((a, b) => sortableNumber(b.currentValue) - sortableNumber(a.currentValue)),
    [fundCards],
  );
  const largestPosition =
    insights?.fundAllocation[0]?.shortName ??
    (valueSortedFunds[0] ? parseFundName(valueSortedFunds[0].schemeName).base : '—');
  const largestPositionPct =
    insights?.fundAllocation[0]?.pct ??
    (valueSortedFunds[0] ? allocationPctByFundId.get(valueSortedFunds[0].id) ?? null : null);
  const topThreeShare = insights?.fundAllocation.length
    ? insights.fundAllocation.slice(0, 3).reduce((sum, item) => sum + item.pct, 0)
    : valueSortedFunds
      .slice(0, 3)
      .reduce((sum, fund) => sum + (allocationPctByFundId.get(fund.id) ?? 0), 0);
  const benchmarkXirr = summary?.marketXirr ?? 0;
  const sortLabel = SORT_OPTIONS.find((option) => option.value === sortBy)?.label ?? 'Current value';

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

  useEffect(() => {
    if (!didAutoExpand.current && sortedFunds.length > 0) {
      didAutoExpand.current = true;
      setExpandedFundId(sortedFunds[0].id);
    }
  }, [sortedFunds]);

  const allocationSegments = useMemo<AllocationSegment[]>(
    () => valueSortedFunds
      .map((fund, index) => ({
        id: fund.id,
        pct: allocationPctByFundId.get(fund.id) ?? 0,
        color: tokens.semantic.fundAllocation[
          index % tokens.semantic.fundAllocation.length
        ],
      }))
      .filter((segment) => segment.pct > 0),
    [allocationPctByFundId, valueSortedFunds, tokens.semantic.fundAllocation],
  );

  return (
    <ClearLensScreen>
      <ClearLensHeader
        onPressMenu={() => setOverflowOpen(true)}
        showTagline
        accountLabel={accountLabel}
      />
      <AppOverflowMenu
        visible={overflowOpen}
        onClose={() => setOverflowOpen(false)}
        onImport={() => router.push('/onboarding')}
        onMoneyTrail={() => router.push('/money-trail')}
        onTools={() => router.push('/tools' as never)}
        onSettings={() => router.push('/(tabs)/settings')}
      />
      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={tokens.colors.emerald} />
        </View>
      ) : (
        <ScrollView style={styles.scrollView} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <View style={styles.heroCopy}>
            <Text style={styles.heroTitle}>Your Funds</Text>
            <Text style={styles.heroSubtitle}>Search, sort, and open every holding.</Text>
          </View>

          <AllocationOverview
            fundCount={fundCards.length}
            topThreeShare={topThreeShare}
            largestPosition={largestPosition}
            largestPositionPct={largestPositionPct}
            segments={allocationSegments}
          />

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
            <TouchableOpacity style={styles.sortButton} onPress={() => setSortMenuOpen(true)}>
              <Ionicons name="swap-vertical-outline" size={18} color={tokens.colors.navy} />
              <Text style={styles.sortButtonText} numberOfLines={1}>{sortLabel}</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.listHeader}>
            <Text style={styles.listTitle}>Funds</Text>
            <Text style={styles.listCount}>{sortedFunds.length} shown</Text>
          </View>

          {sortedFunds.map((fund) => (
            <FundListItem
              key={fund.id}
              fund={fund}
              latestNavDate={summary?.latestNavDate ?? null}
              portfolioPct={allocationPctByFundId.get(fund.id) ?? null}
              expanded={expandedFundId === fund.id}
              onToggle={() => setExpandedFundId((current) => current === fund.id ? null : fund.id)}
              onOpen={() => router.push(`/fund/${fund.id}`)}
              onOpenTransactions={() => router.push(`/money-trail?fundId=${fund.id}`)}
            />
          ))}
        </ScrollView>
      )}
      {!insideTab && <FundsBottomNav />}
      <SortBottomSheet
        visible={sortMenuOpen}
        selected={sortBy}
        onSelect={setSortBy}
        onClose={() => setSortMenuOpen(false)}
      />
    </ClearLensScreen>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  scroll: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingBottom: ClearLensSpacing.lg,
    gap: ClearLensSpacing.md,
  },
  heroCopy: {
    gap: ClearLensSpacing.xs,
  },
  heroTitle: {
    ...ClearLensTypography.h1,
    color: cl.navy,
  },
  heroSubtitle: {
    ...ClearLensTypography.body,
    color: cl.textSecondary,
  },
  overviewCard: {
    gap: ClearLensSpacing.sm,
  },
  screenEyebrow: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    textTransform: 'uppercase',
  },
  overviewGrid: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  allocationStrip: {
    height: 10,
    borderRadius: ClearLensRadii.full,
    overflow: 'hidden',
    flexDirection: 'row',
    backgroundColor: cl.surfaceSoft,
  },
  allocationStripSegment: {
    height: '100%',
  },
  overviewMetric: {
    flex: 1,
    gap: 2,
  },
  overviewDivider: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: cl.borderLight,
  },
  metricLabel: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    textTransform: 'uppercase',
  },
  metricCaption: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    fontFamily: ClearLensFonts.medium,
  },
  overviewValue: {
    ...ClearLensTypography.h2,
    color: cl.navy,
  },
  largestBox: {
    minHeight: 44,
    marginTop: ClearLensSpacing.xs,
    paddingHorizontal: ClearLensSpacing.sm,
    borderRadius: ClearLensRadii.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    backgroundColor: cl.mint50,
  },
  allocationDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  largestPrefix: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  largestName: {
    ...ClearLensTypography.bodySmall,
    flex: 1,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  largestPct: {
    ...ClearLensTypography.bodySmall,
    color: cl.emeraldDeep,
    fontFamily: ClearLensFonts.bold,
  },
  controls: {
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
  },
  searchBox: {
    flex: 1,
    minHeight: 46,
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.surface,
    borderWidth: 1,
    borderColor: cl.border,
    paddingHorizontal: ClearLensSpacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  searchInput: {
    ...ClearLensTypography.body,
    flex: 1,
    color: cl.navy,
    paddingVertical: 0,
  },
  sortButton: {
    minHeight: 44,
    maxWidth: 188,
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.surface,
    borderWidth: 1,
    borderColor: cl.border,
    paddingHorizontal: ClearLensSpacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: ClearLensSpacing.xs,
  },
  sortButtonText: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.bold,
    color: cl.navy,
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  listTitle: {
    ...ClearLensTypography.h2,
    color: cl.navy,
  },
  listCount: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  fundCard: {
    gap: ClearLensSpacing.sm,
    borderLeftWidth: 3,
    paddingLeft: ClearLensSpacing.sm,
  },
  fundTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.xs,
  },
  fundMainTap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    minWidth: 0,
  },
  fundNameBlock: {
    flex: 1,
    gap: 3,
  },
  fundName: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  fundMeta: {
    ...ClearLensTypography.caption,
    fontFamily: ClearLensFonts.semiBold,
    color: cl.textTertiary,
  },
  valueBlock: {
    alignItems: 'flex-end',
    gap: 3,
    minWidth: 92,
  },
  fundValue: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  shareText: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    fontFamily: ClearLensFonts.semiBold,
  },
  expandButton: {
    width: 28,
    height: 28,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactMetricRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.md,
    paddingTop: ClearLensSpacing.sm,
    borderTopWidth: 1,
    borderTopColor: cl.borderLight,
  },
  compactMetric: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  compactMetricLabel: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  compactMetricValue: {
    ...ClearLensTypography.caption,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  expandedPanel: {
    marginTop: ClearLensSpacing.md,
    paddingTop: ClearLensSpacing.md,
    borderTopWidth: 1,
    borderTopColor: cl.borderLight,
    gap: ClearLensSpacing.md,
  },
  expandedRows: {
    gap: ClearLensSpacing.sm,
  },
  metricRowDivider: {
    height: 1,
    backgroundColor: cl.borderLight,
    marginVertical: 2,
  },
  metricRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.md,
  },
  metricRowLabel: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
    fontFamily: ClearLensFonts.semiBold,
  },
  metricRowValueBlock: {
    flexShrink: 1,
    alignItems: 'flex-end',
  },
  metricRowValue: {
    ...ClearLensTypography.bodySmall,
    color: cl.textPrimary,
    fontFamily: ClearLensFonts.bold,
    textAlign: 'right',
  },
  metricRowSubvalue: {
    ...ClearLensTypography.caption,
    textAlign: 'right',
    marginTop: 1,
  },
  sparklineBlock: {
    gap: 4,
  },
  sparklineLabel: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    textTransform: 'uppercase',
  },
  sparklinePanel: {
    minHeight: 62,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: ClearLensRadii.md,
    // Lifted "well" trough behind the NAV sparkline. `mint50` worked in light
    // mode (soft mint) but flips to a near-black green in dark, which merged
    // with the emerald line. `surfaceSoft` reads as a subtle lift in both
    // schemes, so the emerald line keeps its contrast.
    backgroundColor: cl.surfaceSoft,
    overflow: 'hidden',
  },
  transactionsAction: {
    minHeight: 44,
    paddingHorizontal: ClearLensSpacing.md,
    borderRadius: ClearLensRadii.md,
    borderWidth: 1,
    borderColor: cl.borderLight,
    backgroundColor: cl.surface,
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
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: tokens.semantic.overlay.backdrop,
  },
  sheet: {
    backgroundColor: cl.surface,
    borderTopLeftRadius: ClearLensRadii.xl,
    borderTopRightRadius: ClearLensRadii.xl,
    paddingTop: ClearLensSpacing.sm,
    paddingBottom: ClearLensSpacing.lg,
    borderWidth: 1,
    borderColor: cl.border,
    ...ClearLensShadow,
  },
  sheetHandle: {
    width: 46,
    height: 4,
    borderRadius: ClearLensRadii.full,
    alignSelf: 'center',
    marginBottom: ClearLensSpacing.sm,
    backgroundColor: cl.border,
  },
  sheetTitle: {
    ...ClearLensTypography.h2,
    color: cl.navy,
    paddingHorizontal: ClearLensSpacing.md,
    paddingBottom: ClearLensSpacing.sm,
  },
  sheetOption: {
    minHeight: 58,
    paddingHorizontal: ClearLensSpacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.md,
  },
  sheetDivider: {
    borderTopWidth: 1,
    borderTopColor: cl.borderLight,
  },
  sheetOptionLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  sheetIcon: {
    width: 30,
    height: 30,
    borderRadius: ClearLensRadii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.surfaceSoft,
  },
  sheetRowText: {
    ...ClearLensTypography.body,
    color: cl.navy,
    fontFamily: ClearLensFonts.medium,
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: cl.textTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOuterActive: {
    borderColor: cl.emerald,
  },
  radioInner: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: cl.emerald,
  },
  applyButton: {
    minHeight: 48,
    marginHorizontal: ClearLensSpacing.md,
    marginTop: ClearLensSpacing.md,
    borderRadius: ClearLensRadii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.emerald,
  },
  applyButtonText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textOnDark,
    fontFamily: ClearLensFonts.bold,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomNav: {
    minHeight: 96,
    borderTopWidth: 1,
    borderTopColor: cl.borderLight,
    backgroundColor: cl.surface,
    paddingTop: 7,
    paddingBottom: Platform.OS === 'web' ? 48 : 18,
    paddingHorizontal: ClearLensSpacing.sm,
    flexDirection: 'row',
  },
  bottomNavItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  bottomNavLabel: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    fontFamily: ClearLensFonts.semiBold,
  },
  bottomNavLabelActive: {
    color: cl.emerald,
  },
});
}
