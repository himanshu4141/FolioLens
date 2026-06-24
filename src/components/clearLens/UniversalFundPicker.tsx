/**
 * UniversalFundPicker — bottom-sheet picker for the full scheme_master catalog.
 *
 * Two modes:
 *   - mode='multi' (Compare Funds): **family-first** picker. Shows one row per
 *     fund family (of_family_id), collapsing ~8,347 plan variants to ~2,046
 *     logical funds. A global "Direct · Growth" toggle at the top resolves
 *     every selected family to a concrete scheme_code. A per-family chip in the
 *     selected-section lets users override one fund's plan/option independently.
 *     Graceful fallback label ("Regular-only", "IDCW-only") shown when a family
 *     lacks the chosen plan.
 *
 *   - mode='single' (Past SIP Check): plan-level picker. One row per AMFI
 *     scheme code. Auto-closes on selection.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { useSession } from '@/src/hooks/useSession';
import {
  fetchFamilyPlans,
  fetchUserHeldFamilies,
  fetchUserHeldSchemes,
  resolveFamilyToScheme,
  searchFamilies,
  searchSchemes,
  type FamilyPlan,
  type FamilyResolution,
  type FamilySearchResult,
  type PlanPreference,
  type SchemeSearchResult,
} from '@/src/utils/fundSearch';
import { fundComparisonCategory } from '@/src/utils/schemeName';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEARCH_DEBOUNCE_MS = 180;
const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Internal state for one selected family in the multi-mode picker. */
interface SelectedFamily {
  family: FamilySearchResult;
  /** All plans for this family (fetched when selected). */
  plans: FamilyPlan[];
  /**
   * Per-family override. null = use global toggle.
   * Stored so a per-chip change doesn't reset the global.
   */
  override: PlanPreference | null;
}

export interface UniversalFundPickerProps {
  visible: boolean;
  /** Currently-selected scheme codes. Used to initialize multi-mode state. */
  selectedCodes: number[];
  /** Selection mode. 'single' auto-closes the sheet on pick. */
  mode: 'single' | 'multi';
  /** Cap on selection — only relevant for `mode='multi'`. */
  maxFunds?: number;
  /**
   * mode='single': called when user picks / unpicks a scheme.
   * (multi mode uses onCodesChange instead.)
   */
  onToggle?: (scheme: SchemeSearchResult) => void;
  /**
   * mode='multi': called when the set of resolved scheme codes changes
   * (family added/removed, or global/per-fund toggle changed).
   */
  onCodesChange?: (codes: number[]) => void;
  /** Close handler. */
  onClose: () => void;
  /** Optional title override. */
  title?: string;
}

// ---------------------------------------------------------------------------
// Plan toggle option data
// ---------------------------------------------------------------------------

const PLAN_OPTIONS = [
  { value: 'direct' as const, label: 'Direct' },
  { value: 'regular' as const, label: 'Regular' },
];
const OPTION_OPTIONS = [
  { value: 'growth' as const, label: 'Growth' },
  { value: 'idcw' as const, label: 'IDCW' },
];

// ---------------------------------------------------------------------------
// Helper: label for override chip
// ---------------------------------------------------------------------------

function overrideChipLabel(pref: PlanPreference): string {
  const plan = pref.planType === 'direct' ? 'Direct' : 'Regular';
  const option = pref.optionType === 'growth' ? 'Growth' : 'IDCW';
  return `${plan} · ${option}`;
}

function fallbackLabel(res: FamilyResolution | null, _global: PlanPreference): string | null {
  if (!res?.isFallback) return null;
  return res.fallbackReason;
}

// ---------------------------------------------------------------------------
// FamilyRow — one row in the multi-mode family search results
// ---------------------------------------------------------------------------

