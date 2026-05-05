/**
 * Compare Funds — side-by-side comparison of up to 3 user-held funds.
 *
 * Pulls from existing data sources:
 *  - `fund` table for metadata (category, expense ratio, AUM, benchmark, ISIN)
 *  - `fund_portfolio_composition` (via fetchCompositions) for asset mix,
 *    market cap, sector allocation, and top holdings
 *  - NAV history for trailing returns (via fetchPerformanceTimeline)
 *
 * The screen renders comparison sections in horizontal-scroll rows so 3
 * columns fit on a 375px phone. Sections with no data for any fund are
 * silently omitted.
 */
import { useEffect, useMemo, useState } from 'react';
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
  formatTrailingReturn,
} from '@/src/utils/compareFunds';
import { formatCurrency } from '@/src/utils/formatting';
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
        ) : (
          <>
            <ComparisonSection title="Basic" funds={selectedFunds} cells={[
              { label: 'Category', render: (f) => f.category ?? '—' },
              { label: 'Benchmark', render: (f) => f.benchmark ?? '—' },
            ]} tokens={tokens} />

            <ComparisonSection title="Costs" funds={selectedFunds} cells={[
              { label: 'Expense ratio',
                render: (f) => f.expenseRatio != null ? `${f.expenseRatio.toFixed(2)}%` : '—' },
              { label: 'AUM',
                render: (f) => f.aumCr != null ? formatCurrency(f.aumCr * 1_00_00_000) : '—' },
            ]} tokens={tokens} />

            <ComparisonSection title="Trailing returns (annualised)" funds={selectedFunds} cells={[
              { label: '1Y',
                render: (f) => formatTrailingReturn(trailingReturnsByFundId.get(f.id)?.y1 ?? null) },
              { label: '3Y',
                render: (f) => formatTrailingReturn(trailingReturnsByFundId.get(f.id)?.y3 ?? null) },
              { label: '5Y',
                render: (f) => formatTrailingReturn(trailingReturnsByFundId.get(f.id)?.y5 ?? null) },
            ]} tokens={tokens} />

            <ComparisonSection title="Asset allocation" funds={selectedFunds} cells={[
              { label: 'Equity', render: (f) => pctOrDash(compositionsByCode.get(f.schemeCode)?.equityPct) },
              { label: 'Debt', render: (f) => pctOrDash(compositionsByCode.get(f.schemeCode)?.debtPct) },
              { label: 'Cash', render: (f) => pctOrDash(compositionsByCode.get(f.schemeCode)?.cashPct) },
            ]} tokens={tokens} />

            <ComparisonSection title="Market cap mix" funds={selectedFunds} cells={[
              { label: 'Large cap', render: (f) => pctOrDash(compositionsByCode.get(f.schemeCode)?.largeCapPct) },
              { label: 'Mid cap', render: (f) => pctOrDash(compositionsByCode.get(f.schemeCode)?.midCapPct) },
              { label: 'Small cap', render: (f) => pctOrDash(compositionsByCode.get(f.schemeCode)?.smallCapPct) },
            ]} tokens={tokens} />

            <TopSectorsSection funds={selectedFunds} compositionsByCode={compositionsByCode} tokens={tokens} />

            <TopHoldingsSection funds={selectedFunds} compositionsByCode={compositionsByCode} tokens={tokens} />

            {overlapPairs.length > 0 ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Holding overlap</Text>
                {overlapPairs.map((pair, idx) => (
                  <View key={`${pair.aId}-${pair.bId}`}>
                    {idx > 0 ? <View style={styles.rowDivider} /> : null}
                    <View style={styles.row}>
                      <Text style={styles.rowLabel} numberOfLines={2}>
                        {shortName(pair.aName)} ↔ {shortName(pair.bName)}
                      </Text>
                      <Text style={styles.rowValue}>{pair.pct.toFixed(0)}%</Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            <Text style={styles.disclaimer}>
              Numbers come from your portfolio data and the latest disclosed scheme composition.
              Trailing returns assume a single buy-and-hold purchase, not a SIP. We don&apos;t
              recommend or rate funds.
            </Text>
          </>
        )}
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
// Comparison section — header row of fund names + a row per metric
// ---------------------------------------------------------------------------

interface ComparisonCell {
  label: string;
  render: (fund: UserFund) => string;
}

function ComparisonSection({
  title,
  funds,
  cells,
  tokens,
}: {
  title: string;
  funds: UserFund[];
  cells: ComparisonCell[];
  tokens: ClearLensTokens;
}) {
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  // Hide the section entirely if every cell renders "—" for every fund
  const hasAny = cells.some((cell) => funds.some((f) => cell.render(f) !== '—'));
  if (!hasAny) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View style={styles.compRow}>
            <View style={styles.compRowLabel} />
            {funds.map((f) => (
              <View key={f.id} style={styles.compRowCell}>
                <Text style={styles.compHeaderText} numberOfLines={2}>{shortName(f.name)}</Text>
              </View>
            ))}
          </View>
          {cells.map((cell, idx) => (
            <View key={cell.label} style={[styles.compRow, idx > 0 && styles.compRowDividerTop]}>
              <View style={styles.compRowLabel}>
                <Text style={styles.compLabelText}>{cell.label}</Text>
              </View>
              {funds.map((f) => (
                <View key={f.id} style={styles.compRowCell}>
                  <Text style={styles.compValueText}>{cell.render(f)}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function TopSectorsSection({
  funds,
  compositionsByCode,
  tokens,
}: {
  funds: UserFund[];
  compositionsByCode: Map<number, FundPortfolioComposition>;
  tokens: ClearLensTokens;
}) {
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const fundSectors = funds.map((f) => {
    const sectors = compositionsByCode.get(f.schemeCode)?.sectorAllocation;
    if (!sectors) return [] as { name: string; pct: number }[];
    return Object.entries(sectors)
      .map(([name, pct]) => ({ name, pct: Number(pct) }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 3);
  });

  if (!fundSectors.some((s) => s.length > 0)) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Top 3 sectors</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View style={styles.compRow}>
            <View style={styles.compRowLabel} />
            {funds.map((f) => (
              <View key={f.id} style={styles.compRowCell}>
                <Text style={styles.compHeaderText} numberOfLines={2}>{shortName(f.name)}</Text>
              </View>
            ))}
          </View>
          {[0, 1, 2].map((rankIdx) => (
            <View key={rankIdx} style={[styles.compRow, rankIdx > 0 && styles.compRowDividerTop]}>
              <View style={styles.compRowLabel}>
                <Text style={styles.compLabelText}>{`#${rankIdx + 1}`}</Text>
              </View>
              {fundSectors.map((sectors, fundIdx) => {
                const item = sectors[rankIdx];
                return (
                  <View key={`${fundIdx}-${rankIdx}`} style={styles.compRowCell}>
                    <Text style={styles.compValueText} numberOfLines={2}>
                      {item ? `${item.name} (${item.pct.toFixed(0)}%)` : '—'}
                    </Text>
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function TopHoldingsSection({
  funds,
  compositionsByCode,
  tokens,
}: {
  funds: UserFund[];
  compositionsByCode: Map<number, FundPortfolioComposition>;
  tokens: ClearLensTokens;
}) {
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const fundHoldings = funds.map((f) => {
    const h = compositionsByCode.get(f.schemeCode)?.topHoldings;
    return Array.isArray(h) ? h.slice(0, 5) : [];
  });

  if (!fundHoldings.some((h) => h.length > 0)) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Top 5 holdings</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View style={styles.compRow}>
            <View style={styles.compRowLabel} />
            {funds.map((f) => (
              <View key={f.id} style={styles.compRowCell}>
                <Text style={styles.compHeaderText} numberOfLines={2}>{shortName(f.name)}</Text>
              </View>
            ))}
          </View>
          {[0, 1, 2, 3, 4].map((rankIdx) => (
            <View key={rankIdx} style={[styles.compRow, rankIdx > 0 && styles.compRowDividerTop]}>
              <View style={styles.compRowLabel}>
                <Text style={styles.compLabelText}>{`#${rankIdx + 1}`}</Text>
              </View>
              {fundHoldings.map((holdings, fundIdx) => {
                const h = holdings[rankIdx];
                return (
                  <View key={`${fundIdx}-${rankIdx}`} style={styles.compRowCell}>
                    <Text style={styles.compValueText} numberOfLines={2}>
                      {h ? `${h.name} (${h.pctOfNav.toFixed(1)}%)` : '—'}
                    </Text>
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
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

function pctOrDash(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(0)}%`;
}

function shortName(name: string): string {
  // Trim "- Direct Plan - Growth" / "- Direct Plan - Growth Option" suffixes so
  // the column header doesn't dominate every comparison row.
  return name
    .replace(/\s+-\s+(Direct|Regular)\s+Plan(\s+-\s+Growth(\s+Option)?)?$/i, '')
    .replace(/\s+-\s+Growth(\s+Option)?$/i, '')
    .trim();
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

    compRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: 10,
    },
    compRowDividerTop: {
      borderTopWidth: 1,
      borderTopColor: cl.borderLight,
    },
    compRowLabel: {
      width: 110,
      paddingRight: ClearLensSpacing.xs,
    },
    compRowCell: {
      width: 130,
      paddingRight: ClearLensSpacing.xs,
    },
    compHeaderText: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      textTransform: 'uppercase',
      letterSpacing: 0.3,
    },
    compLabelText: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
    },
    compValueText: {
      fontFamily: ClearLensFonts.semiBold,
      fontSize: 13,
      color: cl.navy,
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
