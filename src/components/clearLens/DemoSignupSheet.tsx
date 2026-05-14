import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
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
import { useResponsiveLayout } from '@/src/components/responsive';
import { useDemoSignup } from '@/src/hooks/useDemoSignup';
import {
  readEntryAttributionFromBrowser,
  type EntryAttribution,
} from '@/src/utils/entryAttribution';

/**
 * Gate that the auth screen mounts behind the "Try with sample data"
 * link. Captures email + (optional) marketing consent, POSTs to
 * `demo-signup`, and on success calls back to the parent so it can
 * flip `previewMode` and route into the tabs.
 *
 * Attribution (UTMs + referrer) is read once on first open. On native
 * we currently don't have deep-link UTMs surfaced; the EMPTY default
 * is fine — the rare native deep-link case can be added later.
 */
export function DemoSignupSheet({
  visible,
  onClose,
  onSuccess,
  attribution,
}: {
  visible: boolean;
  onClose: () => void;
  onSuccess: (info: { email: string; isReturning: boolean }) => void;
  attribution?: EntryAttribution;
}) {
  const tokens = useClearLensTokens();
  const { layout } = useResponsiveLayout();
  const isDesktop = layout === 'desktop';
  const styles = useMemo(() => makeStyles(tokens, isDesktop), [tokens, isDesktop]);
  const cl = tokens.colors;
  const [email, setEmail] = useState('');
  const [marketingConsent, setMarketingConsent] = useState(false);
  const { submit, isSubmitting, error, resetError } = useDemoSignup();
  const capturedAttribution = useRef<EntryAttribution | null>(null);

  // Lazy-read browser attribution the first time the sheet opens, so
  // callers don't have to plumb it. Caller-supplied `attribution` takes
  // priority — useful for native callers later.
  useEffect(() => {
    if (!visible) return;
    if (capturedAttribution.current) return;
    capturedAttribution.current =
      attribution ?? (Platform.OS === 'web' ? readEntryAttributionFromBrowser() : null);
  }, [visible, attribution]);

  async function handleSubmit() {
    resetError();
    const result = await submit({
      email,
      marketing_consent: marketingConsent,
      attribution:
        capturedAttribution.current ?? attribution ?? readEntryAttributionFromBrowser(),
    });
    if (result?.ok) {
      onSuccess({ email: email.trim().toLowerCase(), isReturning: result.isReturning });
    }
  }

  function handleClose() {
    if (isSubmitting) return;
    resetError();
    onClose();
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType={isDesktop ? 'fade' : 'slide'}
      onRequestClose={handleClose}
      accessibilityViewIsModal
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={styles.backdropTap} onPress={handleClose} />
        <View style={styles.sheet}>
          {!isDesktop && <View style={styles.handle} />}
          <View style={styles.titleRow}>
            <Text style={styles.title}>Try FolioLens with sample data</Text>
            <TouchableOpacity
              onPress={handleClose}
              disabled={isSubmitting}
              hitSlop={12}
              accessibilityLabel="Close"
              accessibilityRole="button"
            >
              <Ionicons name="close" size={22} color={cl.textTertiary} />
            </TouchableOpacity>
          </View>
          <Text style={styles.subtitle}>
            Drop your email to open the preview right away. We&apos;ll only email you
            if you tick the box below.
          </Text>

          <Text style={styles.label}>Email</Text>
          <TextInput
            style={[styles.input, error ? styles.inputError : null]}
            placeholder="you@example.com"
            placeholderTextColor={cl.textTertiary}
            value={email}
            onChangeText={(v) => {
              setEmail(v);
              if (error) resetError();
            }}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
            editable={!isSubmitting}
            returnKeyType="go"
            onSubmitEditing={handleSubmit}
          />

          <TouchableOpacity
            style={styles.consentRow}
            onPress={() => setMarketingConsent((v) => !v)}
            disabled={isSubmitting}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: marketingConsent }}
            activeOpacity={0.78}
          >
            <View style={[styles.checkbox, marketingConsent && styles.checkboxChecked]}>
              {marketingConsent && <Ionicons name="checkmark" size={14} color={cl.surface} />}
            </View>
            <Text style={styles.consentText}>
              I agree to receive early access and product update emails from FolioLens.
            </Text>
          </TouchableOpacity>

          {error && <Text style={styles.errorText}>{error}</Text>}

          <TouchableOpacity
            style={[styles.primaryButton, isSubmitting && styles.primaryButtonDisabled]}
            onPress={handleSubmit}
            disabled={isSubmitting}
            activeOpacity={0.85}
          >
            {isSubmitting ? (
              <ActivityIndicator color={cl.surface} />
            ) : (
              <Text style={styles.primaryButtonText}>Get preview access →</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.disclaimer}>
            We&apos;ll only contact you if you opt in above. No spam, no investment
            advice. Privacy policy at foliolens.in/privacy.html.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function makeStyles(tokens: ClearLensTokens, isDesktop: boolean) {
  const cl = tokens.colors;
  return StyleSheet.create({
    // Mobile: bottom-anchored sheet with rounded top corners.
    // Desktop: centered card with all-round corners + horizontal padding
    // around it so it doesn't kiss the viewport edges.
    backdrop: {
      flex: 1,
      justifyContent: isDesktop ? 'center' : 'flex-end',
      alignItems: 'center',
      paddingHorizontal: isDesktop ? ClearLensSpacing.lg : 0,
      backgroundColor: tokens.semantic.overlay.backdrop,
    },
    backdropTap: {
      ...StyleSheet.absoluteFillObject,
    },
    sheet: {
      width: '100%',
      maxWidth: isDesktop ? 480 : undefined,
      backgroundColor: cl.surface,
      borderTopLeftRadius: ClearLensRadii.xl,
      borderTopRightRadius: ClearLensRadii.xl,
      // Bottom corners are square on mobile (sheet hugs the viewport edge)
      // and rounded on desktop (it's a free-floating card).
      borderBottomLeftRadius: isDesktop ? ClearLensRadii.xl : 0,
      borderBottomRightRadius: isDesktop ? ClearLensRadii.xl : 0,
      paddingHorizontal: ClearLensSpacing.lg,
      paddingTop: isDesktop ? ClearLensSpacing.lg : ClearLensSpacing.sm,
      paddingBottom: isDesktop ? ClearLensSpacing.lg : ClearLensSpacing.xl,
      gap: ClearLensSpacing.sm,
      ...(isDesktop ? ClearLensShadow : null),
    },
    handle: {
      width: 44,
      height: 4,
      borderRadius: 999,
      alignSelf: 'center',
      backgroundColor: cl.border,
      marginBottom: ClearLensSpacing.sm,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: ClearLensSpacing.sm,
    },
    title: {
      ...ClearLensTypography.h2,
      fontFamily: ClearLensFonts.bold,
      color: cl.textPrimary,
      flex: 1,
    },
    subtitle: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      marginBottom: ClearLensSpacing.sm,
    },
    label: {
      ...ClearLensTypography.caption,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.textSecondary,
      marginTop: ClearLensSpacing.xs,
    },
    input: {
      height: 48,
      paddingHorizontal: ClearLensSpacing.sm,
      borderWidth: 1.5,
      borderColor: cl.border,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.background,
      color: cl.textPrimary,
      fontFamily: ClearLensFonts.regular,
      fontSize: 16,
    },
    inputError: {
      borderColor: tokens.semantic.sentiment.negative,
    },
    consentRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: ClearLensSpacing.sm,
      marginTop: ClearLensSpacing.xs,
    },
    checkbox: {
      width: 22,
      height: 22,
      borderWidth: 1.5,
      borderRadius: 5,
      borderColor: cl.border,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: cl.background,
      marginTop: 1,
    },
    checkboxChecked: {
      backgroundColor: cl.emerald,
      borderColor: cl.emerald,
    },
    consentText: {
      ...ClearLensTypography.caption,
      color: cl.textSecondary,
      flex: 1,
      lineHeight: 18,
    },
    errorText: {
      ...ClearLensTypography.caption,
      color: tokens.semantic.sentiment.negative,
      marginTop: 2,
    },
    primaryButton: {
      height: 52,
      borderRadius: ClearLensRadii.md,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: cl.emerald,
      marginTop: ClearLensSpacing.sm,
    },
    primaryButtonDisabled: {
      opacity: 0.6,
    },
    primaryButtonText: {
      ...ClearLensTypography.body,
      fontFamily: ClearLensFonts.bold,
      color: cl.surface,
    },
    disclaimer: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      fontSize: 11,
      lineHeight: 16,
      marginTop: ClearLensSpacing.xs,
    },
  });
}
