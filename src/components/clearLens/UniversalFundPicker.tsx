/**
 * UniversalFundPicker — bottom-sheet picker that searches the full
 * scheme_master catalog (~37k schemes after the M3v2 seed). Pinned "Your
 * funds" section at the top until the user types ≥2 chars; then the search
 * takes over.
 *
 * Used by Compare Funds (multi-select, max 3) and (in the follow-up PR) Past
 * SIP Check (single-select). Pass `mode='single'` for a radio-style picker
 * that auto-closes on selection; `mode='multi'` keeps the sheet open.
 */
import { useEffect, useMemo, useState } from 'react';
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
  fetchUserHeldSchemes,
  searchSchemes,
  type SchemeSearchResult,
} from '@/src/utils/fundSearch';

const SEARCH_DEBOUNCE_MS = 180;
const PAGE_SIZE = 25;

export interface UniversalFundPickerProps {
  visible: boolean;
  /** Currently-selected scheme codes (for chip / checkmark state). */
  selectedCodes: number[];
  /** Selection mode. 'single' auto-closes the sheet on pick. */
  mode: 'single' | 'multi';
  /** Cap on selection — only relevant for `mode='multi'`. */
  maxFunds?: number;
  /** Called when the user picks/unpicks a scheme. */
  onToggle: (scheme: SchemeSearchResult) => void;
  /** Close handler. */
  onClose: () => void;
  /** Optional title override. */
  title?: string;
}

export function UniversalFundPicker({
  visible,
  selectedCodes,
  mode,
  maxFunds,
  onToggle,
  onClose,
  title,
}: UniversalFundPickerProps) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const { session } = useSession();
  const userId = session?.user.id ?? null;

  const [rawQuery, setRawQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState(0);

  // Debounce the search input
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedQuery(rawQuery);
      setPage(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [rawQuery]);

  // Reset state when the sheet closes so reopening is clean
  useEffect(() => {
    if (!visible) {
      setRawQuery('');
      setDebouncedQuery('');
      setPage(0);
    }
  }, [visible]);

  const yourFundsQuery = useQuery({
    queryKey: ['universal-picker:your-funds', userId],
    enabled: !!userId && visible,
    queryFn: () => (userId ? fetchUserHeldSchemes(userId) : Promise.resolve([] as SchemeSearchResult[])),
    staleTime: 5 * 60 * 1000,
  });

  const searchQuery = useQuery({
    queryKey: ['universal-picker:search', debouncedQuery, page],
    enabled: visible,
    queryFn: () =>
      searchSchemes({
        query: debouncedQuery,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
      }),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });

  const trimmed = debouncedQuery.trim();
  const showYourFunds =
    trimmed.length < 2 && (yourFundsQuery.data?.length ?? 0) > 0;

  const renderRow = (scheme: SchemeSearchResult) => {
    const isSelected = selectedCodes.includes(scheme.schemeCode);
    const atCap =
      mode === 'multi' && !isSelected && maxFunds != null && selectedCodes.length >= maxFunds;
    const disabled = atCap;
    return (
      <TouchableOpacity
        key={scheme.schemeCode}
        style={[
          styles.row,
          isSelected && styles.rowSelected,
          disabled && styles.rowDisabled,
        ]}
        disabled={disabled}
        onPress={() => onToggle(scheme)}
        activeOpacity={0.76}
        accessibilityRole={mode === 'multi' ? 'checkbox' : 'radio'}
        accessibilityState={{ checked: isSelected, disabled: !!disabled }}
      >
        {/* Toggle sits on the LEFT, colocated with the name the user reads, so
            on wide desktop rows you don't have to track all the way right. */}
        {mode === 'multi' ? (
          <View style={[styles.checkbox, isSelected && styles.checkboxActive]}>
            {isSelected && <Ionicons name="checkmark" size={14} color={tokens.colors.textOnDark} />}
          </View>
        ) : (
          <View style={[styles.radio, isSelected && styles.radioActive]}>
            {isSelected && <View style={styles.radioInner} />}
          </View>
        )}
        <View style={styles.rowLeft}>
          <Text
            style={[styles.rowName, disabled && styles.rowNameDisabled]}
            numberOfLines={2}
          >
            {scheme.schemeName}
          </Text>
          {(scheme.schemeCategory || scheme.amcName) && (
            <Text style={styles.rowSub} numberOfLines={1}>
              {[scheme.schemeCategory, scheme.amcName].filter(Boolean).join(' · ')}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <Text style={styles.title}>{title ?? 'Pick a fund'}</Text>
            {mode === 'multi' && maxFunds != null ? (
              <Text style={styles.headerSub}>{`${selectedCodes.length} of ${maxFunds} selected`}</Text>
            ) : null}
          </View>

          <View style={styles.searchBar}>
            <Ionicons
              name="search"
              size={16}
              color={tokens.colors.textTertiary}
              style={styles.searchIcon}
            />
            <TextInput
              style={styles.searchInput}
              placeholder="Search fund, AMC or category…"
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

          <ScrollView
            style={styles.list}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {showYourFunds ? (
              <>
                <Text style={styles.sectionLabel}>Your funds</Text>
                {yourFundsQuery.data?.map(renderRow)}
              </>
            ) : null}

            {trimmed.length >= 2 || !showYourFunds ? (
              <>
                <Text style={styles.sectionLabel}>
                  {trimmed.length >= 2 ? `Results for “${trimmed}”` : 'All funds'}
                </Text>
                {searchQuery.isLoading && !searchQuery.data ? (
                  <View style={styles.center}>
                    <ActivityIndicator color={tokens.colors.emerald} />
                  </View>
                ) : (searchQuery.data?.length ?? 0) === 0 ? (
                  <Text style={styles.empty}>No funds found.</Text>
                ) : (
                  <>
                    {searchQuery.data!.map(renderRow)}
                    {searchQuery.data!.length === PAGE_SIZE ? (
                      <TouchableOpacity
                        style={styles.loadMore}
                        onPress={() => setPage((p) => p + 1)}
                        activeOpacity={0.76}
                      >
                        <Text style={styles.loadMoreText}>Load more</Text>
                      </TouchableOpacity>
                    ) : null}
                    {page > 0 ? (
                      <TouchableOpacity
                        style={styles.loadMore}
                        onPress={() => setPage(0)}
                        activeOpacity={0.76}
                      >
                        <Text style={styles.loadMoreSecondaryText}>Back to start</Text>
                      </TouchableOpacity>
                    ) : null}
                  </>
                )}
              </>
            ) : null}
          </ScrollView>

          <TouchableOpacity style={styles.doneBtn} onPress={onClose} activeOpacity={0.82}>
            <Text style={styles.doneBtnText}>Done</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function makeStyles(tokens: ClearLensTokens) {
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
      paddingBottom: ClearLensSpacing.sm,
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