function FamilyRow({
  family,
  isSelected,
  disabled,
  resolution,
  onPress,
  tokens,
}: {
  family: FamilySearchResult;
  isSelected: boolean;
  disabled: boolean;
  resolution: FamilyResolution | null;
  onPress: () => void;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  const categoryLabel = fundComparisonCategory(family.sebiCategory, family.schemeCategory);
  const fallback = fallbackLabel(resolution, { planType: 'direct', optionType: 'growth' });

  return (
    <TouchableOpacity
      style={[
        styles(tokens).row,
        isSelected && styles(tokens).rowSelected,
        disabled && styles(tokens).rowDisabled,
      ]}
      disabled={disabled}
      onPress={onPress}
      activeOpacity={0.76}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: isSelected, disabled }}
    >
      <View style={[styles(tokens).checkbox, isSelected && styles(tokens).checkboxActive]}>
        {isSelected && <Ionicons name="checkmark" size={14} color={cl.textOnDark} />}
      </View>
      <View style={styles(tokens).rowLeft}>
        <Text style={[styles(tokens).rowName, disabled && styles(tokens).rowNameDisabled]} numberOfLines={2}>
          {family.familyName ?? '—'}
        </Text>
        <Text style={styles(tokens).rowSub} numberOfLines={1}>
          {[categoryLabel, family.amcName].filter(Boolean).join(' · ')}
        </Text>
        {fallback ? (
          <Text style={[styles(tokens).rowSub, { color: cl.warning ?? cl.textTertiary }]} numberOfLines={1}>
            {fallback}
          </Text>
        ) : null}
        {!family.familyActive ? (
          <Text style={[styles(tokens).rowSub, { color: cl.textTertiary }]} numberOfLines={1}>
            Matured / inactive
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// SelectedFamilyChip — a chip for the selected family with override control
// ---------------------------------------------------------------------------

function SelectedFamilyChip({
  item,
  globalPref,
  onRemove,
  onOverrideCycle,
  tokens,
}: {
  item: SelectedFamily;
  globalPref: PlanPreference;
  onRemove: () => void;
  onOverrideCycle: () => void;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;
  const pref = item.override ?? globalPref;
  const resolution = resolveFamilyToScheme(item.plans, pref);
  const chipLabel = overrideChipLabel(pref);
  const isFallback = resolution?.isFallback ?? false;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: ClearLensSpacing.xs,
        backgroundColor: cl.surfaceSoft,
        borderRadius: ClearLensRadii.md,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: cl.borderLight,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 12, fontFamily: ClearLensFonts.semiBold, color: cl.navy }} numberOfLines={1}>
          {item.family.familyName ?? '—'}
        </Text>
        {isFallback && resolution?.fallbackReason ? (
          <Text style={{ fontSize: 10, fontFamily: ClearLensFonts.medium, color: cl.warning ?? cl.textTertiary }}>
            {resolution.fallbackReason}
          </Text>
        ) : null}
      </View>
      {/* Per-fund plan/option override toggle chip */}
      <TouchableOpacity
        onPress={onOverrideCycle}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 3,
          backgroundColor: item.override ? cl.mint50 ?? cl.surfaceSoft : cl.surface,
          borderRadius: ClearLensRadii.sm,
          paddingHorizontal: 7,
          paddingVertical: 3,
          borderWidth: 1,
          borderColor: item.override ? cl.emerald : cl.border,
        }}
        accessibilityLabel={`Change plan for ${item.family.familyName ?? 'this fund'}`}
      >
        <Text style={{ fontSize: 10, fontFamily: ClearLensFonts.bold, color: item.override ? cl.emeraldDeep : cl.textTertiary }}>
          {chipLabel}
        </Text>
        <Ionicons name="swap-horizontal" size={9} color={item.override ? cl.emeraldDeep : cl.textTertiary} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onRemove}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}
        accessibilityLabel={`Remove ${item.family.familyName ?? 'fund'}`}
      >
        <Ionicons name="close" size={13} color={cl.textTertiary} />
      </TouchableOpacity>
    </View>
  );
}

// ---------------------------------------------------------------------------
// GlobalToggle — Direct/Regular × Growth/IDCW
// ---------------------------------------------------------------------------

