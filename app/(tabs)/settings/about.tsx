import { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Updates from 'expo-updates';
import ExpoConstants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { authClient } from '@/src/lib/auth';
import { UtilityHeader } from '@/src/components/UtilityHeader';
import { FeedbackSheet, type FeedbackKind } from '@/src/components/FeedbackSheet';
import { PortfolioDisclaimer } from '@/src/components/clearLens/PortfolioDisclaimer';
import { useAlertDialog, useConfirmDialog } from '@/src/hooks/useDialog';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';

const HELP_URL = 'https://foliolens.in/faq.html';
const PRIVACY_URL = 'https://foliolens.in/privacy.html';
const TERMS_URL = 'https://foliolens.in/terms.html';

type InfoRowProps = {
  label: string;
  value: string;
  onPress?: () => void;
  isLast?: boolean;
};

function InfoRow({ label, value, onPress, isLast }: InfoRowProps) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const Row = onPress ? TouchableOpacity : View;
  return (
    <Row
      style={[styles.row, !isLast && styles.borderBottom]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.rowLeft}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{value}</Text>
      </View>
      {onPress && <Ionicons name="chevron-forward" size={16} color={tokens.colors.textTertiary} />}
    </Row>
  );
}

type LinkRowProps = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
  isLast?: boolean;
};

function LinkRow({ icon, label, onPress, isLast }: LinkRowProps) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <TouchableOpacity
      style={[styles.linkRow, !isLast && styles.borderBottom]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Ionicons name={icon} size={18} color={tokens.colors.textSecondary} />
      <Text style={styles.linkLabel}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={tokens.colors.textTertiary} />
    </TouchableOpacity>
  );
}

export default function AboutScreen() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const [copiedUpdateId, setCopiedUpdateId] = useState(false);
  const [feedbackKind, setFeedbackKind] = useState<FeedbackKind | null>(null);
  const showAlert = useAlertDialog();
  const showConfirm = useConfirmDialog();

  async function handleOpenHelp() {
    try {
      await WebBrowser.openBrowserAsync(HELP_URL, {
        // Keeps the user inside the app via SFSafariViewController / Chrome Custom Tab.
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
    } catch (error) {
      showAlert({
        title: 'Could not open Help',
        body: error instanceof Error ? error.message : 'Please try again.',
      });
    }
  }

  async function openLegalUrl(url: string, label: string) {
    try {
      await WebBrowser.openBrowserAsync(url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
    } catch (error) {
      showAlert({
        title: `Could not open ${label}`,
        body: error instanceof Error ? error.message : 'Please try again.',
      });
    }
  }

  const appVersion = ExpoConstants.expoConfig?.version ?? '—';
  const updateChannel = Updates.channel ?? '—';
  const isEmbedded = Updates.isEmbeddedLaunch;
  const updateId = Updates.updateId;
  const updateIdDisplay = isEmbedded
    ? 'Embedded (no OTA)'
    : updateId
      ? updateId.slice(0, 12) + '…'
      : '—';
  const updateCreatedAt = Updates.createdAt;
  const updateDateDisplay = isEmbedded || !updateCreatedAt
    ? '—'
    : updateCreatedAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      + ' · '
      + updateCreatedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  async function handleCopyUpdateId() {
    if (!updateId) return;
    await Clipboard.setStringAsync(updateId);
    setCopiedUpdateId(true);
    setTimeout(() => setCopiedUpdateId(false), 2000);
  }

  function handleSignOut() {
    showConfirm({
      title: 'Sign out',
      body: 'You can sign back in any time with your email or Google account.',
      okText: 'Sign out',
      cancelText: 'Cancel',
      destructive: true,
      onConfirm: async () => {
        const { error } = await authClient.signOut();
        if (error) {
          showAlert({ title: 'Sign out failed', body: error.message });
        }
      },
    });
  }

  return (
    <SafeAreaView style={styles.container}>
      <UtilityHeader title="About & support" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.frame}>
        {/* Version info — OTA / channel rows are mobile-only;
            on web there is no EAS update channel and no OTA bundle. */}
        <View style={styles.card}>
          <InfoRow label="Version" value={appVersion} isLast={Platform.OS === 'web'} />
          {Platform.OS !== 'web' ? (
            <>
              <InfoRow label="Update channel" value={updateChannel} />
              <InfoRow
                label="OTA update"
                value={copiedUpdateId ? 'Copied!' : updateIdDisplay}
                onPress={updateId && !isEmbedded ? handleCopyUpdateId : undefined}
              />
              <InfoRow
                label="OTA date"
                value={updateDateDisplay}
                isLast
              />
            </>
          ) : null}
        </View>

        {/* Support links */}
        <View style={styles.card}>
          <LinkRow icon="help-circle-outline" label="Help & FAQs" onPress={handleOpenHelp} />
          <LinkRow icon="bulb-outline" label="Request a feature" onPress={() => setFeedbackKind('feature_request')} />
          <LinkRow icon="alert-circle-outline" label="Report an issue" onPress={() => setFeedbackKind('bug_report')} isLast />
        </View>

        {/* Legal — required by both Play Store and App Store reviewers, who
            need to find privacy + terms in-app, not just on the listing. */}
        <View style={styles.card}>
          <LinkRow
            icon="document-text-outline"
            label="Privacy Policy"
            onPress={() => openLegalUrl(PRIVACY_URL, 'Privacy Policy')}
          />
          <LinkRow
            icon="reader-outline"
            label="Terms of Use"
            onPress={() => openLegalUrl(TERMS_URL, 'Terms of Use')}
            isLast
          />
        </View>

        {/* Sign out */}
        <View style={styles.card}>
          <TouchableOpacity style={styles.signOutRow} onPress={handleSignOut} activeOpacity={0.7}>
            <Ionicons name="log-out-outline" size={18} color={tokens.colors.negative} />
            <Text style={styles.signOutText}>Sign out</Text>
          </TouchableOpacity>
        </View>

        <PortfolioDisclaimer />
        </View>
      </ScrollView>

      <FeedbackSheet
        visible={feedbackKind != null}
        kind={feedbackKind}
        onClose={() => setFeedbackKind(null)}
      />
    </SafeAreaView>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: cl.background },
    content: {
      paddingHorizontal: ClearLensSpacing.md,
      paddingTop: ClearLensSpacing.md,
      paddingBottom: ClearLensSpacing.xxl,
      alignItems: 'center',
    },
    frame: { width: '100%', maxWidth: 960, gap: ClearLensSpacing.sm },

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
      paddingVertical: 14,
      gap: ClearLensSpacing.md,
    },
    borderBottom: { borderBottomWidth: 1, borderBottomColor: cl.borderLight },
    rowLeft: { flex: 1, gap: 3 },
    rowLabel: {
      ...ClearLensTypography.label,
      color: cl.textTertiary,
      textTransform: 'uppercase',
    },
    rowValue: {
      ...ClearLensTypography.h3,
      color: cl.navy,
    },

    linkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: 15,
      gap: ClearLensSpacing.md,
    },
    linkLabel: {
      ...ClearLensTypography.body,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.navy,
      flex: 1,
    },

    signOutRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: 15,
    },
    signOutText: {
      ...ClearLensTypography.body,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.negative,
    },
  });
}
