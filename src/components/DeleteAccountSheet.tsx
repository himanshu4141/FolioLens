import { useEffect, useMemo, useState } from 'react';
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
import { useRouter } from 'expo-router';
import { useDeleteAccount } from '@/src/hooks/useDeleteAccount';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';

interface DeleteAccountSheetProps {
  visible: boolean;
  email: string | null;
  onClose: () => void;
}

export function DeleteAccountSheet({ visible, email, onClose }: DeleteAccountSheetProps) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const router = useRouter();
  const [confirmInput, setConfirmInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const deleteMutation = useDeleteAccount();

  // Reset transient state every time the sheet is reopened so a previous
  // failed attempt doesn't bleed into a fresh confirmation.
  useEffect(() => {
    if (visible) {
      setConfirmInput('');
      setError(null);
    }
  }, [visible]);

  const trimmedInput = confirmInput.trim().toLowerCase();
  const trimmedEmail = (email ?? '').trim().toLowerCase();
  const canDelete = !!trimmedEmail && trimmedInput === trimmedEmail && !deleteMutation.isPending;

  async function handleDelete() {
    if (!canDelete) return;
    setError(null);
    try {
      await deleteMutation.mutateAsync();
      onClose();
      router.replace('/auth');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete account.');
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.kbAvoid}
          pointerEvents="box-none"
        >
          <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
            <View style={styles.handle} />
            <View style={styles.header}>
              <Text style={styles.title}>Delete account</Text>
              <TouchableOpacity onPress={onClose} style={styles.closeButton} activeOpacity={0.76}>
                <Ionicons name="close" size={20} color={tokens.colors.navy} />
              </TouchableOpacity>
            </View>

            <View style={styles.warningBox}>
              <Ionicons
                name="warning-outline"
                size={20}
                color={tokens.semantic.sentiment.negativeText}
              />
              <Text style={styles.warningText}>
                This permanently removes your FolioLens account, profile, imported portfolio, and
                feedback history. It cannot be undone.
              </Text>
            </View>

            <Text style={styles.bodyText}>
              Type <Text style={styles.bodyEmphasis}>{email ?? 'your email'}</Text> to confirm.
            </Text>

            <TextInput
              value={confirmInput}
              onChangeText={setConfirmInput}
              placeholder={email ?? 'your email'}
              placeholderTextColor={tokens.colors.textTertiary}
              style={styles.input}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              keyboardType="email-address"
              editable={!deleteMutation.isPending}
            />

            {error ? (
              <View style={styles.errorBox}>
                <Ionicons
                  name="alert-circle-outline"
                  size={16}
                  color={tokens.semantic.sentiment.negativeText}
                />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              style={[styles.deleteButton, !canDelete && styles.deleteButtonDisabled]}
              onPress={handleDelete}
              disabled={!canDelete}
              activeOpacity={0.82}
            >
              {deleteMutation.isPending ? (
                <ActivityIndicator size="small" color={tokens.colors.textOnDark} />
              ) : (
                <Text style={styles.deleteButtonText}>Delete my account</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity onPress={onClose} style={styles.cancelButton} activeOpacity={0.7}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(10, 20, 48, 0.32)',
    },
    kbAvoid: { width: '100%' },
    sheet: {
      paddingHorizontal: ClearLensSpacing.md,
      paddingTop: ClearLensSpacing.sm,
      paddingBottom: ClearLensSpacing.lg,
      backgroundColor: cl.surface,
      borderTopLeftRadius: ClearLensRadii.xl,
      borderTopRightRadius: ClearLensRadii.xl,
      borderWidth: 1,
      borderColor: cl.border,
      ...ClearLensShadow,
    },
    handle: {
      width: 44,
      height: 4,
      borderRadius: 999,
      backgroundColor: cl.border,
      alignSelf: 'center',
      marginBottom: ClearLensSpacing.sm,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: ClearLensSpacing.md,
    },
    title: {
      ...ClearLensTypography.h2,
      color: cl.navy,
    },
    closeButton: {
      width: 34,
      height: 34,
      borderRadius: ClearLensRadii.full,
      backgroundColor: cl.surfaceSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    warningBox: {
      flexDirection: 'row',
      gap: ClearLensSpacing.sm,
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.md,
      backgroundColor: tokens.semantic.sentiment.negativeSurface,
      marginBottom: ClearLensSpacing.md,
    },
    warningText: {
      ...ClearLensTypography.bodySmall,
      color: tokens.semantic.sentiment.negativeText,
      flex: 1,
      lineHeight: 18,
    },
    bodyText: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      marginBottom: ClearLensSpacing.sm,
    },
    bodyEmphasis: {
      color: cl.navy,
      fontFamily: ClearLensFonts.semiBold,
    },
    input: {
      ...ClearLensTypography.body,
      minHeight: 46,
      borderRadius: ClearLensRadii.md,
      borderWidth: 1,
      borderColor: cl.border,
      paddingHorizontal: ClearLensSpacing.md,
      color: cl.navy,
      backgroundColor: cl.surface,
      marginBottom: ClearLensSpacing.md,
    },
    errorBox: {
      flexDirection: 'row',
      gap: 6,
      alignItems: 'center',
      marginBottom: ClearLensSpacing.sm,
    },
    errorText: {
      ...ClearLensTypography.bodySmall,
      color: tokens.semantic.sentiment.negativeText,
      flex: 1,
    },
    deleteButton: {
      minHeight: 50,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.negative,
    },
    deleteButtonDisabled: {
      opacity: 0.4,
    },
    deleteButtonText: {
      ...ClearLensTypography.body,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.textOnDark,
    },
    cancelButton: {
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: ClearLensSpacing.xs,
    },
    cancelButtonText: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
    },
  });
}

export default DeleteAccountSheet;
