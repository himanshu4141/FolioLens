import { useMemo } from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter, useSegments } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { FolioLensLogo } from '@/src/components/clearLens/FolioLensLogo';
import { useSession } from '@/src/hooks/useSession';
import { useImportPortfolioPress } from '@/src/hooks/useImportPortfolioPress';
import { useLatestNavDate } from '@/src/hooks/useLatestNavDate';
import { navStaleness } from '@/src/utils/navUtils';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { SidebarWidth } from './desktopBreakpoints';
import {
  getNavigationCacheContext,
  normalizeNavigationRoute,
  startNavigationMeasurement,
  type NavigationRouteName,
} from '@/src/lib/navigationPerformance';

type NavItem = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  href: string;
  match: (segments: string[]) => boolean;
  routeName: NavigationRouteName;
};

const NAV_ITEMS: NavItem[] = [
  {
    key: 'portfolio',
    label: 'Portfolio',
    icon: 'pie-chart-outline',
    href: '/(tabs)',
    match: (segments) => segments[0] === '(tabs)' && (segments[1] === 'index' || segments[1] === undefined),
    routeName: 'portfolio',
  },
  {
    key: 'funds',
    label: 'Funds',
    icon: 'list-outline',
    href: '/(tabs)/funds',
    match: (segments) => segments[0] === '(tabs)' && segments[1] === 'funds',
    routeName: 'funds',
  },
  {
    key: 'wealth',
    label: 'Wealth Journey',
    icon: 'calculator-outline',
    href: '/(tabs)/wealth-journey',
    match: (segments) => segments[0] === '(tabs)' && segments[1] === 'wealth-journey',
    routeName: 'wealth_journey',
  },
];

const QUICK_ACTIONS: { key: 'import' | 'trail' | 'tools'; icon: keyof typeof Ionicons.glyphMap; label: string }[] = [
  { key: 'import', icon: 'refresh-outline', label: 'Refresh portfolio' },
  { key: 'trail', icon: 'trail-sign-outline', label: 'Money Trail' },
  { key: 'tools', icon: 'construct-outline', label: 'Tools' },
];

