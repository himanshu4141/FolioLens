import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus, Platform } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import * as SystemUI from 'expo-system-ui';
import * as Updates from 'expo-updates';
import ExpoConstants from 'expo-constants';
import { Stack, useRouter, useSegments } from 'expo-router';
import { QueryClientProvider } from '@tanstack/react-query';
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
import { queryClient } from '@/src/lib/queryClient';
import { useSession } from '@/src/hooks/useSession';
import { supabase } from '@/src/lib/supabase';
import { ThemeProvider, useTheme, useClearLensTokens } from '@/src/context/ThemeContext';
import { parseSessionFromUrl } from '@/src/utils/authUtils';
import VercelInsights from '@/src/components/VercelInsights';
import { ErrorBoundary } from '@/src/components/ErrorBoundary';
import { analytics } from '@/src/lib/analytics';
import { installGlobalErrorHandlers } from '@/src/lib/installGlobalErrorHandlers';

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
 * within app/auth/callback.tsx, which calls supabase.auth.exchangeCodeForSession.
 * The openAuthSessionAsync call in auth/index.tsx returns the URL directly,
 * so the Linking listener below never fires for OAuth callbacks.
 */
function handleAuthDeepLink(url: string) {
  const sessionTokens = parseSessionFromUrl(url);
  if (sessionTokens) {
    supabase.auth.setSession({
      access_token: sessionTokens.accessToken,
      refresh_token: sessionTokens.refreshToken,
    });
  }
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    const inAuthGroup = segments[0] === 'auth';

    if (!session && !inAuthGroup) {
      router.replace('/auth');
    } else if (session && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [session, loading, segments, router]);

  return <>{children}</>;
}

// Threshold for the `app_returned` event. Anything shorter than this is a
// brief OS interruption (notification, control centre) we don't count as
// a "return" — only resumes after at least 5 minutes of background time.
const APP_RETURNED_THRESHOLD_MS = 5 * 60 * 1000;

function useAnalyticsLifecycle() {
  // Tracks the last time the app was in foreground; used to compute the
  // gap before emitting `app_returned`. Initialised on mount.
  const lastActiveAtRef = useRef<number>(Date.now());
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

    const identify = (session: Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session']) => {
      if (session?.user) {
        analytics.identify(session.user.id, {
          email_domain: session.user.email?.split('@')[1] ?? null,
        });
      } else {
        analytics.reset();
      }
    };

    supabase.auth.getSession().then(({ data: { session } }) => identify(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_evt, session) => identify(session));

    const onAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        const idleMs = Date.now() - lastActiveAtRef.current;
        lastActiveAtRef.current = Date.now();
        if (idleMs >= APP_RETURNED_THRESHOLD_MS) {
          analytics.track('app_returned', {
            previous_session_age_hours: Number((idleMs / 1000 / 60 / 60).toFixed(2)),
          });
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
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ThemedAppShell />
          <VercelInsights />
        </ThemeProvider>
      </QueryClientProvider>
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
