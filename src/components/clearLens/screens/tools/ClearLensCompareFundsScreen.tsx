/**
 * Compare Funds — "What's Different" (Option C, M3v3).
 *
 * A single vertical scroll of six neutral finding cards: Returns (dark hero)
 * → Risk → Cost → What's inside → Overlap → The basics. Each card leads with
 * a data-built, non-prescriptive headline and hides raw numbers behind a
 * "See the numbers" reveal. No tabs, no winner badges, no recommendations.
 *
 * Supersedes the tabbed M3v2 screen.
 * Design spec: design_handoff_compare_redesign/README.md + Option C spec.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ClearLensHeader, ClearLensScreen } from '@/src/components/clearLens/ClearLensPrimitives';
import { PortfolioDisclaimer } from '@/src/components/clearLens/PortfolioDisclaimer';
import { UniversalFundPicker } from '@/src/components/clearLens/UniversalFundPicker';
import { ToolsPreviewSampleCard } from '@/src/components/clearLens/ToolsPreviewSampleCard';
import { useAppStore } from '@/src/store/appStore';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { useSession } from '@/src/hooks/useSession';
import { useTrackInsightViewed } from '@/src/hooks/useTrackInsightViewed';
import { functionsClient } from '@/src/lib/functions';
import { fundPortfolioCompositionRepo } from '@/src/lib/data/fundPortfolioComposition';
import { pickBestCompositionRows } from '@/src/utils/compositionSource';
import { perfEnd, perfStart } from '@/src/lib/perfMark';
import { type SchemeSearchResult } from '@/src/utils/fundSearch';
import { fundComparisonCategory, shortSchemeName } from '@/src/utils/schemeName';
import {
  computeRiskMetrics,
  computeTrailingReturns,
  type TrailingPeriodReturns,
} from '@/src/utils/computedFundMetrics';
import {
  isCompositionImplausible,
  readMfdataBeta,
} from '@/src/utils/mfdataGuards';
import type { NavPoint } from '@/src/utils/navUtils';
import { fetchFundNavHistory } from '@/src/hooks/useFundDetail';
import { fetchSchemeMaster } from '@/src/hooks/useSchemeMaster';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FUNDS = 3;

// Stable A/B/C identity colors — NOT theme tokens (read on both light/dark).
const BADGE_LETTERS = ['A', 'B', 'C'] as const;
const BADGE_COLORS = ['#10B981', '#6E73C4', '#F59E0B'] as const;
const BADGE_SOFT_COLORS = ['#ECFDF5', '#EEF1F8', '#FFF8E6'] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SchemeMasterRow {
  schemeCode: number;
  schemeName: string;
  schemeCategory: string | null;
  sebiCategory: string | null;
  benchmark: string | null;
  expenseRatio: number | null;
  aumCr: number | null;
  isin: string | null;
  amcName: string | null;
  familyName: string | null;
  planType: 'direct' | 'regular' | null;
  optionType: string | null;
  launchDate: string | null;
  exitLoad: string | null;
  minSipAmount: number | null;
  minLumpsum: number | null;
  minAdditional: number | null;
  morningstarRating: number | null;
  riskLabel: string | null;
  periodReturns: unknown;
  riskRatios: unknown;
}

interface CompositionRow {
  schemeCode: number;
  equityPct: number;
  debtPct: number;
  cashPct: number;
  otherPct: number;
  largeCapPct: number | null;
  midCapPct: number | null;
  smallCapPct: number | null;
  notClassifiedPct: number | null;
  source: 'amfi' | 'category_fallback' | 'category_rules' | string | null;
  sectorAllocation: Record<string, number> | null;
  topHoldings: { name: string; isin: string; sector: string; pctOfNav: number }[] | null;
  rawDebtHoldings: { name?: string; weight_pct?: number; credit_rating?: string }[] | null;
}

type Metrics = {
  trailing: TrailingPeriodReturns;
  sharpe: number | null;
  sortino: number | null;
  stdDev: number | null;
  monthlyObservations: number;
  maxDrawdown: number | null;
};

interface CompareFundData {
  code: number;
  badgeLetter: string;
  badgeColor: string;
  badgeSoft: string;
  scheme: SchemeMasterRow;
  metrics: Metrics | null;
  composition: CompositionRow | null;
}

// ---------------------------------------------------------------------------
// Data fetchers (kept verbatim from M3v2)
// ---------------------------------------------------------------------------

async function fetchSchemes(
  qc: QueryClient,
  schemeCodes: number[],
): Promise<SchemeMasterRow[]> {
  if (schemeCodes.length === 0) return [];
  perfStart('query:compare:schemes');
  const rows = await Promise.all(
    schemeCodes.map((code) =>
      qc.fetchQuery({
        queryKey: ['scheme-master', code],
        queryFn: () => fetchSchemeMaster(code),
        staleTime: STALE_TIMES.NAV_HISTORY,
      }),
    ),
  );
  const present = rows.filter(
    (r): r is NonNullable<typeof r> => r != null && r.scheme_name != null,
  );
  perfEnd('query:compare:schemes', { rows: present.length, codes: schemeCodes.length });
  return present.map((row) => ({
    schemeCode: row.scheme_code,
    schemeName: row.scheme_name as string,
    schemeCategory: row.scheme_category,
    sebiCategory: row.sebi_category,
    benchmark: row.benchmark_index,
    expenseRatio: row.expense_ratio,
    aumCr: row.aum_cr,
    isin: row.isin,
    amcName: row.amc_name,
    familyName: row.family_name,
    planType: (row.plan_type as 'direct' | 'regular' | null) ?? null,
    optionType: row.option_type,
    launchDate: row.launch_date,
    exitLoad: row.exit_load,
    minSipAmount: row.min_sip_amount,
    minLumpsum: row.min_lumpsum,
    minAdditional: row.min_additional,
    morningstarRating: row.morningstar_rating,
    riskLabel: row.risk_label,
    periodReturns: row.period_returns,
    riskRatios: row.risk_ratios,
  }));
}

async function fetchCompositionsForCodes(schemeCodes: number[]): Promise<CompositionRow[]> {
  if (schemeCodes.length === 0) return [];
  perfStart('query:compare:compositions');
  const { data, error } = await fundPortfolioCompositionRepo
    .from()
    .select(
      'scheme_code, portfolio_date, source, equity_pct, debt_pct, cash_pct, other_pct, large_cap_pct, mid_cap_pct, small_cap_pct, not_classified_pct, sector_allocation, top_holdings, raw_debt_holdings',
    )
    .in('scheme_code', schemeCodes)
    .order('portfolio_date', { ascending: false });
  perfEnd('query:compare:compositions', { rows: data?.length ?? 0, codes: schemeCodes.length });
  if (error) throw new Error(`fetchCompositions: ${error.message}`);
  // Pick the best row per scheme_code by explicit source precedence
  // (official > amfi > category_fallback > category_rules), tie-broken by
  // most recent date (the query already orders date DESC).
  return pickBestCompositionRows(data ?? []).map((row) => ({
    schemeCode: row.scheme_code,
    equityPct: row.equity_pct,
    debtPct: row.debt_pct,
    cashPct: row.cash_pct,
    otherPct: row.other_pct,
    largeCapPct: row.large_cap_pct,
    midCapPct: row.mid_cap_pct,
    smallCapPct: row.small_cap_pct,
    notClassifiedPct: row.not_classified_pct,
    source: row.source ?? null,
    sectorAllocation: row.sector_allocation as Record<string, number> | null,
    topHoldings: row.top_holdings as CompositionRow['topHoldings'],
    rawDebtHoldings: row.raw_debt_holdings as CompositionRow['rawDebtHoldings'],
  }));
}

async function fetchNavHistoryForCodes(
  qc: QueryClient,
  schemeCodes: number[],
): Promise<Map<number, NavPoint[]>> {
  const out = new Map<number, NavPoint[]>();
  if (schemeCodes.length === 0) return out;
  perfStart('query:compare:navHistory');
  const entries = await Promise.all(
    schemeCodes.map(async (code) => {
      const rows = await qc.fetchQuery({
        queryKey: ['fund-nav-history', code],
        queryFn: () => fetchFundNavHistory(code),
        staleTime: STALE_TIMES.NAV_HISTORY,
      });
      return [code, rows] as const;
    }),
  );
  let totalRows = 0;
  for (const [code, rows] of entries) {
    out.set(code, rows);
    totalRows += rows.length;
  }
  perfEnd('query:compare:navHistory', { rows: totalRows, codes: schemeCodes.length });
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeMaxDrawdown(series: NavPoint[]): number | null {
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const sorted = [...series]
    .filter((p) => p.date >= cutoffStr && Number.isFinite(p.value) && p.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 10) return null;
  let peak = sorted[0].value;
  let maxDD = 0;
  for (const p of sorted) {
    if (p.value > peak) peak = p.value;
    const dd = (p.value - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD < -0.001 ? maxDD : null;
}

function hasHistory(metrics: Metrics | null): boolean {
  if (!metrics) return false;
  const { y1, y3, y5 } = metrics.trailing;
  return y1 != null || y3 != null || y5 != null;
}

function fundDisplayName(scheme: SchemeMasterRow): string {
  // schemeName is the full AMFI name; shortSchemeName trims the plan/option
  // suffix. We deliberately avoid schemeCategory ("Equity") and familyName
  // (the AMC family) here — neither distinguishes one fund from another.
  return shortSchemeName(scheme.schemeName);
}

// The SEBI sub-category we compare on. scheme_category alone is too broad
// (every equity fund is just "Equity"), so we prefer the persisted granular
// sebi_category and fall back to resolving Large/Mid/Flexi/etc. from the scheme
// name — this is what powers the cross-category banner.
function fundCategory(scheme: SchemeMasterRow): string {
  return fundComparisonCategory(scheme.schemeName, scheme.schemeCategory, scheme.sebiCategory);
}

function returnsHeadline(funds: CompareFundData[]): string {
  const eligible = funds
    .filter((f) => f.metrics?.trailing.y3 != null)
    .map((f) => ({ f, v: f.metrics!.trailing.y3! }));
  if (eligible.length < 2) return 'Returns over the last three years.';
  const sorted = [...eligible].sort((a, b) => b.v - a.v);
  const hi = sorted[0];
  const lo = sorted[sorted.length - 1];
  return `Over 3Y, ${fundDisplayName(hi.f.scheme)} returned ${(hi.v * 100).toFixed(1)}%; ${fundDisplayName(lo.f.scheme)} returned ${(lo.v * 100).toFixed(1)}%.`;
}

function tradeOffHolds(funds: CompareFundData[]): boolean {
  const eligible = funds.filter(
    (f) => f.metrics?.trailing.y3 != null && f.metrics?.maxDrawdown != null,
  );
  if (eligible.length < 2) return false;
  const topReturn = eligible.reduce((m, f) =>
    f.metrics!.trailing.y3! > m.metrics!.trailing.y3! ? f : m,
  );
  const sortedByDD = [...eligible].sort(
    (a, b) => a.metrics!.maxDrawdown! - b.metrics!.maxDrawdown!,
  );
  const ddRank = sortedByDD.findIndex((f) => f.code === topReturn.code);
  return ddRank < 2;
}

function launchMonthsAgo(launchDate: string | null): number {
  if (!launchDate) return 0;
  const d = new Date(launchDate);
  const now = new Date();
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24 * 30)));
}

function launchYear(launchDate: string | null): string {
  if (!launchDate) return '—';
  return new Date(launchDate).getFullYear().toString();
}

function fmtAumCr(aumCr: number | null): string {
  if (aumCr == null) return '—';
  if (aumCr >= 1000) return `₹${(aumCr / 1000).toFixed(1)}K Cr`;
  return `₹${aumCr.toLocaleString('en-IN')} Cr`;
}

function fmtPct(v: number | null, digits = 1): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

// ---------------------------------------------------------------------------
// FundBadge atom
// ---------------------------------------------------------------------------

function FundBadge({
  letter,
  color,
  size = 22,
  radius = 7,
}: {
  letter: string;
  color: string;
  size?: number;
  radius?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: color,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <Text
        style={{
          color: '#fff',
          fontSize: Math.round(size * 0.48),
          fontFamily: ClearLensFonts.extraBold,
          lineHeight: size,
          includeFontPadding: false,
        }}
      >
        {letter}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// FundChip atom
// ---------------------------------------------------------------------------

function FundChip({
  letter,
  color,
  soft,
  label,
  onRemove,
}: {
  letter: string;
  color: string;
  soft: string;
  label: string;
  onRemove?: () => void;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: ClearLensSpacing.sm,
        paddingLeft: 3,
        paddingRight: onRemove ? 4 : 12,
        height: 28,
        borderRadius: ClearLensRadii.full,
        backgroundColor: soft,
      }}
    >
      <FundBadge letter={letter} color={color} size={22} radius={ClearLensRadii.full} />
      <Text
        style={{
          fontSize: 12,
          fontFamily: ClearLensFonts.semiBold,
          color: '#0A1430',
          flexShrink: 1,
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
      {onRemove ? (
        <TouchableOpacity
          onPress={onRemove}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}
          accessibilityLabel={`Remove ${label}`}
        >
          <Ionicons name="close" size={13} color="#7B8AA3" />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// FindingCard frame
// ---------------------------------------------------------------------------

function FindingCard({
  headline,
  sub,
  tone = 'light',
  tokens,
  children,
}: {
  headline: string;
  sub?: string;
  tone?: 'light' | 'dark';
  tokens: ClearLensTokens;
  children?: ReactNode;
}) {
  const cl = tokens.colors;
  const dark = tone === 'dark';
  return (
    <View
      style={[
        {
          borderRadius: ClearLensRadii.xl,
          padding: 18,
          gap: 14,
          backgroundColor: dark ? cl.heroSurface : cl.surface,
          borderWidth: dark ? 0 : 1,
          borderColor: cl.borderLight,
        },
        dark
          ? { shadowColor: '#000', shadowOffset: { width: 0, height: 24 }, shadowOpacity: 0.22, shadowRadius: 60, elevation: 8 }
          : ClearLensShadow,
      ]}
    >
      <View style={{ gap: 4 }}>
        <Text
          style={{
            fontFamily: ClearLensFonts.extraBold,
            fontSize: 21,
            lineHeight: 27,
            letterSpacing: -0.21,
            color: dark ? cl.textOnDark : cl.navy,
          }}
        >
          {headline}
        </Text>
        {sub ? (
          <Text
            style={{
              fontSize: 12,
              fontFamily: ClearLensFonts.medium,
              lineHeight: 18,
              color: dark ? cl.textOnDarkMuted : cl.textTertiary,
            }}
          >
            {sub}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// BarRow & BarsViz
// ---------------------------------------------------------------------------

function BarRow({
  letter,
  color,
  label,
  value,
  widthFraction,
  dark,
  tokens,
}: {
  letter: string;
  color: string;
  label: string;
  value: string;
  widthFraction: number;
  dark?: boolean;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  const trackBg = dark ? 'rgba(255,255,255,0.08)' : cl.surfaceSoft;
  const pct = Math.max(0.12, Math.min(1, widthFraction)) * 100;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <FundBadge letter={letter} color={color} size={22} radius={7} />
      <View style={{ flex: 1, height: 32, borderRadius: 9, backgroundColor: trackBg, overflow: 'hidden' }}>
        <View
          style={{
            width: `${pct}%` as unknown as number,
            height: '100%',
            borderRadius: 9,
            backgroundColor: color,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 12,
          }}
        >
          <Text
            style={{
              flexShrink: 1,
              fontSize: 11,
              fontFamily: ClearLensFonts.bold,
              color: '#fff',
              opacity: 0.95,
              marginRight: 8,
            }}
            numberOfLines={1}
          >
            {label}
          </Text>
          <Text
            style={{
              flexShrink: 0,
              fontFamily: ClearLensFonts.extraBold,
              fontSize: 13,
              color: '#fff',
              fontVariant: ['tabular-nums'],
            }}
          >
            {value}
          </Text>
        </View>
      </View>
    </View>
  );
}

function BarsViz({
  funds,
  valFn,
  formatFn,
  dark,
  tokens,
}: {
  funds: CompareFundData[];
  valFn: (f: CompareFundData) => number | null;
  formatFn: (v: number) => string;
  dark?: boolean;
  tokens: ClearLensTokens;
}) {
  const numerics = funds.map(valFn).filter((v): v is number => v != null).map(Math.abs);
  const maxVal = Math.max(...numerics, 1);

  return (
    <View style={{ gap: 10 }}>
      {funds.map((f) => {
        const v = valFn(f);
        if (v == null) return null;
        const fraction = Math.abs(v) / maxVal;
        return (
          <BarRow
            key={f.code}
            letter={f.badgeLetter}
            color={f.badgeColor}
            label={fundDisplayName(f.scheme)}
            value={formatFn(v)}
            widthFraction={fraction}
            dark={dark}
            tokens={tokens}
          />
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// NumbersReveal — "See the numbers" collapsible
// ---------------------------------------------------------------------------

type RevealRow = { label: string; cells: string[] };

function NumbersReveal({
  funds,
  rows,
  dark,
  tokens,
}: {
  funds: CompareFundData[];
  rows: RevealRow[];
  dark?: boolean;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  const [open, setOpen] = useState(false);
  const chevronAnim = useRef(new Animated.Value(0)).current;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    Animated.timing(chevronAnim, {
      toValue: next ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  };

  const chevronRotate = chevronAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '180deg'],
  });

  const mutedColor = dark ? cl.textOnDarkMuted : cl.textTertiary;
  const dividerColor = dark ? 'rgba(255,255,255,0.12)' : cl.borderLight;

  return (
    <View>
      <TouchableOpacity
        onPress={toggle}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 6,
          minHeight: 40,
        }}
        accessibilityRole="button"
        accessibilityLabel={open ? 'Hide the numbers' : 'See the numbers'}
        accessibilityState={{ expanded: open }}
      >
        <Text
          style={{
            fontSize: 11,
            fontFamily: ClearLensFonts.bold,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: mutedColor,
          }}
        >
          {open ? 'Hide the numbers' : 'See the numbers'}
        </Text>
        <Animated.View style={{ transform: [{ rotate: chevronRotate }] }}>
          <Ionicons name="chevron-down" size={14} color={mutedColor} />
        </Animated.View>
      </TouchableOpacity>

      {open ? (
        <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: dividerColor, gap: 8 }}>
          {/* Badge header row */}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ width: 80 }} />
            {funds.map((f) => (
              <View key={f.code} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <FundBadge letter={f.badgeLetter} color={f.badgeColor} size={16} radius={4} />
                <Text
                  style={{ fontSize: 10, fontFamily: ClearLensFonts.bold, color: mutedColor }}
                  numberOfLines={1}
                >
                  {fundDisplayName(f.scheme)}
                </Text>
              </View>
            ))}
          </View>
          {/* Data rows */}
          {rows.map((row) => (
            <View key={row.label} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <Text
                style={{ width: 80, fontSize: 10, fontFamily: ClearLensFonts.medium, color: mutedColor }}
                numberOfLines={2}
              >
                {row.label}
              </Text>
              {row.cells.map((cell, i) => (
                <Text
                  key={i}
                  style={{
                    flex: 1,
                    fontSize: 12,
                    fontFamily: ClearLensFonts.bold,
                    color: dark ? cl.textOnDark : cl.navy,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {cell}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// EmptyState — 0 funds
// ---------------------------------------------------------------------------

function EmptyState({
  tokens,
  onAdd,
}: {
  tokens: ClearLensTokens;
  onAdd: () => void;
}) {
  const cl = tokens.colors;
  return (
    <View style={{ gap: 18 }}>
      {/* Hero copy */}
      <View style={{ paddingHorizontal: ClearLensSpacing.xs, paddingTop: ClearLensSpacing.md, gap: 4 }}>
        <Text
          style={{
            fontSize: 10,
            fontFamily: ClearLensFonts.bold,
            letterSpacing: 1.4,
            textTransform: 'uppercase',
            color: cl.emerald,
          }}
        >
          COMPARE
        </Text>
        <Text style={{ fontFamily: ClearLensFonts.extraBold, fontSize: 26, lineHeight: 32, color: cl.navy }}>
          Two or more funds, side-by-side.
        </Text>
        <Text style={{ fontFamily: ClearLensFonts.medium, fontSize: 13, color: cl.textSecondary, lineHeight: 19 }}>
          Pick funds from your portfolio or search the full list.
        </Text>
      </View>

      {/* Slot diagram */}
      <View
        style={{
          backgroundColor: cl.surface,
          borderRadius: ClearLensRadii.lg,
          borderWidth: 1,
          borderColor: cl.borderLight,
          ...ClearLensShadow,
          padding: ClearLensSpacing.md,
          gap: 12,
        }}
      >
        <Text
          style={{ fontSize: 10, fontFamily: ClearLensFonts.bold, letterSpacing: 1.2, textTransform: 'uppercase', color: cl.textTertiary }}
        >
          Add up to {MAX_FUNDS} funds
        </Text>
        <View style={{ gap: 8 }}>
          {BADGE_LETTERS.slice(0, MAX_FUNDS).map((letter, i) => (
            <TouchableOpacity
              key={letter}
              onPress={i === 0 ? onAdd : undefined}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                padding: 12,
                borderRadius: 12,
                borderWidth: 1,
                borderStyle: 'dashed',
                borderColor: cl.border,
                backgroundColor: cl.surfaceSoft,
                minHeight: 44,
              }}
              activeOpacity={i === 0 ? 0.7 : 1}
            >
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 7,
                  backgroundColor: cl.surface,
                  borderWidth: 1,
                  borderStyle: 'dashed',
                  borderColor: cl.border,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 10, fontFamily: ClearLensFonts.bold, color: cl.textTertiary }}>{letter}</Text>
              </View>
              <Text style={{ flex: 1, fontSize: 12, fontFamily: ClearLensFonts.semiBold, color: cl.textTertiary }}>
                {i === 0 ? 'Tap to add a fund' : 'Empty slot'}
              </Text>
              {i === 0 ? (
                <Ionicons name="add" size={14} color={cl.emerald} />
              ) : null}
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <Text
        style={{ fontSize: 11, fontFamily: ClearLensFonts.medium, color: cl.textTertiary, lineHeight: 17, paddingHorizontal: 4 }}
      >
        {"Compare works best with funds in the same category. Mixing categories is supported — we'll flag it."}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// OneFundState — 1 fund selected
// ---------------------------------------------------------------------------

function OneFundState({
  fund,
  tokens,
  onRemove,
  onAdd,
}: {
  fund: CompareFundData;
  tokens: ClearLensTokens;
  onRemove: () => void;
  onAdd: () => void;
}) {
  const cl = tokens.colors;
  const { scheme, metrics, badgeLetter, badgeColor } = fund;

  return (
    <View style={{ gap: 14 }}>
      <Text
        style={{ fontSize: 10, fontFamily: ClearLensFonts.bold, letterSpacing: 1.4, textTransform: 'uppercase', color: cl.textTertiary }}
      >
        Comparing · 1 of {MAX_FUNDS}
      </Text>

      {/* Single-fund summary card */}
      <View
        style={{
          backgroundColor: cl.surface,
          borderRadius: ClearLensRadii.lg,
          borderWidth: 1,
          borderColor: cl.borderLight,
          ...ClearLensShadow,
          padding: ClearLensSpacing.md,
          gap: 14,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <FundBadge letter={badgeLetter} color={badgeColor} size={32} radius={10} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 13, fontFamily: ClearLensFonts.bold, color: cl.navy }} numberOfLines={1}>
              {fundDisplayName(scheme)}
            </Text>
            <Text style={{ fontSize: 11, fontFamily: ClearLensFonts.medium, color: cl.textTertiary }} numberOfLines={1}>
              {fundCategory(scheme)}{scheme.benchmark ? ` · ${scheme.benchmark}` : ''}
            </Text>
          </View>
          <TouchableOpacity
            onPress={onRemove}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
            accessibilityLabel="Remove fund"
          >
            <Ionicons name="close" size={14} color={cl.textTertiary} />
          </TouchableOpacity>
        </View>

        {/* 1Y / 3Y / 5Y strip */}
        <View
          style={{
            flexDirection: 'row',
            gap: 8,
            paddingVertical: 12,
            borderTopWidth: 1,
            borderBottomWidth: 1,
            borderColor: cl.borderLight,
          }}
        >
          {(['y1', 'y3', 'y5'] as const).map((k) => {
            const label = k === 'y1' ? '1Y' : k === 'y3' ? '3Y' : '5Y';
            const v = metrics?.trailing[k] ?? null;
            return (
              <View key={k} style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontSize: 10, fontFamily: ClearLensFonts.bold, letterSpacing: 0.4, textTransform: 'uppercase', color: cl.textTertiary }}>
                  {label}
                </Text>
                <Text style={{ fontFamily: ClearLensFonts.extraBold, fontSize: 18, lineHeight: 24, color: cl.navy, fontVariant: ['tabular-nums'] }}>
                  {fmtPct(v)}
                </Text>
              </View>
            );
          })}
        </View>

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 10, fontFamily: ClearLensFonts.bold, letterSpacing: 0.4, textTransform: 'uppercase', color: cl.textTertiary }}>
              Fund size
            </Text>
            <Text style={{ fontSize: 12, fontFamily: ClearLensFonts.bold, color: cl.navy, fontVariant: ['tabular-nums'] }}>
              {fmtAumCr(scheme.aumCr)}
            </Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 10, fontFamily: ClearLensFonts.bold, letterSpacing: 0.4, textTransform: 'uppercase', color: cl.textTertiary }}>
              Expense
            </Text>
            <Text style={{ fontSize: 12, fontFamily: ClearLensFonts.bold, color: cl.navy, fontVariant: ['tabular-nums'] }}>
              {scheme.expenseRatio != null ? `${scheme.expenseRatio.toFixed(2)}%` : '—'}
            </Text>
          </View>
        </View>
      </View>

      {/* Add-next CTA */}
      <TouchableOpacity
        onPress={onAdd}
        style={{
          borderWidth: 1,
          borderStyle: 'dashed',
          borderColor: cl.border,
          borderRadius: ClearLensRadii.xl,
          padding: 20,
          backgroundColor: cl.surfaceSoft,
          alignItems: 'center',
          gap: 10,
          minHeight: 44,
        }}
        activeOpacity={0.7}
      >
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: ClearLensRadii.full,
            backgroundColor: cl.surface,
            borderWidth: 1,
            borderStyle: 'dashed',
            borderColor: cl.border,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="add" size={18} color={cl.emerald} />
        </View>
        <Text style={{ fontSize: 14, fontFamily: ClearLensFonts.bold, color: cl.navy, textAlign: 'center' }}>
          Add a second fund to start comparing
        </Text>
        <Text style={{ fontSize: 12, fontFamily: ClearLensFonts.medium, color: cl.textTertiary, textAlign: 'center', lineHeight: 18 }}>
          {"Pick another fund and we'll show their returns, risk and cost side-by-side."}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ---------------------------------------------------------------------------
// NoHistoryBanner
// ---------------------------------------------------------------------------

function NoHistoryBanner({
  fund,
  tokens,
}: {
  fund: CompareFundData;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  const months = launchMonthsAgo(fund.scheme.launchDate);
  const familyName = fund.scheme.familyName ?? fund.scheme.schemeName;

  return (
    <View
      style={{
        borderRadius: ClearLensRadii.lg,
        backgroundColor: cl.mint50,
        borderWidth: 1,
        borderColor: cl.borderLight,
        padding: 14,
        flexDirection: 'row',
        gap: 10,
        alignItems: 'flex-start',
      }}
    >
      <FundBadge letter={fund.badgeLetter} color={fund.badgeColor} size={26} radius={8} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 12, fontFamily: ClearLensFonts.bold, color: cl.navy }}>
          {familyName} launched {months > 0 ? `${months} months ago` : 'recently'}.
        </Text>
        <Text style={{ fontSize: 11, fontFamily: ClearLensFonts.medium, color: cl.textTertiary, marginTop: 2, lineHeight: 17 }}>
          {"It has no return history yet, so it's left out of the Returns and Risk comparisons. It still appears in Cost, What's inside, Overlap, and The basics."}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// CrossCategoryBanner
// ---------------------------------------------------------------------------

function CrossCategoryBanner({
  categories,
  tokens,
}: {
  categories: string[];
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  return (
    <View
      style={{
        borderRadius: ClearLensRadii.md,
        backgroundColor: cl.warningBg,
        paddingVertical: 10,
        paddingHorizontal: 12,
        flexDirection: 'row',
        gap: 10,
        alignItems: 'flex-start',
      }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: ClearLensRadii.full,
          backgroundColor: cl.surface,
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        <Ionicons name="information-circle-outline" size={13} color={cl.warning} />
      </View>
      <Text style={{ flex: 1, fontSize: 12, fontFamily: ClearLensFonts.medium, color: cl.navy, lineHeight: 18 }}>
        <Text style={{ fontFamily: ClearLensFonts.bold }}>Different categories. </Text>
        {categories.join(', ')} funds hold different kinds of companies by design — their returns aren&apos;t directly comparable.
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// UndoSnackbar
// ---------------------------------------------------------------------------

function UndoSnackbar({
  badgeLetter,
  badgeColor,
  schemeName,
  onUndo,
  tokens,
}: {
  badgeLetter: string;
  badgeColor: string;
  schemeName: string;
  onUndo: () => void;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  return (
    <View
      style={{
        position: 'absolute',
        left: 16,
        right: 16,
        bottom: 24,
        backgroundColor: cl.heroSurface,
        borderRadius: ClearLensRadii.md,
        padding: 12,
        paddingHorizontal: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 16 },
        shadowOpacity: 0.32,
        shadowRadius: 40,
        elevation: 10,
      }}
    >
      <FundBadge letter={badgeLetter} color={badgeColor} size={22} radius={6} />
      <Text style={{ flex: 1, fontSize: 12, fontFamily: ClearLensFonts.semiBold, color: cl.textOnDark, lineHeight: 18 }}>
        {schemeName} removed
      </Text>
      <TouchableOpacity
        onPress={onUndo}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={{ minHeight: 40, alignItems: 'center', justifyContent: 'center' }}
        accessibilityLabel="Undo remove"
      >
        <Text style={{ fontSize: 12, fontFamily: ClearLensFonts.bold, letterSpacing: 0.6, textTransform: 'uppercase', color: cl.mint }}>
          Undo
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ---------------------------------------------------------------------------
// FundStrip — eyebrow + chips + Add button
// ---------------------------------------------------------------------------

function FundStripView({
  fundData,
  selectedCodes,
  tokens,
  onRemove,
  onAdd,
}: {
  fundData: CompareFundData[];
  selectedCodes: number[];
  tokens: ClearLensTokens;
  onRemove: (fund: CompareFundData) => void;
  onAdd: () => void;
}) {
  const cl = tokens.colors;
  const atMax = selectedCodes.length >= MAX_FUNDS;

  return (
    <View style={{ gap: 8, paddingBottom: 2 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text
          style={{ fontSize: 10, fontFamily: ClearLensFonts.bold, letterSpacing: 1.4, textTransform: 'uppercase', color: cl.textTertiary }}
        >
          Comparing · {selectedCodes.length} of {MAX_FUNDS}
        </Text>
        {!atMax ? (
          <TouchableOpacity
            onPress={onAdd}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{ minHeight: 40, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text
              style={{ fontSize: 11, fontFamily: ClearLensFonts.bold, letterSpacing: 0.5, textTransform: 'uppercase', color: cl.emeraldDeep }}
            >
              + Add fund
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {fundData.map((f) => (
          <FundChip
            key={f.code}
            letter={f.badgeLetter}
            color={f.badgeColor}
            soft={f.badgeSoft}
            label={fundDisplayName(f.scheme)}
            onRemove={() => onRemove(f)}
          />
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Returns card (dark hero)
// ---------------------------------------------------------------------------

function ReturnsCard({
  fundData,
  fundsWithHistory,
  tokens,
}: {
  fundData: CompareFundData[];
  fundsWithHistory: CompareFundData[];
  tokens: ClearLensTokens;
}) {
  const allSameCategory = fundData.length > 0 && fundData.every(
    (f) => fundCategory(f.scheme) === fundCategory(fundData[0].scheme),
  );

  const headline = returnsHeadline(fundsWithHistory);
  const sub = allSameCategory
    ? 'Same category — a direct comparison.'
    : 'These sit in different fund categories, so they hold different things by design.';

  return (
    <FindingCard headline={headline} sub={sub} tone="dark" tokens={tokens}>
      <BarsViz
        funds={fundsWithHistory}
        valFn={(f) => f.metrics?.trailing.y3 ?? null}
        formatFn={(v) => `${(v * 100).toFixed(1)}%`}
        dark
        tokens={tokens}
      />
      <NumbersReveal
        funds={fundsWithHistory}
        dark
        tokens={tokens}
        rows={[
          {
            label: '1Y return',
            cells: fundsWithHistory.map((f) => fmtPct(f.metrics?.trailing.y1 ?? null)),
          },
          {
            label: '3Y return',
            cells: fundsWithHistory.map((f) => fmtPct(f.metrics?.trailing.y3 ?? null)),
          },
          {
            label: '5Y return',
            cells: fundsWithHistory.map((f) => fmtPct(f.metrics?.trailing.y5 ?? null)),
          },
        ]}
      />
    </FindingCard>
  );
}

// ---------------------------------------------------------------------------
// Risk card
// ---------------------------------------------------------------------------

function RiskCard({
  fundsWithHistory,
  tokens,
}: {
  fundsWithHistory: CompareFundData[];
  tokens: ClearLensTokens;
}) {
  const ddVals = fundsWithHistory
    .map((f) => f.metrics?.maxDrawdown ?? null)
    .filter((v): v is number => v != null)
    .map((v) => Math.abs(v * 100));

  const ddLo = ddVals.length ? Math.min(...ddVals) : null;
  const ddHi = ddVals.length ? Math.max(...ddVals) : null;

  const useTradeOff = tradeOffHolds(fundsWithHistory);
  const headline = useTradeOff
    ? 'Higher returns came with deeper drops.'
    : ddLo != null && ddHi != null && Math.abs(ddHi - ddLo) > 0.5
    ? `The worst historical drop ranges from ${ddLo.toFixed(0)}% to ${ddHi.toFixed(0)}%.`
    : 'Historical drops vary across these funds.';

  const sub = useTradeOff && ddLo != null && ddHi != null
    ? `Worst peak-to-trough drop ranged from ${ddLo.toFixed(0)}% to ${ddHi.toFixed(0)}% over 5 years.`
    : 'Worst peak-to-trough drop over the last 5 years.';

  return (
    <FindingCard headline={headline} sub={sub} tokens={tokens}>
      <BarsViz
        funds={fundsWithHistory}
        valFn={(f) => f.metrics?.maxDrawdown != null ? Math.abs(f.metrics.maxDrawdown) : null}
        formatFn={(v) => `–${(v * 100).toFixed(0)}%`}
        tokens={tokens}
      />
      <NumbersReveal
        funds={fundsWithHistory}
        tokens={tokens}
        rows={[
          {
            label: 'Volatility',
            cells: fundsWithHistory.map((f) =>
              f.metrics?.stdDev != null ? `${(f.metrics.stdDev * 100).toFixed(1)}%` : '—',
            ),
          },
          {
            label: 'Sharpe ratio',
            cells: fundsWithHistory.map((f) =>
              f.metrics?.sharpe != null ? f.metrics.sharpe.toFixed(2) : '—',
            ),
          },
          {
            label: 'Beta',
            cells: fundsWithHistory.map((f) => {
              const beta = readMfdataBeta(f.scheme.riskRatios, f.scheme.schemeCategory);
              return beta != null ? beta.toFixed(2) : '—';
            }),
          },
        ]}
      />
    </FindingCard>
  );
}

// ---------------------------------------------------------------------------
// Cost card
// ---------------------------------------------------------------------------

function CostCard({
  fundData,
  tokens,
}: {
  fundData: CompareFundData[];
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;

  const costs = fundData.map((f) => ({
    fund: f,
    cost5y: f.scheme.expenseRatio != null
      ? Math.round(100000 * (f.scheme.expenseRatio / 100) * 5)
      : null,
  }));

  const validCosts = costs.filter((c) => c.cost5y != null).map((c) => c.cost5y as number);
  const minCost = validCosts.length > 0 ? Math.min(...validCosts) : null;
  const maxCost = validCosts.length > 0 ? Math.max(...validCosts) : null;
  const range = minCost != null && maxCost != null ? maxCost - minCost : 0;

  const headline = range < 200
    ? 'Costs are close — the spread is under ₹200 over 5 years on ₹1L.'
    : `Costs differ by ₹${range.toLocaleString('en-IN')} over 5 years on ₹1L.`;

  return (
    <FindingCard headline={headline} sub="Expense ratio is what the fund charges per year." tokens={tokens}>
      {/* Mint callout tile */}
      {minCost != null && maxCost != null ? (
        <View
          style={{
            backgroundColor: cl.mint50,
            borderRadius: ClearLensRadii.md,
            padding: 14,
            paddingHorizontal: 16,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <View style={{ gap: 2 }}>
            <Text
              style={{ fontSize: 11, fontFamily: ClearLensFonts.bold, letterSpacing: 0.6, textTransform: 'uppercase', color: cl.emeraldDeep }}
            >
              5Y cost on ₹1L
            </Text>
            <Text
              style={{ fontFamily: ClearLensFonts.extraBold, fontSize: 18, lineHeight: 24, color: cl.navy, fontVariant: ['tabular-nums'] }}
            >
              ₹{minCost.toLocaleString('en-IN')}–₹{maxCost.toLocaleString('en-IN')}
            </Text>
          </View>
          <Text
            style={{ fontFamily: ClearLensFonts.extraBold, fontSize: 22, lineHeight: 26, color: cl.emeraldDeep, fontVariant: ['tabular-nums'] }}
          >
            {range < 200 ? '≈ same' : `₹${range.toLocaleString('en-IN')} gap`}
          </Text>
        </View>
      ) : null}

      <NumbersReveal
        funds={fundData}
        tokens={tokens}
        rows={[
          {
            label: 'Expense ratio',
            cells: fundData.map((f) =>
              f.scheme.expenseRatio != null ? `${f.scheme.expenseRatio.toFixed(2)}%` : '—',
            ),
          },
          {
            label: 'Exit load',
            cells: fundData.map((f) => {
              const el = f.scheme.exitLoad;
              if (!el) return '—';
              return el.split(' if')[0] ?? el;
            }),
          },
        ]}
      />
    </FindingCard>
  );
}

// ---------------------------------------------------------------------------
// What's inside card
// ---------------------------------------------------------------------------

function WhatsInsideCard({
  fundData,
  tokens,
}: {
  fundData: CompareFundData[];
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  const sem = tokens.semantic;

  return (
    <FindingCard
      headline="What each fund holds, in equity terms."
      sub="Same money, different mixes. Compare the size of each company group."
      tokens={tokens}
    >
      <View style={{ gap: 12 }}>
        {fundData.map((f) => {
          const comp = f.composition;
          const large = comp?.largeCapPct ?? 0;
          const mid = comp?.midCapPct ?? 0;
          const small = comp?.smallCapPct ?? 0;
          const other = comp?.notClassifiedPct ?? Math.max(0, 100 - large - mid - small);

          return (
            <View key={f.code} style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <FundBadge letter={f.badgeLetter} color={f.badgeColor} size={18} radius={5} />
                <Text style={{ fontSize: 12, fontFamily: ClearLensFonts.semiBold, color: cl.textSecondary, flex: 1 }}>
                  {fundDisplayName(f.scheme)}
                </Text>
                <Text
                  style={{ fontSize: 11, fontFamily: ClearLensFonts.medium, color: cl.textTertiary, fontVariant: ['tabular-nums'] }}
                >
                  {large.toFixed(0)}L · {mid.toFixed(0)}M · {small.toFixed(0)}S
                </Text>
              </View>
              {/* Stacked bar */}
              <View style={{ height: 10, borderRadius: ClearLensRadii.full, flexDirection: 'row', overflow: 'hidden', backgroundColor: cl.surfaceSoft }}>
                {large > 0 ? <View style={{ width: `${large}%` as unknown as number, backgroundColor: sem.marketCap.large }} /> : null}
                {mid > 0 ? <View style={{ width: `${mid}%` as unknown as number, backgroundColor: sem.marketCap.mid }} /> : null}
                {small > 0 ? <View style={{ width: `${small}%` as unknown as number, backgroundColor: sem.marketCap.small }} /> : null}
                {other > 0 ? <View style={{ width: `${other}%` as unknown as number, backgroundColor: sem.marketCap.other }} /> : null}
              </View>
            </View>
          );
        })}

        {/* Legend */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingTop: 4 }}>
          {[
            { color: sem.marketCap.large, label: 'Large' },
            { color: sem.marketCap.mid, label: 'Mid' },
            { color: sem.marketCap.small, label: 'Small' },
            { color: sem.marketCap.other, label: 'Other' },
          ].map((s) => (
            <View key={s.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: s.color }} />
              <Text style={{ fontSize: 10, fontFamily: ClearLensFonts.semiBold, color: cl.textTertiary }}>
                {s.label}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </FindingCard>
  );
}

// ---------------------------------------------------------------------------
// Overlap card
// ---------------------------------------------------------------------------

function OverlapCard({
  fundData,
  tokens,
}: {
  fundData: CompareFundData[];
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;

  const pairs: { a: CompareFundData; b: CompareFundData; shared: number }[] = [];
  const tops = fundData.map((f) =>
    new Set((f.composition?.topHoldings ?? []).slice(0, 5).map((h) => h.name)),
  );
  for (let i = 0; i < fundData.length; i++) {
    for (let j = i + 1; j < fundData.length; j++) {
      const shared = [...tops[i]].filter((n) => tops[j].has(n)).length;
      pairs.push({ a: fundData[i], b: fundData[j], shared });
    }
  }



  const totalShared = pairs.reduce((s, p) => s + p.shared, 0);
  const headline = totalShared === 0
    ? "Top holdings don't repeat across these funds."
    : 'Some top holdings repeat across these funds.';

  const cols = pairs.length <= 3 ? pairs.length : 3;

  return (
    <FindingCard
      headline={headline}
      sub="How many of each fund's top 5 names also appear in another fund's top 5."
      tokens={tokens}
    >
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 10,
        }}
      >
        {pairs.map((pair, i) => (
          <View
            key={i}
            style={{
              width: cols === 1 ? '100%' : `${(100 / cols - 2)}%` as unknown as number,
              minWidth: 80,
              flex: 1,
              backgroundColor: cl.surfaceSoft,
              borderRadius: ClearLensRadii.md,
              padding: 12,
              alignItems: 'center',
              gap: 8,
            }}
          >
            {/* Overlapping badge pair */}
            <View style={{ flexDirection: 'row' }}>
              <FundBadge letter={pair.a.badgeLetter} color={pair.a.badgeColor} size={22} radius={ClearLensRadii.full} />
              <View style={{ marginLeft: -8 }}>
                <FundBadge letter={pair.b.badgeLetter} color={pair.b.badgeColor} size={22} radius={ClearLensRadii.full} />
              </View>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 1 }}>
              <Text style={{ fontFamily: ClearLensFonts.extraBold, fontSize: 22, color: cl.navy, fontVariant: ['tabular-nums'] }}>
                {pair.shared}
              </Text>
              <Text style={{ fontSize: 11, fontFamily: ClearLensFonts.semiBold, color: cl.textTertiary }}>
                /5
              </Text>
            </View>
            <Text style={{ fontSize: 10, fontFamily: ClearLensFonts.semiBold, color: cl.textTertiary }}>
              shared
            </Text>
          </View>
        ))}
      </View>
    </FindingCard>
  );
}

// ---------------------------------------------------------------------------
// The basics card
// ---------------------------------------------------------------------------

function BasicsCard({
  fundData,
  tokens,
}: {
  fundData: CompareFundData[];
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;

  const rows: { label: string; cells: string[] }[] = [
    {
      label: 'AMC',
      cells: fundData.map((f) => f.scheme.amcName ?? '—'),
    },
    {
      label: 'Fund size',
      cells: fundData.map((f) => fmtAumCr(f.scheme.aumCr)),
    },
    {
      label: 'Benchmark',
      cells: fundData.map((f) => f.scheme.benchmark ?? '—'),
    },
    {
      label: 'Exit load',
      cells: fundData.map((f) => {
        const el = f.scheme.exitLoad;
        if (!el) return '—';
        return el.split(' if')[0] ?? el;
      }),
    },
    {
      label: 'Launched',
      cells: fundData.map((f) => launchYear(f.scheme.launchDate)),
    },
  ];

  return (
    <FindingCard headline="The basics." tokens={tokens}>
      <View style={{ gap: 0 }}>
        {/* Header row */}
        <View style={{ flexDirection: 'row', gap: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: cl.borderLight }}>
          <View style={{ width: 80 }} />
          {fundData.map((f) => (
            <View key={f.code} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <FundBadge letter={f.badgeLetter} color={f.badgeColor} size={16} radius={4} />
              <Text
                style={{ fontSize: 10, fontFamily: ClearLensFonts.bold, color: cl.textTertiary, flex: 1 }}
                numberOfLines={1}
              >
                {fundDisplayName(f.scheme)}
              </Text>
            </View>
          ))}
        </View>
        {rows.map((row, idx) => (
          <View
            key={row.label}
            style={{
              flexDirection: 'row',
              gap: 8,
              paddingVertical: 8,
              borderTopWidth: idx === 0 ? 0 : 1,
              borderTopColor: cl.borderLight,
            }}
          >
            <Text
              style={{ width: 80, fontSize: 11, fontFamily: ClearLensFonts.medium, color: cl.textTertiary }}
            >
              {row.label}
            </Text>
            {row.cells.map((cell, i) => (
              <Text
                key={i}
                style={{
                  flex: 1,
                  fontSize: 12,
                  fontFamily: ClearLensFonts.semiBold,
                  color: cl.navy,
                }}
                numberOfLines={2}
              >
                {cell}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </FindingCard>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function ClearLensCompareFundsScreen() {
  useTrackInsightViewed('compare_funds');
  const router = useRouter();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const previewMode = useAppStore((s) => s.previewMode);
  const queryClient = useQueryClient();

  const [selectedCodes, setSelectedCodes] = useState<number[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [snackbar, setSnackbar] = useState<{
    code: number;
    familyName: string;
    badgeLetter: string;
    badgeColor: string;
  } | null>(null);
  const snackbarTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // On-demand hydration for compared funds. The monthly openfolio-sync cron
  // only pre-seeds HELD funds, so a Compare pick nobody holds is hydrated here
  // (fetch-fund-snapshot is official-first → writes its `official` row live).
  // Idempotent — both edge functions are no-ops when the cache is fresh.
  // We invalidate the dependent queries on success so the screen rerenders
  // with the freshly-hydrated rows.
  const hydrationQueries = useQueries({
    queries: selectedCodes.flatMap((code) => [
      {
        queryKey: ['compare:hydrate-snapshot', code],
        queryFn: async () => {
          const { data, error } = await functionsClient.invoke<{ status: string }>(
            'fetch-fund-snapshot',
            { body: { scheme_code: code } },
          );
          if (error) throw new Error(`fetch-fund-snapshot: ${error.message}`);
          queryClient.invalidateQueries({ queryKey: ['scheme-master', code] });
          queryClient.invalidateQueries({ queryKey: ['compare:schemes'] });
          queryClient.invalidateQueries({ queryKey: ['compare:compositions'] });
          return data;
        },
        staleTime: 5 * 60 * 1000,
      },
      {
        queryKey: ['compare:hydrate-nav', code],
        queryFn: async () => {
          const { data, error } = await functionsClient.invoke<{ status: string }>(
            'fetch-fund-nav',
            { body: { scheme_code: code } },
          );
          if (error) throw new Error(`fetch-fund-nav: ${error.message}`);
          queryClient.invalidateQueries({ queryKey: ['fund-nav-history', code] });
          queryClient.invalidateQueries({ queryKey: ['compare:navhistory'] });
          return data;
        },
        staleTime: 5 * 60 * 1000,
      },
    ]),
  });
  void hydrationQueries;

  const schemesQuery = useQuery({
    queryKey: ['compare:schemes', selectedCodes],
    enabled: selectedCodes.length > 0,
    queryFn: () => fetchSchemes(queryClient, selectedCodes),
    staleTime: 60 * 1000,
  });
  const compositionsQuery = useQuery({
    queryKey: ['compare:compositions', selectedCodes],
    enabled: selectedCodes.length > 0,
    queryFn: () => fetchCompositionsForCodes(selectedCodes),
    staleTime: 5 * 60 * 1000,
  });
  const navHistoryQuery = useQuery({
    queryKey: ['compare:navhistory', selectedCodes],
    enabled: selectedCodes.length > 0,
    queryFn: () => fetchNavHistoryForCodes(queryClient, selectedCodes),
    staleTime: 5 * 60 * 1000,
  });

  // Preserve selection order from selectedCodes.
  const schemes = useMemo<SchemeMasterRow[]>(() => {
    if (!schemesQuery.data) return [];
    const byCode = new Map(schemesQuery.data.map((s) => [s.schemeCode, s]));
    return selectedCodes.map((c) => byCode.get(c)).filter((s): s is SchemeMasterRow => !!s);
  }, [schemesQuery.data, selectedCodes]);

  const compositionsByCode = useMemo(() => {
    const map = new Map<number, CompositionRow>();
    for (const row of compositionsQuery.data ?? []) {
      if (isCompositionImplausible(row.equityPct, row.debtPct, row.cashPct, row.otherPct)) continue;
      map.set(row.schemeCode, row);
    }
    return map;
  }, [compositionsQuery.data]);

  const metricsByCode = useMemo(() => {
    const map = new Map<number, Metrics>();
    const navMap = navHistoryQuery.data;
    if (!navMap) return map;
    for (const code of selectedCodes) {
      const series = navMap.get(code) ?? [];
      const trailing = computeTrailingReturns(series);
      const risk = computeRiskMetrics(series, { windowYears: 3 });
      const maxDrawdown = computeMaxDrawdown(series);
      map.set(code, { trailing, ...risk, maxDrawdown });
    }
    return map;
  }, [navHistoryQuery.data, selectedCodes]);

  // Assembled per-fund data with badge identity.
  const fundData = useMemo<CompareFundData[]>(() => {
    return schemes.map((scheme, i) => ({
      code: scheme.schemeCode,
      badgeLetter: BADGE_LETTERS[i] ?? String.fromCharCode(65 + i),
      badgeColor: BADGE_COLORS[i] ?? '#888888',
      badgeSoft: BADGE_SOFT_COLORS[i] ?? tokens.colors.surfaceSoft,
      scheme,
      metrics: metricsByCode.get(scheme.schemeCode) ?? null,
      composition: compositionsByCode.get(scheme.schemeCode) ?? null,
    }));
  }, [schemes, metricsByCode, compositionsByCode, tokens.colors.surfaceSoft]);

  const handleToggle = (scheme: SchemeSearchResult) => {
    setSelectedCodes((prev) => {
      if (prev.includes(scheme.schemeCode)) return prev.filter((c) => c !== scheme.schemeCode);
      if (prev.length >= MAX_FUNDS) return prev;
      return [...prev, scheme.schemeCode];
    });
  };

  const handleRemove = (fund: CompareFundData) => {
    if (snackbarTimer.current) clearTimeout(snackbarTimer.current);
    setSelectedCodes((prev) => prev.filter((c) => c !== fund.code));
    setSnackbar({
      code: fund.code,
      familyName: fund.scheme.familyName ?? fundDisplayName(fund.scheme),
      badgeLetter: fund.badgeLetter,
      badgeColor: fund.badgeColor,
    });
    snackbarTimer.current = setTimeout(() => setSnackbar(null), 4000);
  };

  const handleUndoRemove = () => {
    if (snackbarTimer.current) clearTimeout(snackbarTimer.current);
    if (snackbar) {
      setSelectedCodes((prev) => {
        if (prev.includes(snackbar.code) || prev.length >= MAX_FUNDS) return prev;
        return [...prev, snackbar.code];
      });
    }
    setSnackbar(null);
  };

  const handleBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/tools');
  };

  // Preview / logged-out states
  if (previewMode) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={handleBack} />
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.titleBlock}>
            <Text style={styles.eyebrow}>Compare funds</Text>
            <Text style={styles.title}>Side-by-side on the metrics that matter</Text>
            <Text style={styles.subtitle}>
              Returns, risk, cost, holdings — across up to {MAX_FUNDS} funds at once.
            </Text>
          </View>
          <ToolsPreviewSampleCard
            bannerMessage="A sample comparison of HDFC Mid-Cap vs HDFC Hybrid Equity. Sign up to compare any two funds with their real history."
            heroLabel="HDFC Mid-Cap vs HDFC Hybrid Equity"
            heroValue="+6.3% / yr"
            heroSubtitle="Over 3Y, HDFC Mid-Cap returned 18.5%; HDFC Hybrid Equity returned 12.2%."
            chart={{
              series: [
                {
                  label: 'HDFC Mid-Cap',
                  color: tokens.colors.emerald,
                  points: [100, 109, 121, 135, 142, 158, 174, 186, 197, 215, 232, 248],
                },
                {
                  label: 'HDFC Hybrid Equity',
                  color: tokens.colors.textTertiary,
                  points: [100, 106, 113, 121, 128, 135, 142, 149, 156, 164, 172, 178],
                },
              ],
            }}
            rows={[
              { label: '3Y — HDFC Mid-Cap', value: '18.5%', tone: 'positive' },
              { label: '3Y — HDFC Hybrid Equity', value: '12.2%' },
              { label: 'Max drawdown — Mid-Cap', value: '–26%' },
              { label: 'Max drawdown — Hybrid', value: '–14%' },
              { label: 'Expense ratio — Mid-Cap', value: '0.65%' },
              { label: 'Expense ratio — Hybrid', value: '0.78%' },
            ]}
            footnote="Sample numbers. Sign up to compare any funds with their real history."
          />
        </ScrollView>
      </ClearLensScreen>
    );
  }

  if (!userId) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={handleBack} />
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Sign in to use this tool</Text>
        </View>
      </ClearLensScreen>
    );
  }

  const isLoading = selectedCodes.length > 0
    && (schemesQuery.isLoading || navHistoryQuery.isLoading || compositionsQuery.isLoading);

  const hasError = schemesQuery.isError || navHistoryQuery.isError || compositionsQuery.isError;

  const fundsWithHistory = fundData.filter((f) => hasHistory(f.metrics));
  const fundsWithoutHistory = fundData.filter((f) => !hasHistory(f.metrics));
  const uniqueCategories = [...new Set(fundData.map((f) => fundCategory(f.scheme)))];
  const isCrossCategory = uniqueCategories.length > 1;

  const renderContent = () => {
    if (fundData.length === 0 && !isLoading) {
      return <EmptyState tokens={tokens} onAdd={() => setPickerOpen(true)} />;
    }

    if (fundData.length === 1) {
      return (
        <OneFundState
          fund={fundData[0]}
          tokens={tokens}
          onRemove={() => handleRemove(fundData[0])}
          onAdd={() => setPickerOpen(true)}
        />
      );
    }

    if (isLoading) {
      return (
        <View style={styles.center}>
          <Text style={styles.helperText}>Crunching the numbers…</Text>
        </View>
      );
    }

    if (hasError) {
      return (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Something went wrong</Text>
          <Text style={styles.helperText}>Check your connection and try again.</Text>
          <TouchableOpacity
            onPress={() => {
              schemesQuery.refetch();
              navHistoryQuery.refetch();
              compositionsQuery.refetch();
            }}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <View style={{ gap: 18 }}>
        {/* Fund strip */}
        <FundStripView
          fundData={fundData}
          selectedCodes={selectedCodes}
          tokens={tokens}
          onRemove={handleRemove}
          onAdd={() => setPickerOpen(true)}
        />

        {/* Banners */}
        {fundsWithoutHistory.length > 0
          ? fundsWithoutHistory.map((f) => (
              <NoHistoryBanner key={f.code} fund={f} tokens={tokens} />
            ))
          : null}
        {isCrossCategory ? (
          <CrossCategoryBanner categories={uniqueCategories} tokens={tokens} />
        ) : null}

        {/* Finding cards */}
        {fundsWithHistory.length >= 2 ? (
          <ReturnsCard fundData={fundData} fundsWithHistory={fundsWithHistory} tokens={tokens} />
        ) : null}
        {fundsWithHistory.length >= 2 ? (
          <RiskCard fundsWithHistory={fundsWithHistory} tokens={tokens} />
        ) : null}
        <CostCard fundData={fundData} tokens={tokens} />
        <WhatsInsideCard fundData={fundData} tokens={tokens} />
        <OverlapCard fundData={fundData} tokens={tokens} />
        <BasicsCard fundData={fundData} tokens={tokens} />

        {/* Footer */}
        <Text style={styles.disclaimer}>
          Past performance is not indicative of future returns. FolioLens does not recommend funds.
        </Text>
        <PortfolioDisclaimer />
      </View>
    );
  };

  return (
    <ClearLensScreen>
      <ClearLensHeader onPressBack={handleBack} />
      <View style={styles.screenBody}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {renderContent()}
        </ScrollView>

        {snackbar ? (
          <UndoSnackbar
            badgeLetter={snackbar.badgeLetter}
            badgeColor={snackbar.badgeColor}
            schemeName={snackbar.familyName}
            onUndo={handleUndoRemove}
            tokens={tokens}
          />
        ) : null}
      </View>

      <UniversalFundPicker
        visible={pickerOpen}
        selectedCodes={selectedCodes}
        mode="multi"
        maxFunds={MAX_FUNDS}
        onToggle={handleToggle}
        onClose={() => setPickerOpen(false)}
        title="Pick funds to compare"
      />
    </ClearLensScreen>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    screenBody: {
      flex: 1,
    },
    scrollContent: {
      paddingHorizontal: ClearLensSpacing.md,
      paddingTop: ClearLensSpacing.sm,
      paddingBottom: ClearLensSpacing.xxl,
      gap: ClearLensSpacing.sm,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: ClearLensSpacing.xl,
      paddingVertical: ClearLensSpacing.lg,
      gap: ClearLensSpacing.sm,
    },
    helperText: { ...ClearLensTypography.body, color: cl.textTertiary, textAlign: 'center' },
    emptyTitle: { ...ClearLensTypography.h2, color: cl.navy, textAlign: 'center' },
    titleBlock: {
      gap: 4,
      paddingHorizontal: ClearLensSpacing.xs,
      paddingVertical: ClearLensSpacing.sm,
    },
    eyebrow: {
      ...ClearLensTypography.label,
      color: cl.emerald,
      textTransform: 'uppercase',
    },
    title: { ...ClearLensTypography.h1, color: cl.navy },
    subtitle: { ...ClearLensTypography.body, color: cl.textSecondary },
    disclaimer: {
      fontSize: 11,
      fontFamily: ClearLensFonts.medium,
      color: cl.textTertiary,
      lineHeight: 17,
      paddingHorizontal: 4,
    },
    retryButton: {
      paddingVertical: ClearLensSpacing.sm,
      paddingHorizontal: ClearLensSpacing.lg,
      backgroundColor: cl.mint50,
      borderRadius: ClearLensRadii.full,
      marginTop: ClearLensSpacing.sm,
    },
    retryText: {
      ...ClearLensTypography.label,
      color: cl.emeraldDeep,
      fontFamily: ClearLensFonts.bold,
    },
  });
}
