/**
 * Compare Funds — brand-faithful, prose-led comparison of up to 3 user-held
 * funds. Mirrors the factory shape of the Past SIP Check screen: inputs →
 * hero (lead with the answer) → short prose insights → disclosure.
 *
 * Pulls from existing data sources:
 *  - `fund` table for metadata (category, expense ratio, AUM, benchmark, ISIN)
 *  - `fund_portfolio_composition` (via fetchCompositions) for asset mix and
 *    market cap mix
 *  - NAV history for trailing returns (via fetchPerformanceTimeline)
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ClearLensHeader, ClearLensScreen } from '@/src/components/clearLens/ClearLensPrimitives';
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
import { fetchPerformanceTimeline } from '@/src/hooks/usePerformanceTimeline';
import { fetchCompositions } from '@/src/hooks/usePortfolioInsights';
import {
  computeHoldingOverlap,
  computeTrailingReturn,
} from '@/src/utils/compareFunds';
import type { FundPortfolioComposition } from '@/src/types/app';

const MAX_FUNDS = 3;
const MIN_FUNDS = 2;

interface UserFund {
  id: string;
  schemeCode: number;
  name: string;
  category: string | null;
  benchmark: string | null;
  expenseRatio: number | null;
  aumCr: number | null;
  isin: string | null;
}

async function fetchUserFundsForCompare(userId: string): Promise<UserFund[]> {
  const { data, error } = await supabase
    .from('fund')
    .select('id, scheme_code, scheme_name, scheme_category, benchmark_index, expense_ratio, aum_cr, isin')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('scheme_name', { ascending: true });
  if (error) throw error;
  return (data ?? [])
    .filter((row) => row.id && row.scheme_name && row.scheme_code != null)
    .map((row) => ({
      id: row.id as string,
      schemeCode: row.scheme_code as number,
      name: row.scheme_name as string,
      category: (row.scheme_category as string | null) ?? null,
      benchmark: (row.benchmark_index as string | null) ?? null,
      expenseRatio: (row.expense_ratio as number | null) ?? null,
      aumCr: (row.aum_cr as number | null) ?? null,
      isin: (row.isin as string | null) ?? null,
    }));
}

export function ClearLensCompareFundsScreen() {
  const router = useRouter();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const { session } = useSession();
  const userId = session?.user.id;

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const fundsQuery = useQuery({
    queryKey: ['compare-funds-holdings', userId],
    queryFn: () => (userId ? fetchUserFundsForCompare(userId) : Promise.resolve([] as UserFund[])),
    enabled: !!userId,
    staleTime: 60_000,
  });

  // Auto-select the first two funds when data first arrives.
  useEffect(() => {
    if (selectedIds.length === 0 && (fundsQuery.data?.length ?? 0) >= MIN_FUNDS) {
      setSelectedIds(fundsQuery.data!.slice(0, MIN_FUNDS).map((f) => f.id));
    }
  }, [fundsQuery.data, selectedIds.length]);

  const selectedFunds = useMemo(() => {
    if (!fundsQuery.data) return [] as UserFund[];
    return selectedIds
      .map((id) => fundsQuery.data!.find((f) => f.id === id))
      .filter((f): f is UserFund => !!f);
  }, [fundsQuery.data, selectedIds]);

  const schemeCodes = selectedFunds.map((f) => f.schemeCode);
  const compositionsQuery = useQuery({
    queryKey: ['compare-funds-compositions', schemeCodes.join(',')],
    enabled: schemeCodes.length > 0,
    queryFn: () => fetchCompositions(schemeCodes),
    staleTime: 5 * 60 * 1000,
  });

  const timelineQuery = useQuery({
    queryKey: ['compare-funds-timeline', selectedIds.join(',')],
    enabled: selectedFunds.length > 0,
    queryFn: () =>
      fetchPerformanceTimeline(
        selectedFunds.map((f) => ({ id: f.id, name: f.name })),
        [],
      ),
    staleTime: 5 * 60 * 1000,
  });

  const compositionsByCode = useMemo(() => {
    const map = new Map<number, FundPortfolioComposition>();
    for (const c of compositionsQuery.data ?? []) map.set(c.schemeCode, c);
    return map;
  }, [compositionsQuery.data]);

  const trailingReturnsByFundId = useMemo(() => {
    const result = new Map<string, { y1: number | null; y3: number | null; y5: number | null }>();
    for (const fund of selectedFunds) {
      const entry = timelineQuery.data?.entries.find((e) => e.id === fund.id);
      if (!entry) {
        result.set(fund.id, { y1: null, y3: null, y5: null });
        continue;
      }
      result.set(fund.id, {
        y1: computeTrailingReturn(entry.history, 1),
        y3: computeTrailingReturn(entry.history, 3),
        y5: computeTrailingReturn(entry.history, 5),
      });
    }
    return result;
  }, [selectedFunds, timelineQuery.data]);

  const overlapPairs = useMemo(() => {
    if (selectedFunds.length < 2) return [];
    const out: { aId: string; bId: string; aName: string; bName: string; pct: number }[] = [];
    for (let i = 0; i < selectedFunds.length; i++) {
      for (let j = i + 1; j < selectedFunds.length; j++) {
        const a = selectedFunds[i];
        const b = selectedFunds[j];
        const overlap = computeHoldingOverlap(
          compositionsByCode.get(a.schemeCode)?.topHoldings ?? null,
          compositionsByCode.get(b.schemeCode)?.topHoldings ?? null,
        );
        out.push({
          aId: a.id, bId: b.id,
          aName: a.name, bName: b.name,
          pct: overlap.overlapPct,
        });
      }
    }
    return out;
  }, [selectedFunds, compositionsByCode]);

  // ---------------------------------------------------------------------------
  // Insight derivation — every block decides for itself whether it has enough
  // signal to render. Each one returns a small typed object the JSX can splat
  // into a card; if the data isn't there, the card is omitted.
  // ---------------------------------------------------------------------------
  const insights = useMemo(() => {
    if (selectedFunds.length < MIN_FUNDS) return null;

    type ReturnEntry = { id: string; name: string; value: number };

    // Pick the longest window where every selected fund has a number.
    // 3Y is the "real" comparison window; 1Y is a fallback when one of the
    // funds is too new for 3Y. If neither aligns across all funds we surface
    // nothing rather than a half-truthful chart.
    const windows: { years: number; label: string; key: 'y3' | 'y1' }[] = [
      { years: 3, label: '3 years', key: 'y3' },
      { years: 1, label: '1 year', key: 'y1' },
    ];
    let returnsWindow: { label: string; entries: ReturnEntry[] } | null = null;
    for (const w of windows) {
      const entries: ReturnEntry[] = [];
      let allHave = true;
      for (const f of selectedFunds) {
        const v = trailingReturnsByFundId.get(f.id)?.[w.key];
        if (v == null || !Number.isFinite(v)) { allHave = false; break; }
        entries.push({ id: f.id, name: shortName(f.name), value: v });
      }
      if (allHave && entries.length === selectedFunds.length) {
        returnsWindow = { label: w.label, entries };
        break;
      }
    }

    let hero: {
      windowLabel: string;
      leaderName: string;
      leaderReturn: number;
      laggardNames: string[];
      deltaPp: number | null;
    } | null = null;
    if (returnsWindow) {
      const sorted = [...returnsWindow.entries].sort((a, b) => b.value - a.value);
      const leader = sorted[0];
      const next = sorted[1];
      const spreadPp = (sorted[0].value - sorted[sorted.length - 1].value) * 100;
      hero = {
        windowLabel: returnsWindow.label,
        leaderName: leader.name,
        leaderReturn: leader.value,
        laggardNames: sorted.slice(1).map((x) => x.name),
        // Treat <1pp as "essentially the same" — calling 0.3pp a "lead" is the
        // kind of false-precision the brand actively avoids.
        deltaPp: spreadPp < 1 ? null : (leader.value - next.value) * 100,
      };
    }

    const costs = selectedFunds.map((f) => ({
      id: f.id, name: shortName(f.name), er: f.expenseRatio,
    }));
    const allDirect = selectedFunds.every((f) => /direct/i.test(f.name));
    const allRegular = selectedFunds.every((f) => /regular/i.test(f.name));
    const planNote = allDirect ? 'all direct plans' : allRegular ? 'all regular plans' : null;

    const assetMix = selectedFunds.map((f) => {
      const c = compositionsByCode.get(f.schemeCode);
      return {
        id: f.id, name: shortName(f.name),
        equity: c?.equityPct ?? null,
        debt: c?.debtPct ?? null,
        cash: c?.cashPct ?? null,
      };
    });
    const assetMixAvail = assetMix.some((a) => a.equity != null);

    const riskProfile = selectedFunds.map((f) => {
      const c = compositionsByCode.get(f.schemeCode);
      const segs: { name: string; pct: number }[] = [];
      if (c?.largeCapPct != null) segs.push({ name: 'large-cap', pct: c.largeCapPct });
      if (c?.midCapPct != null) segs.push({ name: 'mid-cap', pct: c.midCapPct });
      if (c?.smallCapPct != null) segs.push({ name: 'small-cap', pct: c.smallCapPct });
      if (segs.length === 0) return { id: f.id, name: shortName(f.name), top: null };
      const top = segs.reduce((acc, s) => (s.pct > acc.pct ? s : acc));
      return { id: f.id, name: shortName(f.name), top };
    });
    const riskAvail = riskProfile.some((r) => r.top != null);

    return {
      hero,
      returnsWindow,
      costs,
      planNote,
      assetMix: assetMixAvail ? assetMix : null,
      riskProfile: riskAvail ? riskProfile : null,
    };
  }, [selectedFunds, trailingReturnsByFundId, compositionsByCode]);

  // ------ empty / loading states ------
  if (!userId) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Sign in to use this tool</Text>
        </View>
      </ClearLensScreen>
    );
  }

  if (fundsQuery.isLoading) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <View style={styles.center}><Text style={styles.helperText}>Loading your funds…</Text></View>
      </ClearLensScreen>
    );
  }

  if ((fundsQuery.data?.length ?? 0) < MIN_FUNDS) {
    return (
      <ClearLensScreen>
        <ClearLensHeader onPressBack={() => router.back()} />
        <View style={styles.center}>
          <View style={styles.emptyIcon}>
            <Ionicons name="bar-chart-outline" size={36} color={tokens.colors.textTertiary} />
          </View>
          <Text style={styles.emptyTitle}>Need at least 2 funds</Text>
          <Text style={styles.emptySubtitle}>
            Compare Funds works on the funds you already hold. Import or sync to bring at least
            two funds in, then come back here.
          </Text>
        </View>
      </ClearLensScreen>
    );
  }

  return (
    <ClearLensScreen>
      <ClearLensHeader onPressBack={() => router.back()} />

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.titleBlock}>
          <Text style={styles.eyebrow}>Compare Funds</Text>
          <Text style={styles.title}>Side by side, no spin</Text>
          <Text style={styles.subtitle}>
            Pick two or three of your funds. We&apos;ll line up the numbers — you draw your own conclusions.
          </Text>
        </View>

        {/* Fund chips + add */}
        <View style={styles.chipsCard}>
          <Text style={styles.inputLabel}>Selected funds</Text>
          <View style={styles.chipRow}>
            {selectedFunds.map((fund) => (
              <View key={fund.id} style={styles.fundChip}>
                <Text style={styles.fundChipName} numberOfLines={1}>{fund.name}</Text>
                <TouchableOpacity
                  onPress={() => setSelectedIds((prev) => prev.filter((x) => x !== fund.id))}
                  hitSlop={8}
                >
                  <Ionicons name="close-circle" size={18} color={tokens.colors.textTertiary} />
                </TouchableOpacity>
              </View>
            ))}
            {selectedFunds.length < MAX_FUNDS ? (
              <TouchableOpacity style={styles.addChip} onPress={() => setPickerOpen(true)} activeOpacity={0.75}>
                <Ionicons name="add" size={16} color={tokens.colors.emerald} />
                <Text style={styles.addChipText}>Add fund</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        {selectedFunds.length < MIN_FUNDS ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>
              Pick at least {MIN_FUNDS} funds to compare.
            </Text>
          </View>
        ) : timelineQuery.isLoading || compositionsQuery.isLoading ? (
          <View style={styles.center}>
            <Text style={styles.helperText}>Crunching the numbers…</Text>
          </View>
        ) : insights ? (
          <>
            {/* Hero — leads with the answer. The leader's annualised return is
                the single number that matters most; the supporting line carries
                the delta vs the rest of the picks. */}
            {insights.hero ? (
              <View style={styles.banner}>
                <Text style={styles.bannerLabel}>{insights.hero.windowLabel} · best performer</Text>
                <Text style={styles.bannerValue} numberOfLines={2}>
                  {insights.hero.leaderName}
                </Text>
                <Text style={styles.bannerSubtitle}>
                  <Text style={styles.bannerGainUp}>
                    +{(insights.hero.leaderReturn * 100).toFixed(1)}%/yr
                  </Text>
                  {insights.hero.deltaPp != null
                    ? ` — ${insights.hero.deltaPp.toFixed(1)} pp ahead of ${joinNames(insights.hero.laggardNames)}.`
                    : ` — close to ${joinNames(insights.hero.laggardNames)} over the same window.`}
                </Text>
              </View>
            ) : (
              <View style={styles.banner}>
                <Text style={styles.bannerLabel}>Not enough overlap</Text>
                <Text style={styles.bannerValue} numberOfLines={2}>
                  Limited common history
                </Text>
                <Text style={styles.bannerSubtitle}>
                  At least one of these funds is too new to share a 3-year or 1-year window with the rest.
                </Text>
              </View>
            )}

            {/* Returns — every fund's annualised return for the chosen window */}
            {insights.returnsWindow ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Returns</Text>
                <Text style={styles.insightBody}>
                  Over {insights.returnsWindow.label}:{' '}
                  {insights.returnsWindow.entries.map((e, i) => (
                    <Fragment key={e.id}>
                      {i > 0 ? ' · ' : ''}
                      {e.name}{' '}
                      <Text style={styles.insightStrong}>
                        {(e.value * 100).toFixed(1)}%/yr
                      </Text>
                    </Fragment>
                  ))}
                  .
                </Text>
              </View>
            ) : null}

            {/* Cost — expense ratios; flag plan kind only when it's uniform */}
            {insights.costs.some((c) => c.er != null) ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Cost</Text>
                <Text style={styles.insightBody}>
                  {insights.costs.map((c, i) => (
                    <Fragment key={c.id}>
                      {i > 0 ? ' · ' : ''}
                      {c.name}{' '}
                      <Text style={styles.insightStrong}>
                        {c.er != null ? `${c.er.toFixed(2)}%/yr` : '—'}
                      </Text>
                    </Fragment>
                  ))}
                  {insights.planNote ? ` — ${insights.planNote}.` : '.'}
                </Text>
              </View>
            ) : null}

            {/* Overlap — pairwise % of shared top holdings */}
            {overlapPairs.length > 0 ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Holding overlap</Text>
                <Text style={styles.insightBody}>
                  {overlapPairs.map((pair, idx) => (
                    <Fragment key={`${pair.aId}-${pair.bId}`}>
                      {idx > 0 ? ' · ' : ''}
                      {shortName(pair.aName)} ↔ {shortName(pair.bName)}{' '}
                      <Text style={styles.insightStrong}>{pair.pct.toFixed(0)}%</Text>
                    </Fragment>
                  ))}
                  .{' '}
                  <Text style={styles.insightMuted}>
                    {describeOverlap(overlapPairs.map((p) => p.pct))}
                  </Text>
                </Text>
              </View>
            ) : null}

            {/* Risk profile — most distinctive market-cap segment per fund */}
            {insights.riskProfile ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Risk profile</Text>
                <Text style={styles.insightBody}>
                  {insights.riskProfile.map((r, i) => (
                    <Fragment key={r.id}>
                      {i > 0 ? ' · ' : ''}
                      {r.name}{' '}
                      {r.top ? (
                        <Text style={styles.insightStrong}>
                          {`${r.top.pct.toFixed(0)}% ${r.top.name}`}
                        </Text>
                      ) : (
                        <Text style={styles.insightStrong}>—</Text>
                      )}
                    </Fragment>
                  ))}
                  .
                </Text>
              </View>
            ) : null}

            {/* Asset mix — equity / debt / cash split per fund */}
            {insights.assetMix ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Asset mix</Text>
                <Text style={styles.insightBody}>
                  {insights.assetMix.map((a, i) => (
                    <Fragment key={a.id}>
                      {i > 0 ? ' · ' : ''}
                      {a.name}{' '}
                      <Text style={styles.insightStrong}>
                        {formatAssetMix(a.equity, a.debt, a.cash)}
                      </Text>
                    </Fragment>
                  ))}
                  .
                </Text>
              </View>
            ) : null}

            <Text style={styles.disclaimer}>
              Numbers come from your portfolio data and the latest disclosed scheme composition.
              Trailing returns assume a single buy-and-hold purchase, not a SIP. We don&apos;t
              recommend or rate funds.
            </Text>
          </>
        ) : null}
      </ScrollView>

      <FundPicker
        visible={pickerOpen}
        funds={fundsQuery.data ?? []}
        selectedIds={selectedIds}
        maxFunds={MAX_FUNDS}
        onToggle={(id) =>
          setSelectedIds((prev) =>
            prev.includes(id)
              ? prev.filter((x) => x !== id)
              : prev.length >= MAX_FUNDS ? prev : [...prev, id],
          )
        }
        onClose={() => setPickerOpen(false)}
      />
    </ClearLensScreen>
  );
}

