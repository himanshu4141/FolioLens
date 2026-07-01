import { ReactNode, useMemo } from 'react';
import {
  Text,
  Pressable,
  TouchableOpacity,
  View,
  StyleSheet,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { FolioLensLogo } from '@/src/components/clearLens/FolioLensLogo';
import { useResponsiveLayout } from '@/src/components/responsive/useResponsiveLayout';

/**
 * When `desktopMaxWidth` is set and the viewport is desktop, the screen content
 * is constrained to that width and centered horizontally so screens that share
 * a single mobile-style column don't stretch across the desktop content area.
 *
 * Defaults to 960 — the "list" / single-column tier. Dashboard-style screens
 * (Portfolio, Funds) use their own desktop variants capped at MaxContentWidth
 * (1200) for grid-heavy layouts. 960 sits comfortably between a phone-width
 * reading column and a full dashboard frame.
 */
export function ClearLensScreen({
  children,
  desktopMaxWidth = 960,
}: {
  children: ReactNode;
  desktopMaxWidth?: number;
}) {
  const { layout } = useResponsiveLayout();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  if (layout === 'desktop') {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={[styles.desktopFrame, { maxWidth: desktopMaxWidth }]}>
          {children}
        </View>
      </SafeAreaView>
    );
  }
  return <SafeAreaView style={styles.screen}>{children}</SafeAreaView>;
}

export function ClearLensCard({
  children,
  style,
}: {
  children: ReactNode;
  style?: ViewStyle | ViewStyle[];
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return <View style={[styles.card, style]}>{children}</View>;
}

export function ClearLensHeader({
  onPressMenu,
  onPressBack,
  // `title` is accepted for backwards compat with callers still passing it,
  // but never rendered — every screen body owns its h1 to keep title
  // placement consistent across mobile and desktop.
  title: _title,
  showTagline = false,
  accountLabel,
  rightAction,
}: {
  onPressMenu?: () => void;
  onPressBack?: () => void;
  title?: string;
  showTagline?: boolean;
  accountLabel?: string | null;
  rightAction?: { icon: string; onPress: () => void; tint?: string };
}) {
  const accountInitial = getAccountInitial(accountLabel);
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const cl = tokens.colors;
  const { layout } = useResponsiveLayout();
  const isDesktop = layout === 'desktop';

  // On desktop the sidebar owns the logo + account, and each screen body
  // renders its own h1/title. Render the header only when a back button or
  // right action is present — and even then suppress the title to avoid the
  // duplicate-title pattern (e.g. centered "Money Trail" header above an h1
  // "Money Trail" inside the body). The bar becomes a slim chrome strip with
  // just the navigation affordance.
  if (isDesktop) {
    const hasNav = !!onPressBack || !!rightAction;
    if (!hasNav) return null;
    return (
      <View style={[styles.header, styles.headerDesktopChrome]}>
        {onPressBack ? (
          <TouchableOpacity onPress={onPressBack} style={styles.backChip} activeOpacity={0.7} accessibilityLabel="Go back">
            <Ionicons name="chevron-back" size={22} color={cl.navy} />
          </TouchableOpacity>
        ) : (
          <View style={styles.iconButtonGhost} />
        )}

        <View style={styles.headerSpacer} />

        {rightAction ? (
          <TouchableOpacity onPress={rightAction.onPress} style={styles.iconButton} activeOpacity={0.7}>
            <Ionicons name={rightAction.icon as never} size={22} color={rightAction.tint ?? cl.navy} />
          </TouchableOpacity>
        ) : (
          <View style={styles.iconButtonGhost} />
        )}
      </View>
    );
  }

  return (
    <View style={styles.header}>
      {onPressBack ? (
        <TouchableOpacity onPress={onPressBack} style={styles.backChip} activeOpacity={0.7} accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={22} color={cl.navy} />
        </TouchableOpacity>
      ) : (
        <FolioLensLogo size={34} showTagline={showTagline} />
      )}

      <View style={styles.headerSpacer} />

      {rightAction ? (
        <TouchableOpacity onPress={rightAction.onPress} style={styles.iconButton} activeOpacity={0.75}>
          <Ionicons name={rightAction.icon as never} size={22} color={rightAction.tint ?? cl.navy} />
        </TouchableOpacity>
      ) : onPressMenu ? (
        <TouchableOpacity
          onPress={onPressMenu}
          style={styles.accountButton}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="Open account menu"
        >
          <Text style={styles.accountInitial}>{accountInitial}</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.iconButtonGhost} />
      )}
    </View>
  );
}

function getAccountInitial(label?: string | null): string {
  const trimmed = label?.trim();
  if (!trimmed) return '?';

  const namePart = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed;
  const firstLetter = namePart.match(/[A-Za-z0-9]/)?.[0];
  return firstLetter ? firstLetter.toUpperCase() : '?';
}

