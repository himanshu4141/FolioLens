import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus, Platform } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import * as SystemUI from 'expo-system-ui';
import * as Updates from 'expo-updates';
import ExpoConstants from 'expo-constants';
import { Stack, useRouter, useSegments } from 'expo-router';
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
import { useAppStore } from '@/src/store/appStore';
import { clearOnboardingDraft } from '@/src/utils/onboardingDraft';
import { ThemeProvider, useTheme, useClearLensTokens } from '@/src/context/ThemeContext';
import { PreviewBanner } from '@/src/components/PreviewBanner';
import { PreviewExitConfirmModal } from '@/src/components/clearLens/PreviewExitConfirmModal';
import { AppDialog } from '@/src/components/clearLens/AppDialog';
import { featureFlags } from '@/src/lib/featureFlags';
import { parseSessionFromUrl } from '@/src/utils/authUtils';
import VercelInsights from '@/src/components/VercelInsights';
import { ErrorBoundary } from '@/src/components/ErrorBoundary';
import { analytics } from '@/src/lib/analytics';
import { perfNow } from '@/src/lib/perfMark';
import { installGlobalErrorHandlers } from '@/src/lib/installGlobalErrorHandlers';
import {
  bootstrapForUser,
  clearAll as clearLocalDb,
  syncDeltaForUser,
} from '@/src/lib/db/sync';

// Required for expo-web-browser openAuthSessionAsync to complete on Android.
// When Chrome Custom Tabs redirects to the app's active scheme, Android opens the app via
// the deep link. This call detects that URL and resolves the pending
// openAuthSessionAsync promise. Without it, the promise never settles on Android.
WebBrowser.maybeCompleteAuthSession();

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
 * NOTE: Google OAuth (PKCE) callbacks do NOT flow through this function.
 * They arrive as <scheme>://auth/callback?code=... and are handled entirely
 * within app/auth/callback.tsx, which calls authClient.exchangeCodeForSession.
 * The openAuthSessionAsync call in auth/index.tsx returns the URL directly,
 * so the Linking listener below never fires for OAuth callbacks.
 */
