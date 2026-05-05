/**
 * Direct vs Regular Impact — surfaces the cost-drag between regular- and
 * direct-plan mutual funds in the user's portfolio, with an editable
 * what-if for users who don't currently hold any regular plans.
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
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ClearLensHeader, ClearLensScreen, ClearLensSegmentedControl } from '@/src/components/clearLens/ClearLensPrimitives';
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

  const noRegularDetected = breakdown.regular.length === 0 && breakdown.totalValue > 0;
  const hasRegular = breakdown.regular.length > 0;

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

          {fundsQuery.isLoading ? (
            <View style={styles.center}><Text style={styles.helperText}>Loading your funds…</Text></View>
          ) : (
            <PlanBreakdownCard breakdown={breakdown} tokens={tokens} />
          )}

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

          {/* Result banner */}
          <View style={styles.banner}>
            <Text style={styles.bannerLabel}>
              {hasRegular ? 'Estimated cost drag over' : 'Illustrative cost drag over'} {horizon}
            </Text>
            <Text style={styles.bannerValue}>{formatCurrency(impact.impact)}</Text>
            <Text style={styles.bannerSubtitle}>
              ~{impact.impactPct.toFixed(1)}% smaller corpus vs the same money in direct plans
            </Text>
          </View>

          {/* Result detail */}
          <View style={styles.card}>
            <Row label={`Direct plan corpus in ${horizon}`} value={formatCurrency(impact.directFutureValue)} highlight />
            <RowDivider />
            <Row label={`Regular plan corpus in ${horizon}`} value={formatCurrency(impact.regularFutureValue)} />
            <RowDivider />
            <Row
              label="Difference"
              value={formatCurrency(impact.impact)}
              tone="negative"
            />
            <RowDivider />
            <Row label="Base return assumption" value={`${(DEFAULT_BASE_RETURN * 100).toFixed(0)}% p.a.`} />
            <RowDivider />
            <Row label="Starting corpus" value={formatCurrency(corpusForImpact)} />
          </View>

          {/* Education / action card */}
          <View style={styles.infoCard}>
            <View style={styles.infoIconWrap}>
              <Ionicons name="information-circle-outline" size={18} color={tokens.colors.emerald} />
            </View>
            <Text style={styles.infoText}>
              {hasRegular
                ? 'Some of your funds are regular plans. If you\'re paying for advice, that\'s a fair trade. If you\'re not, you may want to review whether the direct plan would suit you better — your platform or advisor can help.'
                : noRegularDetected
                  ? 'All your detected funds appear to be direct plans, which is the lower-cost option. The numbers above are illustrative.'
                  : 'No funds detected yet. The numbers above are illustrative — adjust the inputs to see how a 70bps fee delta compounds.'}
            </Text>
          </View>

          {breakdown.regular.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Your regular-plan funds</Text>
              {breakdown.regular.map((fund, idx) => (
                <View key={fund.id}>
                  {idx > 0 ? <RowDivider /> : null}
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
        </ScrollView>
      </KeyboardAvoidingView>
    </ClearLensScreen>
  );
}

// ---------------------------------------------------------------------------
// Plan breakdown summary
// ---------------------------------------------------------------------------

function PlanBreakdownCard({
  breakdown,
  tokens,
}: {
  breakdown: ReturnType<typeof buildPlanBreakdown>;
  tokens: ClearLensTokens;
}) {
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const total = breakdown.totalValue;

  if (total === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Your portfolio split</Text>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>No active funds detected.</Text>
        </View>
      </View>
    );
  }

  function pct(value: number): string {
    return `${((value / total) * 100).toFixed(0)}%`;
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Your portfolio split</Text>
      <View style={styles.splitRow}>
        <View style={[styles.splitChip, styles.splitChipDirect]}>
          <Text style={styles.splitChipLabel}>Direct</Text>
          <Text style={styles.splitChipValue}>
            {breakdown.direct.length} • {pct(breakdown.directValue)}
          </Text>
        </View>
        <View style={[styles.splitChip, styles.splitChipRegular]}>
          <Text style={styles.splitChipLabel}>Regular</Text>
          <Text style={styles.splitChipValue}>
            {breakdown.regular.length} • {pct(breakdown.regularValue)}
          </Text>
        </View>
        <View style={[styles.splitChip, styles.splitChipUnknown]}>
          <Text style={styles.splitChipLabel}>Unknown</Text>
          <Text style={styles.splitChipValue}>
            {breakdown.unknown.length} • {pct(breakdown.unknownValue)}
          </Text>
        </View>
      </View>
      {breakdown.weightedExpenseRatio != null ? (
        <>
          <RowDivider />
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Weighted expense ratio</Text>
            <Text style={styles.rowValue}>{breakdown.weightedExpenseRatio.toFixed(2)}%</Text>
          </View>
        </>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Row({
  label,
  value,
  highlight,
  tone,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  tone?: 'positive' | 'negative';
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const cl = tokens.colors;
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[
        styles.rowValue,
        highlight && styles.rowValueHighlight,
        tone === 'positive' && { color: cl.positive },
        tone === 'negative' && { color: cl.negative },
      ]}>
        {value}
      </Text>
    </View>
  );
}

function RowDivider() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return <View style={styles.rowDivider} />;
}

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

    splitRow: {
      flexDirection: 'row',
      gap: ClearLensSpacing.xs,
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: ClearLensSpacing.sm,
    },
    splitChip: {
      flex: 1,
      borderRadius: ClearLensRadii.md,
      paddingVertical: ClearLensSpacing.sm,
      paddingHorizontal: ClearLensSpacing.sm,
      borderWidth: 1,
      gap: 2,
    },
    splitChipDirect: {
      backgroundColor: cl.positiveBg,
      borderColor: cl.positive,
    },
    splitChipRegular: {
      backgroundColor: cl.warningBg,
      borderColor: cl.amber,
    },
    splitChipUnknown: {
      backgroundColor: cl.surfaceSoft,
      borderColor: cl.borderLight,
    },
    splitChipLabel: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    splitChipValue: {
      fontFamily: ClearLensFonts.semiBold,
      fontSize: 14,
      color: cl.navy,
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
    rowValueHighlight: {
      fontSize: 16,
      color: cl.emerald,
    },
    rowDivider: {
      height: 1,
      backgroundColor: cl.borderLight,
      marginHorizontal: ClearLensSpacing.md,
    },

    infoCard: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: ClearLensSpacing.sm,
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.mint50,
      borderWidth: 1,
      borderColor: cl.mint,
    },
    infoIconWrap: {
      paddingTop: 1,
    },
    infoText: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
      flex: 1,
      lineHeight: 19,
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