export function ClearLensSegmentedControl<T extends string>({
  options,
  selected,
  onChange,
}: {
  options: { value: T; label: string }[];
  selected: T;
  onChange: (value: T) => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.segmented}>
      {options.map((option) => {
        const active = option.value === selected;
        return (
          <TouchableOpacity
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.segment, active && styles.segmentActive]}
            activeOpacity={0.75}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
              {option.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export function ClearLensMetricCard({
  label,
  value,
  tone = 'neutral',
  sublabel,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'negative' | 'neutral';
  sublabel?: string;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const cl = tokens.colors;
  const valueStyle: TextStyle =
    tone === 'positive'
      ? { color: cl.emerald }
      : tone === 'negative'
        ? { color: cl.negative }
        : { color: cl.navy };

  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, valueStyle]}>{value}</Text>
      {sublabel ? <Text style={styles.metricSub}>{sublabel}</Text> : null}
    </View>
  );
}

export function ClearLensPill({
  label,
  active = false,
  onPress,
  onPressIn,
  onHoverIn,
  onFocus,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  onPressIn?: () => void;
  onHoverIn?: () => void;
  onFocus?: () => void;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      onPressIn={onPressIn}
      onHoverIn={onHoverIn}
      onFocus={onFocus}
      style={({ pressed }) => [
        styles.pill,
        active && styles.pillActive,
        pressed && { opacity: 0.75 },
      ]}
    >
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </Pressable>
  );
}


function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: cl.background,
    },
    desktopFrame: {
      flex: 1,
      width: '100%',
      alignSelf: 'center',
    },
    card: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.border,
      padding: ClearLensSpacing.md,
      ...ClearLensShadow,
    },
    header: {
      minHeight: 58,
      paddingHorizontal: ClearLensSpacing.md,
      paddingTop: 2,
      paddingBottom: 6,
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      backgroundColor: cl.background,
    },
    headerDesktopChrome: {
      minHeight: 44,
      paddingTop: 4,
      paddingBottom: 4,
    },
    // Matches UtilityHeader's `clearBackBtn` so the back affordance reads the
    // same on every screen (Settings sub-pages use UtilityHeader; the rest use
    // ClearLensHeader). 38 px circle, surface fill, 1 px border.
    backChip: {
      width: 38,
      height: 38,
      borderRadius: ClearLensRadii.full,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: cl.surface,
      borderWidth: 1,
      borderColor: cl.border,
    },
    headerTitle: {
      ...ClearLensTypography.h3,
      flex: 1,
      color: cl.navy,
      textAlign: 'center',
    },
    headerSpacer: { flex: 1 },
    iconButton: {
      width: 40,
      height: 40,
      borderRadius: ClearLensRadii.full,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'transparent',
    },
    iconButtonGhost: { width: 40, height: 40 },
    accountButton: {
      width: 34,
      height: 34,
      borderRadius: ClearLensRadii.full,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: cl.accountSurface,
      borderWidth: 1,
      borderColor: cl.accountBorder,
    },
    accountInitial: {
      ...ClearLensTypography.bodySmall,
      color: cl.slate,
      fontWeight: '700',
    },
    segmented: {
      flexDirection: 'row',
      padding: 4,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.surfaceSoft,
      gap: 4,
    },
    segment: {
      flex: 1,
      minHeight: 42,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: ClearLensRadii.sm,
    },
    segmentActive: {
      backgroundColor: cl.mint50,
      borderWidth: 1,
      borderColor: cl.emerald,
      ...ClearLensShadow,
      shadowOpacity: 0.04,
      elevation: 1,
    },
    segmentText: {
      ...ClearLensTypography.bodySmall,
      fontWeight: '600',
      color: cl.textTertiary,
    },
    segmentTextActive: { color: cl.emeraldDeep, fontWeight: '700' },
    metricCard: {
      flex: 1,
      padding: ClearLensSpacing.sm,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.surfaceSoft,
      gap: 3,
    },
    metricLabel: {
      ...ClearLensTypography.label,
      color: cl.textTertiary,
      textTransform: 'uppercase',
    },
    metricValue: { ...ClearLensTypography.h3 },
    metricSub: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
    },
    pill: {
      minHeight: 38,
      paddingHorizontal: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.full,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: cl.surfaceSoft,
    },
    pillActive: {
      backgroundColor: cl.mint50,
      borderWidth: 1,
      borderColor: cl.emerald,
    },
    pillText: {
      ...ClearLensTypography.bodySmall,
      fontWeight: '600',
      color: cl.textTertiary,
    },
    pillTextActive: { color: cl.emeraldDeep, fontWeight: '700' },
  });
}
