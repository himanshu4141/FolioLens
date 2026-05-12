import { useMemo } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '@/src/store/appStore';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { useResponsiveLayout } from '@/src/components/responsive';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';

/**
 * Confirm dialog shown when a preview-mode user taps any "Import
 * portfolio" entry point. Replaces the previous `Alert.alert` (native)
 * and `window.confirm` (web) — both of which read as un-styled OS chrome
 * inside an otherwise design-system-styled app.
 *
 * Visibility is driven by `importGateVisible` on the app store. The
 * hook that fires this (`useImportPreviewGate`) toggles the flag from
 * anywhere; this component is mounted once at the root.
 *
 * Layout mirrors `DemoSignupSheet`: bottom-anchored sheet on mobile,
 * centered card on desktop, so the gate matches the rest of the app's
 * modal vocabulary.
 */
export function PreviewExitConfirmModal() {
  const router = useRouter();
  const tokens = useClearLensTokens();
  const { layout } = useResponsiveLayout();
  const isDesktop = layout === 'desktop';
  const styles = useMemo(() => makeStyles(tokens, isDesktop), [tokens, isDesktop]);
  const cl = tokens.colors;
  const visible = useAppStore((s) => s.importGateVisible);
  const hide = useAppStore((s) => s.hideImportGate);
  const exitPreviewMode = useAppStore((s) => s.exitPreviewMode);

  function handleStay() {
    hide();
  }

  function handleSignUp() {
    hide();
    exitPreviewMode();
    router.replace('/auth');
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType={isDesktop ? 'fade' : 'slide'}
      onRequestClose={hide}
      accessibilityViewIsModal
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={styles.backdropTap} onPress={hide} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          {!isDesktop && <View style={styles.handle} />}
          <View style={styles.iconBubble}>
            <Ionicons name="cloud-upload-outline" size={22} color={cl.emerald} />
          </View>
          <Text style={styles.title}>Sign up to import</Text>
          <Text style={styles.body}>
            Preview mode uses sample data. Importing your real portfolio needs a
            FolioLens account — it&apos;s free and takes a moment.
          </Text>
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.buttonSecondary]}
              onPress={handleStay}
              activeOpacity={0.78}
              accessibilityRole="button"
            >
              <Text style={styles.buttonSecondaryText}>Stay in preview</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.buttonPrimary]}
              onPress={handleSignUp}
              activeOpacity={0.85}
              accessibilityRole="button"
            >
              <Text style={styles.buttonPrimaryText}>Sign up</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function makeStyles(tokens: ClearLensTokens, isDesktop: boolean) {
  const cl = tokens.colors;
  return StyleSheet.create({
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
      maxWidth: isDesktop ? 420 : undefined,
      backgroundColor: cl.surface,
      borderTopLeftRadius: ClearLensRadii.xl,
      borderTopRightRadius: ClearLensRadii.xl,
      borderBottomLeftRadius: isDesktop ? ClearLensRadii.xl : 0,
      borderBottomRightRadius: isDesktop ? ClearLensRadii.xl : 0,
      paddingHorizontal: ClearLensSpacing.lg,
      paddingTop: isDesktop ? ClearLensSpacing.lg : ClearLensSpacing.sm,
      paddingBottom: isDesktop ? ClearLensSpacing.lg : ClearLensSpacing.xl,
      gap: ClearLensSpacing.sm,
      alignItems: 'center',
      ...(isDesktop ? ClearLensShadow : null),
    },
    handle: {
      width: 44,
      height: 4,
      borderRadius: 999,
      backgroundColor: cl.border,
      marginBottom: ClearLensSpacing.xs,
    },
    iconBubble: {
      width: 48,
      height: 48,
      borderRadius: ClearLensRadii.full,
      backgroundColor: cl.mint50,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: ClearLensSpacing.xs,
    },
    title: {
      ...ClearLensTypography.h2,
      fontFamily: ClearLensFonts.bold,
      color: cl.textPrimary,
      textAlign: 'center',
    },
    body: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      textAlign: 'center',
      lineHeight: 22,
      paddingHorizontal: ClearLensSpacing.xs,
    },
    buttonRow: {
      flexDirection: 'row',
      gap: ClearLensSpacing.sm,
      marginTop: ClearLensSpacing.sm,
      width: '100%',
    },
    button: {
      flex: 1,
      height: 48,
      borderRadius: ClearLensRadii.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonSecondary: {
      backgroundColor: cl.surfaceSoft,
      borderWidth: 1,
      borderColor: cl.border,
    },
    buttonPrimary: {
      backgroundColor: cl.emerald,
    },
    buttonSecondaryText: {
      ...ClearLensTypography.body,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.textPrimary,
    },
    buttonPrimaryText: {
      ...ClearLensTypography.body,
      fontFamily: ClearLensFonts.bold,
      color: cl.surface,
    },
  });
}
