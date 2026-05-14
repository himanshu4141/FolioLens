import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '@/src/store/appStore';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensFonts,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';

/**
 * Persistent banner mounted under AuthGate when the user is in
 * preview ("try the app without signing up") mode. Sits below the
 * status-bar inset and above all screen content. Tapping the chip
 * exits preview and returns to /auth so the user can sign up properly.
 */
export function PreviewBanner() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const exitPreviewMode = useAppStore((s) => s.exitPreviewMode);

  function handleExit() {
    exitPreviewMode();
    router.replace('/auth');
  }

  return (
    <View style={[styles.banner, { paddingTop: insets.top + 6 }]}>
      <View style={styles.row}>
        <View style={styles.dot} />
        <Text style={styles.label}>Preview mode · sample portfolio</Text>
        <Pressable
          style={styles.exitButton}
          onPress={handleExit}
          accessibilityRole="button"
          accessibilityLabel="Exit preview and sign in"
        >
          <Text style={styles.exitText}>Sign up</Text>
          <Ionicons name="arrow-forward" size={13} color={tokens.colors.surface} />
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    banner: {
      backgroundColor: tokens.semantic.state.warning,
      paddingHorizontal: ClearLensSpacing.md,
      paddingBottom: 8,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
    },
    dot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: cl.surface,
    },
    label: {
      ...ClearLensTypography.caption,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.surface,
      flex: 1,
    },
    exitButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: cl.surface + '88',
    },
    exitText: {
      ...ClearLensTypography.caption,
      fontFamily: ClearLensFonts.bold,
      color: cl.surface,
    },
  });
}