function GlobalToggle({
  planType,
  optionType,
  onPlanChange,
  onOptionChange,
  tokens,
}: {
  planType: 'direct' | 'regular';
  optionType: 'growth' | 'idcw';
  onPlanChange: (v: 'direct' | 'regular') => void;
  onOptionChange: (v: 'growth' | 'idcw') => void;
  tokens: ClearLensTokens;
}) {
  const cl = tokens.colors;

  const renderSegment = <T extends string>(
    options: { value: T; label: string }[],
    value: T,
    onChange: (v: T) => void,
  ) => (
    <View style={{ flexDirection: 'row', gap: 1 }}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <TouchableOpacity
            key={opt.value}
            onPress={() => onChange(opt.value)}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: ClearLensRadii.sm,
              backgroundColor: active ? cl.emerald : cl.surfaceSoft,
              borderWidth: 1,
              borderColor: active ? cl.emerald : cl.borderLight,
              minHeight: 30,
              alignItems: 'center',
              justifyContent: 'center',
            }}
            activeOpacity={0.76}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
            accessibilityLabel={opt.label}
          >
            <Text
              style={{
                fontSize: 11,
                fontFamily: active ? ClearLensFonts.bold : ClearLensFonts.medium,
                color: active ? cl.textOnDark : cl.textSecondary,
              }}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: ClearLensSpacing.sm,
        paddingVertical: ClearLensSpacing.xs,
      }}
    >
      <Text
        style={{
          fontSize: 11,
          fontFamily: ClearLensFonts.bold,
          color: cl.textTertiary,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
        }}
      >
        Comparing:
      </Text>
      {renderSegment(PLAN_OPTIONS, planType, onPlanChange)}
      <Text style={{ fontSize: 11, fontFamily: ClearLensFonts.medium, color: cl.textTertiary }}>·</Text>
      {renderSegment(OPTION_OPTIONS, optionType, onOptionChange)}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Cycle helper for per-fund override
// ---------------------------------------------------------------------------

