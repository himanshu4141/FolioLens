import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  InteractionManager,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchUserTransactions } from '@/src/hooks/useUserTransactions';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { perfEnd, perfStart } from '@/src/lib/perfMark';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { G, Line as SvgLine, Path as SvgPath, Text as SvgText } from 'react-native-svg';
import { AppOverflowMenu } from '@/src/components/AppOverflowMenu';
import {
  ClearLensCard,
  ClearLensHeader,
  ClearLensScreen,
  ClearLensSegmentedControl,
} from '@/src/components/clearLens/ClearLensPrimitives';
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
import { usePortfolio } from '@/src/hooks/usePortfolio';
import { useSession } from '@/src/hooks/useSession';
import { useTrackInsightViewed } from '@/src/hooks/useTrackInsightViewed';
import {
  useAppStore,
  type WealthJourneyReturnPreset,
  type WealthJourneyState,
} from '@/src/store/appStore';
import { formatCurrency } from '@/src/utils/formatting';
import {
  getMilestones,
  projectRetirementIncome,
  projectWealth,
} from '@/src/utils/simulatorCalc';
import {
  buildReturnProfile,
  buildSipTargetChips,
  detectRecurringMonthlySipDetails,
  type ReturnPreset,
  type RecurringMonthlySipDetail,
} from '@/src/utils/wealthJourney';
import { parseFundName } from '@/src/utils/fundName';

const MAX_SIP = 25_00_000;
const MAX_TOP_UP = 10_00_00_000;

type ScreenMode = 'home' | 'adjust';
type ResultsView = 'growth' | 'withdrawal';
type SipEditorMode = 'review' | 'manual' | null;

interface ChoiceChip {
  label: string;
  value: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatPercent(value: number): string {
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

function formatAxisValue(value: number): string {
  if (value >= 1_00_00_000) return `${(value / 1_00_00_000).toFixed(1)}Cr`;
  if (value >= 1_00_000) return `${Math.round(value / 1_00_000)}L`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${Math.round(value)}`;
}

function buildVisibleYears(horizonYears: number): number[] {
  if (horizonYears <= 6) {
    return Array.from({ length: horizonYears + 1 }, (_, index) => index);
  }

  const interval =
    horizonYears <= 8 ? 2 : horizonYears <= 15 ? 3 : horizonYears <= 25 ? 5 : 6;
  const years = new Set<number>([0, horizonYears]);

  for (let year = interval; year < horizonYears; year += interval) {
    years.add(year);
  }

  return [...years].sort((a, b) => a - b);
}

function formatCheckpointLabel(year: number, startLabel: string): string {
  return year === 0 ? startLabel : `${year}Y`;
}

function ValueField({
  label,
  helperText,
  value,
  onChange,
  prefix,
  suffix,
  chips,
  max,
}: {
  label: string;
  helperText?: string;
  value: number;
  onChange: (value: number) => void;
  prefix?: string;
  suffix?: string;
  chips: ChoiceChip[];
  max?: number;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    const numeric = parseFloat(draft.replace(/[^0-9.]/g, ''));
    if (!Number.isNaN(numeric)) {
      onChange(max ? clamp(numeric, 0, max) : numeric);
    } else {
      setDraft(String(value));
    }
  }

  return (
    <View style={styles.fieldBlock}>
      <View style={styles.fieldHeader}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {helperText ? <Text style={styles.fieldHelper}>{helperText}</Text> : null}
      </View>
      <View style={styles.fieldShell}>
        {prefix ? <Text style={styles.fieldAffix}>{prefix}</Text> : null}
        <TextInput
          style={styles.fieldInput}
          value={draft}
          onChangeText={setDraft}
          onBlur={commit}
          onSubmitEditing={commit}
          keyboardType="numeric"
          returnKeyType="done"
        />
        {suffix ? <Text style={styles.fieldAffix}>{suffix}</Text> : null}
        <Ionicons name="pencil-outline" size={16} color={tokens.colors.textTertiary} />
      </View>
      <View style={styles.chipRow}>
        {chips.map((chip) => {
          const active = Math.abs(value - chip.value) < 0.001;
          return (
            <TouchableOpacity
              key={`${label}-${chip.label}`}
              style={[styles.choiceChip, active && styles.choiceChipActive]}
              onPress={() => onChange(chip.value)}
              activeOpacity={0.76}
            >
              <Text style={[styles.choiceChipText, active && styles.choiceChipTextActive]}>
                {chip.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function ReturnPresetPicker({
  presets,
  selectedPreset,
  value,
  onPresetChange,
  onCustomChange,
}: {
  presets: ReturnPreset[];
  selectedPreset: WealthJourneyReturnPreset | null;
  value: number;
  onPresetChange: (key: Exclude<WealthJourneyReturnPreset, 'custom'>, value: number) => void;
  onCustomChange: (value: number) => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    const numeric = parseFloat(draft.replace(/[^0-9.]/g, ''));
    if (!Number.isNaN(numeric)) {
      onCustomChange(clamp(numeric, 0, 30));
    } else {
      setDraft(String(value));
    }
  }

  return (
    <View style={styles.fieldBlock}>
      <View style={styles.fieldHeader}>
        <Text style={styles.fieldLabel}>Expected return</Text>
        <Text style={styles.fieldHelper}>Use a cautious long-term assumption.</Text>
      </View>
      <View style={styles.returnGrid}>
        {presets.map((preset) => {
          const active = selectedPreset === preset.key;
          return (
            <TouchableOpacity
              key={preset.key}
              style={[styles.returnCard, active && styles.returnCardActive]}
              onPress={() => onPresetChange(preset.key, preset.value)}
              activeOpacity={0.76}
            >
              <Text style={[styles.returnCardLabel, active && styles.returnCardLabelActive]}>
                {preset.label}
              </Text>
              <Text style={[styles.returnCardValue, active && styles.returnCardLabelActive]}>
                {formatPercent(preset.value)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <View style={styles.fieldShell}>
        <TextInput
          style={styles.fieldInput}
          value={draft}
          onChangeText={setDraft}
          onBlur={commit}
          onSubmitEditing={commit}
          keyboardType="numeric"
          returnKeyType="done"
        />
        <Text style={styles.fieldAffix}>% p.a.</Text>
        <Ionicons name="pencil-outline" size={16} color={tokens.colors.textTertiary} />
      </View>
    </View>
  );
}

function JourneyLineChart({
  data,
  data2,
  chartWidth,
  compact,
  labels,
  pointerHeight,
}: {
  data: { value: number; label: string }[];
  data2?: { value: number; label: string }[];
  chartWidth: number;
  compact: boolean;
  labels: string[];
  pointerHeight: number;
}) {
  const tokens = useClearLensTokens();
  const hasSecondSeries = !!data2 && data2.length > 0;
  const chartHeight = compact ? 210 : pointerHeight;
  const plotTop = 12;
  const plotBottom = 30;
  const plotLeft = 56;
  const plotRight = 8;
  const plotWidth = Math.max(1, chartWidth - plotLeft - plotRight);
  const plotHeight = Math.max(1, chartHeight - plotTop - plotBottom);
  const allValues = [
    ...data.map((point) => point.value),
    ...(data2 ?? []).map((point) => point.value),
  ].filter((value) => Number.isFinite(value));
  const yMax = Math.max(1, Math.max(...allValues) * 1.08);
  const labelEvery = data.length <= 6 ? 1 : Math.ceil(data.length / 5);

  function xFor(index: number, pointCount: number): number {
    return plotLeft + (pointCount <= 1 ? 0 : (index / (pointCount - 1)) * plotWidth);
  }

  function yFor(value: number): number {
    return plotTop + plotHeight - (Math.max(0, value) / yMax) * plotHeight;
  }

  function pathFor(points: { value: number }[]): string {
    return points
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index, points.length).toFixed(1)} ${yFor(point.value).toFixed(1)}`)
      .join(' ');
  }