function handleAuthDeepLink(url: string) {
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

// Threshold for the `app_returned` event. Anything shorter than this is a
// brief OS interruption (notification, control centre) we don't count as
// a "return" — only resumes after at least 5 minutes of background time.
const APP_RETURNED_THRESHOLD_MS = 5 * 60 * 1000;

// Throttle for the foreground delta sync. Lower than the analytics
// threshold above on purpose: a user who uploaded a CAS on web and
// switched to mobile within a minute should still see the new portfolio
// value when the app comes back to foreground. The throttle just stops
// a tap-back-from-control-centre from spamming Supabase every few
// seconds.
const FOREGROUND_SYNC_MIN_INTERVAL_MS = 30 * 1000;

function useAnalyticsLifecycle() {
  // Tracks the last time the app was in foreground; used to compute the
  // gap before emitting `app_returned`. Initialised on mount.
  const lastActiveAtRef = useRef<number>(Date.now());
  // Tracks the last successful foreground delta sync attempt. Separate
  // from `lastActiveAtRef` because we want to gate sync on time-since-
  // last-sync, not time-since-last-foreground (so two quick app switches
  // don't both trigger Supabase pulls).
  const lastForegroundSyncAtRef = useRef<number>(0);
  const sentAppStartedRef = useRef(false);

  useEffect(() => {
    if (!analytics.isEnabled) return;

    installGlobalErrorHandlers();

    if (!sentAppStartedRef.current) {
      sentAppStartedRef.current = true;
      analytics.track('app_started', {
        app_version: ExpoConstants.expoConfig?.version ?? null,
        eas_update_id: Updates.updateId ?? null,
        eas_update_created_at: Updates.createdAt?.toISOString() ?? null,
        is_embedded_launch: Updates.isEmbeddedLaunch,
        platform: Platform.OS,
      });
    }

    const identify = (session: Awaited<ReturnType<typeof authClient.getSession>>['data']['session']) => {
      if (session?.user) {
        analytics.identify(session.user.id, {
          email_domain: session.user.email?.split('@')[1] ?? null,
        });
      } else {
        analytics.reset();
      }
    };

    // SQLite read cache is native-only — web falls through to the
    // React Query persister + Supabase fallback path. Gating here
    // (rather than letting the throw-on-web stub in `db.web.ts`
    // bubble up) keeps the console clean and avoids firing a useless
    // network round-trip during web bootstrap.
    const sqliteSupported = Platform.OS !== 'web';

    // Bootstrap repairs drift (full-pulls the transaction set), so if
    // it surfaces rows that weren't already in SQLite we have to
    // invalidate React Query — otherwise the persisted cache rehydrates
    // with the stale (incomplete) values and screens stay on the wrong
    // numbers until the next staleTime tick. Same shape as the
    // foreground-resume sync below.
    const runBootstrap = (userId: string) => {
      void bootstrapForUser(userId)
        .then((result) => {
          const changed =
            result.txInserted > 0 || result.navInserted > 0 || result.idxInserted > 0;
          if (changed) {
            void queryClient.invalidateQueries();
          }
        })
        .catch((err) => {
          console.warn('[db/sync] bootstrap failed', err);
        });
    };

    authClient.getSession().then(({ data: { session } }) => {
      identify(session);
      if (sqliteSupported && session?.user.id) {
        runBootstrap(session.user.id);
      }
    });
    const { data: { subscription } } = authClient.onAuthStateChange((event, session) => {
      identify(session);
      if (sqliteSupported && event === 'SIGNED_IN' && session?.user.id) {
        runBootstrap(session.user.id);
      }
      if (event === 'SIGNED_OUT') {
        // Sign-out is a single audited operation: every cache or piece
        // of state that's tied to the previous user must be dropped
        // before the next sign-in could possibly read it. New caches
        // get added here. See `docs/architecture/cache-surfaces.md`.
        //
        // Supabase's own session token is wiped by `authClient.signOut()`
        // before this event fires (the SDK calls `storage.removeItem`
        // on its session key as part of the sign-out mutation).
        queryClient.clear();
        void persister.removeClient();
        // Reset the in-memory Zustand store fields that aren't in
        // `partialize` — they survive sign-out → sign-in within the same
        // app process and would otherwise leak user A's preview / dialog
        // / feature-flag state into user B's session. Persisted user
        // preferences (theme, default benchmark, etc.) are deliberately
        // kept.
        useAppStore.getState().resetUserScopedState();
        // The onboarding draft holds PII (PAN, DOB, email) for users
        // mid-import; never let it cross sign-in boundaries.
        void clearOnboardingDraft().catch((err) => {
          console.warn('[onboarding] clearOnboardingDraft failed', err);
        });
        if (sqliteSupported) {
          // Wipe the SQLite read cache too — PII (transactions) must
          // not survive a sign-out.
          void clearLocalDb().catch((err) => {
            console.warn('[db/sync] clearAll failed', err);
          });
        }
      }
    });

    const onAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        const idleMs = Date.now() - lastActiveAtRef.current;
        lastActiveAtRef.current = Date.now();
        if (idleMs >= APP_RETURNED_THRESHOLD_MS) {
          analytics.track('app_returned', {
            previous_session_age_hours: Number((idleMs / 1000 / 60 / 60).toFixed(2)),
          });
        }

        // Pull any server-side changes (e.g. a CAS uploaded from web on
        // another device) into the local SQLite cache, then invalidate
        // React Query so screens recompute against the fresh rows. The
        // single-flight guard inside `syncDeltaForUser` plus the
        // foreground-sync throttle below keep this cheap.
        if (sqliteSupported) {
          const sinceLastSync = Date.now() - lastForegroundSyncAtRef.current;
          if (sinceLastSync >= FOREGROUND_SYNC_MIN_INTERVAL_MS) {
            lastForegroundSyncAtRef.current = Date.now();
            void authClient.getSession().then(({ data: { session } }) => {
              const uid = session?.user.id;
              if (!uid) return;
              syncDeltaForUser(uid)
                .then((result) => {
                  const changed =
                    result.txInserted > 0 ||
                    result.navInserted > 0 ||
                    result.idxInserted > 0;
                  if (changed) {
                    void queryClient.invalidateQueries();
                  }
                })
                .catch((err) => {
                  console.warn('[db/sync] foreground delta failed', err);
                });
            });
          }
        }
      } else if (nextState === 'background' || nextState === 'inactive') {
        lastActiveAtRef.current = Date.now();
      }
    };
    const appStateSub = AppState.addEventListener('change', onAppStateChange);

    return () => {
      subscription.unsubscribe();
      appStateSub.remove();
    };
  }, []);
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
  });

  useAnalyticsLifecycle();

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
          // are non-fatal — the app continues with an empty cache. Surface
          // them so we can spot a pattern.
          console.warn('[persister] cache restore failed', { buster: __BUSTER__ });
          perfNow('persister:restore_failed', { buster: __BUSTER__ });
          analytics.track('persister_restore_failed', { buster: __BUSTER__ });
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
