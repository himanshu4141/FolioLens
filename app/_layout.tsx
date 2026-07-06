import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import * as SystemUI from 'expo-system-ui';
import * as Updates from 'expo-updates';
import ExpoConstants from 'expo-constants';
import { Stack, usePathname, useRouter, useSegments } from 'expo-router';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter';
import {
  PERSIST_MAX_AGE_MS,
  __BUSTER__,
  persister,
  queryClient,
  shouldPersistQueryKey,
} from '@/src/lib/queryClient';
import { useSession } from '@/src/hooks/useSession';
import { authClient } from '@/src/lib/auth';
import { SessionProvider } from '@/src/context/SessionContext';
import { useAppStore } from '@/src/store/appStore';
import { clearOnboardingDraft } from '@/src/utils/onboardingDraft';
import { ThemeProvider, useTheme, useClearLensTokens } from '@/src/context/ThemeContext';
import { PreviewBanner } from '@/src/components/PreviewBanner';
import { PreviewExitConfirmModal } from '@/src/components/clearLens/PreviewExitConfirmModal';
import { AppDialog } from '@/src/components/clearLens/AppDialog';
import { featureFlags } from '@/src/lib/featureFlags';
import { isNativeMagicLinkUrl, parseSessionFromUrl } from '@/src/utils/authUtils';
import VercelInsights from '@/src/components/VercelInsights';
import { ErrorBoundary } from '@/src/components/ErrorBoundary';
import { NavigationPerformanceObserver } from '@/src/components/NavigationPerformanceObserver';
import { analytics } from '@/src/lib/analytics';
import { perfNow } from '@/src/lib/perfMark';
import { installGlobalErrorHandlers } from '@/src/lib/installGlobalErrorHandlers';
import { startAppLifecycle } from '@/src/lib/appLifecycle';
import { invalidateQueriesForSync, syncVisibleRoute } from '@/src/lib/syncInvalidation';
import {
  bootstrapForUser,
  clearAll as clearLocalDb,
  didSyncChangeData,
  syncDeltaForUser,
} from '@/src/lib/db/sync';

// Expo defines maybeCompleteAuthSession as a web-popup bridge only. Native
// completion is owned by openAuthSessionAsync plus the shared OAuth coordinator.
if (Platform.OS === 'web') WebBrowser.maybeCompleteAuthSession();

/**
 * Parse a magic-link deep-link URL and establish a Supabase session.
 *
 * Supabase magic links land at <scheme>://auth/confirm with the tokens in
 * the URL hash fragment, e.g.:
 *   foliolens-main://auth/confirm#access_token=xxx&refresh_token=yyy&type=magiclink
 *
 * On native `detectSessionInUrl` is false so Supabase won't pick these up
 * automatically — we parse and forward them ourselves.
 *
 * Google OAuth callbacks are deliberately ignored here. WebBrowser and Expo
 * Router can both receive them, so they go through the one process-wide OAuth
 * completion coordinator instead of this magic-link listener.
 */
function handleAuthDeepLink(url: string) {
  if (!isNativeMagicLinkUrl(url)) return;
  const sessionTokens = parseSessionFromUrl(url);
  if (sessionTokens) {
    authClient.setSession({
      access_token: sessionTokens.accessToken,
      refresh_token: sessionTokens.refreshToken,
    });
  }
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession();
  const previewMode = useAppStore((s) => s.previewMode);
  const exitPreviewMode = useAppStore((s) => s.exitPreviewMode);
  const segments = useSegments();
  const router = useRouter();

  // Defense-in-depth: if the preview-mode feature flag is off but
  // `previewMode` is persisted from a previous build that had the
  // flag on, force-exit on mount. The auth-screen entry CTA is the
  // only normal way to enter preview, but a hot-flip of the flag
  // shouldn't leave existing users stranded inside a preview the
  // build no longer ships.
  useEffect(() => {
    if (!featureFlags.previewMode && previewMode) {
      exitPreviewMode();
    }
  }, [previewMode, exitPreviewMode]);

  useEffect(() => {
    if (loading) return;

    const inAuthGroup = segments[0] === 'auth';
    const hasAccess = !!session || previewMode;

    if (!hasAccess && !inAuthGroup) {
      router.replace('/auth');
    } else if (hasAccess && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [session, loading, previewMode, segments, router]);

  return (
    <>
      {previewMode && <PreviewBanner />}
      {children}
      <PreviewExitConfirmModal />
      <AppDialog />
    </>
  );
}

function useAppLifecycle() {
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const { getCurrentSession, subscribeToAuth } = useSession();

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    return startAppLifecycle({
      analytics,
      appStartedMetadata: {
        appVersion: ExpoConstants.expoConfig?.version ?? null,
        easUpdateId: Updates.updateId ?? null,
        easUpdateCreatedAt: Updates.createdAt?.toISOString() ?? null,
        isEmbeddedLaunch: Updates.isEmbeddedLaunch,
        platform: Platform.OS,
      },
      isSqliteSupported: Platform.OS !== 'web',
      now: Date.now,
      installGlobalErrorHandlers,
      getSession: getCurrentSession,
      subscribeToAuth,
      subscribeToAppState: (handler) => {
        const subscription = AppState.addEventListener('change', (state) => {
          if (state === 'active' || state === 'background' || state === 'inactive') {
            handler(state);
          }
        });
        return () => subscription.remove();
      },
      bootstrapForUser,
      syncDeltaForUser,
      didSyncChangeData,
      clearLocalDb,
      clearQueryClient: () => queryClient.clear(),
      invalidateQueries: (result) => invalidateQueriesForSync(
        queryClient,
        result,
        syncVisibleRoute(pathnameRef.current),
      ),
      removePersistedClient: () => persister.removeClient(),
      resetUserScopedState: () => useAppStore.getState().resetUserScopedState(),
      clearOnboardingDraft,
      getLocalTransactionCount: async () => {
        if (Platform.OS === 'web') return null;
        try {
          const txRepo = await import('@/src/lib/db/tx');
          return await txRepo.count();
        } catch {
          return null;
        }
      },
      warn: (message, error) => console.warn(message, error),
    });
  }, [getCurrentSession, subscribeToAuth]);
}

