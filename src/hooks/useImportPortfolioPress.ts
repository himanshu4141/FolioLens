import { useCallback } from 'react';
import { Alert, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useAppStore } from '@/src/store/appStore';

/**
 * Preview-mode gate for any "Import portfolio" / "Onboarding" entry point.
 *
 * In preview mode the onboarding flow can't run (no real auth user, every
 * Supabase query hangs or rejects), so the UI used to land users on a
 * spinner that never resolved. This hook lets each entry point intercept
 * the press: if `gate()` returns `true`, the alert was shown and the
 * caller should NOT navigate. If it returns `false`, normal-mode logic
 * proceeds (callers do their original `router.push(...)`).
 *
 * The alert offers two options: stay in preview, or sign up — which exits
 * preview and routes to /auth.
 */
export function useImportPreviewGate(): () => boolean {
  const router = useRouter();
  const previewMode = useAppStore((s) => s.previewMode);
  const exitPreviewMode = useAppStore((s) => s.exitPreviewMode);

  return useCallback((): boolean => {
    if (!previewMode) return false;

    const exitToAuth = () => {
      exitPreviewMode();
      router.replace('/auth');
    };

    // React Native's Alert isn't available on web; window.confirm is.
    if (Platform.OS === 'web') {
      const ok =
        typeof window !== 'undefined'
          ? window.confirm(
              "Sign up to import your real portfolio.\n\nYou're currently in preview mode with sample data — importing requires a FolioLens account.",
            )
          : false;
      if (ok) exitToAuth();
      return true;
    }

    Alert.alert(
      'Sign up to import your portfolio',
      "You're currently in preview mode with sample data. Importing your real portfolio requires a FolioLens account.",
      [
        { text: 'Stay in preview', style: 'cancel' },
        { text: 'Sign up', onPress: exitToAuth },
      ],
    );
    return true;
  }, [previewMode, router, exitPreviewMode]);
}

/**
 * Convenience wrapper: returns a press handler that either shows the
 * preview-mode alert or pushes to `/onboarding`. Use this for entry
 * points that have no extra route params.
 */
export function useImportPortfolioPress(): () => void {
  const router = useRouter();
  const gate = useImportPreviewGate();
  return useCallback(() => {
    if (gate()) return;
    router.push('/onboarding');
  }, [gate, router]);
}
