/**
 * Direct vs Regular Impact — surfaces the cost-drag between regular- and
 * direct-plan mutual funds in the user's portfolio. Brand-faithful factory
 * shape: inputs → hero (lead with the answer) → short prose insights →
 * disclosure.
 *
 * Detection is name-based (AMFI naming convention puts "Direct Plan" or
 * "Regular Plan" right in the scheme name). Cost impact is a future-value
 * differential: same corpus + SIP, two return streams, base − delta.
 */
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ClearLensHeader, ClearLensScreen, ClearLensSegmentedControl } from '@/src/components/clearLens/ClearLensPrimitives';
import { PortfolioDisclaimer } from '@/src/components/clearLens/PortfolioDisclaimer';
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
import { supabase } from '@/src/lib/supabase';
import {
  buildPlanBreakdown,
  computeCostImpact,
  type FundPlanRow,
} from '@/src/utils/directVsRegularCalc';
import { formatCurrency } from '@/src/utils/formatting';

const HORIZON_OPTIONS: { value: HorizonKey; label: string }[] = [
  { value: '5Y', label: '5Y' },
  { value: '10Y', label: '10Y' },
  { value: '15Y', label: '15Y' },
  { value: '20Y', label: '20Y' },
];

type HorizonKey = '5Y' | '10Y' | '15Y' | '20Y';

const HORIZON_YEARS: Record<HorizonKey, number> = {
  '5Y': 5, '10Y': 10, '15Y': 15, '20Y': 20,
};

const DEFAULT_BASE_RETURN = 0.10;
// 70 bps — typical commission delta between regular and direct equity plans.
const DEFAULT_EXPENSE_DELTA_PCT = 0.7;

interface UserFundRow {
  id: string;
  schemeName: string;
  currentValue: number;
  expenseRatio: number | null;
}

