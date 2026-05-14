import { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '@/src/store/appStore';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';

/**
 * Inline banner the Tools Hub screens render at the top in preview mode.
 * Tells the user the output is a sample (so they don't think the
 * portfolio numbers are theirs) and points them at the sign-up CTA.
 *
 * Hidden when `previewMode` is false — callers can mount it
 * unconditionally and let the banner self-gate.
 */
export function ToolsPreviewBanner({ message }: { message: string }) {
  const router = useRouter();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const previewMode = useAppStore((s) => s.previewMode);
  const exitPreviewMode = useAppStore((s) => s.exitPreviewMode);

  if (!previewMode) return null;

  function handleSignUp() {
    exitPreviewMode();
    router.replace('/auth');
  }

  return (
    <View style={styles.banner}>
      <View style={styles.iconBubble}>
        <Ionicons name="eye-outline" size={16} color={tokens.colors.emerald} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.title}>Sample output</Text>
        <Text style={styles.body}>{message}</Text>
      </View>
      <TouchableOpacity
        style={styles.cta}
        onPress={handleSignUp}
        activeOpacity={0.78}
        accessibilityRole="button"
        accessibilityLabel="Sign up to use this tool with your portfolio"
      >
        <Text style={styles.ctaText}>Sign up</Text>
      </TouchableOpacity>
    </View>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      backgroundColor: cl.mint50,
      borderRadius: ClearLensRadii.lg,
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: ClearLensSpacing.sm,
    },
    iconBubble: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: cl.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    copy: {
      flex: 1,
      gap: 2,
    },
    title: {
      ...ClearLensTypography.bodySmall,
      fontFamily: ClearLensFonts.bold,
      color: cl.textPrimary,
    },
    body: {
      ...ClearLensTypography.caption,
      color: cl.textSecondary,
      lineHeight: 16,
    },
    cta: {
      paddingHorizontal: ClearLensSpacing.md,
      height: 32,
      borderRadius: ClearLensRadii.full,
      backgroundColor: cl.emerald,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ctaText: {
      ...ClearLensTypography.bodySmall,
      fontFamily: ClearLensFonts.bold,
      color: cl.surface,
    },
  });
}