// ---------------------------------------------------------------------------
// Multi-select fund picker bottom sheet
// ---------------------------------------------------------------------------

function FundPicker({
  visible,
  funds,
  selectedIds,
  maxFunds,
  onToggle,
  onClose,
}: {
  visible: boolean;
  funds: UserFund[];
  selectedIds: string[];
  maxFunds: number;
  onToggle: (id: string) => void;
  onClose: () => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Pick funds to compare</Text>
          <Text style={styles.sheetSub}>{`${selectedIds.length} of ${maxFunds} selected`}</Text>
          <ScrollView style={styles.sheetList}>
            {funds.map((fund, idx) => {
              const isSelected = selectedIds.includes(fund.id);
              const disabled = !isSelected && selectedIds.length >= maxFunds;
              return (
                <TouchableOpacity
                  key={fund.id}
                  style={[styles.sheetOption, idx > 0 && styles.sheetDivider, disabled && styles.sheetOptionDisabled]}
                  onPress={() => !disabled && onToggle(fund.id)}
                  activeOpacity={0.76}
                >
                  <View style={styles.sheetOptionLeft}>
                    <Text style={[styles.sheetRowText, disabled && styles.sheetRowTextDisabled]} numberOfLines={2}>
                      {fund.name}
                    </Text>
                    {fund.category ? <Text style={styles.sheetRowSub}>{fund.category}</Text> : null}
                  </View>
                  <View style={[styles.checkBox, isSelected && styles.checkBoxActive]}>
                    {isSelected && <Ionicons name="checkmark" size={14} color={tokens.colors.textOnDark} />}
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <TouchableOpacity style={styles.applyButton} onPress={onClose} activeOpacity={0.82}>
            <Text style={styles.applyButtonText}>Done</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortName(name: string): string {
  // Trim "- Direct Plan - Growth" / "- Direct Plan - Growth Option" suffixes
  // so they don't dominate the prose; the user already sees the full name in
  // the chip above.
  return name
    .replace(/\s+-\s+(Direct|Regular)\s+Plan(\s+-\s+Growth(\s+Option)?)?$/i, '')
    .replace(/\s+-\s+Growth(\s+Option)?$/i, '')
    .trim();
}

function joinNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function describeOverlap(percentages: number[]): string {
  const max = Math.max(...percentages);
  if (max < 10) return "Low — these funds aren't doubling up.";
  if (max < 25) return 'Moderate — some shared bets, but each adds its own picks.';
  if (max < 50) return 'High — a meaningful slice of the same names.';
  return 'Very high — these funds are mostly buying the same things.';
}

function formatAssetMix(
  equity: number | null,
  debt: number | null,
  cash: number | null,
): string {
  const parts: string[] = [];
  if (equity != null) parts.push(`${equity.toFixed(0)}% equity`);
  if (debt != null && debt >= 1) parts.push(`${debt.toFixed(0)}% debt`);
  if (cash != null && cash >= 1) parts.push(`${cash.toFixed(0)}% cash`);
  return parts.length > 0 ? parts.join(' / ') : '—';
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
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
    helperText: {
      ...ClearLensTypography.body,
      color: cl.textTertiary,
    },
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

    emptyIcon: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: cl.surfaceSoft,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: ClearLensSpacing.xs,
    },
    emptyTitle: { ...ClearLensTypography.h2, color: cl.navy, textAlign: 'center' },
    emptySubtitle: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      textAlign: 'center',
      lineHeight: 22,
    },

    chipsCard: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.border,
      ...ClearLensShadow,
      padding: ClearLensSpacing.md,
      gap: ClearLensSpacing.sm,
    },
    inputLabel: {
      ...ClearLensTypography.label,
      color: cl.textTertiary,
      letterSpacing: 0.4,
    },
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: ClearLensSpacing.xs,
    },
    fundChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.xs,
      paddingVertical: 6,
      paddingHorizontal: ClearLensSpacing.sm,
      borderRadius: ClearLensRadii.full,
      backgroundColor: cl.surfaceSoft,
      borderWidth: 1,
      borderColor: cl.borderLight,
      maxWidth: '100%',
    },
    fundChipName: {
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
      flexShrink: 1,
    },
    addChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingVertical: 6,
      paddingHorizontal: ClearLensSpacing.sm,
      borderRadius: ClearLensRadii.full,
      borderWidth: 1,
      borderColor: cl.emerald,
      borderStyle: 'dashed',
    },
    addChipText: {
      fontFamily: ClearLensFonts.semiBold,
      fontSize: 13,
      color: cl.emerald,
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
      paddingTop: ClearLensSpacing.xs,
      lineHeight: 19,
    },
    bannerGainUp: {
      color: cl.positive,
      fontFamily: ClearLensFonts.semiBold,
    },

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
    insightMuted: {
      ...ClearLensTypography.bodySmall,
      color: cl.textTertiary,
    },

    errorBox: {
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.surfaceSoft,
      borderWidth: 1,
      borderColor: cl.borderLight,
    },
    errorText: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
      lineHeight: 18,
    },

    disclaimer: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      textAlign: 'center',
      paddingHorizontal: ClearLensSpacing.sm,
      lineHeight: 17,
      marginTop: ClearLensSpacing.xs,
    },

    backdrop: {
      flex: 1,
      backgroundColor: tokens.semantic.overlay.backdrop,
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: cl.surface,
      borderTopLeftRadius: ClearLensRadii.xl,
      borderTopRightRadius: ClearLensRadii.xl,
      paddingTop: ClearLensSpacing.sm,
      paddingHorizontal: ClearLensSpacing.md,
      paddingBottom: ClearLensSpacing.lg,
      maxHeight: '75%',
    },
    sheetHandle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: cl.borderLight,
      alignSelf: 'center',
      marginBottom: ClearLensSpacing.sm,
    },
    sheetTitle: {
      ...ClearLensTypography.h3,
      color: cl.navy,
      paddingTop: ClearLensSpacing.xs,
    },
    sheetSub: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      paddingBottom: ClearLensSpacing.xs,
    },
    sheetList: {
      flexGrow: 0,
    },
    sheetOption: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: ClearLensSpacing.md - 2,
      gap: ClearLensSpacing.sm,
    },
    sheetOptionDisabled: { opacity: 0.5 },
    sheetDivider: {
      borderTopWidth: 1,
      borderTopColor: cl.borderLight,
    },
    sheetOptionLeft: { flex: 1, gap: 2 },
    sheetRowText: { ...ClearLensTypography.body, color: cl.navy },
    sheetRowTextDisabled: { color: cl.textTertiary },
    sheetRowSub: { ...ClearLensTypography.caption, color: cl.textTertiary },
    checkBox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: cl.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkBoxActive: {
      borderColor: cl.emerald,
      backgroundColor: cl.emerald,
    },
    applyButton: {
      backgroundColor: cl.emerald,
      borderRadius: ClearLensRadii.md,
      paddingVertical: ClearLensSpacing.sm + 4,
      alignItems: 'center',
      marginTop: ClearLensSpacing.sm,
    },
    applyButtonText: {
      fontFamily: ClearLensFonts.semiBold,
      fontSize: 16,
      color: cl.textOnDark,
    },
  });
}