async function fetchPlanRows(userId: string): Promise<UserFundRow[]> {
  const { data: funds, error } = await supabase
    .from('fund')
    .select('id, scheme_name, scheme_code, expense_ratio')
    .eq('user_id', userId)
    .eq('is_active', true);
  if (error) throw error;
  if (!funds?.length) return [];

  // Compute current value per fund: latest NAV × net units (purchases − redemptions).
  const fundIds = funds.map((f) => f.id as string);
  const { data: txs } = await supabase
    .from('transaction')
    .select('fund_id, transaction_type, units')
    .in('fund_id', fundIds);

  const unitsByFund = new Map<string, number>();
  for (const tx of txs ?? []) {
    const fid = tx.fund_id as string;
    const t = (tx.transaction_type as string) ?? '';
    const u = Number(tx.units) || 0;
    const isOut = ['purchase', 'switch_in', 'dividend_reinvest'].includes(t);
    const isIn = ['redemption', 'switch_out'].includes(t);
    const delta = isOut ? u : isIn ? -u : 0;
    unitsByFund.set(fid, (unitsByFund.get(fid) ?? 0) + delta);
  }

  const schemeCodes = funds
    .map((f) => f.scheme_code as number | null)
    .filter((c): c is number => c != null);
  const navByScheme = new Map<number, number>();
  if (schemeCodes.length > 0) {
    const { data: navRows } = await supabase
      .from('nav_history')
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
    .map((f) => {
      const units = Math.max(0, unitsByFund.get(f.id as string) ?? 0);
      const nav = f.scheme_code != null ? navByScheme.get(f.scheme_code as number) ?? 0 : 0;
      return {
        id: f.id as string,
        schemeName: f.scheme_name as string,
        currentValue: units * nav,
        expenseRatio: (f.expense_ratio as number | null) ?? null,
      };
    });
}

export function ClearLensDirectVsRegularScreen() {
  useTrackInsightViewed('direct_vs_regular');
  const router = useRouter();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const { session } = useSession();
  const userId = session?.user.id;

  const [horizon, setHorizon] = useState<HorizonKey>('10Y');
  const [deltaStr, setDeltaStr] = useState<string>(String(DEFAULT_EXPENSE_DELTA_PCT));
  const [sipStr, setSipStr] = useState<string>('10000');

  const fundsQuery = useQuery({
    queryKey: ['direct-vs-regular-funds', userId],
    queryFn: () => (userId ? fetchPlanRows(userId) : Promise.resolve([] as UserFundRow[])),
    enabled: !!userId,
    staleTime: 60_000,
  });

  const breakdown = useMemo(() => {
    const rows: FundPlanRow[] = (fundsQuery.data ?? []).map((f) => ({
      id: f.id,
      schemeName: f.schemeName,
      currentValue: f.currentValue,
      expenseRatio: f.expenseRatio,
    }));
    return buildPlanBreakdown(rows);
  }, [fundsQuery.data]);

  const years = HORIZON_YEARS[horizon];
  const expenseRatioDelta = parsePct(deltaStr);
  const monthlySip = parseRupees(sipStr);

  // Headline impact uses the regular-plan corpus only (the lever the user can
  // actually move). If no regular plan detected, fall back to the total corpus
  // so the what-if illustration still works.
  const corpusForImpact =
    breakdown.regularValue > 0
      ? breakdown.regularValue
      : breakdown.totalValue > 0
        ? breakdown.totalValue
        : 5_00_000;

  const impact = useMemo(
    () =>
      computeCostImpact({
        currentCorpus: corpusForImpact,
        monthlySip,
        years,
        directAnnualReturn: DEFAULT_BASE_RETURN,
        expenseRatioDelta,
      }),
    [corpusForImpact, monthlySip, years, expenseRatioDelta],
  );

  const hasRegular = breakdown.regular.length > 0;
  const hasAnyFunds = breakdown.totalValue > 0;
  const allDirect = hasAnyFunds && breakdown.direct.length > 0 && !hasRegular && breakdown.unknown.length === 0;
  const regularSharePct = hasAnyFunds
    ? (breakdown.regularValue / breakdown.totalValue) * 100
    : 0;

  if (!userId) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <View style={styles.center}><Text style={styles.emptyTitle}>Sign in to use this tool</Text></View>
      </ClearLensScreen>
    );
  }

  return (
    <ClearLensScreen>
      <ClearLensHeader onPressBack={() => router.back()} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.titleBlock}>
            <Text style={styles.eyebrow}>Direct vs Regular</Text>
            <Text style={styles.title}>How much could fees cost you?</Text>
            <Text style={styles.subtitle}>
              Direct plans skip the distributor commission, so they have a lower expense ratio. Over years,
              that compounds. Here&apos;s the size of that drag for your portfolio.
            </Text>
          </View>

          {/* Inputs */}
          <View style={styles.card}>
            <View style={styles.inputRow}>
              <Text style={styles.inputLabel}>Horizon</Text>
              <ClearLensSegmentedControl
                options={HORIZON_OPTIONS}
                selected={horizon}
                onChange={setHorizon}
              />
            </View>

            <Separator />

            <View style={styles.inputRow}>
              <Text style={styles.inputLabel}>Monthly SIP (₹)</Text>
              <TextInput
                style={styles.textInput}
                placeholder="e.g. 10,000"
                placeholderTextColor={tokens.colors.textTertiary}
                value={sipStr}
                onChangeText={setSipStr}
                keyboardType="numeric"
                returnKeyType="next"
              />
            </View>

            <Separator />

            <View style={styles.inputRow}>
              <Text style={styles.inputLabel}>Expense ratio difference (% per year)</Text>
              <TextInput
                style={styles.textInput}
                placeholder="e.g. 0.7"
                placeholderTextColor={tokens.colors.textTertiary}
                value={deltaStr}
                onChangeText={setDeltaStr}
                keyboardType="numeric"
                returnKeyType="done"
              />
              <Text style={styles.inputHint}>
                Typical equity-fund commission is around 0.5%–1.0% per year.
              </Text>
            </View>
          </View>

          {fundsQuery.isLoading ? (
            <View style={styles.center}><Text style={styles.helperText}>Loading your funds…</Text></View>
          ) : (
            <>
              {/* Hero — leads with the rupee gap and the % corpus shrinkage */}
              <View style={styles.banner}>
                <Text style={styles.bannerLabel}>
                  {hasRegular ? `Estimated cost drag over ${horizon}` : `Illustrative cost drag over ${horizon}`}
                </Text>
                <Text style={styles.bannerValue}>{formatCurrency(impact.impact)}</Text>
                <Text style={styles.bannerSubtitle}>
                  ~{impact.impactPct.toFixed(1)}% smaller corpus vs the same money in direct plans
                </Text>
              </View>

              {/* Comparison detail — replaces the 5-row spreadsheet card */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>What that looks like</Text>
                <Text style={styles.insightBody}>
                  Same SIP, two return streams. In <Text style={styles.insightStrong}>{horizon}</Text>,{' '}
                  {formatCurrency(corpusForImpact)} + {formatCurrency(monthlySip)}/mo grows to{' '}
                  <Text style={styles.insightStrong}>{formatCurrency(impact.directFutureValue)}</Text> in direct plans
                  vs{' '}
                  <Text style={styles.insightStrong}>{formatCurrency(impact.regularFutureValue)}</Text> in regular —{' '}
                  a <Text style={styles.insightLoss}>{formatCurrency(impact.impact)}</Text> gap from the{' '}
                  {(expenseRatioDelta * 100).toFixed(2)}%/yr fee delta. Both assume a{' '}
                  {(DEFAULT_BASE_RETURN * 100).toFixed(0)}% base return.
                </Text>
              </View>

              {/* Portfolio split — replaces the standalone PlanBreakdownCard */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Your portfolio</Text>
                <Text style={styles.insightBody}>
                  {!hasAnyFunds ? (
                    <>
                      No funds detected yet — the numbers above are illustrative on{' '}
                      <Text style={styles.insightStrong}>{formatCurrency(corpusForImpact)}</Text>.
                      Adjust the inputs to see how the fee delta compounds.
                    </>
                  ) : allDirect ? (
                    <>
                      <Text style={styles.insightStrong}>
                        All {breakdown.direct.length} of your detected funds are direct plans.
                      </Text>{' '}
                      No commission drag from the regular-vs-direct gap.
                      {breakdown.weightedExpenseRatio != null
                        ? ` Weighted expense ratio: ${breakdown.weightedExpenseRatio.toFixed(2)}%.`
                        : ''}
                    </>
                  ) : hasRegular ? (
                    <>
                      <Text style={styles.insightStrong}>
                        {breakdown.regular.length} of your {breakdown.direct.length + breakdown.regular.length + breakdown.unknown.length} funds
                      </Text>
                      {' '}
                      ({formatCurrency(breakdown.regularValue)} of {formatCurrency(breakdown.totalValue)},{' '}
                      <Text style={styles.insightStrong}>{regularSharePct.toFixed(0)}%</Text>) are in regular plans.
                      {breakdown.weightedExpenseRatio != null
                        ? ` Weighted expense ratio across the portfolio: ${breakdown.weightedExpenseRatio.toFixed(2)}%.`
                        : ''}
                    </>
                  ) : (
                    <>
                      Plan type couldn&apos;t be detected for{' '}
                      <Text style={styles.insightStrong}>{breakdown.unknown.length} fund(s)</Text>{' '}
                      — the numbers above are illustrative.
                    </>
                  )}
                </Text>
              </View>

              {/* What to do — folded the old infoCard into a normal prose card */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>What to do</Text>
                <Text style={styles.insightBody}>
                  {hasRegular ? (
                    <>
                      <Text style={styles.insightStrong}>If you&apos;re paying for advice</Text>, the regular-plan
                      fee is a fair trade.{' '}
                      <Text style={styles.insightStrong}>If you&apos;re not</Text> — and the lowest-cost option
                      is what you want — your platform or advisor can help you switch the regular-plan funds
                      to direct.
                    </>
                  ) : allDirect ? (
                    <>
                      You&apos;re already on the lower-cost side. Nothing to action — keep an eye on the
                      expense ratios when you add new funds.
                    </>
                  ) : (
                    <>
                      Adjust the inputs above to see how a regular-vs-direct fee gap compounds.
                      When you import funds, we&apos;ll detect plan type from the scheme name and tailor this advice.
                    </>
                  )}
                </Text>
              </View>

              {/* Regular-plan funds list — kept compact, only when present */}
              {hasRegular ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Your regular-plan funds</Text>
                  {breakdown.regular.map((fund, idx) => (
                    <View key={fund.id}>
                      {idx > 0 ? <View style={styles.rowDivider} /> : null}
                      <View style={styles.row}>
                        <Text style={styles.rowLabel} numberOfLines={2}>{fund.schemeName}</Text>
                        <Text style={styles.rowValue}>{formatCurrency(fund.currentValue)}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}

              <Text style={styles.disclaimer}>
                Estimates use a fixed {(DEFAULT_BASE_RETURN * 100).toFixed(0)}% p.a. base return for both plans;
                the difference comes only from the expense ratio gap. Past performance is not indicative of future returns.
                We don&apos;t advise switching — your platform or advisor is the right place for that.
              </Text>

              <PortfolioDisclaimer />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </ClearLensScreen>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Separator() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return <View style={styles.separator} />;
}

function parseRupees(str: string): number {
  const n = parseFloat(str.replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parsePct(str: string): number {
  const n = parseFloat(str);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(5, n)) / 100;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    flex: { flex: 1 },
    scrollContent: {
      paddingHorizontal: ClearLensSpacing.md,
      paddingTop: ClearLensSpacing.xs,
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
    helperText: { ...ClearLensTypography.body, color: cl.textTertiary },
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
    subtitle: { ...ClearLensTypography.body, color: cl.textSecondary, lineHeight: 22 },

    emptyTitle: { ...ClearLensTypography.h2, color: cl.navy, textAlign: 'center' },

    card: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.border,
      ...ClearLensShadow,
      paddingVertical: ClearLensSpacing.xs,
      overflow: 'hidden',
    },
    cardTitle: {
      ...ClearLensTypography.h3,
      color: cl.navy,
      paddingHorizontal: ClearLensSpacing.md,
      paddingTop: ClearLensSpacing.xs,
      paddingBottom: ClearLensSpacing.xs,
    },
    insightBody: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      paddingHorizontal: ClearLensSpacing.md,
      paddingTop: ClearLensSpacing.xs,
      paddingBottom: ClearLensSpacing.sm,
      lineHeight: 22,
    },
    insightStrong: {
      color: cl.navy,
      fontFamily: ClearLensFonts.semiBold,
    },
    insightLoss: {
      color: cl.negative,
      fontFamily: ClearLensFonts.semiBold,
    },

    inputRow: {
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: ClearLensSpacing.sm + 2,
      gap: 8,
    },
    inputLabel: {
      ...ClearLensTypography.label,
      color: cl.textTertiary,
      letterSpacing: 0.4,
    },
    inputHint: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
    },
    textInput: {
      fontFamily: ClearLensFonts.regular,
      fontSize: 15,
      color: cl.textPrimary,
      paddingVertical: 4,
    },
    separator: {
      height: 1,
      backgroundColor: cl.borderLight,
      marginHorizontal: ClearLensSpacing.md,
    },

    banner: {
      backgroundColor: cl.heroSurface,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
      gap: 4,
    },
    bannerLabel: {
      ...ClearLensTypography.label,
      color: cl.textOnDarkMuted,
      textTransform: 'uppercase',
    },
    bannerValue: {
      ...ClearLensTypography.h1,
      color: cl.textOnDark,
    },
    bannerSubtitle: {
      ...ClearLensTypography.bodySmall,
      color: cl.textOnDarkMuted,
    },

    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: 12,
      gap: ClearLensSpacing.sm,
    },
    rowLabel: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      flex: 1,
    },
    rowValue: {
      fontFamily: ClearLensFonts.semiBold,
      fontSize: 14,
      color: cl.navy,
    },
    rowDivider: {
      height: 1,
      backgroundColor: cl.borderLight,
      marginHorizontal: ClearLensSpacing.md,
    },

    disclaimer: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      textAlign: 'center',
      paddingHorizontal: ClearLensSpacing.sm,
      lineHeight: 17,
      marginTop: ClearLensSpacing.xs,
    },
  });
}
