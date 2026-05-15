import { useMemo, useState } from 'react';
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { formatInboxAddress } from '@/src/utils/casInboxToken';

/**
 * Shared body of the "Set up auto-refresh" UI. Used by:
 *
 *   - The wizard's Step 3 sub-screen (opened from the third import card).
 *   - Settings → Account → Auto-refresh row (deep-linked on tap).
 *
 * Owns no remote state — the parent passes the user's inbox token,
 * the optional pending Gmail confirmation URL, and a callback to
 * invoke after the user clicks the confirmation link (so the parent
 * can refetch user_profile).
 *
 * The hybrid-flow (M2.0 decision):
 *
 *   - Manual forward is the universal default. Works on every client.
 *   - Auto-forward is an opt-in expander with platform tabs:
 *       Gmail   — surface confirmationUrl when captured
 *       Outlook — direct rule instructions, no verification step
 *       iCloud / Yahoo — explicitly not supported
 *       Other  — generic guidance
 */

type ClientTab = 'gmail' | 'outlook' | 'other';

const GMAIL_FILTER_URL = 'https://mail.google.com/mail/u/0/#settings/filters';
const OUTLOOK_RULES_URL = 'https://outlook.live.com/mail/0/options/mail/rules';

interface Props {
  inboxToken: string;
  /** Captured by the Edge Function when Gmail emails the verification link. */
  pendingConfirmationUrl?: string | null;
  /** Set after the user confirms they finished the provider-side rule/filter setup. */
  autoForwardCompletedAt?: string | null;
  /** Called after the user taps the "Confirm Gmail forwarding" CTA so the parent can refetch. */
  onConfirmClicked?: () => void;
  /** Persists the user's "auto-forward setup is complete" confirmation. */
  onAutoForwardCompleted?: () => Promise<void>;
  /** Wizard-only continuation after auto-forward setup is complete. */
  onContinue?: () => void;
}

type GmailChecklistKey = 'forwardingAddress' | 'verification' | 'filter';

const GMAIL_CAS_SENDERS = ['donotreply@camsonline.com', 'samfS@kfintech.com'];
const GMAIL_FILTER_QUERY = `from:(${GMAIL_CAS_SENDERS.join(' OR ')})`;

