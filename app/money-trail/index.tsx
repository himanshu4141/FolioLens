import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  ClearLensCard,
  ClearLensHeader,
  ClearLensScreen,
} from '@/src/components/clearLens/ClearLensPrimitives';
import { useMoneyTrail } from '@/src/hooks/useMoneyTrail';
import { ResponsiveRouteFrame, useIsDesktop } from '@/src/components/responsive';
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
import { formatCurrency } from '@/src/utils/formatting';
import {
  DEFAULT_MONEY_TRAIL_FILTERS,
  MONEY_TRAIL_SORT_LABELS,
  applyMoneyTrailControls,
  buildAnnualMoneyFlows,
  buildMoneyTrailSummary,
  formatMoneyTrailDate,
  getFinancialYearShortLabel,
  parseMoneyTrailAmountInput,
  statusLabel,
  type MoneyTrailDatePreset,
  type MoneyTrailFilters,
  type MoneyTrailSortOption,
  type MoneyTrailSummaryMode,
  type MoneyTrailTransactionType,
  type PortfolioTransaction,
} from '@/src/utils/moneyTrail';
import { exportMoneyTrailCsv } from '@/src/utils/moneyTrailExport';

const DATE_PRESETS: { value: MoneyTrailDatePreset; label: string }[] = [
  { value: 'this_fy', label: 'This financial year' },
  { value: 'last_fy', label: 'Last financial year' },
  { value: 'last_3_months', label: 'Last 3 months' },
  { value: 'all_time', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
];

// Filter chips group multiple underlying transaction types so users don't
// have to think in CAS-statement vocabulary (SIP vs lumpsum, switch in vs
// out). The data layer still tracks the granular types — this is UI sugar.
//
// "Other" is a catch-all for the long tail (STPs, SWPs, transfers we haven't
// classified, plus any future-discovered raw type that normalizeMoneyTrailType
// maps to 'unknown'). Keeping it explicit prevents users from missing rows.
const TYPE_FILTER_GROUPS: { values: MoneyTrailTransactionType[]; label: string }[] = [
  { values: ['sip_purchase', 'purchase'], label: 'Investment' },
  { values: ['redemption'], label: 'Withdrawal' },
  { values: ['switch_in', 'switch_out'], label: 'Switch' },
  { values: ['dividend_payout', 'dividend_reinvestment'], label: 'Dividend' },
  { values: ['failed', 'reversal'], label: 'Failed/reversed' },
  { values: ['transfer', 'stp_in', 'stp_out', 'swp', 'unknown'], label: 'Other' },
];

const SORT_OPTIONS: MoneyTrailSortOption[] = [
  'newest',
  'oldest',
  'amount_desc',
  'amount_asc',
  'fund_asc',
  'fund_desc',
];

function HeroSection({
  transactions,
  summaryMode,
  rangeLabel,
}: {
  transactions: PortfolioTransaction[];
  summaryMode: MoneyTrailSummaryMode;
  rangeLabel: string;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const summary = useMemo(() => buildMoneyTrailSummary(transactions, summaryMode), [summaryMode, transactions]);
  const annualFlows = useMemo(() => buildAnnualMoneyFlows(transactions, summaryMode), [summaryMode, transactions]);
  const moneyInCount = useMemo(
    () => transactions.filter((tx) => tx.direction === 'money_in' && !tx.hiddenByDefault).length,
    [transactions],
  );
  const moneyOutCount = useMemo(
    () => transactions.filter((tx) => tx.direction === 'money_out' && !tx.hiddenByDefault).length,
    [transactions],
  );

  const copy = summaryMode === 'fund_cost_basis'
    ? { hero: 'Cost basis', flowIn: 'Money into fund', flowOut: 'Money out of fund' }
    : { hero: 'Net invested', flowIn: 'Money in', flowOut: 'Money out' };

  return (
    <ClearLensCard style={styles.heroCard}>
      <View>
        <Text style={styles.heroEyebrow}>{copy.hero} · {rangeLabel}</Text>
        <Text style={styles.heroValue}>{formatCurrency(summary.netInvested)}</Text>
      </View>

      <View style={styles.flowRow}>
        <FlowStat
          icon="arrow-down-circle"
          tint={tokens.colors.emeraldDeep}
          tintBg={tokens.colors.mint50}
          label={copy.flowIn}
          amount={summary.totalInvested}
          count={moneyInCount}
        />
        <View style={styles.flowDivider} />
        <FlowStat
          icon="arrow-up-circle"
          tint={tokens.colors.amber}
          tintBg="#FFF7E6"
          label={copy.flowOut}
          amount={summary.totalWithdrawn}
          count={moneyOutCount}
        />
      </View>

      {annualFlows.length > 0 ? (
        <AnnualBars annualFlows={annualFlows} />
      ) : null}
    </ClearLensCard>
  );
}

function FlowStat({
  icon,
  tint,
  tintBg,
  label,
  amount,
  count,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  tintBg: string;
  label: string;
  amount: number;
  count: number;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.flowStat}>
      <View style={[styles.flowIcon, { backgroundColor: tintBg }]}>
        <Ionicons name={icon} size={18} color={tint} />
      </View>
      <View style={styles.flowCopy}>
        <Text style={styles.flowLabel}>{label}</Text>
        <Text style={styles.flowAmount}>{formatCurrency(amount)}</Text>
        <Text style={styles.flowMeta}>
          {count} {count === 1 ? 'entry' : 'entries'}
        </Text>
      </View>
    </View>
  );
}

function AnnualBars({ annualFlows }: { annualFlows: ReturnType<typeof buildAnnualMoneyFlows> }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const visibleFlows = useMemo(() => annualFlows.slice(-6), [annualFlows]);
  const [selectedFy, setSelectedFy] = useState<string | null>(null);
  const maxValue = Math.max(
    1,
    ...visibleFlows.flatMap((flow) => [flow.invested, flow.withdrawn, Math.abs(flow.netInvested)]),
  );

  const activeFy = selectedFy ?? visibleFlows[visibleFlows.length - 1]?.financialYear ?? null;
  const activeFlow = activeFy ? visibleFlows.find((flow) => flow.financialYear === activeFy) ?? null : null;

  return (
    <View style={styles.annualBlock}>
      <View style={styles.annualHeader}>
        <Text style={styles.annualHeading}>By financial year</Text>
        <View style={styles.annualLegend}>
          <View style={styles.legendItem}>
            <View style={[styles.legendSwatch, { backgroundColor: tokens.colors.emerald }]} />
            <Text style={styles.legendText}>Invested</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendSwatch, { backgroundColor: tokens.colors.amber }]} />
            <Text style={styles.legendText}>Withdrawn</Text>
          </View>
        </View>
      </View>

      {activeFlow ? (
        <View style={styles.annualDetail}>
          <Text style={styles.annualDetailFy}>{activeFlow.financialYear}</Text>
          <View style={styles.annualDetailRow}>
            <Text style={styles.annualDetailItem}>
              Invested <Text style={[styles.annualDetailValue, { color: tokens.colors.emeraldDeep }]}>{formatCurrency(activeFlow.invested)}</Text>
            </Text>
            <Text style={styles.annualDetailItem}>
              Withdrawn <Text style={[styles.annualDetailValue, { color: tokens.colors.amber }]}>{formatCurrency(activeFlow.withdrawn)}</Text>
            </Text>
          </View>
        </View>
      ) : null}

      <View style={styles.annualBars}>
        {visibleFlows.map((flow) => {
          const investedHeight = Math.max(6, (flow.invested / maxValue) * 64);
          const withdrawnHeight = flow.withdrawn > 0 ? Math.max(3, (flow.withdrawn / maxValue) * 28) : 0;
          const isActive = flow.financialYear === activeFy;
          return (
            <TouchableOpacity
              key={flow.financialYear}
              style={styles.annualBarItem}
              onPress={() => setSelectedFy(flow.financialYear)}
              activeOpacity={0.7}
              accessibilityLabel={`${flow.financialYear}: invested ${formatCurrency(flow.invested)}, withdrawn ${formatCurrency(flow.withdrawn)}`}
            >
              <View style={styles.annualBarTrack}>
                <View
                  style={[
                    styles.annualInvested,
                    { height: investedHeight },
                    !isActive && styles.annualBarDim,
                  ]}
                />
                {withdrawnHeight > 0 && (
                  <View
                    style={[
                      styles.annualWithdrawn,
                      { height: withdrawnHeight },
                      !isActive && styles.annualBarDim,
                    ]}
                  />
                )}
              </View>
              <Text style={[styles.annualLabel, isActive && styles.annualLabelActive]}>
                {getFinancialYearShortLabel(flow.financialYear)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function TransactionRow({
  transaction,
  onPress,
}: {
  transaction: PortfolioTransaction;
  onPress: () => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const treatment = transactionTreatment(transaction, tokens);

  return (
    <TouchableOpacity style={styles.transactionRow} onPress={onPress} activeOpacity={0.76}>
      <View style={[styles.transactionIcon, { backgroundColor: treatment.bg }]}>
        <Ionicons name={treatment.icon} size={18} color={treatment.color} />
      </View>
      <View style={styles.transactionCopy}>
        <Text style={styles.transactionType}>{transaction.userFacingType}</Text>
        <Text style={styles.transactionFund} numberOfLines={1}>{transaction.fundName}</Text>
        <Text style={styles.transactionDate}>{formatMoneyTrailDate(transaction.date)}</Text>
      </View>
      <View style={styles.transactionAmountBlock}>
        <Text style={[styles.transactionAmount, { color: treatment.color }]}>{formatCurrency(transaction.amount)}</Text>
        <Text style={[styles.statusText, { color: treatment.statusColor }]}>
          {statusLabel(transaction.status)}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function transactionTreatment(
  transaction: PortfolioTransaction,
  tokens: ClearLensTokens,
): {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  bg: string;
  statusColor: string;
} {
  const cl = tokens.colors;
  if (transaction.hiddenByDefault) {
    return {
      icon: 'remove-circle-outline',
      color: cl.textTertiary,
      bg: cl.grey50,
      statusColor: cl.textTertiary,
    };
  }
  if (transaction.direction === 'money_in') {
    return {
      icon: 'arrow-down-circle-outline',
      color: cl.emeraldDeep,
      bg: cl.mint50,
      statusColor: cl.emeraldDeep,
    };
  }
  if (transaction.direction === 'money_out') {
    return {
      icon: 'arrow-up-circle-outline',
      color: cl.amber,
      bg: cl.warningBg,
      statusColor: cl.emeraldDeep,
    };
  }
  if (transaction.direction === 'internal') {
    return {
      icon: 'swap-horizontal-outline',
      // In dark mode `slate` flips to a light grey — that reads on the dark
      // card. In light mode it stays as the brand slate. Either way the
      // amount text stays legible against the row surface.
      color: cl.textPrimary,
      bg: cl.surfaceSoft,
      statusColor: cl.emeraldDeep,
    };
  }
  return {
    icon: 'ellipse-outline',
    color: cl.textTertiary,
    bg: cl.surfaceSoft,
    statusColor: cl.textTertiary,
  };
}

function ActiveFilterChips({
  filters,
  fundOptions,
  query,
  onClear,
}: {
  filters: MoneyTrailFilters;
  fundOptions: { id: string; name: string }[];
  query: string;
  onClear: () => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const chips: string[] = [];
  if (query.trim()) chips.push(`Search: ${query.trim()}`);
  if (filters.datePreset !== 'all_time') chips.push(DATE_PRESETS.find((item) => item.value === filters.datePreset)?.label ?? 'Date range');
  if (filters.fundIds.length > 0) {
    const names = filters.fundIds
      .map((fundId) => fundOptions.find((fund) => fund.id === fundId)?.name)
      .filter(Boolean);
    chips.push(names.length === 1 ? names[0]! : `${names.length} funds`);
  }
  if (filters.transactionTypes.length > 0) {
    const activeGroups = TYPE_FILTER_GROUPS.filter((group) =>
      group.values.some((value) => filters.transactionTypes.includes(value)),
    );
    if (activeGroups.length > 0) {
      chips.push(activeGroups.map((group) => group.label).join(', '));
    }
  }
  if (filters.amcNames.length > 0) chips.push(`${filters.amcNames.length} AMCs`);
  if (filters.minAmount != null || filters.maxAmount != null) chips.push('Amount range');
  if (filters.includeHidden) chips.push('Hidden shown');

  if (chips.length === 0) return null;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
      {chips.map((chip) => (
        <View key={chip} style={styles.activeChip}>
          <Text style={styles.activeChipText}>{chip}</Text>
        </View>
      ))}
      <TouchableOpacity style={styles.clearChip} onPress={onClear} activeOpacity={0.76}>
        <Text style={styles.clearChipText}>Clear all filters</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function SortSheet({
  visible,
  selected,
  onClose,
  onApply,
}: {
  visible: boolean;
  selected: MoneyTrailSortOption;
  onClose: () => void;
  onApply: (sort: MoneyTrailSortOption) => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const [draft, setDraft] = useState(selected);

  useEffect(() => {
    if (visible) setDraft(selected);
  }, [selected, visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <SheetHeader title="Sort by" onClose={onClose} />
          {SORT_OPTIONS.map((option) => (
            <TouchableOpacity
              key={option}
              style={styles.sheetOption}
              onPress={() => setDraft(option)}
              activeOpacity={0.76}
            >
              <Text style={styles.sheetOptionText}>{MONEY_TRAIL_SORT_LABELS[option]}</Text>
              <View style={[styles.radioOuter, draft === option && styles.radioOuterActive]}>
                {draft === option && <View style={styles.radioInner} />}
              </View>
            </TouchableOpacity>
          ))}
          <SheetActions
            secondaryLabel="Cancel"
            primaryLabel="Apply"
            onSecondary={onClose}
            onPrimary={() => {
              onApply(draft);
              onClose();
            }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function FilterSheet({
  visible,
  selected,
  fundOptions,
  amcOptions,
  onClose,
  onApply,
}: {
  visible: boolean;
  selected: MoneyTrailFilters;
  fundOptions: { id: string; name: string }[];
  amcOptions: string[];
  onClose: () => void;
  onApply: (filters: MoneyTrailFilters) => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const [draft, setDraft] = useState<MoneyTrailFilters>(selected);
  const [minAmountText, setMinAmountText] = useState('');
  const [maxAmountText, setMaxAmountText] = useState('');

  useEffect(() => {
    if (!visible) return;
    setDraft(selected);
    setMinAmountText(selected.minAmount != null ? String(selected.minAmount) : '');
    setMaxAmountText(selected.maxAmount != null ? String(selected.maxAmount) : '');
  }, [selected, visible]);

  function toggleArrayValue<T extends string>(key: keyof MoneyTrailFilters, value: T) {
    setDraft((current) => {
      const values = current[key] as T[];
      return {
        ...current,
        [key]: values.includes(value)
          ? values.filter((item) => item !== value)
          : [...values, value],
      };
    });
  }

  function applyDraft() {
    onApply({
      ...draft,
      minAmount: parseMoneyTrailAmountInput(minAmountText),
      maxAmount: parseMoneyTrailAmountInput(maxAmountText),
    });
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.filterSheet} onPress={(event) => event.stopPropagation()}>
          <SheetHeader title="Filters" onClose={onClose} trailing="Clear all" onTrailing={() => {
            setDraft(DEFAULT_MONEY_TRAIL_FILTERS);
            setMinAmountText('');
            setMaxAmountText('');
          }} />
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.filterContent}>
            <FilterGroup title="Date range">
              <View style={styles.wrapRow}>
                {DATE_PRESETS.map((preset) => (
                  <ChoiceChip
                    key={preset.value}
                    label={preset.label}
                    selected={draft.datePreset === preset.value}
                    onPress={() => setDraft((current) => ({ ...current, datePreset: preset.value }))}
                  />
                ))}
              </View>
              {draft.datePreset === 'custom' && (
                <View style={styles.inputRow}>
                  <TextInput
                    value={draft.customStartDate ?? ''}
                    onChangeText={(value) => setDraft((current) => ({ ...current, customStartDate: value }))}
                    placeholder="Start YYYY-MM-DD"
                    placeholderTextColor={tokens.colors.textTertiary}
                    style={styles.textInput}
                  />
                  <TextInput
                    value={draft.customEndDate ?? ''}
                    onChangeText={(value) => setDraft((current) => ({ ...current, customEndDate: value }))}
                    placeholder="End YYYY-MM-DD"
                    placeholderTextColor={tokens.colors.textTertiary}
                    style={styles.textInput}
                  />
                </View>
              )}
            </FilterGroup>

            <FilterGroup title="Transaction type">
              <View style={styles.wrapRow}>
                {TYPE_FILTER_GROUPS.map((group) => {
                  const selected = group.values.every((value) => draft.transactionTypes.includes(value));
                  return (
                    <ChoiceChip
                      key={group.label}
                      label={group.label}
                      selected={selected}
                      onPress={() => {
                        setDraft((current) => {
                          const without = current.transactionTypes.filter(
                            (value) => !group.values.includes(value),
                          );
                          return {
                            ...current,
                            transactionTypes: selected ? without : [...without, ...group.values],
                          };
                        });
                      }}
                    />
                  );
                })}
              </View>
            </FilterGroup>

            {amcOptions.length > 0 && (
              <FilterGroup title="AMC">
                <View style={styles.wrapRow}>
                  {amcOptions.map((amc) => (
                    <ChoiceChip
                      key={amc}
                      label={amc}
                      selected={draft.amcNames.includes(amc)}
                      onPress={() => toggleArrayValue('amcNames', amc)}
                    />
                  ))}
                </View>
              </FilterGroup>
            )}

            {fundOptions.length > 0 && (
              <FilterGroup title="Fund name">
                <View style={styles.wrapRow}>
                  {fundOptions.map((fund) => (
                    <ChoiceChip
                      key={fund.id}
                      label={fund.name}
                      selected={draft.fundIds.includes(fund.id)}
                      onPress={() => toggleArrayValue('fundIds', fund.id)}
                    />
                  ))}
                </View>
              </FilterGroup>
            )}

            <FilterGroup title="Amount range">
              <View style={styles.inputRow}>
                <TextInput
                  value={minAmountText}
                  onChangeText={setMinAmountText}
                  keyboardType="numeric"
                  placeholder="Min amount"
                  placeholderTextColor={tokens.colors.textTertiary}
                  style={styles.textInput}
                />
                <TextInput
                  value={maxAmountText}
                  onChangeText={setMaxAmountText}
                  keyboardType="numeric"
                  placeholder="Max amount"
                  placeholderTextColor={tokens.colors.textTertiary}
                  style={styles.textInput}
                />
              </View>
            </FilterGroup>

            <TouchableOpacity
              style={styles.toggleRow}
              onPress={() => setDraft((current) => ({ ...current, includeHidden: !current.includeHidden }))}
              activeOpacity={0.76}
            >
              <View>
                <Text style={styles.toggleTitle}>Include hidden/reversed transactions</Text>
                <Text style={styles.toggleSubtitle}>Shows failed, cancelled, and reversed rows.</Text>
              </View>
              <View style={[styles.toggleTrack, draft.includeHidden && styles.toggleTrackActive]}>
                <View style={[styles.toggleKnob, draft.includeHidden && styles.toggleKnobActive]} />
              </View>
            </TouchableOpacity>
          </ScrollView>
          <SheetActions
            secondaryLabel="Cancel"
            primaryLabel="Apply filters"
            onSecondary={onClose}
            onPrimary={applyDraft}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ExportSheet({
  visible,
  transactionCount,
  exportResult,
  exportError,
  onClose,
  onExport,
}: {
  visible: boolean;
  transactionCount: number;
  exportResult: string | null;
  exportError: string | null;
  onClose: () => void;
  onExport: () => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <SheetHeader title="CSV export" onClose={onClose} />
          <View style={styles.exportBody}>
            <View style={styles.exportIcon}>
              <Ionicons name="document-text-outline" size={36} color={tokens.colors.emeraldDeep} />
              <Text style={styles.exportBadge}>CSV</Text>
            </View>
            <Text style={styles.exportTitle}>Export your transactions</Text>
            <Text style={styles.exportText}>
              File will include {transactionCount} visible transaction{transactionCount === 1 ? '' : 's'} matching your current filters.
            </Text>
            {exportResult && <Text style={styles.exportResult}>{exportResult}</Text>}
            {exportError && (
              <View style={styles.errorBox}>
                <Text style={styles.errorBoxTitle}>Couldn&apos;t export CSV</Text>
                <Text style={styles.errorBoxText}>{exportError}</Text>
              </View>
            )}
          </View>
          <SheetActions
            secondaryLabel="Cancel"
            primaryLabel="Export CSV"
            onSecondary={onClose}
            onPrimary={onExport}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SheetHeader({
  title,
  trailing,
  onTrailing,
  onClose,
}: {
  title: string;
  trailing?: string;
  onTrailing?: () => void;
  onClose: () => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.sheetHeader}>
      <Text style={styles.sheetTitle}>{title}</Text>
      <View style={styles.sheetHeaderActions}>
        {trailing && onTrailing ? (
          <TouchableOpacity onPress={onTrailing} activeOpacity={0.76}>
            <Text style={styles.sheetTrailing}>{trailing}</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={styles.sheetClose} onPress={onClose} activeOpacity={0.76}>
          <Ionicons name="close" size={20} color={tokens.colors.navy} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function SheetActions({
  secondaryLabel,
  primaryLabel,
  onSecondary,
  onPrimary,
}: {
  secondaryLabel: string;
  primaryLabel: string;
  onSecondary: () => void;
  onPrimary: () => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.sheetActions}>
      <TouchableOpacity style={styles.sheetSecondaryButton} onPress={onSecondary} activeOpacity={0.76}>
        <Text style={styles.sheetSecondaryText}>{secondaryLabel}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.sheetPrimaryButton} onPress={onPrimary} activeOpacity={0.82}>
        <Text style={styles.sheetPrimaryText}>{primaryLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.filterGroup}>
      <Text style={styles.filterGroupTitle}>{title}</Text>
      {children}
    </View>
  );
}

function ChoiceChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <TouchableOpacity style={[styles.choiceChip, selected && styles.choiceChipSelected]} onPress={onPress} activeOpacity={0.76}>
      <Text style={[styles.choiceChipText, selected && styles.choiceChipTextSelected]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

function EmptyTransactions({ filtered, onPrimary }: { filtered: boolean; onPrimary: () => void }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <ClearLensCard style={styles.emptyCard}>
      <View style={styles.emptyIcon}>
        <Ionicons name={filtered ? 'search-outline' : 'cloud-upload-outline'} size={30} color={tokens.colors.emerald} />
      </View>
      <Text style={styles.emptyTitle}>{filtered ? 'No matching transactions' : 'No transactions yet'}</Text>
      <Text style={styles.emptyText}>
        {filtered
          ? 'Try changing your filters or date range.'
          : 'Upload your CAS statement to see your complete Money Trail.'}
      </Text>
      <TouchableOpacity style={styles.emptyButton} onPress={onPrimary} activeOpacity={0.82}>
        <Text style={styles.emptyButtonText}>{filtered ? 'Clear filters' : 'Upload CAS'}</Text>
      </TouchableOpacity>
    </ClearLensCard>
  );
}

const SCROLL_TOP_THRESHOLD = 480;

export default function MoneyTrailScreen() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const router = useRouter();
  const isDesktop = useIsDesktop();
  const params = useLocalSearchParams<{ fundId?: string }>();
  const requestedFundId = typeof params.fundId === 'string' ? params.fundId : undefined;
  const didApplyFundParam = useRef(false);
  const scrollRef = useRef<ScrollView | null>(null);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<MoneyTrailFilters>(DEFAULT_MONEY_TRAIL_FILTERS);
  // Sort lives in the store so it survives navigating away and back, and so
  // any future Money Trail desktop variant shares the same source of truth.
  const sortBy = useAppStore((s) => s.moneyTrailSortBy);
  const setSortBy = useAppStore((s) => s.setMoneyTrailSortBy);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const { data, isLoading, isError, refetch } = useMoneyTrail();
  const transactions = useMemo(() => data?.transactions ?? [], [data?.transactions]);

  useEffect(() => {
    if (!requestedFundId || didApplyFundParam.current) return;
    didApplyFundParam.current = true;
    setFilters((current) => ({ ...current, fundIds: [requestedFundId] }));
  }, [requestedFundId]);

  const visibleTransactions = useMemo(
    () => applyMoneyTrailControls(transactions, filters, query, sortBy),
    [filters, query, sortBy, transactions],
  );
  // Hero summary should reflect the *scope* of what's being viewed (date
  // range + optional fund focus), not drill-down list filters. Otherwise
  // selecting "Investment" filter zeroes out the Money Out tile and makes
  // the hero feel inconsistent with what users think of as their account
  // summary. The transaction list still respects the full filter set.
  const heroTransactions = useMemo(() => {
    const scopeFilters: MoneyTrailFilters = {
      ...DEFAULT_MONEY_TRAIL_FILTERS,
      datePreset: filters.datePreset,
      customStartDate: filters.customStartDate,
      customEndDate: filters.customEndDate,
      fundIds: filters.fundIds,
      includeHidden: filters.includeHidden,
    };
    return applyMoneyTrailControls(transactions, scopeFilters, '', sortBy);
  }, [
    filters.datePreset,
    filters.customStartDate,
    filters.customEndDate,
    filters.fundIds,
    filters.includeHidden,
    sortBy,
    transactions,
  ]);
  const summaryMode: MoneyTrailSummaryMode = filters.fundIds.length > 0
    ? 'fund_cost_basis'
    : 'portfolio_external';
  const rangeLabel = useMemo(
    () => DATE_PRESETS.find((preset) => preset.value === filters.datePreset)?.label ?? 'All time',
    [filters.datePreset],
  );
  const hasAnyFilter = query.trim().length > 0 ||
    filters.datePreset !== 'all_time' ||
    filters.transactionTypes.length > 0 ||
    filters.amcNames.length > 0 ||
    filters.fundIds.length > 0 ||
    filters.minAmount != null ||
    filters.maxAmount != null ||
    filters.includeHidden;

  function clearFilters() {
    setFilters(DEFAULT_MONEY_TRAIL_FILTERS);
    setQuery('');
  }

  function scrollToTop() {
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }

  async function handleExport() {
    setExportResult(null);
    setExportError(null);
    try {
      const result = await exportMoneyTrailCsv(visibleTransactions);
      setExportResult(`Exported ${visibleTransactions.length} transactions. ${result.message}`);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Please try again.');
    }
  }

  return (
    <ResponsiveRouteFrame>
    <ClearLensScreen>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Sidebar already exposes Money Trail in Quick Actions on desktop, so
          we don't need an in-screen back button there. */}
      {isDesktop ? null : <ClearLensHeader onPressBack={() => router.back()} />}

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={tokens.colors.emerald} />
        </View>
      ) : isError ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>Couldn&apos;t load Money Trail.</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => refetch()} activeOpacity={0.82}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={32}
          onScroll={(event) => {
            const next = event.nativeEvent.contentOffset.y > SCROLL_TOP_THRESHOLD;
            if (next !== showScrollTop) setShowScrollTop(next);
          }}
        >
          <View style={styles.titleBlock}>
            <Text style={styles.eyebrow}>Money Trail</Text>
            <Text style={styles.title}>Where every rupee went</Text>
            <Text style={styles.subtitle}>Every investment, withdrawal, switch, and dividend in your portfolio.</Text>
          </View>

          {transactions.length > 0 ? (
            <>
              <HeroSection
                transactions={heroTransactions}
                summaryMode={summaryMode}
                rangeLabel={rangeLabel}
              />

              <View style={styles.controlsBlock}>
                <View style={styles.searchBox}>
                  <Ionicons name="search-outline" size={18} color={tokens.colors.textTertiary} />
                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder="Search fund, type, amount..."
                    placeholderTextColor={tokens.colors.textTertiary}
                    style={styles.searchInput}
                  />
                </View>
                <TouchableOpacity style={styles.iconButton} onPress={() => setSortOpen(true)} activeOpacity={0.76}>
                  <Ionicons name="swap-vertical-outline" size={19} color={tokens.colors.navy} />
                </TouchableOpacity>
                <TouchableOpacity style={styles.iconButton} onPress={() => setFilterOpen(true)} activeOpacity={0.76}>
                  <Ionicons name="filter-outline" size={19} color={tokens.colors.navy} />
                </TouchableOpacity>
              </View>

              <ActiveFilterChips
                filters={filters}
                fundOptions={data?.fundOptions ?? []}
                query={query}
                onClear={clearFilters}
              />

              <View style={styles.listHeader}>
                <View>
                  <Text style={styles.listTitle}>Transactions</Text>
                  <Text style={styles.listSubtitle}>
                    {visibleTransactions.length} shown · {MONEY_TRAIL_SORT_LABELS[sortBy]}
                  </Text>
                </View>
                <TouchableOpacity style={styles.exportButton} onPress={() => setExportOpen(true)} activeOpacity={0.76}>
                  <Ionicons name="download-outline" size={17} color={tokens.colors.emeraldDeep} />
                  <Text style={styles.exportButtonText}>Export</Text>
                </TouchableOpacity>
              </View>

              {visibleTransactions.length === 0 ? (
                <EmptyTransactions filtered={hasAnyFilter} onPrimary={clearFilters} />
              ) : (
                <View style={styles.transactionList}>
                  {visibleTransactions.map((transaction) => (
                    <TransactionRow
                      key={transaction.id}
                      transaction={transaction}
                      onPress={() => router.push(`/money-trail/${transaction.id}`)}
                    />
                  ))}
                </View>
              )}
            </>
          ) : (
            <EmptyTransactions filtered={false} onPrimary={() => router.push('/onboarding')} />
          )}
        </ScrollView>
      )}

      <SortSheet
        visible={sortOpen}
        selected={sortBy}
        onClose={() => setSortOpen(false)}
        onApply={setSortBy}
      />
      <FilterSheet
        visible={filterOpen}
        selected={filters}
        fundOptions={data?.fundOptions ?? []}
        amcOptions={data?.amcOptions ?? []}
        onClose={() => setFilterOpen(false)}
        onApply={setFilters}
      />
      <ExportSheet
        visible={exportOpen}
        transactionCount={visibleTransactions.length}
        exportResult={exportResult}
        exportError={exportError}
        onClose={() => setExportOpen(false)}
        onExport={handleExport}
      />

      {showScrollTop ? (
        <TouchableOpacity
          style={styles.scrollTopFab}
          onPress={scrollToTop}
          activeOpacity={0.82}
          accessibilityLabel="Scroll to top"
          accessibilityRole="button"
        >
          <Ionicons name="arrow-up" size={20} color={tokens.colors.textOnDark} />
        </TouchableOpacity>
      ) : null}
    </ClearLensScreen>
    </ResponsiveRouteFrame>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
  scroll: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingBottom: ClearLensSpacing.xxl,
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
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
  },
  heroCard: {
    gap: ClearLensSpacing.md,
  },
  heroEyebrow: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    fontFamily: ClearLensFonts.semiBold,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  heroValue: {
    ...ClearLensTypography.h1,
    color: cl.emeraldDeep,
    marginTop: 4,
  },
  flowRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: ClearLensSpacing.md,
    paddingTop: ClearLensSpacing.sm,
    borderTopWidth: 1,
    borderTopColor: cl.borderLight,
  },
  flowStat: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  flowDivider: {
    width: 1,
    backgroundColor: cl.borderLight,
  },
  flowIcon: {
    width: 34,
    height: 34,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flowCopy: {
    flex: 1,
    gap: 2,
  },
  flowLabel: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  flowAmount: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  flowMeta: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  annualBlock: {
    paddingTop: ClearLensSpacing.sm,
    borderTopWidth: 1,
    borderTopColor: cl.borderLight,
    gap: ClearLensSpacing.sm,
  },
  annualHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.md,
  },
  annualHeading: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    fontFamily: ClearLensFonts.semiBold,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  annualLegend: {
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  legendSwatch: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  legendText: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  annualDetail: {
    paddingHorizontal: ClearLensSpacing.sm,
    paddingVertical: 6,
    borderRadius: ClearLensRadii.sm,
    backgroundColor: cl.surfaceSoft,
    gap: 2,
  },
  annualDetailFy: {
    ...ClearLensTypography.caption,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  annualDetailRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: ClearLensSpacing.md,
  },
  annualDetailItem: {
    ...ClearLensTypography.caption,
    color: cl.textSecondary,
  },
  annualDetailValue: {
    fontFamily: ClearLensFonts.bold,
  },
  annualBars: {
    minHeight: 90,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.sm,
  },
  annualBarItem: {
    flex: 1,
    alignItems: 'center',
    gap: ClearLensSpacing.xs,
  },
  annualBarTrack: {
    height: 70,
    width: 18,
    justifyContent: 'flex-end',
    borderBottomWidth: 1,
    borderBottomColor: cl.border,
  },
  annualInvested: {
    width: 18,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    backgroundColor: cl.emerald,
  },
  annualWithdrawn: {
    width: 18,
    backgroundColor: cl.amber,
  },
  annualBarDim: {
    opacity: 0.42,
  },
  annualLabel: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  annualLabelActive: {
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  scrollTopFab: {
    position: 'absolute',
    right: ClearLensSpacing.md,
    bottom: ClearLensSpacing.lg,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: cl.emeraldDeep,
    alignItems: 'center',
    justifyContent: 'center',
    ...ClearLensShadow,
  },
  controlsBlock: {
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
  },
  searchBox: {
    flex: 1,
    minHeight: 46,
    borderRadius: ClearLensRadii.md,
    borderWidth: 1,
    borderColor: cl.border,
    backgroundColor: cl.surface,
    paddingHorizontal: ClearLensSpacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  searchInput: {
    ...ClearLensTypography.bodySmall,
    flex: 1,
    color: cl.navy,
    paddingVertical: 0,
  },
  iconButton: {
    width: 46,
    minHeight: 46,
    borderRadius: ClearLensRadii.md,
    borderWidth: 1,
    borderColor: cl.border,
    backgroundColor: cl.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipRow: {
    gap: ClearLensSpacing.sm,
    paddingRight: ClearLensSpacing.md,
  },
  activeChip: {
    minHeight: 34,
    paddingHorizontal: ClearLensSpacing.md,
    borderRadius: ClearLensRadii.full,
    backgroundColor: cl.mint50,
    justifyContent: 'center',
  },
  activeChipText: {
    ...ClearLensTypography.caption,
    color: cl.emeraldDeep,
    fontFamily: ClearLensFonts.bold,
  },
  clearChip: {
    minHeight: 34,
    paddingHorizontal: ClearLensSpacing.md,
    borderRadius: ClearLensRadii.full,
    backgroundColor: cl.surfaceSoft,
    justifyContent: 'center',
  },
  clearChipText: {
    ...ClearLensTypography.caption,
    color: cl.slate,
    fontFamily: ClearLensFonts.bold,
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.md,
  },
  listTitle: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  listSubtitle: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  exportButton: {
    minHeight: 38,
    paddingHorizontal: ClearLensSpacing.md,
    borderRadius: ClearLensRadii.full,
    borderWidth: 1,
    borderColor: cl.border,
    backgroundColor: cl.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.xs,
  },
  exportButtonText: {
    ...ClearLensTypography.caption,
    color: cl.emeraldDeep,
    fontFamily: ClearLensFonts.bold,
  },
  transactionList: {
    borderRadius: ClearLensRadii.lg,
    backgroundColor: cl.surface,
    borderWidth: 1,
    borderColor: cl.border,
    overflow: 'hidden',
    ...ClearLensShadow,
  },
  transactionRow: {
    minHeight: 86,
    padding: ClearLensSpacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: cl.borderLight,
  },
  transactionIcon: {
    width: 34,
    height: 34,
    borderRadius: ClearLensRadii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  transactionCopy: {
    flex: 1,
    gap: 2,
  },
  transactionType: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  transactionFund: {
    ...ClearLensTypography.caption,
    color: cl.textSecondary,
    fontFamily: ClearLensFonts.semiBold,
  },
  transactionDate: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  transactionAmountBlock: {
    alignItems: 'flex-end',
    gap: 3,
    minWidth: 82,
  },
  transactionAmount: {
    ...ClearLensTypography.bodySmall,
    fontFamily: ClearLensFonts.bold,
  },
  statusText: {
    ...ClearLensTypography.caption,
    fontFamily: ClearLensFonts.semiBold,
  },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: tokens.semantic.overlay.backdrop,
  },
  sheet: {
    maxHeight: '86%',
    borderTopLeftRadius: ClearLensRadii.xl,
    borderTopRightRadius: ClearLensRadii.xl,
    borderWidth: 1,
    borderColor: cl.border,
    backgroundColor: cl.surface,
    paddingBottom: ClearLensSpacing.lg,
    ...ClearLensShadow,
  },
  filterSheet: {
    maxHeight: '92%',
    borderTopLeftRadius: ClearLensRadii.xl,
    borderTopRightRadius: ClearLensRadii.xl,
    borderWidth: 1,
    borderColor: cl.border,
    backgroundColor: cl.surface,
    paddingBottom: ClearLensSpacing.lg,
    ...ClearLensShadow,
  },
  sheetHeader: {
    minHeight: 58,
    paddingHorizontal: ClearLensSpacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetTitle: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  sheetHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  sheetTrailing: {
    ...ClearLensTypography.caption,
    color: cl.emeraldDeep,
    fontFamily: ClearLensFonts.bold,
  },
  sheetClose: {
    width: 34,
    height: 34,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.surfaceSoft,
  },
  sheetOption: {
    minHeight: 54,
    paddingHorizontal: ClearLensSpacing.md,
    borderTopWidth: 1,
    borderTopColor: cl.borderLight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetOptionText: {
    ...ClearLensTypography.bodySmall,
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
  sheetActions: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingTop: ClearLensSpacing.md,
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
  },
  sheetSecondaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: ClearLensRadii.md,
    borderWidth: 1,
    borderColor: cl.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.surface,
  },
  sheetPrimaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: ClearLensRadii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.emeraldDeep,
  },
  sheetSecondaryText: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  sheetPrimaryText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textOnDark,
    fontFamily: ClearLensFonts.bold,
  },
  filterContent: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingBottom: ClearLensSpacing.md,
    gap: ClearLensSpacing.md,
  },
  filterGroup: {
    gap: ClearLensSpacing.sm,
  },
  filterGroupTitle: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    fontFamily: ClearLensFonts.bold,
    textTransform: 'uppercase',
  },
  wrapRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: ClearLensSpacing.sm,
  },
  choiceChip: {
    minHeight: 34,
    maxWidth: '100%',
    paddingHorizontal: ClearLensSpacing.md,
    borderRadius: ClearLensRadii.full,
    borderWidth: 1,
    borderColor: cl.border,
    backgroundColor: cl.surface,
    justifyContent: 'center',
  },
  choiceChipSelected: {
    borderColor: cl.emerald,
    backgroundColor: cl.mint50,
  },
  choiceChipText: {
    ...ClearLensTypography.caption,
    color: cl.slate,
    fontFamily: ClearLensFonts.semiBold,
  },
  choiceChipTextSelected: {
    color: cl.emeraldDeep,
    fontFamily: ClearLensFonts.bold,
  },
  inputRow: {
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
  },
  textInput: {
    ...ClearLensTypography.bodySmall,
    flex: 1,
    minHeight: 46,
    borderRadius: ClearLensRadii.md,
    borderWidth: 1,
    borderColor: cl.border,
    paddingHorizontal: ClearLensSpacing.md,
    color: cl.navy,
    backgroundColor: cl.surface,
  },
  toggleRow: {
    minHeight: 58,
    padding: ClearLensSpacing.md,
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.surfaceSoft,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.md,
  },
  toggleTitle: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  toggleSubtitle: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  toggleTrack: {
    width: 44,
    height: 26,
    borderRadius: ClearLensRadii.full,
    backgroundColor: cl.border,
    padding: 3,
  },
  toggleTrackActive: {
    backgroundColor: cl.emerald,
  },
  toggleKnob: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: cl.surface,
  },
  toggleKnobActive: {
    transform: [{ translateX: 18 }],
  },
  exportBody: {
    paddingHorizontal: ClearLensSpacing.md,
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  exportIcon: {
    width: 74,
    height: 74,
    borderRadius: ClearLensRadii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.mint50,
  },
  exportBadge: {
    ...ClearLensTypography.caption,
    color: cl.emeraldDeep,
    fontFamily: ClearLensFonts.bold,
  },
  exportTitle: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  exportText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
    textAlign: 'center',
  },
  exportResult: {
    ...ClearLensTypography.caption,
    color: cl.emeraldDeep,
    textAlign: 'center',
  },
  errorBox: {
    alignSelf: 'stretch',
    padding: ClearLensSpacing.md,
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.negativeBg,
    gap: 2,
  },
  errorBoxTitle: {
    ...ClearLensTypography.bodySmall,
    color: tokens.semantic.sentiment.negativeText,
    fontFamily: ClearLensFonts.bold,
  },
  errorBoxText: {
    ...ClearLensTypography.caption,
    color: tokens.semantic.sentiment.negativeText,
  },
  emptyCard: {
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  emptyIcon: {
    width: 58,
    height: 58,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.mint50,
  },
  emptyTitle: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  emptyText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
    textAlign: 'center',
  },
  emptyButton: {
    minHeight: 44,
    paddingHorizontal: ClearLensSpacing.lg,
    borderRadius: ClearLensRadii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.emeraldDeep,
  },
  emptyButtonText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textOnDark,
    fontFamily: ClearLensFonts.bold,
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
  retryButton: {
    minHeight: 42,
    paddingHorizontal: ClearLensSpacing.lg,
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.emeraldDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryButtonText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textOnDark,
    fontFamily: ClearLensFonts.bold,
  },
});
}
