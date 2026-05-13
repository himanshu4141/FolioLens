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
 * Generic styled dialog mounted once at the app root. Reads from
 * `useAppStore` → `dialog`. Callers use the `useAlertDialog` /
 * `useConfirmDialog` hooks from `src/hooks/useDialog.ts` to stage a
 * request.
 *
 * Replaces every `Alert.alert` / `window.confirm` / `window.alert` in
 * the app — those rendered un-styled OS chrome (or silently no-op'd on
 * react-native-web) which read as un-professional inside an otherwise
 * design-system-styled app.
 *
 * Layout mirrors `DemoSignupSheet` + `PreviewExitConfirmModal`: bottom-
 * anchored sheet on mobile, centered card on desktop.
 */
export function AppDialog() {
  const tokens = useClearLensTokens();
  const { layout } = useResponsiveLayout();
  const isDesktop = layout === 'desktop';
  const styles = useMemo(() => makeStyles(tokens, isDesktop), [tokens, isDesktop]);
  const dialog = useAppStore((s) => s.dialog);
  const hideDialog = useAppStore((s) => s.hideDialog);

  if (!dialog) {
    return (
      <Modal visible={false} transparent>
        <View />
      </Modal>
    );
  }

  function handleConfirm() {
    if (!dialog) return;
    hideDialog();
    dialog.onConfirm?.();
  }

  function handleCancel() {
    if (!dialog) return;
    hideDialog();
    dialog.onCancel?.();
  }

  // For an "alert" (single OK), the primary action is just to dismiss —
  // there's no caller-supplied onConfirm. We still route through
  // handleConfirm so future callers can pass one.
  const okText = dialog.okText ?? (dialog.kind === 'alert' ? 'OK' : 'Confirm');
  const cancelText = dialog.cancelText ?? 'Cancel';

  return (
    <Modal
      visible
      transparent
      animationType={isDesktop ? 'fade' : 'slide'}
      onRequestClose={handleCancel}
      accessibilityViewIsModal
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={styles.backdropTap} onPress={handleCancel} accessibilityLabel="Close" />
        <View style={styles.sheet} accessibilityRole="alert">
          {!isDesktop && <View style={styles.handle} />}
          <Text style={styles.title}>{dialog.title}</Text>
          {dialog.body ? <Text style={styles.body}>{dialog.body}</Text> : null}
          <View style={styles.buttonRow}>
            {dialog.kind === 'confirm' ? (
              <TouchableOpacity
                style={[styles.button, styles.buttonSecondary]}
                onPress={handleCancel}
                activeOpacity={0.78}
                accessibilityRole="button"
              >
                <Text style={styles.buttonSecondaryText}>{cancelText}</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[
                styles.button,
                dialog.destructive ? styles.buttonDestructive : styles.buttonPrimary,
              ]}
              onPress={handleConfirm}
              activeOpacity={0.85}
              accessibilityRole="button"
            >
              <Text
                style={
                  dialog.destructive ? styles.buttonDestructiveText : styles.buttonPrimaryText
                }
              >
                {okText}
              </Text>
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
      ...(isDesktop ? ClearLensShadow : null),
    },
    handle: {
      width: 44,
      height: 4,
      borderRadius: 999,
      backgroundColor: cl.border,
      alignSelf: 'center',
      marginBottom: ClearLensSpacing.xs,
    },
    title: {
      ...ClearLensTypography.h2,
      fontFamily: ClearLensFonts.bold,
      color: cl.textPrimary,
    },
    body: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      lineHeight: 22,
    },
    buttonRow: {
      flexDirection: 'row',
      gap: ClearLensSpacing.sm,
      marginTop: ClearLensSpacing.sm,
      justifyContent: 'flex-end',
    },
    button: {
      minWidth: 96,
      paddingHorizontal: ClearLensSpacing.md,
      height: 44,
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
    buttonDestructive: {
      backgroundColor: tokens.semantic.sentiment.negative,
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
    buttonDestructiveText: {
      ...ClearLensTypography.body,
      fontFamily: ClearLensFonts.bold,
      color: cl.surface,
    },
  });
}
