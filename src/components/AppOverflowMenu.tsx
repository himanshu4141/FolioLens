import { useMemo } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { authClient } from '@/src/lib/auth';
import { useAppStore } from '@/src/store/appStore';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';

interface AppOverflowMenuProps {
  visible: boolean;
  onClose: () => void;
  onImport: () => void;
  // Money Trail and Tools are required so every screen surfaces the same
  // Quick Actions menu — preventing the per-screen drift we shipped before
  // (some screens omitted Money Trail, some omitted Tools).
  onMoneyTrail: () => void;
  onTools: () => void;
  onSettings: () => void;
  // When the user has no holdings yet, the same destination is the
  // first-time import flow — so swap the label/icon back to "Import"
  // instead of "Refresh" to avoid implying there's something to refresh.
  hasPortfolio?: boolean;
}

type RowConfig = {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
};

export function AppOverflowMenu({
  visible,
  onClose,
  onImport,
  onMoneyTrail,
  onSettings,
  onTools,
  hasPortfolio = true,
}: AppOverflowMenuProps) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const cl = tokens.colors;
  const router = useRouter();
  const previewMode = useAppStore((s) => s.previewMode);
  const exitPreviewMode = useAppStore((s) => s.exitPreviewMode);

  function dismissAnd(action: () => void) {
    return () => {
      onClose();
      action();
    };
  }

  async function handleSignOut() {
    onClose();
    if (previewMode) {
      exitPreviewMode();
      router.replace('/auth');
      return;
    }
    const { error } = await authClient.signOut();
    if (error) {
      Alert.alert('Sign out failed', error.message);
    }
  }

  // In preview mode the import action would push the user into a sign-up
  // flow they haven't asked for — drop the row instead so the menu is
  // honest about what's available without an account.
  const dataActions: RowConfig[] = previewMode
    ? []
    : [
        {
          key: 'import',
          icon: hasPortfolio ? 'refresh-outline' : 'cloud-upload-outline',
          // First-time users land here with no holdings — show "Import" so the
          // CTA matches the empty-state action. Returning users see "Refresh"
          // since they'll mostly use this to pull in fresh CAS transactions.
          label: hasPortfolio ? 'Refresh portfolio' : 'Import portfolio',
          onPress: dismissAnd(onImport),
        },
      ];

  const navActions: RowConfig[] = [
    { key: 'trail', icon: 'trail-sign-outline', label: 'Money Trail', onPress: dismissAnd(onMoneyTrail) },
    { key: 'tools', icon: 'construct-outline', label: 'Tools', onPress: dismissAnd(onTools) },
    { key: 'settings', icon: 'settings-outline', label: 'Settings', onPress: dismissAnd(onSettings) },
  ];

  const destructiveActions: RowConfig[] = [
    {
      key: 'signout',
      icon: 'log-out-outline',
      label: previewMode ? 'Exit preview' : 'Log out',
      onPress: handleSignOut,
      danger: true,
    },
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Quick actions</Text>

          {dataActions.length > 0 && (
            <>
              <RowGroup
                rows={dataActions}
                styles={styles}
                dangerColor={cl.negative}
                textColor={cl.textPrimary}
              />
              <View style={styles.groupDivider} />
            </>
          )}
          <RowGroup
            rows={navActions}
            styles={styles}
            dangerColor={cl.negative}
            textColor={cl.textPrimary}
          />
          <View style={styles.groupDivider} />
          <RowGroup
            rows={destructiveActions}
            styles={styles}
            dangerColor={cl.negative}
            textColor={cl.textPrimary}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function RowGroup({
  rows,
  styles,
  dangerColor,
  textColor,
}: {
  rows: RowConfig[];
  styles: ReturnType<typeof makeStyles>;
  dangerColor: string;
  textColor: string;
}) {
  return (
    <View>
      {rows.map((row) => {
        const labelColor = row.danger ? dangerColor : textColor;
        return (
          <TouchableOpacity
            key={row.key}
            style={styles.item}
            onPress={row.onPress}
            disabled={row.disabled}
            activeOpacity={0.76}
          >
            <View style={styles.itemIcon}>
              <Ionicons name={row.icon} size={20} color={labelColor} />
            </View>
            <Text style={[styles.itemText, { color: labelColor }]}>{row.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: tokens.semantic.overlay.backdrop,
    },
    sheet: {
      borderWidth: 1,
      borderTopLeftRadius: ClearLensRadii.xl,
      borderTopRightRadius: ClearLensRadii.xl,
      paddingTop: ClearLensSpacing.sm,
      paddingBottom: ClearLensSpacing.lg,
      overflow: 'hidden',
      backgroundColor: cl.surface,
      borderColor: cl.border,
      ...ClearLensShadow,
    },
    sheetHandle: {
      width: 44,
      height: 4,
      borderRadius: 999,
      alignSelf: 'center',
      marginBottom: ClearLensSpacing.sm,
      backgroundColor: cl.border,
    },
    sheetTitle: {
      ...ClearLensTypography.h2,
      fontFamily: ClearLensFonts.bold,
      color: cl.textPrimary,
      paddingHorizontal: ClearLensSpacing.md,
      paddingBottom: ClearLensSpacing.sm,
    },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: 12,
    },
    itemIcon: {
      width: 24,
      alignItems: 'center',
    },
    itemText: {
      ...ClearLensTypography.body,
      fontFamily: ClearLensFonts.medium,
      flex: 1,
    },
    groupDivider: {
      height: 1,
      marginHorizontal: ClearLensSpacing.md,
      marginVertical: 6,
      backgroundColor: cl.border,
    },
  });
}
