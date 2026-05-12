import { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/src/lib/supabase';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';

export function maskPan(pan: string): string {
  if (pan.length !== 10) return pan;
  return pan.slice(0, 2) + '•'.repeat(6) + pan.slice(8);
}

export function navStatusBadge(
  navDate: string | null | undefined,
  cl: ClearLensTokens['colors'],
) {
  if (!navDate) return { color: cl.textTertiary, dot: cl.textTertiary, label: 'Unknown' };
  const today = new Date().toISOString().split('T')[0];
  const diffMs = new Date(today).getTime() - new Date(navDate).getTime();
  const diffDays = Math.round(diffMs / 86_400_000);
  const d = new Date(navDate);
  const dateLabel = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  if (diffDays <= 1) return { color: cl.positive, dot: cl.positive, label: 'Live' };
  if (diffDays <= 3) return { color: cl.warning, dot: cl.amber, label: `Stale · ${dateLabel}` };
  return { color: cl.negative, dot: cl.negative, label: `Outdated · ${dateLabel}` };
}

type HubRowProps = {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  statusLabel?: string;
  statusColor?: string;
  onPress: () => void;
  isLast?: boolean;
  styles: ReturnType<typeof makeHubStyles>;
  cl: ClearLensTokens['colors'];
};

function HubRow({ icon, title, subtitle, statusLabel, statusColor, onPress, isLast, styles, cl }: HubRowProps) {
  return (
    <TouchableOpacity
      style={[styles.row, !isLast && styles.rowBorder]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.iconCircle}>
        <Ionicons name={icon} size={20} color={cl.emerald} />
      </View>
      <View style={styles.rowContent}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowSubtitle} numberOfLines={1}>{subtitle}</Text>
        {statusLabel ? (
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
          </View>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={cl.textTertiary} />
    </TouchableOpacity>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeHubStyles(tokens), [tokens]);
  const cl = tokens.colors;

  const { data: latestNavRow } = useQuery({
    queryKey: ['latest-nav-date'],
    queryFn: async () => {
      const { data } = await supabase
        .from('nav_history')
        .select('nav_date')
        .order('nav_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.nav_date as string | null ?? null;
    },
    staleTime: 10 * 60 * 1000,
  });

  const navBadge = navStatusBadge(latestNavRow, cl);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.frame}>
          <View style={styles.header}>
            <Text style={styles.eyebrow}>Settings</Text>
            <Text style={styles.heading}>Account & preferences</Text>
            <Text style={styles.subheading}>Manage your account, data, and how the app behaves.</Text>
          </View>

          <View style={styles.card}>
            <HubRow
              icon="person-outline"
              title="Account"
              subtitle="Email, PAN, connected accounts"
              onPress={() => router.push('/settings/account')}
              styles={styles}
              cl={cl}
            />
            <HubRow
              icon="cloud-upload-outline"
              title="Portfolio import"
              subtitle="Auto-forward inbox, setup status, upload fallback"
              onPress={() => router.push('/settings/portfolio-import')}
              styles={styles}
              cl={cl}
            />
            <HubRow
              icon="refresh-outline"
              title="Data sync"
              subtitle="NAV data status and manual sync"
              statusLabel={navBadge.label}
              statusColor={navBadge.dot}
              onPress={() => router.push('/settings/data-sync')}
              styles={styles}
              cl={cl}
            />
            <HubRow
              icon="options-outline"
              title="Preferences"
              subtitle="Benchmark, appearance, return assumptions"
              onPress={() => router.push('/settings/preferences')}
              styles={styles}
              cl={cl}
            />
            <HubRow
              icon="information-circle-outline"
              title="About & support"
              subtitle="Version, updates and sign out"
              onPress={() => router.push('/settings/about')}
              styles={styles}
              cl={cl}
              isLast
            />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeHubStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: cl.background },
    // Cap inner column width so on desktop the cards don't stretch
    // edge-to-edge of the content area. 960 px matches the list-tier
    // ClearLensScreen.desktopMaxWidth used by the other single-column
    // screens (Wealth Journey, Money Trail, sub-pages, etc.).
    content: {
      padding: ClearLensSpacing.md,
      alignItems: 'center',
    },
    frame: {
      width: '100%',
      maxWidth: 960,
      gap: ClearLensSpacing.md,
    },
    header: { gap: 4, paddingVertical: ClearLensSpacing.sm },
    eyebrow: {
      ...ClearLensTypography.label,
      color: cl.emerald,
      textTransform: 'uppercase',
    },
    heading: {
      ...ClearLensTypography.h1,
      fontFamily: ClearLensFonts.extraBold,
      color: cl.navy,
    },
    subheading: {
      ...ClearLensTypography.body,
      color: cl.textTertiary,
    },
    card: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.border,
      overflow: 'hidden',
      ...ClearLensShadow,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: ClearLensSpacing.md,
      gap: ClearLensSpacing.md,
    },
    rowBorder: {
      borderBottomWidth: 1,
      borderBottomColor: cl.borderLight,
    },
    iconCircle: {
      width: 44,
      height: 44,
      borderRadius: ClearLensRadii.full,
      backgroundColor: cl.mint50,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    rowContent: { flex: 1, gap: 2 },
    rowTitle: {
      ...ClearLensTypography.h3,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.navy,
    },
    rowSubtitle: {
      ...ClearLensTypography.bodySmall,
      color: cl.textTertiary,
    },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    statusText: { ...ClearLensTypography.caption, fontFamily: ClearLensFonts.semiBold },
  });
}