export function DesktopSidebar() {
  const router = useRouter();
  const segments = useSegments();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { session } = useSession();
  const accountMetadata = session?.user.user_metadata as { full_name?: string; name?: string } | undefined;
  const accountLabel = accountMetadata?.full_name ?? accountMetadata?.name ?? session?.user.email ?? null;
  const accountInitial = useMemo(() => getAccountInitial(accountLabel), [accountLabel]);
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const cl = tokens.colors;

  const latestNavDate = useLatestNavDate();
  const navStamp = useMemo(() => navStaleness(latestNavDate), [latestNavDate]);

  const handleImportPress = useImportPortfolioPress();
  function handleQuickAction(key: 'import' | 'trail' | 'tools') {
    if (key === 'import') {
      handleImportPress();
      return;
    }
    if (key === 'trail') return router.push('/money-trail');
    if (key === 'tools') return router.push('/tools' as never);
  }

  function openTab(item: NavItem) {
    startNavigationMeasurement({
      transition: 'bottom_tab',
      fromRoute: normalizeNavigationRoute(pathname),
      toRoute: item.routeName,
      context: getNavigationCacheContext(queryClient, { toRoute: item.routeName }),
    });
    router.push(item.href as never);
  }

  function openSettings() {
    startNavigationMeasurement({
      transition: 'portfolio_to_settings',
      fromRoute: normalizeNavigationRoute(pathname),
      toRoute: 'settings',
      context: getNavigationCacheContext(queryClient, { toRoute: 'settings' }),
    });
    router.push('/(tabs)/settings');
  }

  return (
    <View style={styles.sidebar}>
      <View style={styles.brandBlock}>
        <FolioLensLogo size={32} showWordmark />
      </View>

      <Text style={styles.sectionLabel}>Navigate</Text>
      <View style={styles.navGroup}>
        {NAV_ITEMS.map((item) => {
          const active = item.match(segments as string[]);
          return (
            <TouchableOpacity
              key={item.key}
              style={[styles.navItem, active && styles.navItemActive]}
              onPress={() => openTab(item)}
              activeOpacity={0.78}
            >
              <Ionicons
                name={item.icon}
                size={18}
                color={active ? cl.textOnDark : cl.slate}
              />
              <Text
                style={[
                  styles.navLabel,
                  { color: active ? cl.textOnDark : cl.slate },
                ]}
              >
                {item.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={styles.sectionLabel}>Quick actions</Text>
      <View style={styles.quickGroup}>
        {QUICK_ACTIONS.map((action) => (
          <TouchableOpacity
            key={action.key}
            style={styles.quickItem}
            onPress={() => handleQuickAction(action.key)}
            activeOpacity={0.78}
          >
            <Ionicons name={action.icon} size={16} color={cl.slate} />
            <Text style={styles.quickLabel} numberOfLines={1}>{action.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.spacer} />

      {navStamp.label !== '' && (
        <View style={styles.navStampRow}>
          <Ionicons
            name="time-outline"
            size={13}
            color={navStamp.critical ? cl.negative : cl.textTertiary}
          />
          <Text
            style={[
              styles.navStampText,
              navStamp.critical && styles.navStampTextCritical,
            ]}
            numberOfLines={1}
          >
            NAV {navStamp.label}
          </Text>
        </View>
      )}

      {/* The account row is a direct link to Settings — the non-account items
          surfaced by the legacy account dropdown (Import, Money Trail, Tools)
          are already in this sidebar, and Sign Out lives inside
          Settings → About & support. Keeps one entry point per action. */}
      <TouchableOpacity
        style={styles.accountRow}
        onPress={openSettings}
        activeOpacity={0.8}
        accessibilityRole="link"
        accessibilityLabel="Open settings"
      >
        <View style={styles.accountBadge}>
          <Text style={styles.accountInitial}>{accountInitial}</Text>
        </View>
        <View style={styles.accountText}>
          <Text style={styles.accountName} numberOfLines={1}>
            {accountLabel ?? 'Signed in'}
          </Text>
          <Text style={styles.accountAction}>Account · settings</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={cl.textTertiary} />
      </TouchableOpacity>
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


function makeStyles(tokens: ClearLensTokens) {
  const c = tokens.colors;
  return StyleSheet.create({
    sidebar: {
      width: SidebarWidth,
      alignSelf: 'stretch',
      height: '100%',
      backgroundColor: c.surface,
      borderRightWidth: 1,
      borderRightColor: c.borderLight,
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: ClearLensSpacing.lg,
      gap: ClearLensSpacing.md,
    },
    brandBlock: { paddingVertical: ClearLensSpacing.xs },
    sectionLabel: {
      ...ClearLensTypography.label,
      color: c.textTertiary,
      textTransform: 'uppercase',
      paddingHorizontal: 6,
      marginTop: ClearLensSpacing.xs,
    },
    navGroup: { gap: 4 },
    navItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      paddingHorizontal: ClearLensSpacing.sm,
      paddingVertical: 10,
      borderRadius: ClearLensRadii.md,
    },
    navItemActive: { backgroundColor: c.heroSurface },
    navLabel: { ...ClearLensTypography.bodySmall, fontFamily: ClearLensFonts.semiBold },
    quickGroup: { gap: 2 },
    quickItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      paddingHorizontal: ClearLensSpacing.sm,
      paddingVertical: 8,
      borderRadius: ClearLensRadii.sm,
    },
    quickLabel: {
      ...ClearLensTypography.caption,
      color: c.slate,
      fontFamily: ClearLensFonts.medium,
      flex: 1,
    },
    spacer: { flex: 1 },
    navStampRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: ClearLensSpacing.sm,
      paddingVertical: 4,
    },
    navStampText: {
      ...ClearLensTypography.caption,
      color: c.textTertiary,
    },
    navStampTextCritical: {
      color: c.negative,
      fontFamily: ClearLensFonts.semiBold,
    },
    accountRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      paddingHorizontal: ClearLensSpacing.sm,
      paddingVertical: ClearLensSpacing.sm,
      borderRadius: ClearLensRadii.md,
      backgroundColor: c.surfaceSoft,
    },
    accountBadge: {
      width: 34,
      height: 34,
      borderRadius: ClearLensRadii.full,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.accountSurface,
      borderWidth: 1,
      borderColor: c.accountBorder,
    },
    accountInitial: {
      ...ClearLensTypography.bodySmall,
      color: c.slate,
      fontFamily: ClearLensFonts.bold,
    },
    accountText: { flex: 1, gap: 2 },
    accountName: {
      ...ClearLensTypography.bodySmall,
      color: c.navy,
      fontFamily: ClearLensFonts.semiBold,
    },
    accountAction: { ...ClearLensTypography.caption, color: c.textTertiary },
  });
}