export default function RootLayout() {
  return (
    <SessionProvider>
      <RootLayoutContent />
    </SessionProvider>
  );
}

function RootLayoutContent() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
  });

  useAppLifecycle();

  useEffect(() => {
    // Web: Supabase handles the hash fragment natively via detectSessionInUrl
    if (Platform.OS === 'web') return;

    // Cold-start: app was launched by tapping the magic link
    Linking.getInitialURL().then((url) => {
      if (url) handleAuthDeepLink(url);
    });

    // Warm-start: app was already open when the link arrived
    const subscription = Linking.addEventListener('url', ({ url }) => handleAuthDeepLink(url));
    return () => subscription.remove();
  }, []);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <ErrorBoundary>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          buster: __BUSTER__,
          maxAge: PERSIST_MAX_AGE_MS,
          dehydrateOptions: {
            shouldDehydrateQuery: (query) => shouldPersistQueryKey(query.queryKey),
          },
        }}
        onSuccess={() => {
          // Fires once after rehydration finishes (success path). The log
          // is the field-debugging signal for "is the OTA bundle running
          // the new persister wiring at all?" — without it, a perceived
          // slow load on the user's device is impossible to attribute
          // between "cache miss" and "OTA never applied".
          console.log('[persister] cache restored', { buster: __BUSTER__ });
          perfNow('persister:restored', { buster: __BUSTER__ });
          analytics.track('persister_restored', { buster: __BUSTER__ });
        }}
        onError={() => {
          // Restoration errors (corrupt JSON, AsyncStorage read failure)
          // are non-fatal — the app continues with an empty cache. The
          // rich `persister_restore_failed` analytics event (error
          // name / message / blob size) is emitted from the persister
          // wrapper in `queryClient.ts` where we still hold the actual
          // exception; this callback only fires the perfMark so the
          // local-dev console line + perf timeline still surface it.
          console.warn('[persister] cache restore failed', { buster: __BUSTER__ });
          perfNow('persister:restore_failed', { buster: __BUSTER__ });
        }}
      >
        <ThemeProvider>
          <ThemedAppShell />
          <VercelInsights />
        </ThemeProvider>
      </PersistQueryClientProvider>
    </ErrorBoundary>
  );
}

function ThemedAppShell() {
  const { resolvedScheme } = useTheme();
  const clearLens = useClearLensTokens();

  useEffect(() => {
    // Sync the underlying system UI background so the splash transition and
    // pull-to-refresh halo match the resolved scheme.
    SystemUI.setBackgroundColorAsync(clearLens.colors.background).catch(() => {});
  }, [clearLens.colors.background]);

  return (
    <SafeAreaProvider>
      <StatusBar style={resolvedScheme === 'dark' ? 'light' : 'dark'} />
      {/*
        The `key` forces a remount on scheme change so module-level
        StyleSheet.create blocks (which capture token values once) re-evaluate
        with the new palette. Cost: transient UI state (modals, scroll
        position) resets when the user toggles light/dark — acceptable for a
        rare preference change.
      */}
      <AuthGate key={resolvedScheme}>
        <NavigationPerformanceObserver />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: clearLens.colors.background } }}>
          <Stack.Screen name="auth" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="fund/[id]" options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="money-trail" options={{ headerShown: false }} />
          <Stack.Screen name="portfolio-insights" options={{ headerShown: true, title: 'Portfolio Insights' }} />
          <Stack.Screen name="onboarding" />
          <Stack.Screen name="tools" />
        </Stack>
      </AuthGate>
    </SafeAreaProvider>
  );
}