  return (
    <Svg width={chartWidth} height={chartHeight}>
      {[4, 3, 2, 1, 0].map((tick) => {
        const value = (yMax / 4) * tick;
        const y = yFor(value);
        return (
          <G key={`tick-${tick}`}>
            <SvgLine
              x1={plotLeft}
              x2={plotLeft + plotWidth}
              y1={y}
              y2={y}
              stroke={tick === 0 ? tokens.colors.border : tokens.colors.borderLight}
              strokeWidth={1}
              strokeDasharray={tick === 0 ? undefined : '4 8'}
            />
            <SvgText
              x={plotLeft - 10}
              y={y + 4}
              fill={tokens.colors.textTertiary}
              fontSize={11}
              fontWeight="600"
              textAnchor="end"
            >
              {formatAxisValue(value)}
            </SvgText>
          </G>
        );
      })}

      {data.length > 0 && (
        <SvgPath
          d={pathFor(data)}
          fill="none"
          stroke={hasSecondSeries ? tokens.semantic.chart.benchmark : tokens.semantic.chart.portfolio}
          strokeWidth={hasSecondSeries ? 2.5 : 3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {hasSecondSeries && data2 && (
        <SvgPath
          d={pathFor(data2)}
          fill="none"
          stroke={tokens.semantic.chart.portfolio}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {data.map((point, index) => {
        const showLabel = index === 0 || index === data.length - 1 || index % labelEvery === 0;
        if (!showLabel) return null;
        return (
          <SvgText
            key={`${point.label}-${index}`}
            x={xFor(index, data.length)}
            y={chartHeight - 8}
            fill={tokens.colors.textTertiary}
            fontSize={11}
            fontWeight="600"
            textAnchor={index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle'}
          >
            {labels[index] ?? point.label}
          </SvgText>
        );
      })}
    </Svg>
  );
}

function ChartPlaceholder({ height }: { height: number }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={[styles.chartPlaceholder, { height }]}>
      <ActivityIndicator size="small" color={tokens.colors.emerald} />
    </View>
  );
}

function SnapshotMetric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'neutral';
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.snapshotMetric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.snapshotValue, tone === 'positive' && styles.positiveText]}>{value}</Text>
    </View>
  );
}

function SipEditorModal({
  mode,
  hasDetectedSip,
  detectedSip,
  detectedDetails,
  detectedDetailsTitle,
  fundNameById,
  currentSip,
  draft,
  setDraft,
  onClose,
  onUseDetected,
  onManual,
  onSaveManual,
}: {
  mode: SipEditorMode;
  hasDetectedSip: boolean;
  detectedSip: number;
  detectedDetails: RecurringMonthlySipDetail[];
  detectedDetailsTitle: string;
  fundNameById: Map<string, string>;
  currentSip: number;
  draft: string;
  setDraft: (value: string) => void;
  onClose: () => void;
  onUseDetected: () => void;
  onManual: () => void;
  onSaveManual: () => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const insets = useSafeAreaInsets();
  const manualDraftValue = parseFloat(draft.replace(/[^0-9.]/g, ''));
  const sheetBodyStyle = [
    styles.sheetBody,
    { paddingBottom: ClearLensSpacing.lg + insets.bottom },
  ];

  return (
    <Modal visible={mode !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 16 : 0}
          style={styles.modalKeyboardView}
        >
          <Pressable style={styles.modalSheet} onPress={(event) => event.stopPropagation()}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {mode === 'manual'
                  ? 'Enter monthly SIP'
                  : hasDetectedSip
                    ? 'Review detected SIP'
                    : 'Review monthly SIP'}
              </Text>
              <TouchableOpacity onPress={onClose} style={styles.iconButton}>
                <Ionicons name="close" size={20} color={tokens.colors.slate} />
              </TouchableOpacity>
            </View>

          {mode === 'manual' ? (
            <ScrollView
              bounces={false}
              keyboardShouldPersistTaps="handled"
              style={styles.sheetScrollBody}
              contentContainerStyle={sheetBodyStyle}
            >
              <Text style={styles.sheetCopy}>Set the monthly SIP you want to use for projections.</Text>
              <Text style={styles.fieldLabel}>Monthly SIP for projections</Text>
              <View style={styles.fieldShell}>
                <Text style={styles.fieldAffix}>₹</Text>
                <TextInput
                  style={styles.fieldInput}
                  value={draft}
                  onChangeText={setDraft}
                  keyboardType="numeric"
                  returnKeyType="done"
                />
                <Ionicons name="pencil-outline" size={16} color={tokens.colors.emerald} />
              </View>
              <Text style={styles.sheetFinePrint}>
                This only changes your Wealth Journey estimate. It does not change your portfolio data.
              </Text>
              <Text style={styles.sheetSectionTitle}>Quick choices</Text>
              <View style={styles.chipRow}>
                {buildSipTargetChips(currentSip || 100000).map((chip) => {
                  const active = Number.isFinite(manualDraftValue) && Math.abs(manualDraftValue - chip.value) < 1;
                  return (
                    <TouchableOpacity
                      key={chip.label}
                      style={[styles.choiceChip, active && styles.choiceChipActive]}
                      onPress={() => setDraft(String(chip.value))}
                    >
                      <Text style={[styles.choiceChipText, active && styles.choiceChipTextActive]}>
                        {chip.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <TouchableOpacity style={styles.primaryButton} onPress={onSaveManual}>
                <Text style={styles.primaryButtonText}>Save</Text>
              </TouchableOpacity>
            </ScrollView>
          ) : (
            <ScrollView
              bounces={false}
              keyboardShouldPersistTaps="handled"
              style={styles.sheetScrollBody}
              contentContainerStyle={sheetBodyStyle}
            >
              <Text style={styles.sheetCopy}>
                {hasDetectedSip
                  ? 'We estimated this from recurring investments in the last 6 months.'
                  : 'This monthly SIP is used only for Wealth Journey projections.'}
              </Text>
              <View style={styles.detectedBox}>
                <Text style={styles.metricLabel}>{hasDetectedSip ? 'Detected SIP' : 'Monthly SIP'}</Text>
                <Text style={styles.detectedValue}>{formatCurrency(detectedSip || currentSip)}</Text>
              </View>
              {detectedDetails.length > 0 && (
                <View style={styles.recurringList}>
                  <Text style={styles.sheetSectionTitle}>{detectedDetailsTitle}</Text>
                  {detectedDetails.slice(0, 4).map((detail, index) => (
                    <View
                      key={detail.fundId}
                      style={[
                        styles.recurringRow,
                        index < Math.min(detectedDetails.length, 4) - 1 && styles.recurringRowBorder,
                      ]}
                    >
                      <Text style={styles.recurringName} numberOfLines={1}>
                        {fundNameById.get(detail.fundId) ?? 'Fund'}
                      </Text>
                      <Text style={styles.recurringValue}>{formatCurrency(detail.amount)}</Text>
                    </View>
                  ))}
                  {detectedDetails.length > 4 && (
                    <Text style={styles.recurringMore}>+{detectedDetails.length - 4} more funds</Text>
                  )}
                </View>
              )}
              <View style={styles.sheetActions}>
                <TouchableOpacity
                  style={[styles.secondaryButton, styles.sheetActionItem]}
                  onPress={onManual}
                >
                  <Text style={styles.secondaryButtonText}>Enter manually</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.primaryButton, styles.sheetActionItem]}
                  onPress={onUseDetected}
                >
                  <Text style={styles.primaryButtonText}>
                    {hasDetectedSip ? 'Use detected SIP' : 'Keep monthly SIP'}
                  </Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          )}
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

export function ClearLensWealthJourneyScreen() {
  useTrackInsightViewed('wealth_journey');
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const router = useRouter();
  const isFocused = useIsFocused();
  const { width: viewportWidth } = useWindowDimensions();
  const { session } = useSession();
  const userId = session?.user.id;
  const queryClient = useQueryClient();
  const accountMetadata = session?.user.user_metadata as { full_name?: string; name?: string } | undefined;
  const accountLabel = accountMetadata?.full_name ?? accountMetadata?.name ?? session?.user.email ?? null;
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [screenMode, setScreenMode] = useState<ScreenMode>('home');
  const [resultsView, setResultsView] = useState<ResultsView>('growth');
  const [sipEditorMode, setSipEditorMode] = useState<SipEditorMode>(null);
  const [sipDraft, setSipDraft] = useState('');
  const [chartsReady, setChartsReady] = useState(false);

  const { wealthJourney, updateWealthJourney, returnAssumptions } = useAppStore();

  useEffect(() => {
    if (!isFocused) {
      setChartsReady(false);
      setOverflowOpen(false);
      setSipEditorMode(null);
      setScreenMode('home');
      return undefined;
    }

    let cancelled = false;
    const task = InteractionManager.runAfterInteractions(() => {
      if (!cancelled) {
        setChartsReady(true);
      }
    });

    return () => {
      cancelled = true;
      task.cancel();
    };
  }, [isFocused]);

  const { data: portfolioData, isLoading: portfolioLoading } = usePortfolio();
  const summary = portfolioData?.summary ?? null;
  const currentCorpus = summary?.totalValue ?? 0;
  const returnProfile = useMemo(
    () => buildReturnProfile(summary?.xirr, returnAssumptions),
    [summary?.xirr, returnAssumptions],
  );
  const fundNameById = useMemo(
    () =>
      new Map(
        (portfolioData?.fundCards ?? []).map((fund) => [
          fund.id,
          parseFundName(fund.schemeName).base,
        ]),
      ),
    [portfolioData?.fundCards],
  );

  const sixMonthsAgo = useMemo(() => {
    const date = new Date();
    date.setMonth(date.getMonth() - 6);
    return date.toISOString().split('T')[0];
  }, []);

  // Read the user's transactions through the shared
  // `['user-transactions', userId]` cache (same key Portfolio and
  // Money Trail populate). The wealth-journey window (last 6 months)
  // is applied in JS off the full set — that's cheap because the
  // payload is already in memory after Portfolio has loaded.
  const { data: transactions } = useQuery({
    queryKey: ['wealth-journey-transactions', userId, sixMonthsAgo],
    enabled: !!userId,
    queryFn: async () => {
      perfStart('query:wealthJourney:transactions');
      const all = await queryClient.fetchQuery({
        queryKey: ['user-transactions', userId],
        queryFn: () => fetchUserTransactions(userId!),
        staleTime: STALE_TIMES.USER_TRANSACTIONS,
      });
      const filtered = all
        .filter((tx) => tx.transaction_date >= sixMonthsAgo)
        // Wealth Journey iterates newest-first to detect the most-recent
        // SIP cadence; preserve that order even though the shared
        // cache stores rows ascending by date.
        .slice()
        .reverse()
        .map((tx) => ({
          transaction_date: tx.transaction_date,
          amount: tx.amount,
          transaction_type: tx.transaction_type,
          fund_id: tx.fund_id,
        }));
      perfEnd('query:wealthJourney:transactions', {
        rows: filtered.length,
        since: sixMonthsAgo,
        total_cached: all.length,
      });
      return filtered;
    },
    staleTime: STALE_TIMES.USER_TRANSACTIONS,
  });

  const detectedSipDetails = useMemo(
    () => detectRecurringMonthlySipDetails(transactions ?? []),
    [transactions],
  );
  const detectedSip = useMemo(
    () => detectedSipDetails.reduce((sum, detail) => sum + detail.amount, 0),
    [detectedSipDetails],
  );

  useEffect(() => {
    if (!wealthJourney.hasOpened) {
      updateWealthJourney({ hasOpened: true });
    }
  }, [updateWealthJourney, wealthJourney.hasOpened]);

  const defaultExpectedReturn =
    returnProfile.presets.find((preset) => preset.key === returnProfile.defaultPresetKey)?.value ??
    10;
  const selectedReturnPresetKey =
    wealthJourney.expectedReturnPreset ?? returnProfile.defaultPresetKey;
  const selectedReturnPreset =
    selectedReturnPresetKey === 'custom'
      ? null
      : returnProfile.presets.find((preset) => preset.key === selectedReturnPresetKey);
  const expectedReturn =
    selectedReturnPresetKey === 'custom'
      ? wealthJourney.expectedReturn ?? defaultExpectedReturn
      : selectedReturnPreset?.value ?? defaultExpectedReturn;

  useEffect(() => {
    const patch: Partial<WealthJourneyState> = {};
    if (wealthJourney.expectedReturnPreset == null) {
      patch.expectedReturnPreset = returnProfile.defaultPresetKey;
    }
    if (
      wealthJourney.expectedReturn == null ||
      (selectedReturnPresetKey !== 'custom' && wealthJourney.expectedReturn !== expectedReturn)
    ) {
      patch.expectedReturn = expectedReturn;
    }
    if (wealthJourney.postRetirementReturn == null) {
      patch.postRetirementReturn = returnProfile.postRetirementDefault;
    }
    if (Object.keys(patch).length > 0) {
      updateWealthJourney(patch);
    }
  }, [
    returnProfile.defaultPresetKey,
    returnProfile.postRetirementDefault,
    expectedReturn,
    selectedReturnPresetKey,
    updateWealthJourney,
    wealthJourney.expectedReturn,
    wealthJourney.expectedReturnPreset,
    wealthJourney.postRetirementReturn,
  ]);

  const currentSip = wealthJourney.currentSipOverride ?? detectedSip ?? 0;
  const reviewSipDetails = useMemo(() => {
    if (detectedSipDetails.length > 0) return detectedSipDetails;

    const fundCards = portfolioData?.fundCards ?? [];
    const sipTotal = currentSip || detectedSip;
    const totalValue = fundCards.reduce((sum, fund) => sum + (fund.currentValue ?? 0), 0);
    if (sipTotal <= 0 || totalValue <= 0) return [];

    return fundCards
      .map((fund) => ({
        fundId: fund.id,
        amount: Math.max(
          0,
          Math.round(((sipTotal * (fund.currentValue ?? 0)) / totalValue) / 100) * 100,
        ),
        monthCount: 0,
        latestDate: '',
      }))
      .filter((detail) => detail.amount > 0)
      .sort((a, b) => b.amount - a.amount);
  }, [currentSip, detectedSip, detectedSipDetails, portfolioData?.fundCards]);
  const reviewSipDetailsTitle =
    detectedSipDetails.length > 0 ? 'Recent recurring investments' : 'Current SIP allocation';
  const futureSipTarget =
    wealthJourney.futureSipTarget ??
    clamp(currentSip + wealthJourney.monthlySipIncrease, 0, MAX_SIP);
  const adjustedSip = futureSipTarget;
  const additionalTopUp = wealthJourney.additionalTopUp;
  const yearsToRetirement = wealthJourney.yearsToRetirement;
  const retirementDurationYears = wealthJourney.retirementDurationYears;
  const withdrawalRate = wealthJourney.withdrawalRate;
  const postRetirementReturn =
    wealthJourney.postRetirementReturn ?? returnProfile.postRetirementDefault;

  useEffect(() => {
    if (wealthJourney.futureSipTarget == null && wealthJourney.monthlySipIncrease !== 0) {
      updateWealthJourney({
        futureSipTarget: clamp(currentSip + wealthJourney.monthlySipIncrease, 0, MAX_SIP),
        monthlySipIncrease: 0,
      });
    }
  }, [
    currentSip,
    updateWealthJourney,
    wealthJourney.futureSipTarget,
    wealthJourney.monthlySipIncrease,
  ]);

  const baselinePoints = useMemo(
    () => projectWealth(currentSip, currentCorpus, expectedReturn, yearsToRetirement, 0),
    [currentCorpus, currentSip, expectedReturn, yearsToRetirement],
  );
  const adjustedPoints = useMemo(
    () => projectWealth(adjustedSip, currentCorpus, expectedReturn, yearsToRetirement, additionalTopUp),
    [additionalTopUp, adjustedSip, currentCorpus, expectedReturn, yearsToRetirement],
  );

  const projectedCorpus = adjustedPoints[adjustedPoints.length - 1]?.value ?? currentCorpus;
  const withdrawalProjection = useMemo(
    () =>
      projectRetirementIncome(
        projectedCorpus,
        withdrawalRate,
        retirementDurationYears,
        postRetirementReturn,
      ),
    [postRetirementReturn, projectedCorpus, retirementDurationYears, withdrawalRate],
  );

  // On desktop the screen is constrained by ClearLensScreen's desktopMaxWidth
  // (760 px). Cap the chart width to that, otherwise it would size from the raw
  // viewport (≥1024 px) and overflow the centered column.
  const rawWidth = Math.max(320, viewportWidth || 360);
  const screenWidth = Math.min(rawWidth, 760);
  const compact = screenWidth <= 430;
  const chartWidth = Math.max(250, screenWidth - ClearLensSpacing.md * 4 - 8);
  const visibleGrowthYears = useMemo(() => buildVisibleYears(yearsToRetirement), [yearsToRetirement]);
  const baselineChartData = useMemo(
    () =>
      visibleGrowthYears.map((year) => ({
        value:
          year === 0
            ? currentCorpus
            : baselinePoints.find((point) => point.year === year)?.value ?? currentCorpus,
        label: formatCheckpointLabel(year, 'Now'),
      })),
    [baselinePoints, currentCorpus, visibleGrowthYears],
  );
  const adjustedChartData = useMemo(
    () =>
      visibleGrowthYears.map((year) => ({
        value:
          year === 0
            ? currentCorpus
            : adjustedPoints.find((point) => point.year === year)?.value ?? currentCorpus,
        label: formatCheckpointLabel(year, 'Now'),
      })),
    [adjustedPoints, currentCorpus, visibleGrowthYears],
  );
  const visibleWithdrawalYears = useMemo(
    () => buildVisibleYears(retirementDurationYears),
    [retirementDurationYears],
  );
  const withdrawalChartData = useMemo(
    () =>
      visibleWithdrawalYears.map((year) => ({
        value: withdrawalProjection.trajectory.find((point) => point.year === year)?.value ?? 0,
        label: formatCheckpointLabel(year, 'Start'),
      })),
    [visibleWithdrawalYears, withdrawalProjection.trajectory],
  );
  const displayedMilestones = useMemo(() => getMilestones(adjustedPoints).slice(0, 3), [adjustedPoints]);
  const futureSipChips = useMemo<ChoiceChip[]>(
    () => buildSipTargetChips(currentSip || 100000),
    [currentSip],
  );
  const growthBadgeLabel =
    selectedReturnPresetKey === 'custom'
      ? `Custom ${formatPercent(expectedReturn)}`
      : `${selectedReturnPreset?.label ?? returnProfile.suggestedLabel} ${formatPercent(expectedReturn)}`;

  function markSaved(patch: Partial<WealthJourneyState>) {
    updateWealthJourney({ ...patch, hasSavedPlan: true });
  }

  function openSipReview() {
    setSipDraft(String(currentSip || detectedSip || 0));
    setSipEditorMode('review');
  }

  function saveSipDraft() {
    const numeric = parseFloat(sipDraft.replace(/[^0-9.]/g, ''));
    if (!Number.isNaN(numeric)) {
      updateWealthJourney({
        currentSipOverride: clamp(Math.round(numeric), 0, MAX_SIP),
      });
      setSipEditorMode(null);
    }
  }

  function renderGrowthCard(compactMode = false) {
    return (
      <ClearLensCard style={styles.resultCard}>
        <View style={styles.cardHeader}>
          <View style={styles.flexCopy}>
            <Text style={styles.metricLabel}>Projected corpus</Text>
            <Text style={styles.resultHero}>{formatCurrency(projectedCorpus)}</Text>
            <Text style={styles.sectionSubtitle}>in {yearsToRetirement} years</Text>
          </View>
          <View style={styles.badge}>
            <View style={styles.badgeDot} />
            <Text style={styles.badgeText}>{growthBadgeLabel} p.a.</Text>
          </View>
        </View>
        {chartsReady ? (
          <JourneyLineChart
            data={baselineChartData}
            data2={adjustedChartData}
            chartWidth={chartWidth}
            compact={compact}
            labels={baselineChartData.map((point) => point.label)}
            pointerHeight={compact ? 210 : 226}
          />
        ) : (
          <ChartPlaceholder height={compact ? 210 : 226} />
        )}
        <View style={styles.legendRow}>
          <View style={styles.legendItem}>
            <View style={[styles.legendLine, { backgroundColor: tokens.semantic.chart.benchmark }]} />
            <Text style={styles.legendText}>Current plan</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: tokens.semantic.chart.portfolio }]} />
            <Text style={styles.legendText}>Adjusted plan</Text>
          </View>
        </View>
        {!compactMode && (
          <View style={styles.milestoneGrid}>
            {displayedMilestones.map((milestone) => (
              <View key={milestone.year} style={styles.milestoneCell}>
                <Text style={styles.metricLabel}>{milestone.year}Y</Text>
                <Text style={styles.milestoneValue}>{formatCurrency(milestone.value)}</Text>
              </View>
            ))}
          </View>
        )}
      </ClearLensCard>
    );
  }

  function renderProjectionDisclaimer() {
    return (
      <View style={styles.disclaimer}>
        <Ionicons name="information-circle-outline" size={15} color={tokens.colors.textTertiary} />
        <Text style={styles.disclaimerText}>
          This is a projection, not a promise. Markets go up and down. Results can be higher or lower than shown. Returns are nominal, pre-tax. Inflation is not adjusted unless stated.
        </Text>
      </View>
    );
  }

  function renderWithdrawalSummaryCard() {
    return (
      <ClearLensCard style={styles.resultCard}>
        <View style={styles.withdrawalSummaryTop}>
          <View style={styles.withdrawalSummaryMetric}>
            <Text style={styles.metricLabel}>Monthly income</Text>
            <Text style={[styles.largeMetric, styles.positiveText]}>{formatCurrency(withdrawalProjection.monthlyIncome)}/mo</Text>
            <Text style={styles.sectionSubtitle}>{formatPercent(withdrawalRate)} withdrawal rate</Text>
          </View>
          <View style={[styles.withdrawalSummaryMetric, styles.withdrawalSummaryMetricRight]}>
            <Text style={styles.metricLabel}>Lasts for</Text>
            <Text style={styles.largeMetric}>{retirementDurationYears} years</Text>
            <Text style={styles.sectionSubtitle}>at {formatPercent(postRetirementReturn)} p.a. post-return</Text>
          </View>
        </View>
        <View style={styles.withdrawalDetailRow}>
          <View>
            <Text style={styles.metricLabel}>Corpus at start</Text>
            <Text style={styles.resultRowValue}>{formatCurrency(projectedCorpus)}</Text>
          </View>
          <View style={styles.rightMetric}>
            <Text style={styles.metricLabel}>Residual corpus</Text>
            <Text style={styles.resultRowValue}>{formatCurrency(withdrawalProjection.endCorpus)}</Text>
          </View>
        </View>
      </ClearLensCard>
    );
  }

  function renderWithdrawalDrawdownCard() {
    return (
      <ClearLensCard style={styles.resultCard}>
        <Text style={styles.sectionTitle}>Drawdown path</Text>
        {chartsReady ? (
          <JourneyLineChart
            data={withdrawalChartData}
            chartWidth={chartWidth}
            compact={compact}
            labels={withdrawalChartData.map((point) => point.label)}
            pointerHeight={compact ? 210 : 226}
          />
        ) : (
          <ChartPlaceholder height={compact ? 210 : 226} />
        )}
        <View style={styles.withdrawalDetailRow}>
          <View>
            <Text style={styles.metricLabel}>Post-ret. return</Text>
            <Text style={styles.resultRowValue}>{formatPercent(postRetirementReturn)} p.a.</Text>
          </View>
          <View style={styles.rightMetric}>
            <Text style={styles.metricLabel}>Withdrawal rate</Text>
            <Text style={styles.resultRowValue}>{formatPercent(withdrawalRate)} p.a.</Text>
          </View>
        </View>
      </ClearLensCard>
    );
  }

  function renderWithdrawalPathNote() {
    return (
      <View style={styles.projectionNote}>
        <Ionicons name="bulb-outline" size={16} color={tokens.colors.emeraldDeep} />
        <Text style={styles.infoBannerText}>
          This path leaves <Text style={styles.inlineStrong}>{formatCurrency(withdrawalProjection.endCorpus)}</Text> after {retirementDurationYears} years.
        </Text>
      </View>
    );
  }

  function renderWithdrawalSections() {
    return (
      <>
        {renderWithdrawalSummaryCard()}
        {renderWithdrawalDrawdownCard()}
        {renderWithdrawalPathNote()}
      </>
    );
  }

  return (
    <ClearLensScreen>
      <ClearLensHeader
        title={screenMode === 'home' ? undefined : 'Adjust your plan'}
        showTagline={screenMode === 'home'}
        onPressBack={screenMode === 'home' ? undefined : () => setScreenMode('home')}
        onPressMenu={screenMode === 'home' ? () => setOverflowOpen(true) : undefined}
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

      {portfolioLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={tokens.colors.emerald} />
        </View>
      ) : (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 72 : 0}
          style={styles.keyboardScreen}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          >
          {screenMode === 'home' && (
            <>
              <View style={styles.heroCopy}>
                <Text style={styles.heroEyebrow}>Wealth Journey</Text>
                <Text style={styles.heroTitle}>Plan today, with clarity</Text>
                <Text style={styles.heroSubtitle}>See where your money is headed under your current pace.</Text>
              </View>

              <ClearLensCard style={styles.snapshotCard}>
                <View style={styles.cardHeader}>
                  <View style={styles.flexCopy}>
                    <Text style={styles.sectionTitle}>Your portfolio today</Text>
                    <Text style={styles.sectionSubtitle}>Started from your current portfolio. Edit assumptions anytime.</Text>
                  </View>
                </View>
                <View style={styles.snapshotGrid}>
                  <SnapshotMetric label="Corpus" value={formatCurrency(currentCorpus)} />
                  <SnapshotMetric label="Monthly SIP" value={`${formatCurrency(currentSip)}/mo`} />
                  <SnapshotMetric label="XIRR" value={summary ? `${(summary.xirr * 100).toFixed(2)}%` : '—'} tone="positive" />
                </View>
                <View style={styles.infoBanner}>
                  <Ionicons name="checkmark-circle-outline" size={16} color={tokens.colors.emeraldDeep} />
                  <Text style={styles.infoBannerText}>
                    {detectedSip > 0 ? 'Detected from recurring buys in the last 6 months.' : 'Add your SIP assumption to personalize projections.'}
                  </Text>
                  <TouchableOpacity onPress={openSipReview}>
                    <Text style={styles.inlineLink}>Review / edit</Text>
                  </TouchableOpacity>
                </View>
              </ClearLensCard>

              <View style={styles.planHeader}>
                <Text style={styles.sectionTitle}>Your plan at a glance</Text>
                <ClearLensSegmentedControl
                  options={[
                    { value: 'growth', label: 'Wealth growth' },
                    { value: 'withdrawal', label: 'Withdrawal income' },
                  ]}
                  selected={resultsView}
                  onChange={setResultsView}
                />
              </View>

              {resultsView === 'growth' ? renderGrowthCard(true) : renderWithdrawalSections()}

              <TouchableOpacity style={styles.primaryButton} onPress={() => setScreenMode('adjust')}>
                <Text style={styles.primaryButtonText}>Adjust your plan</Text>
              </TouchableOpacity>
              {renderProjectionDisclaimer()}

              <TouchableOpacity
                style={styles.exploreToolsRow}
                onPress={() => router.push('/tools' as never)}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel="Explore more tools"
              >
                <Text style={styles.exploreToolsLabel}>Explore more tools</Text>
                <Ionicons name="chevron-forward" size={16} color={tokens.colors.emerald} />
              </TouchableOpacity>
            </>
          )}

          {screenMode === 'adjust' && (
            <>
              <Text style={styles.centerSubtitle}>Build your plan using simple inputs.</Text>
              <View style={styles.formSection}>
                <Text style={styles.formSectionTitle}>1 · Investment plan</Text>
                <ValueField
                  label="Monthly SIP (going forward)"
                  value={adjustedSip}
                  onChange={(value) =>
                    markSaved({
                      futureSipTarget: clamp(Math.round(value), 0, MAX_SIP),
                      monthlySipIncrease: clamp(Math.round(value), 0, MAX_SIP) - currentSip,
                    })
                  }
                  prefix="₹"
                  chips={futureSipChips}
                  max={MAX_SIP}
                />
                <ValueField
                  label="Additional top-up"
                  value={additionalTopUp}
                  onChange={(value) => markSaved({ additionalTopUp: clamp(Math.round(value), 0, MAX_TOP_UP) })}
                  prefix="₹"
                  chips={[
                    { label: '₹0', value: 0 },
                    { label: '₹5L', value: 5_00_000 },
                    { label: '₹10L', value: 10_00_000 },
                    { label: '₹25L', value: 25_00_000 },
                  ]}
                  max={MAX_TOP_UP}
                />
                <ValueField
                  label="Saving period"
                  helperText="How long you keep investing before withdrawals begin"
                  value={yearsToRetirement}
                  onChange={(value) => markSaved({ yearsToRetirement: clamp(Math.round(value), 1, 40) })}
                  suffix="years"
                  chips={[
                    { label: '10Y', value: 10 },
                    { label: '15Y', value: 15 },
                    { label: '20Y', value: 20 },
                    { label: '25Y', value: 25 },
                  ]}
                />
                <ReturnPresetPicker
                  presets={returnProfile.presets}
                  selectedPreset={selectedReturnPresetKey}
                  value={expectedReturn}
                  onPresetChange={(key, value) => markSaved({ expectedReturnPreset: key, expectedReturn: value })}
                  onCustomChange={(value) => markSaved({ expectedReturnPreset: 'custom', expectedReturn: value })}
                />
              </View>

              <View style={styles.formSection}>
                <Text style={styles.formSectionTitle}>2 · Withdrawal plan</Text>
                <ValueField
                  label="Withdrawal rate (p.a.)"
                  value={withdrawalRate}
                  onChange={(value) => markSaved({ withdrawalRate: clamp(value, 1, 12) })}
                  suffix="%"
                  chips={[
                    { label: '3%', value: 3 },
                    { label: '4%', value: 4 },
                    { label: '5%', value: 5 },
                    { label: '6%', value: 6 },
                  ]}
                />
                <ValueField
                  label="Post-withdrawal return (p.a.)"
                  value={postRetirementReturn}
                  onChange={(value) => markSaved({ postRetirementReturn: clamp(value, 0, 20) })}
                  suffix="%"
                  chips={[
                    { label: '5%', value: 5 },
                    { label: '6%', value: 6 },
                    { label: '7%', value: 7 },
                    { label: '8%', value: 8 },
                  ]}
                />
              </View>

              <TouchableOpacity style={styles.primaryButton} onPress={() => setScreenMode('home')}>
                <Text style={styles.primaryButtonText}>Apply plan</Text>
              </TouchableOpacity>
            </>
          )}

          <PortfolioDisclaimer />
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      <SipEditorModal
        mode={sipEditorMode}
        hasDetectedSip={detectedSip > 0}
        detectedSip={detectedSip}
        detectedDetails={reviewSipDetails}
        detectedDetailsTitle={reviewSipDetailsTitle}
        fundNameById={fundNameById}
        currentSip={currentSip}
        draft={sipDraft}
        setDraft={setSipDraft}
        onClose={() => setSipEditorMode(null)}
        onUseDetected={() => {
          if (detectedSip > 0) {
            updateWealthJourney({ currentSipOverride: null });
          }
          setSipEditorMode(null);
        }}
        onManual={() => setSipEditorMode('manual')}
        onSaveManual={saveSipDraft}
      />
    </ClearLensScreen>
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
  keyboardScreen: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroCopy: {
    gap: 4,
  },
  heroEyebrow: {
    ...ClearLensTypography.label,
    color: cl.emerald,
    textTransform: 'uppercase',
  },
  heroTitle: {
    ...ClearLensTypography.h1,
    color: cl.navy,
  },
  heroSubtitle: {
    ...ClearLensTypography.body,
    color: cl.textSecondary,
  },
  snapshotCard: {
    gap: ClearLensSpacing.md,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.sm,
  },
  flexCopy: {
    flex: 1,
    gap: 2,
  },
  sectionTitle: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  sectionSubtitle: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
  },
  editButton: {
    minHeight: 32,
    borderRadius: ClearLensRadii.full,
    paddingHorizontal: ClearLensSpacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: cl.mint50,
  },
  editButtonText: {
    ...ClearLensTypography.caption,
    color: cl.emeraldDeep,
    fontFamily: ClearLensFonts.bold,
  },
  snapshotGrid: {
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
    paddingTop: ClearLensSpacing.sm,
    borderTopWidth: 1,
    borderTopColor: cl.borderLight,
  },
  snapshotMetric: {
    flex: 1,
    gap: 4,
  },
  metricLabel: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    textTransform: 'uppercase',
  },
  snapshotValue: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  positiveText: {
    color: tokens.semantic.sentiment.positive,
  },
  negativeText: {
    color: tokens.semantic.sentiment.negative,
  },
  infoBanner: {
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.mint50,
    padding: ClearLensSpacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.xs,
  },
  infoBannerText: {
    ...ClearLensTypography.caption,
    flex: 1,
    color: cl.textSecondary,
  },
  inlineLink: {
    ...ClearLensTypography.caption,
    color: cl.emeraldDeep,
    fontFamily: ClearLensFonts.bold,
  },
  planHeader: {
    gap: ClearLensSpacing.sm,
  },
  resultCard: {
    gap: ClearLensSpacing.md,
    overflow: 'hidden',
  },
  chartPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultHero: {
    ...ClearLensTypography.hero,
    color: cl.navy,
  },
  badge: {
    borderRadius: ClearLensRadii.full,
    paddingHorizontal: ClearLensSpacing.sm,
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: cl.mint50,
  },
  badgeDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: cl.emerald,
  },
  badgeText: {
    ...ClearLensTypography.caption,
    color: cl.emeraldDeep,
    fontFamily: ClearLensFonts.bold,
  },
  chartAxisText: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  pointerLabel: {
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.surface,
    borderWidth: 1,
    borderColor: cl.border,
    padding: ClearLensSpacing.sm,
    ...ClearLensShadow,
  },
  pointerDate: {
    ...ClearLensTypography.caption,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  pointerSeriesText: {
    ...ClearLensTypography.caption,
    color: cl.textSecondary,
  },
  legendRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: ClearLensSpacing.md,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLine: {
    width: 12,
    height: 2,
    borderRadius: 1,
  },
  legendText: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  milestoneGrid: {
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
    paddingTop: ClearLensSpacing.md,
    borderTopWidth: 1,
    borderTopColor: cl.borderLight,
  },
  milestoneCell: {
    flex: 1,
    gap: 4,
  },
  milestoneValue: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  rightMetric: {
    alignItems: 'flex-end',
  },
  largeMetric: {
    ...ClearLensTypography.h2,
    color: cl.navy,
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: ClearLensRadii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.emerald,
    paddingHorizontal: ClearLensSpacing.md,
  },
  primaryButtonText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textOnDark,
    fontFamily: ClearLensFonts.bold,
  },
  exploreToolsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: ClearLensSpacing.xs,
    paddingVertical: ClearLensSpacing.sm,
  },
  exploreToolsLabel: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
    fontFamily: ClearLensFonts.semiBold,
  },
  secondaryButton: {
    minHeight: 44,
    borderRadius: ClearLensRadii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: cl.surface,
    borderWidth: 1,
    borderColor: cl.border,
    paddingHorizontal: ClearLensSpacing.md,
  },
  secondaryButtonText: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  textButton: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  textButtonText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
    fontFamily: ClearLensFonts.semiBold,
  },
  centerSubtitle: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
    textAlign: 'center',
  },
  formSection: {
    gap: ClearLensSpacing.md,
  },
  formSectionTitle: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    textTransform: 'uppercase',
  },
  fieldBlock: {
    gap: ClearLensSpacing.sm,
  },
  fieldHeader: {
    gap: 2,
  },
  fieldLabel: {
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
    fontFamily: ClearLensFonts.medium,
  },
  fieldHelper: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  fieldShell: {
    minHeight: 48,
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.surface,
    borderWidth: 1,
    borderColor: cl.border,
    paddingHorizontal: ClearLensSpacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.xs,
  },
  fieldInput: {
    ...ClearLensTypography.h3,
    flex: 1,
    color: cl.navy,
    paddingVertical: 0,
  },
  fieldAffix: {
    ...ClearLensTypography.bodySmall,
    color: cl.textTertiary,
    fontFamily: ClearLensFonts.semiBold,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: ClearLensSpacing.xs,
  },
  choiceChip: {
    minHeight: 36,
    borderRadius: ClearLensRadii.full,
    borderWidth: 1,
    borderColor: cl.border,
    backgroundColor: cl.surface,
    paddingHorizontal: ClearLensSpacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceChipActive: {
    backgroundColor: cl.mint50,
    borderColor: cl.emerald,
  },
  choiceChipText: {
    ...ClearLensTypography.caption,
    color: cl.textSecondary,
    fontFamily: ClearLensFonts.bold,
  },
  choiceChipTextActive: {
    color: cl.emeraldDeep,
  },
  returnGrid: {
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
  },
  returnCard: {
    flex: 1,
    minHeight: 56,
    borderRadius: ClearLensRadii.md,
    borderWidth: 1,
    borderColor: cl.border,
    backgroundColor: cl.surface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  returnCardActive: {
    backgroundColor: cl.mint50,
    borderColor: cl.emerald,
  },
  returnCardLabel: {
    ...ClearLensTypography.caption,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  returnCardValue: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  returnCardLabelActive: {
    color: cl.emeraldDeep,
  },
  twoColumnGrid: {
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
  },
  resultRows: {
    gap: ClearLensSpacing.sm,
    paddingTop: ClearLensSpacing.md,
    borderTopWidth: 1,
    borderTopColor: cl.borderLight,
  },
  withdrawalMetricGrid: {
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
  },
  withdrawalSummaryTop: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: ClearLensSpacing.md,
  },
  withdrawalSummaryMetric: {
    flex: 1,
    minWidth: 140,
    gap: 3,
  },
  withdrawalSummaryMetricRight: {
    alignItems: 'flex-end',
  },
  withdrawalMetricBox: {
    flex: 1,
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.surfaceSoft,
    padding: ClearLensSpacing.sm,
    gap: 3,
  },
  withdrawalIncomeBox: {
    backgroundColor: cl.mint50,
  },
  withdrawalDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.md,
    paddingTop: ClearLensSpacing.md,
    borderTopWidth: 1,
    borderTopColor: cl.borderLight,
  },
  resultRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.md,
  },
  resultRowLabel: {
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
  },
  resultRowValue: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  disclaimer: {
    flexDirection: 'row',
    gap: ClearLensSpacing.xs,
    alignItems: 'flex-start',
    paddingHorizontal: ClearLensSpacing.xs,
  },
  disclaimerText: {
    ...ClearLensTypography.caption,
    flex: 1,
    color: cl.textTertiary,
  },
  projectionNote: {
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.mint50,
    padding: ClearLensSpacing.md,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: ClearLensSpacing.sm,
  },
  inlineStrong: {
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: tokens.semantic.overlay.backdrop,
    justifyContent: 'flex-end',
  },
  modalKeyboardView: {
    width: '100%',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    maxHeight: '88%',
    borderTopLeftRadius: ClearLensRadii.xl,
    borderTopRightRadius: ClearLensRadii.xl,
    backgroundColor: cl.surface,
    ...ClearLensShadow,
  },
  sheetHeader: {
    minHeight: 56,
    paddingHorizontal: ClearLensSpacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: cl.borderLight,
  },
  sheetTitle: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: ClearLensRadii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetBody: {
    padding: ClearLensSpacing.md,
    gap: ClearLensSpacing.sm,
  },
  sheetScrollBody: {
    flexGrow: 0,
    flexShrink: 1,
  },
  sheetCopy: {
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
  },
  sheetFinePrint: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  sheetSectionTitle: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    textTransform: 'uppercase',
  },
  detectedBox: {
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.surfaceSoft,
    padding: ClearLensSpacing.sm,
    gap: ClearLensSpacing.xs,
  },
  detectedValue: {
    ...ClearLensTypography.h2,
    color: cl.navy,
  },
  recurringList: {
    gap: ClearLensSpacing.xs,
  },
  recurringRow: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.md,
  },
  recurringRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: cl.borderLight,
  },
  recurringName: {
    ...ClearLensTypography.bodySmall,
    flex: 1,
    color: cl.navy,
  },
  recurringValue: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  recurringMore: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  sheetActions: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: ClearLensSpacing.sm,
  },
  sheetActionItem: {
    flex: 1,
  },
});
}
