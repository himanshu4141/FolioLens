import { useMemo, useState } from 'react';
import {
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/src/lib/supabase';
import { useSession } from '@/src/hooks/useSession';
import { useUserProfile } from '@/src/hooks/useUserProfile';
import { UtilityHeader } from '@/src/components/UtilityHeader';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { formatInboxAddress } from '@/src/utils/casInboxToken';

type LastImport = {
  created_at: string;
  import_source: 'email' | 'qr' | 'pdf';
  import_status: 'pending' | 'success' | 'failed';
  funds_updated: number;
  transactions_added: number;
};

const PORTFOLIO_TIPS: { icon: keyof typeof Ionicons.glyphMap; text: string }[] = [
  {
    icon: 'filter-outline',
    text: 'Auto-forward only CAS emails from donotreply@camsonline.com and samfS@kfintech.com.',
  },
  {
    icon: 'document-text-outline',
    text: 'Manual upload remains available for CAMS, KFintech, MFCentral, CDSL, and NSDL PDFs.',
  },
  {
    icon: 'list-outline',
    text: 'Use Detailed CAS statements so FolioLens receives transaction history, not only balances.',
  },
];

function formatImportDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  return `${date} · ${time}`;
}

function formatImportSource(source: LastImport['import_source']): string {
  if (source === 'email') return 'Auto-forward';
  if (source === 'pdf') return 'PDF upload';
  return 'Legacy email route';
}

async function fetchLastImport(userId: string): Promise<LastImport | null> {
  const { data, error } = await supabase
    .from('cas_import')
    .select('created_at, import_source, import_status, funds_updated, transactions_added')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[settings/portfolio-import] fetchLastImport failed', error);
    throw error;
  }
  return data as LastImport | null;
}