export function AutoRefreshSetup({
  inboxToken,
  pendingConfirmationUrl,
  autoForwardCompletedAt,
  onConfirmClicked,
  onAutoForwardCompleted,
  onContinue,
}: Props) {
  const tokens = useClearLensTokens();
  const cl = tokens.colors;
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

  const inboxAddress = useMemo(() => formatInboxAddress(inboxToken), [inboxToken]);
  const [copied, setCopied] = useState(false);
  const [autoForwardOpen, setAutoForwardOpen] = useState(false);
  const [tab, setTab] = useState<ClientTab>('gmail');
  const [gmailChecklist, setGmailChecklist] = useState<Record<GmailChecklistKey, boolean>>({
    forwardingAddress: false,
    verification: false,
    filter: false,
  });
  const [savingComplete, setSavingComplete] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  const autoForwardComplete = !!autoForwardCompletedAt;
  const gmailChecklistComplete =
    gmailChecklist.forwardingAddress && gmailChecklist.verification && gmailChecklist.filter;

  async function handleCopy() {
    await Clipboard.setStringAsync(inboxAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  async function openExternal(url: string) {
    try {
      if (Platform.OS === 'web') {
        await Linking.openURL(url);
      } else {
        await WebBrowser.openBrowserAsync(url);
      }
    } catch {
      // best-effort; clipboard already has the address either way
    }
  }

  async function handleConfirmGmail() {
    if (!pendingConfirmationUrl) return;
    await openExternal(pendingConfirmationUrl);
    setGmailChecklist((current) => ({ ...current, verification: true }));
    onConfirmClicked?.();
  }

  function toggleGmailChecklist(key: GmailChecklistKey) {
    if (autoForwardComplete) return;
    setGmailChecklist((current) => ({ ...current, [key]: !current[key] }));
  }

  async function handleAutoForwardComplete() {
    if (!gmailChecklistComplete || autoForwardComplete || !onAutoForwardCompleted) return;
    setSavingComplete(true);
    setCompleteError(null);
    try {
      await onAutoForwardCompleted();
      onContinue?.();
    } catch (err) {
      setCompleteError(err instanceof Error ? err.message : 'Could not save setup status');
    } finally {
      setSavingComplete(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>Your portfolio inbox</Text>
        <Text style={styles.title}>Skip the upload from now on.</Text>
        <Text style={styles.subtitle}>
          Whenever a new statement lands in your email, forward it to the
          address below. We&apos;ll pull in the new transactions automatically —
          no need to download or upload anything.
        </Text>
      </View>

      <View style={styles.addressCard}>
        <Text style={styles.addressLabel}>Your private FolioLens address</Text>
        <View style={styles.addressRow}>
          <Text style={[styles.addressValue, styles.mono]} numberOfLines={2} selectable>
            {inboxAddress}
          </Text>
          <TouchableOpacity
            style={[styles.copyBtn, copied && styles.copyBtnActive]}
            onPress={handleCopy}
            activeOpacity={0.8}
          >
            <Ionicons
              name={copied ? 'checkmark' : 'copy-outline'}
              size={14}
              color={cl.emeraldDeep}
            />
            <Text style={styles.copyBtnText}>{copied ? 'Copied' : 'Copy'}</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.addressHint}>
          Only you. Only statements. We never email anyone else — and we drop
          spoofed inbound, but treat the address like an unlisted phone number.
        </Text>
      </View>

      <View style={styles.howCard}>
        <View style={styles.howRow}>
          <View style={styles.howNum}><Text style={styles.howNumText}>1</Text></View>
          <Text style={styles.howText}>
            <Text style={styles.howBold}>One-time:</Text> set up a Gmail or
            Outlook filter that auto-forwards CAMS / KFintech statement emails
            to this address.
          </Text>
        </View>
        <View style={styles.howRow}>
          <View style={styles.howNum}><Text style={styles.howNumText}>2</Text></View>
          <Text style={styles.howText}>
            From then on, every new statement flows in by itself — we&apos;ll add
            anything new to your portfolio.
          </Text>
        </View>
      </View>

      {autoForwardComplete ? (
        <View style={styles.confirmBanner}>
          <View style={styles.confirmIconWrap}>
            <Ionicons name="checkmark-circle" size={20} color={cl.emeraldDeep} />
          </View>
          <View style={styles.confirmCopy}>
            <Text style={styles.confirmTitle}>Auto-forward is ready</Text>
            <Text style={styles.confirmBody}>
              Future CAS emails from CAMS and KFintech should forward to this
              inbox automatically. If a monthly CAS does not appear, manually
              forward that email to the address above.
            </Text>
            {onContinue ? (
              <TouchableOpacity
                style={styles.confirmCta}
                onPress={onContinue}
                activeOpacity={0.85}
              >
                <Text style={styles.confirmCtaText}>Continue</Text>
                <Ionicons name="arrow-forward" size={14} color={cl.textOnDark} />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      ) : pendingConfirmationUrl ? (
        <View style={styles.confirmBanner}>
          <View style={styles.confirmIconWrap}>
            <Ionicons name="alert-circle" size={20} color={cl.emeraldDeep} />
          </View>
          <View style={styles.confirmCopy}>
            <Text style={styles.confirmTitle}>Confirm Gmail forwarding</Text>
            <Text style={styles.confirmBody}>
              Google emailed a verification link to your import address. Click
              the button to finish setting up auto-forward — you only need to
              do this once.
            </Text>
            <TouchableOpacity
              style={styles.confirmCta}
              onPress={handleConfirmGmail}
              activeOpacity={0.85}
            >
              <Text style={styles.confirmCtaText}>Open verification link</Text>
              <Ionicons name="open-outline" size={14} color={cl.textOnDark} />
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      <View style={styles.manualCard}>
        <Text style={styles.manualTitle}>Or forward each CAS manually</Text>
        <Text style={styles.manualBody}>
          When a new statement email arrives, open it and tap Forward → paste
          the address above → send. Works on every email client without any
          setup — handy if you don&apos;t want to set up the filter below.
        </Text>
      </View>

      <Pressable
        style={styles.expander}
        onPress={() => setAutoForwardOpen((v) => !v)}
        accessibilityRole="button"
      >
        <Ionicons
          name={autoForwardOpen ? 'chevron-down' : 'chevron-forward'}
          size={16}
          color={cl.emeraldDeep}
        />
        <Text style={styles.expanderText}>
          Or set up auto-forward (advanced)
        </Text>
      </Pressable>

      {autoForwardOpen ? (
        <View style={styles.advancedCard}>
          <View style={styles.tabRow}>
            <TabButton label="Gmail" active={tab === 'gmail'} onPress={() => setTab('gmail')} styles={styles} />
            <TabButton label="Outlook" active={tab === 'outlook'} onPress={() => setTab('outlook')} styles={styles} />
            <TabButton label="Other" active={tab === 'other'} onPress={() => setTab('other')} styles={styles} />
          </View>

          {tab === 'gmail' ? (
            <View style={styles.tabBody}>
              <Step n={1} text="Open Gmail Settings → Forwarding and POP/IMAP." styles={styles} />
              <Step
                n={2}
                text="Click 'Add a forwarding address' and paste the address above. Save."
                styles={styles}
              />
              <Step
                n={3}
                text="Confirm Google's verification. If FolioLens captured the link, use the button below; if you confirmed in Gmail directly, just check this step."
                styles={styles}
              />
              <Step
                n={4}
                text="Create a Gmail filter for the CAS senders, then choose 'Forward it to' → your FolioLens import inbox."
                styles={styles}
              />
              <View style={styles.senderBox}>
                <Text style={styles.senderLabel}>Gmail filter search</Text>
                <Text style={[styles.senderQuery, styles.mono]} selectable>
                  {GMAIL_FILTER_QUERY}
                </Text>
                <View style={styles.senderRow}>
                  {GMAIL_CAS_SENDERS.map((sender) => (
                    <View key={sender} style={styles.senderPill}>
                      <Text style={styles.senderPillText}>{sender}</Text>
                    </View>
                  ))}
                </View>
              </View>
              <TouchableOpacity
                style={styles.linkRow}
                onPress={() => openExternal(GMAIL_FILTER_URL)}
                activeOpacity={0.7}
              >
                <Ionicons name="open-outline" size={14} color={cl.emeraldDeep} />
                <Text style={styles.linkText}>Open Gmail filter settings</Text>
              </TouchableOpacity>
              <Text style={styles.tabFooter}>
                Gmail Workspace users: an admin may have to allowlist external
                forwarding for your domain.
              </Text>
              <View style={styles.checklist}>
                <ChecklistRow
                  checked={autoForwardComplete || gmailChecklist.forwardingAddress}
                  title="I added the forwarding address"
                  detail="Pasted the FolioLens import inbox into Gmail's forwarding settings and saved."
                  onPress={() => toggleGmailChecklist('forwardingAddress')}
                  styles={styles}
                  cl={cl}
                />
                <ChecklistRow
                  checked={autoForwardComplete || gmailChecklist.verification}
                  title="I confirmed Google's verification"
                  detail="Clicked the link Gmail emailed to your import inbox so the address shows as Verified in Gmail's settings."
                  onPress={() => toggleGmailChecklist('verification')}
                  styles={styles}
                  cl={cl}
                />
                {pendingConfirmationUrl && !autoForwardComplete ? (
                  <TouchableOpacity
                    style={[styles.confirmCta, styles.inlineConfirmCta]}
                    onPress={handleConfirmGmail}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.confirmCtaText}>Open verification link</Text>
                    <Ionicons name="open-outline" size={14} color={cl.textOnDark} />
                  </TouchableOpacity>
                ) : null}
                <ChecklistRow
                  checked={autoForwardComplete || gmailChecklist.filter}
                  title="I created the CAMS / KFintech filter"
                  detail="Filter forwards matching CAS emails to my FolioLens import inbox."
                  onPress={() => toggleGmailChecklist('filter')}
                  styles={styles}
                  cl={cl}
                />
              </View>
              {!autoForwardComplete ? (
                <>
                  <TouchableOpacity
                    style={[
                      styles.completeBtn,
                      (!gmailChecklistComplete || savingComplete) && styles.completeBtnDisabled,
                    ]}
                    onPress={handleAutoForwardComplete}
                    activeOpacity={0.85}
                    disabled={!gmailChecklistComplete || savingComplete}
                  >
                    <Ionicons name="checkmark-circle-outline" size={16} color={cl.textOnDark} />
                    <Text style={styles.completeBtnText}>
                      {savingComplete ? 'Saving…' : 'Mark auto-forward ready'}
                    </Text>
                  </TouchableOpacity>
                  {completeError ? (
                    <Text style={styles.errorText}>{completeError}</Text>
                  ) : null}
                </>
              ) : null}
            </View>
          ) : null}

          {tab === 'outlook' ? (
            <View style={styles.tabBody}>
              <Step n={1} text="Open Outlook Settings → Mail → Rules → 'Add new rule'." styles={styles} />
              <Step
                n={2}
                text="Condition: From contains 'donotreply@camsonline.com' OR 'samfS@kfintech.com'."
                styles={styles}
              />
              <Step
                n={3}
                text="Action: 'Forward to' → your FolioLens import inbox. Save."
                styles={styles}
              />
              <TouchableOpacity
                style={styles.linkRow}
                onPress={() => openExternal(OUTLOOK_RULES_URL)}
                activeOpacity={0.7}
              >
                <Ionicons name="open-outline" size={14} color={cl.emeraldDeep} />
                <Text style={styles.linkText}>Open Outlook rules</Text>
              </TouchableOpacity>
              <Text style={styles.tabFooter}>
                Outlook applies the rule immediately — no destination
                verification. Microsoft 365 (work) accounts behave the same
                unless your tenant blocks external forwarding.
              </Text>
            </View>
          ) : null}

          {tab === 'other' ? (
            <View style={styles.tabBody}>
              <Text style={styles.tabBodyText}>
                <Text style={styles.bold}>iCloud Mail</Text> and{' '}
                <Text style={styles.bold}>Yahoo Mail (free)</Text> can&apos;t
                auto-forward only the CAS emails — please use manual forward
                instead.
              </Text>
              <Text style={styles.tabBodyText}>
                For other clients, look for a Filters / Rules / Server-side
                forwarding option. If your client requires verifying the
                destination, we capture the verification email and surface a
                &quot;Confirm&quot; button above this card the same way we do
                for Gmail.
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

function TabButton({
  label,
  active,
  onPress,
  styles,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <TouchableOpacity
      style={[styles.tab, active && styles.tabActive]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Step({
  n,
  text,
  styles,
}: {
  n: number;
  text: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.stepRow}>
      <View style={styles.stepNumWrap}>
        <Text style={styles.stepNum}>{n}</Text>
      </View>
      <Text style={styles.stepText}>{text}</Text>
    </View>
  );
}

function ChecklistRow({
  checked,
  title,
  detail,
  onPress,
  styles,
  cl,
}: {
  checked: boolean;
  title: string;
  detail: string;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
  cl: ClearLensTokens['colors'];
}) {
  return (
    <Pressable
      style={[styles.checkRow, checked && styles.checkRowDone]}
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
    >
      <View style={[styles.checkIcon, checked && styles.checkIconDone]}>
        <Ionicons
          name={checked ? 'checkmark' : 'ellipse-outline'}
          size={14}
          color={checked ? cl.textOnDark : cl.emeraldDeep}
        />
      </View>
      <View style={styles.checkCopy}>
        <Text style={styles.checkTitle}>{title}</Text>
        <Text style={styles.checkDetail}>{detail}</Text>
      </View>
    </Pressable>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    container: {
      paddingHorizontal: ClearLensSpacing.md,
      paddingBottom: ClearLensSpacing.xxl,
      gap: ClearLensSpacing.md,
    },
    header: {
      gap: 6,
      paddingTop: ClearLensSpacing.sm,
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
    howCard: {
      backgroundColor: cl.surfaceSoft,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
      gap: ClearLensSpacing.sm,
    },
    howRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: ClearLensSpacing.sm,
    },
    howNum: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: cl.mint50,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
    },
    howNumText: {
      fontSize: 12,
      fontFamily: ClearLensFonts.bold,
      color: cl.emeraldDeep,
    },
    howText: {
      flex: 1,
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
      lineHeight: 19,
    },
    howBold: {
      fontFamily: ClearLensFonts.bold,
    },
    addressCard: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.border,
      padding: ClearLensSpacing.md,
      gap: 8,
      ...ClearLensShadow,
    },
    addressLabel: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      fontFamily: ClearLensFonts.bold,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    addressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
    },
    addressValue: {
      flex: 1,
      fontSize: 14,
      color: cl.navy,
    },
    mono: { fontFamily: 'Courier' },
    copyBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: cl.mint50,
      borderRadius: ClearLensRadii.full,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    copyBtnActive: {
      backgroundColor: cl.positiveBg,
    },
    copyBtnText: {
      fontSize: 12,
      fontFamily: ClearLensFonts.bold,
      color: cl.emeraldDeep,
    },
    addressHint: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      lineHeight: 16,
    },
    confirmBanner: {
      flexDirection: 'row',
      gap: ClearLensSpacing.sm,
      backgroundColor: cl.positiveBg,
      borderWidth: 1,
      borderColor: cl.mint,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
    },
    confirmIconWrap: {
      width: 28,
      height: 28,
      alignItems: 'center',
      justifyContent: 'center',
    },
    confirmCopy: {
      flex: 1,
      gap: 6,
    },
    confirmTitle: {
      ...ClearLensTypography.body,
      color: cl.navy,
      fontFamily: ClearLensFonts.bold,
    },
    confirmBody: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
      lineHeight: 18,
    },
    confirmCta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      backgroundColor: cl.emeraldDeep,
      borderRadius: ClearLensRadii.full,
      paddingHorizontal: 14,
      paddingVertical: 8,
      marginTop: 4,
    },
    inlineConfirmCta: {
      marginTop: 0,
      marginLeft: 38,
    },
    confirmCtaText: {
      ...ClearLensTypography.bodySmall,
      color: cl.textOnDark,
      fontFamily: ClearLensFonts.bold,
    },
    manualCard: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.border,
      padding: ClearLensSpacing.md,
      gap: ClearLensSpacing.sm,
      ...ClearLensShadow,
    },
    manualHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      flexWrap: 'wrap',
    },
    manualBadge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: ClearLensRadii.sm,
      backgroundColor: cl.mint50,
    },
    manualBadgeText: {
      fontSize: 9,
      fontFamily: ClearLensFonts.bold,
      color: cl.emeraldDeep,
      letterSpacing: 0.4,
    },
    manualTitle: {
      ...ClearLensTypography.body,
      color: cl.navy,
      fontFamily: ClearLensFonts.bold,
    },
    manualBody: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
      lineHeight: 18,
    },
    expander: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 4,
    },
    expanderText: {
      ...ClearLensTypography.bodySmall,
      color: cl.emeraldDeep,
      fontFamily: ClearLensFonts.bold,
    },
    advancedCard: {
      backgroundColor: cl.surfaceSoft,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
      gap: ClearLensSpacing.md,
    },
    tabRow: {
      flexDirection: 'row',
      gap: 6,
    },
    tab: {
      flex: 1,
      paddingVertical: 8,
      borderRadius: ClearLensRadii.full,
      backgroundColor: cl.surface,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: cl.border,
    },
    tabActive: {
      backgroundColor: cl.emeraldDeep,
      borderColor: cl.emeraldDeep,
    },
    tabText: {
      ...ClearLensTypography.caption,
      color: cl.textSecondary,
      fontFamily: ClearLensFonts.bold,
    },
    tabTextActive: {
      color: cl.textOnDark,
    },
    tabBody: {
      gap: ClearLensSpacing.sm,
    },
    tabBodyText: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
      lineHeight: 18,
    },
    bold: {
      fontFamily: ClearLensFonts.bold,
      color: cl.navy,
    },
    stepRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: ClearLensSpacing.sm,
    },
    stepNumWrap: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: cl.mint50,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
    },
    stepNum: {
      fontSize: 11,
      fontFamily: ClearLensFonts.bold,
      color: cl.emeraldDeep,
    },
    stepText: {
      flex: 1,
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
      lineHeight: 18,
    },
    senderBox: {
      borderWidth: 1,
      borderColor: cl.border,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.surface,
      padding: ClearLensSpacing.sm,
      gap: 8,
    },
    senderLabel: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      fontFamily: ClearLensFonts.bold,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    senderQuery: {
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
      lineHeight: 18,
    },
    senderRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    senderPill: {
      borderRadius: ClearLensRadii.full,
      backgroundColor: cl.mint50,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    senderPillText: {
      ...ClearLensTypography.caption,
      color: cl.emeraldDeep,
      fontFamily: ClearLensFonts.bold,
    },
    checklist: {
      gap: 8,
      marginTop: 4,
    },
    checkRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: ClearLensSpacing.sm,
      borderWidth: 1,
      borderColor: cl.border,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.surface,
      padding: ClearLensSpacing.sm,
    },
    checkRowDone: {
      borderColor: cl.mint,
      backgroundColor: cl.positiveBg,
    },
    checkIcon: {
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: cl.mint50,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
    },
    checkIconDone: {
      backgroundColor: cl.emeraldDeep,
    },
    checkCopy: {
      flex: 1,
      gap: 2,
    },
    checkTitle: {
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
      fontFamily: ClearLensFonts.bold,
    },
    checkDetail: {
      ...ClearLensTypography.caption,
      color: cl.textSecondary,
      lineHeight: 16,
    },
    completeBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: cl.emeraldDeep,
      borderRadius: ClearLensRadii.full,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    completeBtnDisabled: {
      opacity: 0.48,
    },
    completeBtnText: {
      ...ClearLensTypography.bodySmall,
      color: cl.textOnDark,
      fontFamily: ClearLensFonts.bold,
    },
    errorText: {
      ...ClearLensTypography.caption,
      color: tokens.semantic.sentiment.negativeText,
      lineHeight: 16,
    },
    linkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 4,
    },
    linkText: {
      ...ClearLensTypography.bodySmall,
      color: cl.emeraldDeep,
      fontFamily: ClearLensFonts.bold,
    },
    tabFooter: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      lineHeight: 16,
      marginTop: 4,
    },
  });
}