/** Cycles through all combos the family actually has, or all 4 combos as fallback. */
function cycleOverride(
  current: PlanPreference | null,
  family: FamilySearchResult,
  global: PlanPreference,
): PlanPreference | null {
  const combos: PlanPreference[] = [
    { planType: 'direct' as const, optionType: 'growth' as const },
    { planType: 'regular' as const, optionType: 'growth' as const },
    { planType: 'direct' as const, optionType: 'idcw' as const },
    { planType: 'regular' as const, optionType: 'idcw' as const },
  ].filter((c) => {
    if (c.planType === 'direct' && !family.hasDirect) return false;
    if (c.planType === 'regular' && !family.hasRegular) return false;
    if (c.optionType === 'growth' && !family.hasGrowth) return false;
    if (c.optionType === 'idcw' && !family.hasIdcw) return false;
    return true;
  });

  // If no combos known (rare — family flags all false), allow all 4.
  const available = combos.length > 0 ? combos : [
    { planType: 'direct' as const, optionType: 'growth' as const },
    { planType: 'regular' as const, optionType: 'growth' as const },
    { planType: 'direct' as const, optionType: 'idcw' as const },
    { planType: 'regular' as const, optionType: 'idcw' as const },
  ];

  const active = current ?? global;
  const idx = available.findIndex(
    (c) => c.planType === active.planType && c.optionType === active.optionType,
  );
  const next = available[(idx + 1) % available.length];

  // If we've cycled back to the global preference, clear the override.
  if (next.planType === global.planType && next.optionType === global.optionType) return null;
  return next;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function UniversalFundPicker({
  visible,
  selectedCodes,
  mode,
  maxFunds,
  onToggle,
  onCodesChange,
  onClose,
  title,
}: UniversalFundPickerProps) {
  const tokens = useClearLensTokens();
  const { session } = useSession();
  const userId = session?.user.id ?? null;

  // --- shared search state ---
  const [rawQuery, setRawQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState(0);

  // --- multi-mode family state ---
  const [selectedFamilies, setSelectedFamilies] = useState<SelectedFamily[]>([]);
  const [globalPlanType, setGlobalPlanType] = useState<'direct' | 'regular'>('direct');
  const [globalOptionType, setGlobalOptionType] = useState<'growth' | 'idcw'>('growth');

  // Tracks whether we've already initialized family state from selectedCodes on open.
  const initializedForCodes = useRef<number[] | null>(null);

  // Debounce the search input.
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedQuery(rawQuery);
      setPage(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [rawQuery]);

  // Reset query/page when the sheet closes.
  useEffect(() => {
    if (!visible) {
      setRawQuery('');
      setDebouncedQuery('');
      setPage(0);
      // Do NOT reset selectedFamilies / globalPlanType — they persist across open/close.
      // Reset the init guard so we re-sync on next open.
      initializedForCodes.current = null;
    }
  }, [visible]);

  // ---------------------------------------------------------------------------
  // Compute resolved codes from selected families + toggles + overrides.
  // Emit via onCodesChange whenever this set changes.
  // ---------------------------------------------------------------------------
  const globalPref = useMemo<PlanPreference>(
    () => ({ planType: globalPlanType, optionType: globalOptionType }),
    [globalPlanType, globalOptionType],
  );

  const resolvedCodes = useMemo<number[]>(() => {
    return selectedFamilies
      .map((item) => {
        const pref = item.override ?? globalPref;
        const res = resolveFamilyToScheme(item.plans, pref);
        return res?.schemeCode ?? item.family.representativeSchemeCode;
      });
  }, [selectedFamilies, globalPref]);

  // Emit resolved codes when they change (multi mode only).
  const lastEmitted = useRef<number[]>([]);
  useEffect(() => {
    if (mode !== 'multi' || !onCodesChange) return;
    const same =
      resolvedCodes.length === lastEmitted.current.length &&
      resolvedCodes.every((c, i) => c === lastEmitted.current[i]);
    if (same) return;
    lastEmitted.current = resolvedCodes;
    onCodesChange(resolvedCodes);
  }, [resolvedCodes, mode, onCodesChange]);

  // ---------------------------------------------------------------------------
  // On open: sync selectedFamilies from selectedCodes when they don't match.
  // This handles the case where the parent removed a fund outside the picker.
  // ---------------------------------------------------------------------------
  const syncFromSelectedCodesQuery = useQuery({
    queryKey: ['universal-picker:sync-families', selectedCodes.slice().sort().join(',')],
    enabled:
      visible &&
      mode === 'multi' &&
      selectedCodes.length > 0 &&
      JSON.stringify(initializedForCodes.current?.slice().sort()) !==
        JSON.stringify(selectedCodes.slice().sort()),
    queryFn: async () => {
      // Look up of_family_id + plan data for the given scheme codes.
      const { schemeMasterRepo } = await import('@/src/lib/data/schemeMaster');
      const { data, error } = await schemeMasterRepo
        .from()
        .select('scheme_code, of_family_id, plan_type, option_type')
        .in('scheme_code', selectedCodes);
      if (error) throw error;
      return (data ?? []) as unknown as {
        scheme_code: number;
        of_family_id: string | null;
        plan_type: string | null;
        option_type: string | null;
      }[];
    },
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!syncFromSelectedCodesQuery.data || mode !== 'multi') return;
    const rows = syncFromSelectedCodesQuery.data;
    // If all selected codes map to families already in selectedFamilies, no action needed.
    const existingFamilyIds = new Set(selectedFamilies.map((s) => s.family.ofFamilyId));
    const incomingFamilyIds = new Set(
      rows.map((r) => r.of_family_id).filter((id): id is string => id != null),
    );
    // Remove families whose resolved code is no longer in selectedCodes.
    const codesSet = new Set(selectedCodes);
    setSelectedFamilies((prev) =>
      prev.filter((item) => {
        const pref = item.override ?? globalPref;
        const res = resolveFamilyToScheme(item.plans, pref);
        const code = res?.schemeCode ?? item.family.representativeSchemeCode;
        return codesSet.has(code);
      }),
    );
    initializedForCodes.current = selectedCodes;
    void existingFamilyIds; // suppress unused warning
    void incomingFamilyIds;
  }, [syncFromSelectedCodesQuery.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Fetch plans for a family when the user selects it.
  // ---------------------------------------------------------------------------
  const [pendingFamilyForPlans, setPendingFamilyForPlans] = useState<FamilySearchResult | null>(null);

  const familyPlansQuery = useQuery({
    queryKey: ['universal-picker:family-plans', pendingFamilyForPlans?.ofFamilyId ?? ''],
    enabled: !!pendingFamilyForPlans,
    queryFn: () => fetchFamilyPlans(pendingFamilyForPlans!.ofFamilyId),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!familyPlansQuery.data || !pendingFamilyForPlans) return;
    const plans = familyPlansQuery.data;
    const family = pendingFamilyForPlans;
    setSelectedFamilies((prev) => {
      // If already in the list, update plans (shouldn't normally happen).
      if (prev.some((s) => s.family.ofFamilyId === family.ofFamilyId)) {
        return prev.map((s) =>
          s.family.ofFamilyId === family.ofFamilyId ? { ...s, plans } : s,
        );
      }
      return [...prev, { family, plans, override: null }];
    });
    setPendingFamilyForPlans(null);
  }, [familyPlansQuery.data, pendingFamilyForPlans]);

  // ---------------------------------------------------------------------------
  // Queries — "Your funds" sections
  // ---------------------------------------------------------------------------

  const yourFamiliesQuery = useQuery({
    queryKey: ['universal-picker:your-families', userId],
    enabled: !!userId && visible && mode === 'multi',
    queryFn: () => (userId ? fetchUserHeldFamilies(userId) : Promise.resolve([] as FamilySearchResult[])),
    staleTime: 5 * 60_000,
  });

  const yourFundsQuery = useQuery({
    queryKey: ['universal-picker:your-funds', userId],
    enabled: !!userId && visible && mode === 'single',
    queryFn: () => (userId ? fetchUserHeldSchemes(userId) : Promise.resolve([] as SchemeSearchResult[])),
    staleTime: 5 * 60_000,
  });

  // ---------------------------------------------------------------------------
  // Queries — Search results
  // ---------------------------------------------------------------------------

  const familySearchQuery = useQuery({
    queryKey: ['universal-picker:family-search', debouncedQuery, page],
    enabled: visible && mode === 'multi',
    queryFn: () => searchFamilies({ query: debouncedQuery, offset: page * PAGE_SIZE, limit: PAGE_SIZE }),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });

  const schemeSearchQuery = useQuery({
    queryKey: ['universal-picker:search', debouncedQuery, page],
    enabled: visible && mode === 'single',
    queryFn: () => searchSchemes({ query: debouncedQuery, offset: page * PAGE_SIZE, limit: PAGE_SIZE }),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });

  // ---------------------------------------------------------------------------
  // Handlers — multi-mode
  // ---------------------------------------------------------------------------

  const handleFamilyToggle = useCallback(
    (family: FamilySearchResult) => {
      const alreadySelected = selectedFamilies.some(
        (s) => s.family.ofFamilyId === family.ofFamilyId,
      );
      if (alreadySelected) {
        setSelectedFamilies((prev) =>
          prev.filter((s) => s.family.ofFamilyId !== family.ofFamilyId),
        );
      } else {
        if (maxFunds != null && selectedFamilies.length >= maxFunds) return;
        // Kick off plans fetch; family added to selectedFamilies when plans arrive.
        setPendingFamilyForPlans(family);
      }
    },
    [selectedFamilies, maxFunds],
  );

  const handleOverrideCycle = useCallback(
    (familyId: string) => {
      setSelectedFamilies((prev) =>
        prev.map((item) => {
          if (item.family.ofFamilyId !== familyId) return item;
          const nextOverride = cycleOverride(item.override, item.family, globalPref);
          return { ...item, override: nextOverride };
        }),
      );
    },
    [globalPref],
  );

  const handleFamilyRemove = useCallback(
    (familyId: string) => {
      setSelectedFamilies((prev) => prev.filter((s) => s.family.ofFamilyId !== familyId));
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const trimmed = debouncedQuery.trim();

  const renderSchemeRow = (scheme: SchemeSearchResult) => {
    const isSelected = selectedCodes.includes(scheme.schemeCode);
    const atCap = !isSelected && maxFunds != null && selectedCodes.length >= maxFunds;
    const disabled = atCap;
    return (
      <TouchableOpacity
        key={scheme.schemeCode}
        style={[
          styles(tokens).row,
          isSelected && styles(tokens).rowSelected,
          disabled && styles(tokens).rowDisabled,
        ]}
        disabled={disabled}
        onPress={() => onToggle?.(scheme)}
        activeOpacity={0.76}
        accessibilityRole={mode === 'multi' ? 'checkbox' : 'radio'}
        accessibilityState={{ checked: isSelected, disabled: !!disabled }}
      >
        {mode === 'multi' ? (
          <View style={[styles(tokens).checkbox, isSelected && styles(tokens).checkboxActive]}>
            {isSelected && <Ionicons name="checkmark" size={14} color={tokens.colors.textOnDark} />}
          </View>
        ) : (
          <View style={[styles(tokens).radio, isSelected && styles(tokens).radioActive]}>
            {isSelected && <View style={styles(tokens).radioInner} />}
          </View>
        )}
        <View style={styles(tokens).rowLeft}>
          <Text
            style={[styles(tokens).rowName, disabled && styles(tokens).rowNameDisabled]}
            numberOfLines={2}
          >
            {scheme.schemeName}
          </Text>
          {(scheme.schemeCategory || scheme.amcName) && (
            <Text style={styles(tokens).rowSub} numberOfLines={1}>
              {[scheme.schemeCategory, scheme.amcName].filter(Boolean).join(' · ')}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const selectedFamilyIds = new Set(selectedFamilies.map((s) => s.family.ofFamilyId));
  const atCapMulti = maxFunds != null && selectedFamilies.length >= maxFunds;
  const hasPendingFamilyLoad = !!pendingFamilyForPlans && familyPlansQuery.isLoading;

  const showYourFundsScheme = mode === 'single' && trimmed.length < 2 && (yourFundsQuery.data?.length ?? 0) > 0;
  const showYourFundsFamily = mode === 'multi' && trimmed.length < 2 && (yourFamiliesQuery.data?.length ?? 0) > 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles(tokens).backdrop} onPress={onClose}>
        <Pressable style={styles(tokens).sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles(tokens).handle} />

          {/* Header */}
          <View style={styles(tokens).header}>
            <Text style={styles(tokens).title}>{title ?? 'Pick a fund'}</Text>
            {mode === 'multi' && maxFunds != null ? (
              <Text style={styles(tokens).headerSub}>
                {`${selectedFamilies.length} of ${maxFunds} selected`}
              </Text>
            ) : null}
          </View>

          {/* Global plan/option toggle (multi mode only) */}
          {mode === 'multi' ? (
            <GlobalToggle
              planType={globalPlanType}
              optionType={globalOptionType}
              onPlanChange={setGlobalPlanType}
              onOptionChange={setGlobalOptionType}
              tokens={tokens}
            />
          ) : null}

          {/* Selected families strip (multi mode only) */}
          {mode === 'multi' && selectedFamilies.length > 0 ? (
            <View style={{ gap: ClearLensSpacing.xs, paddingTop: ClearLensSpacing.xs }}>
              {selectedFamilies.map((item) => (
                <SelectedFamilyChip
                  key={item.family.ofFamilyId}
                  item={item}
                  globalPref={globalPref}
                  onRemove={() => handleFamilyRemove(item.family.ofFamilyId)}
                  onOverrideCycle={() => handleOverrideCycle(item.family.ofFamilyId)}
                  tokens={tokens}
                />
              ))}
              {hasPendingFamilyLoad ? (
                <ActivityIndicator size="small" color={tokens.colors.emerald} style={{ alignSelf: 'flex-start', paddingLeft: 4 }} />
              ) : null}
            </View>
          ) : null}

          {/* Search bar */}
          <View style={styles(tokens).searchBar}>
            <Ionicons
              name="search"
              size={16}
              color={tokens.colors.textTertiary}
              style={styles(tokens).searchIcon}
            />
            <TextInput
              style={styles(tokens).searchInput}
              placeholder={mode === 'multi' ? 'Search fund or AMC…' : 'Search fund, AMC or category…'}
              placeholderTextColor={tokens.colors.textTertiary}
              value={rawQuery}
              onChangeText={setRawQuery}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
            />
            {rawQuery.length > 0 ? (
              <TouchableOpacity onPress={() => setRawQuery('')} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={tokens.colors.textTertiary} />
              </TouchableOpacity>
            ) : null}
          </View>

          {/* Results list */}
          <ScrollView
            style={styles(tokens).list}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* --- MULTI MODE: family-first --- */}
            {mode === 'multi' ? (
              <>
                {showYourFundsFamily ? (
                  <>
                    <Text style={styles(tokens).sectionLabel}>Your funds</Text>
                    {(yourFamiliesQuery.data ?? []).map((family) => {
                      const pref = globalPref;
                      const isSel = selectedFamilyIds.has(family.ofFamilyId);
                      const selItem = selectedFamilies.find((s) => s.family.ofFamilyId === family.ofFamilyId);
                      const activePref = selItem?.override ?? pref;
                      const resolution = isSel && selItem
                        ? resolveFamilyToScheme(selItem.plans, activePref)
                        : null;
                      return (
                        <FamilyRow
                          key={family.ofFamilyId}
                          family={family}
                          isSelected={isSel}
                          disabled={!isSel && atCapMulti}
                          resolution={resolution}
                          onPress={() => handleFamilyToggle(family)}
                          tokens={tokens}
                        />
                      );
                    })}
                  </>
                ) : null}

                {trimmed.length >= 2 || !showYourFundsFamily ? (
                  <>
                    <Text style={styles(tokens).sectionLabel}>
                      {trimmed.length >= 2 ? `Results for "${trimmed}"` : 'All funds'}
                    </Text>
                    {familySearchQuery.isLoading && !familySearchQuery.data ? (
                      <View style={styles(tokens).center}>
                        <ActivityIndicator color={tokens.colors.emerald} />
                      </View>
                    ) : (familySearchQuery.data?.length ?? 0) === 0 ? (
                      <Text style={styles(tokens).empty}>No funds found.</Text>
                    ) : (
                      <>
                        {(familySearchQuery.data ?? []).map((family) => {
                          const isSel = selectedFamilyIds.has(family.ofFamilyId);
                          const selItem = selectedFamilies.find(
                            (s) => s.family.ofFamilyId === family.ofFamilyId,
                          );
                          const activePref = selItem?.override ?? globalPref;
                          const resolution = isSel && selItem
                            ? resolveFamilyToScheme(selItem.plans, activePref)
                            : null;
                          return (
                            <FamilyRow
                              key={family.ofFamilyId}
                              family={family}
                              isSelected={isSel}
                              disabled={!isSel && atCapMulti}
                              resolution={resolution}
                              onPress={() => handleFamilyToggle(family)}
                              tokens={tokens}
                            />
                          );
                        })}
                        {(familySearchQuery.data?.length ?? 0) === PAGE_SIZE ? (
                          <TouchableOpacity
                            style={styles(tokens).loadMore}
                            onPress={() => setPage((p) => p + 1)}
                            activeOpacity={0.76}
                          >
                            <Text style={styles(tokens).loadMoreText}>Load more</Text>
                          </TouchableOpacity>
                        ) : null}
                        {page > 0 ? (
                          <TouchableOpacity
                            style={styles(tokens).loadMore}
                            onPress={() => setPage(0)}
                            activeOpacity={0.76}
                          >
                            <Text style={styles(tokens).loadMoreSecondaryText}>Back to start</Text>
                          </TouchableOpacity>
                        ) : null}
                      </>
                    )}
                  </>
                ) : null}
              </>
            ) : (
              /* --- SINGLE MODE: plan-level (existing) --- */
              <>
                {showYourFundsScheme ? (
                  <>
                    <Text style={styles(tokens).sectionLabel}>Your funds</Text>
                    {yourFundsQuery.data?.map(renderSchemeRow)}
                  </>
                ) : null}

                {trimmed.length >= 2 || !showYourFundsScheme ? (
                  <>
                    <Text style={styles(tokens).sectionLabel}>
                      {trimmed.length >= 2 ? `Results for "${trimmed}"` : 'All funds'}
                    </Text>
                    {schemeSearchQuery.isLoading && !schemeSearchQuery.data ? (
                      <View style={styles(tokens).center}>
                        <ActivityIndicator color={tokens.colors.emerald} />
                      </View>
                    ) : (schemeSearchQuery.data?.length ?? 0) === 0 ? (
                      <Text style={styles(tokens).empty}>No funds found.</Text>
                    ) : (
                      <>
                        {schemeSearchQuery.data!.map(renderSchemeRow)}
                        {schemeSearchQuery.data!.length === PAGE_SIZE ? (
                          <TouchableOpacity
                            style={styles(tokens).loadMore}
                            onPress={() => setPage((p) => p + 1)}
                            activeOpacity={0.76}
                          >
                            <Text style={styles(tokens).loadMoreText}>Load more</Text>
                          </TouchableOpacity>
                        ) : null}
                        {page > 0 ? (
                          <TouchableOpacity
                            style={styles(tokens).loadMore}
                            onPress={() => setPage(0)}
                            activeOpacity={0.76}
                          >
                            <Text style={styles(tokens).loadMoreSecondaryText}>Back to start</Text>
                          </TouchableOpacity>
                        ) : null}
                      </>
                    )}
                  </>
                ) : null}
              </>
            )}
          </ScrollView>

          <TouchableOpacity style={styles(tokens).doneBtn} onPress={onClose} activeOpacity={0.82}>
            <Text style={styles(tokens).doneBtnText}>Done</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Styles (function-based — takes tokens as arg to avoid closure over stale values)
// ---------------------------------------------------------------------------

function styles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
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
      maxHeight: '85%',
      minHeight: '50%',
    },
    handle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: cl.borderLight,
      alignSelf: 'center',
      marginBottom: ClearLensSpacing.sm,
    },
    header: {
      paddingTop: ClearLensSpacing.xs,
      paddingBottom: ClearLensSpacing.xs,
      gap: 2,
    },
    title: {
      ...ClearLensTypography.h3,
      color: cl.navy,
    },
    headerSub: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
    },
    searchBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.xs,
      paddingHorizontal: ClearLensSpacing.sm,
      paddingVertical: 8,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.surfaceSoft,
      borderWidth: 1,
      borderColor: cl.borderLight,
      marginTop: ClearLensSpacing.xs,
    },
    searchIcon: { paddingHorizontal: 2 },
    searchInput: {
      flex: 1,
      fontFamily: ClearLensFonts.regular,
      fontSize: 15,
      color: cl.textPrimary,
      paddingVertical: 0,
    },
    list: {
      marginTop: ClearLensSpacing.sm,
      flexGrow: 0,
    },
    sectionLabel: {
      ...ClearLensTypography.label,
      color: cl.textTertiary,
      letterSpacing: 0.4,
      paddingTop: ClearLensSpacing.sm,
      paddingBottom: ClearLensSpacing.xs,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      paddingVertical: ClearLensSpacing.sm + 2,
      paddingHorizontal: 2,
      borderBottomWidth: 1,
      borderBottomColor: cl.borderLight,
    },
    rowSelected: { backgroundColor: cl.surfaceSoft },
    rowDisabled: { opacity: 0.5 },
    rowLeft: { flex: 1, gap: 2 },
    rowName: { ...ClearLensTypography.body, color: cl.navy },
    rowNameDisabled: { color: cl.textTertiary },
    rowSub: { ...ClearLensTypography.caption, color: cl.textTertiary },

    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: cl.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkboxActive: {
      borderColor: cl.emerald,
      backgroundColor: cl.emerald,
    },
    radio: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 1.5,
      borderColor: cl.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    radioActive: {
      borderColor: cl.emerald,
    },
    radioInner: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: cl.emerald,
    },

    center: {
      paddingVertical: ClearLensSpacing.md,
      alignItems: 'center',
    },
    empty: {
      ...ClearLensTypography.bodySmall,
      color: cl.textTertiary,
      textAlign: 'center',
      paddingVertical: ClearLensSpacing.md,
    },
    loadMore: {
      alignItems: 'center',
      paddingVertical: ClearLensSpacing.sm + 2,
    },
    loadMoreText: {
      ...ClearLensTypography.bodySmall,
      color: cl.emerald,
      fontFamily: ClearLensFonts.semiBold,
    },
    loadMoreSecondaryText: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
    },
    doneBtn: {
      backgroundColor: cl.emerald,
      borderRadius: ClearLensRadii.md,
      paddingVertical: ClearLensSpacing.sm + 4,
      alignItems: 'center',
      marginTop: ClearLensSpacing.sm,
    },
    doneBtnText: {
      fontFamily: ClearLensFonts.semiBold,
      fontSize: 16,
      color: cl.textOnDark,
    },
  });
}