export default function PortfolioImportScreen() {
  const router = useRouter();
  const { session } = useSession();
  const userId = session?.user.id;
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const cl = tokens.colors;
  const [copied, setCopied] = useState(false);

  const { data: profile, isLoading: profileLoading } = useUserProfile(userId);

  const { data: lastImport } = useQuery({
    queryKey: ['last-cas-import', userId],
    queryFn: () => fetchLastImport(userId!),
    enabled: !!userId,
  });

  const inboxAddress = useMemo(() => {
    if (!profile?.cas_inbox_token) return null;
    try {
      return formatInboxAddress(profile.cas_inbox_token);
    } catch {
      return null;
    }
  }, [profile?.cas_inbox_token]);

  const autoForwardReady = !!profile?.cas_auto_forward_setup_completed_at;
  const pendingConfirmationUrl = profile?.cas_inbox_confirmation_url ?? null;
  const formattedLastImport = formatImportDate(lastImport?.created_at);

  async function handleCopy() {
    if (!inboxAddress) return;
    await Clipboard.setStringAsync(inboxAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleOpenConfirmation() {
    if (!pendingConfirmationUrl) return;
    if (Platform.OS === 'web') {
      void Linking.openURL(pendingConfirmationUrl);
      return;
    }
    void WebBrowser.openBrowserAsync(pendingConfirmationUrl);
  }

  return (
    <SafeAreaView style={styles.container}>
      <UtilityHeader title="Portfolio import" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.headerCopy}>
          <Text style={styles.heading}>Import and auto-refresh</Text>
          <Text style={styles.subheading}>
            Keep your FolioLens import inbox as the default path, with PDF upload as a fallback.
          </Text>
        </View>

        <Text style={styles.sectionLabel}>Auto-forward</Text>
        <View style={styles.card}>
          <View style={styles.statusBlock}>
            <View style={styles.statusTop}>
              <View style={styles.statusIcon}>
                <Ionicons name="mail-unread-outline" size={19} color={cl.emeraldDeep} />
              </View>
              <View style={styles.rowLeft}>
                <Text style={styles.rowValue}>FolioLens import inbox</Text>
                <Text style={styles.rowSub}>
                  {autoForwardReady
                    ? 'Ready for future CAMS and KFintech CAS emails.'
                    : 'Set up Gmail or Outlook forwarding once.'}
                </Text>
              </View>
              <View style={[styles.statusBadge, autoForwardReady ? styles.statusBadgeReady : styles.statusBadgeSetup]}>
                <Text style={[styles.statusBadgeText, autoForwardReady ? styles.statusTextReady : styles.statusTextSetup]}>
                  {autoForwardReady ? 'Ready' : 'Setup'}
                </Text>
              </View>
            </View>

            <View style={styles.importAddressRow}>
              <Text style={styles.importAddress} numberOfLines={1} selectable>
                {profileLoading ? 'Loading address...' : inboxAddress ?? 'Open import flow to create your inbox'}
              </Text>
              {inboxAddress ? (
                <TouchableOpacity
                  style={[styles.copyBtn, copied && styles.copyBtnDone]}
                  onPress={handleCopy}
                  activeOpacity={0.7}
                >
                  <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={14} color={cl.emerald} />
                  <Text style={styles.copyBtnText}>{copied ? 'Copied' : 'Copy'}</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            <TouchableOpacity
              style={styles.primaryAction}
              onPress={() =>
                router.push({ pathname: '/onboarding', params: { mode: 'auto-refresh' } })
              }
              activeOpacity={0.78}
            >
              <Ionicons name="settings-outline" size={15} color={cl.textOnDark} />
              <Text style={styles.primaryActionText}>
                {autoForwardReady ? 'Review setup' : 'Set up auto-forward'}
              </Text>
            </TouchableOpacity>
          </View>

          {pendingConfirmationUrl && !autoForwardReady ? (
            <View style={[styles.row, styles.borderTop]}>
              <View style={styles.rowLeft}>
                <Text style={styles.rowLabel}>Gmail verification</Text>
                <Text style={styles.rowSub}>
                  Google has sent a confirmation link for this inbox.
                </Text>
              </View>
              <TouchableOpacity
                onPress={handleOpenConfirmation}
                style={styles.secondaryAction}
                activeOpacity={0.76}
              >
                <Text style={styles.secondaryActionText}>Confirm</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>

        <Text style={styles.sectionLabel}>Import options</Text>
        <View style={styles.card}>
          <TouchableOpacity
            style={styles.row}
            onPress={() => router.push('/onboarding')}
            activeOpacity={0.72}
          >
            <View style={styles.optionIcon}>
              <Ionicons name="cloud-upload-outline" size={18} color={cl.emerald} />
            </View>
            <View style={styles.rowLeft}>
              <Text style={styles.rowValue}>Open import flow</Text>
              <Text style={styles.rowSub}>Upload a CAS PDF or adjust auto-forward setup.</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={cl.textTertiary} />
          </TouchableOpacity>
        </View>

        {formattedLastImport ? (
          <>
            <Text style={styles.sectionLabel}>Latest import</Text>
            <View style={styles.card}>
              <View style={styles.row}>
                <View style={styles.optionIcon}>
                  <Ionicons name="checkmark-circle-outline" size={18} color={cl.emerald} />
                </View>
                <View style={styles.rowLeft}>
                  <Text style={styles.rowValue}>{formatImportSource(lastImport!.import_source)}</Text>
                  <Text style={styles.rowSub}>
                    {formattedLastImport} · {lastImport!.import_status} · {lastImport!.transactions_added} transactions
                  </Text>
                </View>
              </View>
            </View>
          </>
        ) : null}

        <Text style={styles.sectionLabel}>Good setup</Text>
        <View style={styles.card}>
          {PORTFOLIO_TIPS.map((tip, idx) => (
            <View key={tip.text} style={[styles.tipRow, idx > 0 && styles.borderTop]}>
              <View style={styles.tipIconWrap}>
                <Ionicons name={tip.icon} size={16} color={cl.textTertiary} />
              </View>
              <Text style={styles.tipText}>{tip.text}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: cl.background },
    content: { padding: ClearLensSpacing.md, gap: ClearLensSpacing.sm, paddingBottom: ClearLensSpacing.xxl },

    headerCopy: {
      gap: 4,
      paddingBottom: ClearLensSpacing.xs,
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

    sectionLabel: {
      ...ClearLensTypography.label,
      color: cl.textTertiary,
      textTransform: 'uppercase',
      marginBottom: ClearLensSpacing.xs,
      marginTop: ClearLensSpacing.xs,
    },

    card: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.border,
      overflow: 'hidden',
      ...ClearLensShadow,
    },

    statusBlock: {
      padding: ClearLensSpacing.md,
      gap: ClearLensSpacing.sm,
    },
    statusTop: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
    },
    statusIcon: {
      width: 36,
      height: 36,
      borderRadius: ClearLensRadii.full,
      backgroundColor: cl.mint50,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    statusBadge: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: ClearLensRadii.full,
      flexShrink: 0,
    },
    statusBadgeReady: { backgroundColor: cl.positiveBg },
    statusBadgeSetup: { backgroundColor: cl.mint50 },
    statusBadgeText: {
      ...ClearLensTypography.caption,
      fontFamily: ClearLensFonts.semiBold,
    },
    statusTextReady: { color: cl.emerald },
    statusTextSetup: { color: cl.emeraldDeep },

    importAddressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      minHeight: 36,
    },
    importAddress: {
      ...ClearLensTypography.body,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.navy,
      flex: 1,
      minWidth: 0,
    },
    copyBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 6,
      backgroundColor: cl.mint50,
      borderRadius: ClearLensRadii.full,
      flexShrink: 0,
    },
    copyBtnDone: { backgroundColor: cl.positiveBg },
    copyBtnText: {
      ...ClearLensTypography.caption,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.emerald,
    },

    primaryAction: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 9,
      backgroundColor: cl.emeraldDeep,
      borderRadius: ClearLensRadii.full,
    },
    primaryActionText: {
      ...ClearLensTypography.caption,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.textOnDark,
    },
    secondaryAction: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      backgroundColor: cl.mint50,
      borderRadius: ClearLensRadii.full,
    },
    secondaryActionText: {
      ...ClearLensTypography.caption,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.emerald,
    },

    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: 14,
      gap: ClearLensSpacing.md,
    },
    borderTop: { borderTopWidth: 1, borderTopColor: cl.borderLight },
    rowLeft: { flex: 1, gap: 3, minWidth: 0 },
    rowLabel: {
      ...ClearLensTypography.label,
      color: cl.textTertiary,
      textTransform: 'uppercase',
    },
    rowValue: {
      ...ClearLensTypography.h3,
      color: cl.navy,
    },
    rowSub: {
      ...ClearLensTypography.bodySmall,
      color: cl.textTertiary,
    },
    optionIcon: {
      width: 32,
      height: 32,
      borderRadius: ClearLensRadii.full,
      backgroundColor: cl.mint50,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },

    tipRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: 12,
      gap: ClearLensSpacing.sm,
    },
    tipIconWrap: { width: 22, alignItems: 'center', paddingTop: 1 },
    tipText: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
      flex: 1,
    },
  });
}
