import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useAppStore } from '@/src/store/appStore';

/**
 * Preview-mode gate for any "Import portfolio" / "Onboarding" entry point.
 *
 * In preview mode the onboarding flow can't run (no real auth user, every
 * Supabase query hangs or rejects), so the UI used to land users on a
 * spinner that never resolved. This hook lets each entry point intercept
 * the press: if `gate()` returns `true`, the gate was shown and the
 * caller should NOT navigate. If it returns `false`, normal-mode logic
 * proceeds (callers do their original `router.push(...)`).
 *
 * The gate UI itself lives in `PreviewExitConfirmModal`, mounted once at
 * the app root and driven by `importGateVisible` on the app store. This
 * hook just flips the flag — replaces the older `Alert.alert` /
 * `window.confirm` path which rendered un-styled OS chrome inside an
 * otherwise design-system-styled app.
 */
export function useImportPreviewGate(): () => boolean {
  const previewMode = useAppStore((s) => s.previewMode);
  const showImportGate = useAppStore((s) => s.showImportGate);

  return useCallback((): boolean => {
    if (!previewMode) return false;
    showImportGate();
    return true;
  }, [previewMode, showImportGate]);
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
