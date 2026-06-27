/**
 * Direct vs Regular Impact — cohesion redesign (M4 Phase 4 Tools Hub).
 *
 * Flow: title block → detected inputs → ToolResultHero → compact two-bar
 * compare viz + "See the assumptions" reveal → "What this means" →
 * "Your portfolio" (per-fund). No "What to do" card; no prescriptive copy.
 *
 * Personalized path: drag computed per regular fund from its own ER delta
 * vs its direct-plan sibling (family_name lookup in scheme_master). Falls
 * back to per-category commission constant when no sibling is found.
 *
 * All colors via useClearLensTokens() — no literal hex values.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import {
  ClearLensCard,
  ClearLensHeader,
  ClearLensScreen,
  ClearLensSegmentedControl,
} from '@/src/components/clearLens/ClearLensPrimitives';
import { PortfolioDisclaimer } from '@/src/components/clearLens/PortfolioDisclaimer';
import { ToolsPreviewSampleCard } from '@/src/components/clearLens/ToolsPreviewSampleCard';
import {
  RevealSection,
  StatusChip,
  ToolResultHero,
  ToolTitleBlock,
} from '@/src/components/clearLens/tools/kit';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { useSession } from '@/src/hooks/useSession';
import { useTrackInsightViewed } from '@/src/hooks/useTrackInsightViewed';
import { fundViewRepo } from '@/src/lib/data/userFund';
import { transactionRepo } from '@/src/lib/data/transaction';
import { navHistoryRepo } from '@/src/lib/data/navHistory';
import { schemeMasterRepo } from '@/src/lib/data/schemeMaster';
import { useAppStore } from '@/src/store/appStore';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { fetchSchemeMaster } from '@/src/hooks/useSchemeMaster';
import {
  buildPlanBreakdown,
  computeCostImpact,
  computeFundDrags,
  detectPlanType,
  weightedFeeGapPct,
  type DirectErSource,
  type FundDragInput,
  type FundDragResult,
  type FundPlanRow,
  type PlanType,
} from '@/src/utils/directVsRegularCalc';
import { formatCurrency } from '@/src/utils/formatting';
import { shortSchemeName } from '@/src/utils/schemeName';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HORIZON_OPTIONS: { value: HorizonKey; label: string }[] = [
  { value: '5Y', label: '5Y' },
  { value: '10Y', label: '10Y' },
  { value: '15Y', label: '15Y' },
  { value: '20Y', label: '20Y' },
];

type HorizonKey = '5Y' | '10Y' | '15Y' | '20Y';

const HORIZON_YEARS: Record<HorizonKey, number> = {
  '5Y': 5,
  '10Y': 10,
  '15Y': 15,
  '20Y': 20,
};

const DEFAULT_BASE_RETURN = 0.10;
const DEFAULT_EXPENSE_DELTA_PCT = 0.007; // 70 bps — illustrative only
const DEFAULT_SIP = 10_000;
const ILLUSTRATIVE_CORPUS = 5_00_000; // used when no funds detected

// Per-category commission constants (Option 2 fallback for sibling-lookup miss).
const CATEGORY_COMMISSION_PCT: { pattern: RegExp; pct: number }[] = [
  { pattern: /equity|flexi|large.?cap|mid.?cap|small.?cap|multi.?cap|elss|index|etf/i, pct: 0.90 },
  { pattern: /hybrid|balanced|multi.?asset|aggressive|conservative|arbitrage/i, pct: 0.70 },
  { pattern: /debt|credit|bond|duration|liquid|overnight|money.?market|banking|psu/i, pct: 0.40 },
  { pattern: /solution|retirement|children/i, pct: 0.50 },
];

function categoryCommission(sebiCat: string | null, schemeCat: string | null): number {
  const cat = (sebiCat ?? schemeCat ?? '').toLowerCase();
  for (const { pattern, pct } of CATEGORY_COMMISSION_PCT) {
    if (pattern.test(cat)) return pct;
  }
  return 0.70;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DvrFund {
  id: string;
  schemeName: string;
  schemeCode: number | null;
  currentValue: number;
  expenseRatio: number | null;
  planType: PlanType;
  familyName: string | null;
  sebiCategory: string | null;
  schemeCategory: string | null;
  directEr: number | null;
  directErSource: DirectErSource | null;
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

async function fetchRawFunds(userId: string) {
  const { data: funds, error } = await fundViewRepo
    .from()
    .select('id, scheme_name, scheme_code, expense_ratio')
    .eq('user_id', userId)
    .eq('is_active', true);
  if (error) throw error;
  if (!funds?.length) return [];

  const fundIds = funds.map((f) => f.id as string);
  const { data: txs } = await transactionRepo
    .from()
    .select('fund_id, transaction_type, units')
    .in('fund_id', fundIds);

  const unitsByFund = new Map<string, number>();
  for (const tx of txs ?? []) {
    const fid = tx.fund_id as string;
    const t = (tx.transaction_type as string) ?? '';
    const u = Number(tx.units) || 0;
    const isIn = ['purchase', 'switch_in', 'dividend_reinvest'].includes(t);
    const isOut = ['redemption', 'switch_out'].includes(t);
    unitsByFund.set(fid, (unitsByFund.get(fid) ?? 0) + (isIn ? u : isOut ? -u : 0));
  }

  const schemeCodes = funds
    .map((f) => f.scheme_code as number | null)
    .filter((c): c is number => c != null);
  const navByScheme = new Map<number, number>();
  if (schemeCodes.length > 0) {
    const { data: navRows } = await navHistoryRepo
      .from()
      .select('scheme_code, nav, nav_date')
      .in('scheme_code', schemeCodes)
      .order('nav_date', { ascending: false });
    for (const row of navRows ?? []) {
      const code = row.scheme_code as number;
      if (!navByScheme.has(code)) navByScheme.set(code, row.nav as number);
    }
  }

  return funds
    .filter((f) => f.id && f.scheme_name)
    .map((f) => ({
      id: f.id as string,
      schemeName: f.scheme_name as string,
      schemeCode: (f.scheme_code as number | null) ?? null,
      currentValue: Math.max(
        0,
        (Math.max(0, unitsByFund.get(f.id as string) ?? 0)) *
          (f.scheme_code != null ? navByScheme.get(f.scheme_code as number) ?? 0 : 0),
      ),
      expenseRatio: (f.expense_ratio as number | null) ?? null,
    }));
}

async function fetchDvrData(userId: string, qc: QueryClient): Promise<DvrFund[]> {
  const raw = await fetchRawFunds(userId);
  if (raw.length === 0) return [];

  // Detect plan type for every fund.
  const withPlanType = raw.map((f) => ({
    ...f,
    planType: detectPlanType(f.schemeName),
  }));

  // Identify regular-plan funds that need sibling ER lookup.
  const regularFunds = withPlanType.filter(
    (f) => f.planType === 'regular' && f.schemeCode != null,
  );

  if (regularFunds.length === 0) {
    return withPlanType.map((f) => ({
      ...f,
      familyName: null,
      sebiCategory: null,
      schemeCategory: null,
      directEr: null,
      directErSource: null,
    }));
  }

  // Fetch scheme master for regular funds to get family_name + category.
  const schemeMasters = await Promise.all(
    regularFunds.map((f) =>
      qc.fetchQuery({
        queryKey: ['scheme-master', f.schemeCode],
        queryFn: () => fetchSchemeMaster(f.schemeCode!),
        staleTime: STALE_TIMES.NAV_HISTORY,
      }),
    ),
  );

  const metaByCode = new Map<
    number,
    { familyName: string | null; sebiCategory: string | null; schemeCategory: string | null }
  >();
  for (let i = 0; i < regularFunds.length; i++) {
    const sm = schemeMasters[i];
    const code = regularFunds[i].schemeCode!;
    metaByCode.set(code, {
      familyName: sm?.family_name ?? null,
      sebiCategory: sm?.sebi_category ?? null,
      schemeCategory: sm?.scheme_category ?? null,
    });
  }

  // Batch-fetch direct-plan siblings by family_name.
  const familyNames = [
    ...new Set(
      regularFunds
        .map((f) => metaByCode.get(f.schemeCode!)?.familyName)
        .filter((n): n is string => n != null && n.length > 0),
    ),
  ];

  const directErByFamily = new Map<string, number>();
  if (familyNames.length > 0) {
    const { data: siblings } = await schemeMasterRepo
      .from()
      .select('family_name, expense_ratio')
      .in('family_name', familyNames)
      .eq('plan_type', 'direct')
      .not('expense_ratio', 'is', null);
    for (const row of siblings ?? []) {
      const fn = row.family_name as string | null;
      const er = row.expense_ratio as number | null;
      if (fn && er != null && !directErByFamily.has(fn)) {
        directErByFamily.set(fn, er);
      }
    }
  }

  // Enrich each fund.
  return withPlanType.map((f) => {
    const meta =
      f.schemeCode != null ? metaByCode.get(f.schemeCode) : undefined;
    const familyName = meta?.familyName ?? null;
    const sebiCategory = meta?.sebiCategory ?? null;
    const schemeCategory = meta?.schemeCategory ?? null;

    let directEr: number | null = null;
    let directErSource: DirectErSource | null = null;

    if (f.planType === 'regular' && f.expenseRatio != null) {
      if (familyName && directErByFamily.has(familyName)) {
        directEr = directErByFamily.get(familyName)!;
        directErSource = 'sibling-lookup';
      } else {
        const commPct = categoryCommission(sebiCategory, schemeCategory);
        directEr = Math.max(0, f.expenseRatio - commPct);
        directErSource = 'category-constant';
      }
    }

    return { ...f, familyName, sebiCategory, schemeCategory, directEr, directErSource };
  });
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/** Compact lakh/crore formatter for hero value and bar labels. */
function inrCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(2)} Cr`;
  if (abs >= 1_00_000) return `₹${(n / 1_00_000).toFixed(2)} L`;
  if (abs >= 1_000) return `₹${(n / 1_000).toFixed(1)} K`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function displayName(fund: DvrFund): string {
  return fund.familyName ?? shortSchemeName(fund.schemeName);
}

// ---------------------------------------------------------------------------
// Preview sample data (frozen — computed from real calc)
// ---------------------------------------------------------------------------

// directFV / regularFV over 10Y on ₹5L @10% / 9.07% — 6 evenly-spaced points.
const PREVIEW_DIRECT_PTS = [500000, 605000, 732050, 885780, 1071794, 1296871];
const PREVIEW_REGULAR_PTS = [500000, 596000, 710000, 845000, 1006000, 1191740];

// ---------------------------------------------------------------------------
// CompareTwoBar
// ---------------------------------------------------------------------------

function CompareTwoBar({
  directFV,
  regularFV,
  tokens,
}: {
  directFV: number;
  regularFV: number;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  const max = Math.max(directFV, regularFV, 1);
  const gap = directFV - regularFV;
  const gapPct = regularFV > 0 ? (gap / regularFV) * 100 : 0;

  const rows = [
    { key: 'direct', label: 'If held in direct plans', v: directFV, color: cl.emerald },
    { key: 'regular', label: 'In regular plans (now)', v: regularFV, color: cl.lavender },
  ];

  return (
    <View style={{ gap: 12 }}>
      {rows.map((r) => (
        <View key={r.key} style={{ gap: 5 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <Text style={{ fontSize: 12, fontFamily: ClearLensFonts.semiBold, color: cl.textSecondary, flex: 1 }}>
              {r.label}
            </Text>
            <Text style={{ fontFamily: ClearLensFonts.extraBold, fontSize: 16, color: cl.navy, fontVariant: ['tabular-nums'] }}>
              {inrCompact(r.v)}
            </Text>
          </View>
          <View style={{ height: 14, borderRadius: ClearLensRadii.full, backgroundColor: cl.surfaceSoft, overflow: 'hidden' }}>
            <View
              style={{
                width: `${(r.v / max) * 100}%` as unknown as number,
                height: '100%',
                borderRadius: ClearLensRadii.full,
                backgroundColor: r.color,
              }}
            />
          </View>
        </View>
      ))}

      {/* Gap tile */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          backgroundColor: cl.surfaceSoft,
          borderRadius: ClearLensRadii.md,
          padding: 12,
          paddingHorizontal: 14,
        }}
      >
        <Text style={{ fontSize: 11, fontFamily: ClearLensFonts.bold, letterSpacing: 0.5, textTransform: 'uppercase', color: cl.textTertiary }}>
          The gap
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text style={{ fontFamily: ClearLensFonts.extraBold, fontSize: 18, color: cl.navy, fontVariant: ['tabular-nums'] }}>
            {inrCompact(gap)}
          </Text>
          <Text style={{ fontSize: 12, fontFamily: ClearLensFonts.bold, color: cl.textTertiary, fontVariant: ['tabular-nums'] }}>
            ~{Math.abs(gapPct).toFixed(1)}%
          </Text>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// AssumptionRow
// ---------------------------------------------------------------------------

function AssumptionRow({
  label,
  value,
  isFirst = false,
  tokens,
}: {
  label: string;
  value: string;
  isFirst?: boolean;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        paddingVertical: 9,
        borderTopWidth: isFirst ? 0 : 1,
        borderTopColor: cl.borderLight,
      }}
    >
      <Text style={{ fontSize: 13, fontFamily: ClearLensFonts.regular, color: cl.textSecondary, flex: 1 }}>
        {label}
      </Text>
      <Text style={{ fontSize: 13, fontFamily: ClearLensFonts.bold, color: cl.navy, fontVariant: ['tabular-nums'], textAlign: 'right' }}>
        {value}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// RegularBadge — lavender chip used in per-fund rows
// ---------------------------------------------------------------------------

function RegularBadge({ tokens }: { tokens: ClearLensTokens }) {
  const cl = tokens.colors;
  return (
    <View
      style={{
        backgroundColor: 'rgba(110,115,196,0.12)',
        borderRadius: ClearLensRadii.sm,
        paddingHorizontal: 6,
        paddingVertical: 2,
        flexShrink: 0,
      }}
    >
      <Text style={{ fontSize: 10, fontFamily: ClearLensFonts.bold, letterSpacing: 0.4, textTransform: 'uppercase', color: cl.lavender }}>
        Regular
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// InputsCard
// ---------------------------------------------------------------------------

function InputsCard({
  personalized,
  horizon,
  onHorizonChange,
  weightedGapPct,
  sipStr,
  onSipChange,
  tokens,
}: {
  personalized: boolean;
  horizon: HorizonKey;
  onHorizonChange: (h: HorizonKey) => void;
  weightedGapPct: number | null;
  sipStr: string;
  onSipChange: (s: string) => void;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  const sep = <View style={{ height: 1, backgroundColor: cl.borderLight, marginHorizontal: ClearLensSpacing.md }} />;

  return (
    <ClearLensCard style={{ padding: 0, gap: 0 }}>
      {/* Horizon */}
      <View style={{ padding: ClearLensSpacing.md, paddingBottom: 12, gap: 8 }}>
        <Text style={{ fontSize: 11, fontFamily: ClearLensFonts.semiBold, letterSpacing: 0.4, textTransform: 'uppercase', color: cl.textTertiary }}>
          Horizon
        </Text>
        <ClearLensSegmentedControl
          options={HORIZON_OPTIONS}
          selected={horizon}
          onChange={onHorizonChange}
        />
      </View>

      {sep}

      {personalized ? (
        /* Detected fee gap — read-only */
        <View
          style={{
            paddingVertical: 12,
            paddingHorizontal: ClearLensSpacing.md,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 11, fontFamily: ClearLensFonts.semiBold, letterSpacing: 0.4, textTransform: 'uppercase', color: cl.textTertiary }}>
              Fee gap · detected
            </Text>
            <Text style={{ fontSize: 11, fontFamily: ClearLensFonts.regular, color: cl.textTertiary }}>
              Value-weighted across your regular-plan funds.
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 5, height: 5, borderRadius: ClearLensRadii.full, backgroundColor: cl.emerald }} />
            <Text style={{ fontSize: 15, fontFamily: ClearLensFonts.bold, color: cl.navy, fontVariant: ['tabular-nums'] }}>
              {weightedGapPct != null ? `${weightedGapPct.toFixed(2)}%/yr` : '—'}
            </Text>
          </View>
        </View>
      ) : (
        <>
          {/* Monthly SIP (illustrative path) */}
          <View style={{ paddingVertical: 12, paddingHorizontal: ClearLensSpacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <Text style={{ fontSize: 11, fontFamily: ClearLensFonts.semiBold, letterSpacing: 0.4, textTransform: 'uppercase', color: cl.textTertiary }}>
              Monthly SIP (₹)
            </Text>
            <TextInput
              style={{
                fontFamily: ClearLensFonts.bold,
                fontSize: 15,
                color: cl.navy,
                textAlign: 'right',
                minWidth: 80,
                fontVariant: ['tabular-nums'],
              }}
              value={sipStr}
              onChangeText={onSipChange}
              keyboardType="numeric"
              returnKeyType="done"
              placeholderTextColor={cl.textTertiary}
              accessibilityLabel="Monthly SIP amount"
            />
          </View>

          {sep}

          {/* Expense ratio delta — read-only, labelled illustrative */}
          <View style={{ paddingVertical: 12, paddingHorizontal: ClearLensSpacing.md, paddingBottom: ClearLensSpacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 11, fontFamily: ClearLensFonts.semiBold, letterSpacing: 0.4, textTransform: 'uppercase', color: cl.textTertiary }}>
                Fee difference · illustrative
              </Text>
              <Text style={{ fontSize: 11, fontFamily: ClearLensFonts.regular, color: cl.textTertiary }}>
                Typical equity-fund commission is 0.5%–1.0%/yr.
              </Text>
            </View>
            <Text style={{ fontSize: 15, fontFamily: ClearLensFonts.bold, color: cl.navy, fontVariant: ['tabular-nums'] }}>
              {(DEFAULT_EXPENSE_DELTA_PCT * 100).toFixed(2)}%
            </Text>
          </View>
        </>
      )}
    </ClearLensCard>
  );
}

// ---------------------------------------------------------------------------
// Loading / Error / NoFunds states
// ---------------------------------------------------------------------------

function LoadingState({ tokens }: { tokens: ClearLensTokens }) {
  const cl = tokens.colors;
  return (
    <View style={{ paddingVertical: 40, alignItems: 'center' }}>
      <Text style={{ ...ClearLensTypography.body, color: cl.textTertiary }}>
        Loading your funds…
      </Text>
    </View>
  );
}

function ErrorState({
  onRetry,
  tokens,
}: {
  onRetry: () => void;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  return (
    <View style={{ paddingVertical: 40, alignItems: 'center', gap: 16 }}>
      <Text style={{ ...ClearLensTypography.body, color: cl.textSecondary, textAlign: 'center' }}>
        {"Couldn't load your funds. Check your connection and try again."}
      </Text>
      <TouchableOpacity
        onPress={onRetry}
        style={{
          backgroundColor: cl.emerald,
          paddingVertical: 10,
          paddingHorizontal: 24,
          borderRadius: ClearLensRadii.full,
          minHeight: 44,
          alignItems: 'center',
          justifyContent: 'center',
        }}
        accessibilityRole="button"
        accessibilityLabel="Retry"
      >
        <Text style={{ fontSize: 14, fontFamily: ClearLensFonts.bold, color: '#fff' }}>
          Retry
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function NoFundsState({ tokens }: { tokens: ClearLensTokens }) {
  const cl = tokens.colors;
  return (
    <View style={{ paddingVertical: 32, gap: 8, paddingHorizontal: ClearLensSpacing.xs }}>
      <Ionicons name="albums-outline" size={32} color={cl.textTertiary} />
      <Text style={{ ...ClearLensTypography.h3, color: cl.navy }}>
        No funds imported yet
      </Text>
      <Text style={{ ...ClearLensTypography.body, color: cl.textSecondary, lineHeight: 22 }}>
        Import your portfolio via CAS or MF Central to detect plan types and calculate your actual cost drag.
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function ClearLensDirectVsRegularScreen() {
  useTrackInsightViewed('direct_vs_regular');
  const router = useRouter();
  const tokens = useClearLensTokens();
  const cl = tokens.colors;
  const { session } = useSession();
  const userId = session?.user.id;
  const previewMode = useAppStore((s) => s.previewMode);
  const queryClient = useQueryClient();

  const [horizon, setHorizon] = useState<HorizonKey>('10Y');
  const [sipStr, setSipStr] = useState<string>(String(DEFAULT_SIP));

  const years = HORIZON_YEARS[horizon];

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  const fundsQuery = useQuery({
    queryKey: ['dvr-funds', userId],
    queryFn: () => fetchDvrData(userId!, queryClient),
    enabled: !previewMode && !!userId,
    staleTime: 60_000,
  });

  const allFunds = fundsQuery.data ?? [];

  const breakdown = useMemo(() => {
    const rows: FundPlanRow[] = allFunds.map((f) => ({
      id: f.id,
      schemeName: f.schemeName,
      planType: f.planType,
      currentValue: f.currentValue,
      expenseRatio: f.expenseRatio,
    }));
    return buildPlanBreakdown(rows);
  }, [allFunds]);

  const fundDrags: FundDragResult[] = useMemo(() => {
    const inputs: FundDragInput[] = allFunds
      .filter(
        (f): f is DvrFund & { directEr: number; directErSource: DirectErSource } =>
          f.planType === 'regular' &&
          f.expenseRatio != null &&
          f.directEr != null &&
          f.directErSource != null,
      )
      .map((f) => ({
        fund: {
          id: f.id,
          schemeName: f.schemeName,
          planType: 'regular',
          currentValue: f.currentValue,
          expenseRatio: f.expenseRatio,
        },
        directEr: f.directEr,
        directErSource: f.directErSource,
      }));
    return computeFundDrags(inputs, years);
  }, [allFunds, years]);

  const totalDrag = fundDrags.reduce((s, d) => s + d.drag, 0);
  const wGapPct = weightedFeeGapPct(fundDrags);

  const regularMissingEr = allFunds.filter(
    (f) => f.planType === 'regular' && f.expenseRatio == null,
  );

  const hasRegular = breakdown.regular.length > 0;
  const hasAnyFunds = breakdown.totalValue > 0;
  const allDirect =
    hasAnyFunds &&
    breakdown.direct.length > 0 &&
    breakdown.regular.length === 0 &&
    breakdown.unknown.length === 0;

  // Illustrative path inputs
  const monthlySip = parseSip(sipStr);
  const illustrativeCorpus =
    breakdown.totalValue > 0 ? breakdown.totalValue : ILLUSTRATIVE_CORPUS;

  const illustrativeImpact = useMemo(
    () =>
      computeCostImpact({
        currentCorpus: illustrativeCorpus,
        monthlySip,
        years,
        directAnnualReturn: DEFAULT_BASE_RETURN,
        expenseRatioDelta: DEFAULT_EXPENSE_DELTA_PCT,
      }),
    [illustrativeCorpus, monthlySip, years],
  );

  // ---------------------------------------------------------------------------
  // Preview
  // ---------------------------------------------------------------------------

  if (previewMode) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <ScrollView
          contentContainerStyle={scrollStyle}
          showsVerticalScrollIndicator={false}
        >
          <ToolTitleBlock
            eyebrow="Direct vs Regular"
            title="How much do plan fees add up to?"
            subtitle="Direct plans skip the distributor commission, so they cost less each year. Over time, that gap compounds."
          />
          <ToolsPreviewSampleCard
            bannerMessage="A sample portfolio with two regular-plan funds, 10-year horizon. Sign up to detect your own funds' actual expense ratios."
            heroLabel="Cost drag on regular-plan holdings · 10Y"
            heroValue={inrCompact(105_131)}
            heroSubtitle="~8.8% smaller than the same ₹5.0 L held in the direct versions."
            chart={{
              series: [
                { label: `Direct ${inrCompact(PREVIEW_DIRECT_PTS[PREVIEW_DIRECT_PTS.length - 1])}`, color: cl.emerald, points: PREVIEW_DIRECT_PTS },
                { label: `Regular ${inrCompact(PREVIEW_REGULAR_PTS[PREVIEW_REGULAR_PTS.length - 1])}`, color: cl.lavender, points: PREVIEW_REGULAR_PTS },
              ],
            }}
            rows={[
              { label: 'Regular-plan holdings', value: '₹5.0 L' },
              { label: 'Detected fee gap', value: '0.93%/yr' },
              { label: 'Cost drag over 10Y', value: `−${inrCompact(105_131)}`, tone: 'negative' },
            ]}
            footnote="Sample figures. Sign up to detect your own plan types from scheme names and run this on your portfolio."
          />
          <PortfolioDisclaimer />
        </ScrollView>
      </ClearLensScreen>
    );
  }

  if (!userId) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: ClearLensSpacing.xl }}>
          <Text style={{ ...ClearLensTypography.h3, color: cl.navy, textAlign: 'center' }}>
            Sign in to use this tool
          </Text>
        </View>
      </ClearLensScreen>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const personalized = hasRegular && fundDrags.length > 0;

  return (
    <ClearLensScreen>
      <ClearLensHeader onPressBack={() => router.back()} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={scrollStyle}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <ToolTitleBlock
            eyebrow="Direct vs Regular"
            title="How much do plan fees add up to?"
            subtitle="Direct plans skip the distributor commission, so they cost less each year. Over time, that gap compounds."
          />

          {/* ----- Loading / Error / No-funds ----- */}
          {fundsQuery.isLoading ? (
            <LoadingState tokens={tokens} />
          ) : fundsQuery.isError ? (
            <ErrorState onRetry={() => fundsQuery.refetch()} tokens={tokens} />
          ) : !hasAnyFunds ? (
            <>
              <NoFundsState tokens={tokens} />
              <IllustrativeContent
                horizon={horizon}
                onHorizonChange={setHorizon}
                sipStr={sipStr}
                onSipChange={setSipStr}
                illustrativeCorpus={illustrativeCorpus}
                monthlySip={monthlySip}
                years={years}
                impact={illustrativeImpact}
                tokens={tokens}
              />
            </>
          ) : personalized ? (
            /* ----- Personalized (regular detected) ----- */
            <PersonalizedContent
              horizon={horizon}
              onHorizonChange={setHorizon}
              wGapPct={wGapPct}
              sipStr={sipStr}
              onSipChange={setSipStr}
              totalDrag={totalDrag}
              fundDrags={fundDrags}
              allFunds={allFunds}
              breakdown={breakdown}
              regularMissingEr={regularMissingEr}
              years={years}
              tokens={tokens}
            />
          ) : (
            /* ----- Illustrative (all-direct or only unknowns) ----- */
            <IllustrativeContent
              horizon={horizon}
              onHorizonChange={setHorizon}
              sipStr={sipStr}
              onSipChange={setSipStr}
              illustrativeCorpus={illustrativeCorpus}
              monthlySip={monthlySip}
              years={years}
              impact={illustrativeImpact}
              allDirect={allDirect}
              breakdown={breakdown}
              tokens={tokens}
            />
          )}

          <PortfolioDisclaimer />
        </ScrollView>
      </KeyboardAvoidingView>
    </ClearLensScreen>
  );
}

// ---------------------------------------------------------------------------
// PersonalizedContent
// ---------------------------------------------------------------------------

function PersonalizedContent({
  horizon,
  onHorizonChange,
  wGapPct,
  sipStr,
  onSipChange,
  totalDrag,
  fundDrags,
  allFunds,
  breakdown,
  regularMissingEr,
  years,
  tokens,
}: {
  horizon: HorizonKey;
  onHorizonChange: (h: HorizonKey) => void;
  wGapPct: number | null;
  sipStr: string;
  onSipChange: (s: string) => void;
  totalDrag: number;
  fundDrags: FundDragResult[];
  allFunds: DvrFund[];
  breakdown: ReturnType<typeof buildPlanBreakdown>;
  regularMissingEr: DvrFund[];
  years: number;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  const totalRegularFV = fundDrags.reduce((s, d) => s + d.regularFutureValue, 0);
  const totalDirectFV = fundDrags.reduce((s, d) => s + d.directFutureValue, 0);
  const regularCount = breakdown.regular.length;
  const totalCount =
    breakdown.direct.length + breakdown.regular.length + breakdown.unknown.length;
  const regularShare = breakdown.totalValue > 0
    ? (breakdown.regularValue / breakdown.totalValue) * 100
    : 0;

  const heroLabel = `Cost drag on your regular-plan holdings · ${horizon}`;
  const heroSubtitle = wGapPct != null
    ? `Your ${regularCount} regular-plan fund${regularCount !== 1 ? 's' : ''} carry expense ratios ~${wGapPct.toFixed(2)}%/yr above their direct versions. On ${inrCompact(breakdown.regularValue)} held over ${years} years, that compounds to this.`
    : `Your ${regularCount} regular-plan fund${regularCount !== 1 ? 's' : ''} carry higher expense ratios than their direct versions. On ${inrCompact(breakdown.regularValue)} held over ${years} years, that compounds to this.`;

  return (
    <>
      <InputsCard
        personalized
        horizon={horizon}
        onHorizonChange={onHorizonChange}
        weightedGapPct={wGapPct}
        sipStr={sipStr}
        onSipChange={onSipChange}
        tokens={tokens}
      />

      <ToolResultHero
        label={heroLabel}
        value={inrCompact(totalDrag)}
        subtitle={heroSubtitle}
        chip={<StatusChip tone="mint" onDark>Detected from your funds</StatusChip>}
      />

      {/* What that looks like */}
      <ClearLensCard style={{ gap: 14 }}>
        <CardHeader
          title="What that looks like"
          sub={`Your ${inrCompact(breakdown.regularValue)} of regular holdings, two ways, over ${horizon}.`}
          tokens={tokens}
        />
        <CompareTwoBar
          directFV={totalDirectFV}
          regularFV={totalRegularFV}
          tokens={tokens}
        />
        <RevealSection label="See the assumptions">
          <View style={{ gap: 12 }}>
            <AssumptionRow label="Base return (both plans)" value="10% p.a." isFirst tokens={tokens} />
            <AssumptionRow label="Horizon" value={`${years} years`} tokens={tokens} />
            <AssumptionRow label="Regular-plan holdings" value={inrCompact(breakdown.regularValue)} tokens={tokens} />
            {wGapPct != null && (
              <AssumptionRow label="Value-weighted fee gap" value={`${wGapPct.toFixed(2)}%/yr`} tokens={tokens} />
            )}
            {/* Per-fund ER sub-table */}
            {fundDrags.length > 0 && (
              <View style={{ gap: 4 }}>
                <Text style={{ fontSize: 11, fontFamily: ClearLensFonts.bold, letterSpacing: 0.5, textTransform: 'uppercase', color: cl.textTertiary, marginTop: 4 }}>
                  Per fund · regular → direct ER
                </Text>
                {fundDrags.map((d, i) => (
                  <AssumptionRow
                    key={d.fund.id}
                    label={shortSchemeName(d.fund.schemeName)}
                    value={`${d.regularEr.toFixed(2)}% → ${d.directEr.toFixed(2)}%  ·  +${(d.deltaDecimal * 100).toFixed(2)}%${d.directErSource === 'category-constant' ? ' (est.)' : ''}`}
                    isFirst={i === 0}
                    tokens={tokens}
                  />
                ))}
              </View>
            )}
          </View>
        </RevealSection>
      </ClearLensCard>

      {/* What this means */}
      <ClearLensCard style={{ gap: 10 }}>
        <CardHeader title="What this means" tokens={tokens} />
        <Text style={{ ...ClearLensTypography.body, color: cl.textSecondary, lineHeight: 22 }}>
          Regular plans carry a distributor commission baked into their expense ratio; direct plans
          {"don't"}. The figure above is each regular fund{"'s"}{' '}
          <Text style={{ color: cl.navy, fontFamily: ClearLensFonts.semiBold }}>own</Text>{' '}
          expense-ratio gap vs its direct version, compounded over {years} years on what you
          actually hold — not a generic estimate.
        </Text>
      </ClearLensCard>

      {/* Your portfolio */}
      <ClearLensCard style={{ padding: 0, gap: 0 }}>
        <View style={{ padding: ClearLensSpacing.md, paddingBottom: 10, gap: 8 }}>
          <CardHeader title="Your portfolio" tokens={tokens} />
          <Text style={{ ...ClearLensTypography.body, color: cl.textSecondary, lineHeight: 22 }}>
            <Text style={{ color: cl.navy, fontFamily: ClearLensFonts.semiBold }}>
              {regularCount} of your {totalCount} fund{totalCount !== 1 ? 's' : ''}
            </Text>{' '}
            are in regular plans — {inrCompact(breakdown.regularValue)} of{' '}
            {inrCompact(breakdown.totalValue)} ({regularShare.toFixed(0)}%). Here{"'s"} the
            detected cost of each.
          </Text>
        </View>

        {/* Per-fund rows */}
        <View style={{ borderTopWidth: 1, borderTopColor: cl.borderLight }}>
          {fundDrags.map((d, i) => {
            const fund = allFunds.find((f) => f.id === d.fund.id);
            return (
              <PerFundRow
                key={d.fund.id}
                name={fund ? displayName(fund) : shortSchemeName(d.fund.schemeName)}
                value={d.fund.currentValue}
                regularEr={d.regularEr}
                directEr={d.directEr}
                drag={d.drag}
                horizon={horizon}
                isLast={i === fundDrags.length - 1}
                tokens={tokens}
              />
            );
          })}
          {regularMissingEr.length > 0 && (
            <View style={{ paddingHorizontal: ClearLensSpacing.md, paddingVertical: 12, borderTopWidth: 1, borderTopColor: cl.borderLight }}>
              <Text style={{ fontSize: 12, fontFamily: ClearLensFonts.medium, color: cl.textTertiary, lineHeight: 18 }}>
                {regularMissingEr.length} regular-plan fund{regularMissingEr.length !== 1 ? 's' : ''} excluded — expense ratio not yet available. Their drag is not included in the total above.
              </Text>
            </View>
          )}
          {breakdown.unknown.length > 0 && (
            <View style={{ paddingHorizontal: ClearLensSpacing.md, paddingVertical: 12, borderTopWidth: 1, borderTopColor: cl.borderLight }}>
              <Text style={{ fontSize: 12, fontFamily: ClearLensFonts.medium, color: cl.textTertiary, lineHeight: 18 }}>
                {breakdown.unknown.length} fund{breakdown.unknown.length !== 1 ? 's' : ''} excluded — plan type not detected from scheme name.
              </Text>
            </View>
          )}
        </View>
      </ClearLensCard>

      <DisclaimerText personalized tokens={tokens} />
    </>
  );
}

// ---------------------------------------------------------------------------
// IllustrativeContent
// ---------------------------------------------------------------------------

function IllustrativeContent({
  horizon,
  onHorizonChange,
  sipStr,
  onSipChange,
  illustrativeCorpus,
  monthlySip,
  years,
  impact,
  allDirect = false,
  breakdown,
  tokens,
}: {
  horizon: HorizonKey;
  onHorizonChange: (h: HorizonKey) => void;
  sipStr: string;
  onSipChange: (s: string) => void;
  illustrativeCorpus: number;
  monthlySip: number;
  years: number;
  impact: ReturnType<typeof computeCostImpact>;
  allDirect?: boolean;
  breakdown?: ReturnType<typeof buildPlanBreakdown>;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;

  const heroLabel = `Illustrative cost drag over ${horizon}`;
  const heroSubtitle = allDirect && breakdown
    ? `Your funds are all direct plans, so none of this gap applies to your holdings — the figure is illustrative on ${inrCompact(illustrativeCorpus)} at a typical 0.70%/yr difference.`
    : `Illustrative on ${inrCompact(illustrativeCorpus)}${monthlySip > 0 ? ` + ${inrCompact(monthlySip)}/mo SIP` : ''} at a typical 0.70%/yr fee difference over ${years} years.`;

  return (
    <>
      <InputsCard
        personalized={false}
        horizon={horizon}
        onHorizonChange={onHorizonChange}
        weightedGapPct={null}
        sipStr={sipStr}
        onSipChange={onSipChange}
        tokens={tokens}
      />

      <ToolResultHero
        label={heroLabel}
        value={inrCompact(impact.impact)}
        subtitle={heroSubtitle}
        chip={<StatusChip tone="mint" onDark>{allDirect ? 'All direct — no drag' : 'Illustrative'}</StatusChip>}
      />

      {/* What that looks like */}
      <ClearLensCard style={{ gap: 14 }}>
        <CardHeader
          title="What that looks like"
          sub={`Same SIP, two return streams over ${horizon}.`}
          tokens={tokens}
        />
        <CompareTwoBar
          directFV={impact.directFutureValue}
          regularFV={impact.regularFutureValue}
          tokens={tokens}
        />
        <RevealSection label="See the assumptions">
          <AssumptionRow label="Base return (both plans)" value="10% p.a." isFirst tokens={tokens} />
          <AssumptionRow label="Fee difference (typical)" value="0.70%/yr" tokens={tokens} />
          <AssumptionRow label="Horizon" value={`${years} years`} tokens={tokens} />
          <AssumptionRow label="Illustrative corpus" value={inrCompact(illustrativeCorpus)} tokens={tokens} />
          {monthlySip > 0 && (
            <AssumptionRow label="Monthly SIP" value={formatCurrency(monthlySip)} tokens={tokens} />
          )}
          <AssumptionRow label="Direct plans grow to" value={inrCompact(impact.directFutureValue)} tokens={tokens} />
          <AssumptionRow label="Regular plans grow to" value={inrCompact(impact.regularFutureValue)} tokens={tokens} />
        </RevealSection>
      </ClearLensCard>

      {/* What this means */}
      <ClearLensCard style={{ gap: 10 }}>
        <CardHeader title="What this means" tokens={tokens} />
        <Text style={{ ...ClearLensTypography.body, color: cl.textSecondary, lineHeight: 22 }}>
          {allDirect ? (
            <>
              All of your detected funds are direct plans, so there{"'s"} no regular-vs-direct
              commission gap on your holdings. The figure above shows what a typical{' '}
              <Text style={{ color: cl.navy, fontFamily: ClearLensFonts.semiBold }}>
                0.70%/yr
              </Text>{' '}
              difference would compound to, for reference.
            </>
          ) : (
            <>
              Regular plans carry a distributor commission baked into their expense ratio;
              direct plans {"don't"}. The figure above is illustrative — once you import your
              portfolio, this tool will compute the drag from your{"  funds'"} own expense ratios.
            </>
          )}
        </Text>
      </ClearLensCard>

      {/* Your portfolio — simplified */}
      {breakdown && (
        <ClearLensCard style={{ gap: 10 }}>
          <CardHeader title="Your portfolio" tokens={tokens} />
          <Text style={{ ...ClearLensTypography.body, color: cl.textSecondary, lineHeight: 22 }}>
            {allDirect ? (
              <>
                <Text style={{ color: cl.navy, fontFamily: ClearLensFonts.semiBold }}>
                  All {breakdown.direct.length} detected fund{breakdown.direct.length !== 1 ? 's' : ''} are direct plans.
                </Text>{' '}
                {breakdown.weightedExpenseRatio != null
                  ? `Weighted expense ratio: ${breakdown.weightedExpenseRatio.toFixed(2)}%.`
                  : ''}
              </>
            ) : breakdown.unknown.length > 0 ? (
              <>
                Plan type {"couldn't"} be detected for{' '}
                <Text style={{ color: cl.navy, fontFamily: ClearLensFonts.semiBold }}>
                  {breakdown.unknown.length} fund{breakdown.unknown.length !== 1 ? 's' : ''}
                </Text>{' '}
                — the numbers above are illustrative.
              </>
            ) : (
              'No funds detected yet — the numbers above are illustrative.'
            )}
          </Text>
        </ClearLensCard>
      )}

      <DisclaimerText tokens={tokens} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared atoms
// ---------------------------------------------------------------------------

function CardHeader({
  title,
  sub,
  tokens,
}: {
  title: string;
  sub?: string;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  return (
    <View style={{ gap: 3 }}>
      <Text style={{ ...ClearLensTypography.h3, color: cl.navy }}>{title}</Text>
      {sub ? (
        <Text style={{ fontSize: 12, fontFamily: ClearLensFonts.medium, color: cl.textTertiary, lineHeight: 18 }}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

function PerFundRow({
  name,
  value,
  regularEr,
  directEr,
  drag,
  horizon,
  isLast,
  tokens,
}: {
  name: string;
  value: number;
  regularEr: number;
  directEr: number;
  drag: number;
  horizon: HorizonKey;
  isLast: boolean;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        paddingHorizontal: ClearLensSpacing.md,
        paddingVertical: 12,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: cl.borderLight,
      }}
    >
      {/* Left: name + badge + ER info */}
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text
            style={{ fontSize: 14, fontFamily: ClearLensFonts.semiBold, color: cl.navy, flexShrink: 1 }}
            numberOfLines={1}
          >
            {name}
          </Text>
          <RegularBadge tokens={tokens} />
        </View>
        <Text style={{ fontSize: 12, fontFamily: ClearLensFonts.regular, color: cl.textTertiary, fontVariant: ['tabular-nums'] }}>
          {inrCompact(value)} · ER {regularEr.toFixed(2)}%{' '}
          <Text style={{ color: cl.textSecondary }}>vs {directEr.toFixed(2)}% direct</Text>
        </Text>
      </View>

      {/* Right: rupee drag */}
      <View style={{ alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
        <Text style={{ fontSize: 14, fontFamily: ClearLensFonts.bold, color: cl.warning, fontVariant: ['tabular-nums'] }}>
          −{inrCompact(drag)}
        </Text>
        <Text style={{ fontSize: 11, fontFamily: ClearLensFonts.regular, color: cl.textTertiary }}>
          over {horizon}
        </Text>
      </View>
    </View>
  );
}

function DisclaimerText({
  personalized = false,
  tokens,
}: {
  personalized?: boolean;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  return (
    <Text
      style={{
        fontSize: 11,
        fontFamily: ClearLensFonts.medium,
        color: cl.textTertiary,
        textAlign: 'center',
        paddingHorizontal: ClearLensSpacing.sm,
        lineHeight: 17,
        marginTop: ClearLensSpacing.xs,
      }}
    >
      {personalized
        ? 'Estimates use a fixed 10% p.a. base return for both plans; the difference comes only from the expense-ratio gap, detected from your funds\' scheme names and AMFI expense ratios. Past performance is not indicative of future returns. FolioLens does not recommend funds or plans.'
        : 'Estimates use a fixed 10% p.a. base return for both plans; the difference comes only from the expense ratio gap. Past performance is not indicative of future returns. FolioLens does not recommend funds or plans.'}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSip(str: string): number {
  const n = parseFloat(str.replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Shared scroll content padding
const scrollStyle = {
  paddingHorizontal: ClearLensSpacing.md,
  paddingTop: ClearLensSpacing.xs,
  paddingBottom: ClearLensSpacing.xxl,
  gap: ClearLensSpacing.sm,
} as const;
