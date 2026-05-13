import { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import * as Linking from 'expo-linking';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { authClient } from '@/src/lib/auth';
import { FolioLensLogo } from '@/src/components/clearLens/FolioLensLogo';
import { getAppScheme, getNativeExchangeCallbackUrl } from '@/src/utils/appScheme';
import { parseSessionFromUrl } from '@/src/utils/authUtils';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';

type CallbackState = 'exchanging' | 'linked' | 'error';

interface ErrorState {
  message: string;
  isDuplicate: boolean;
}

export default function OAuthCallbackScreen() {
  const router = useRouter();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const cl = tokens.colors;
  const { code, error: oauthError, error_description, scheme, callbackUrl } = useLocalSearchParams<{
    code?: string;
    error?: string;
    error_description?: string;
    scheme?: string;
    callbackUrl?: string;
  }>();
  const targetScheme = typeof scheme === 'string' && scheme.length > 0 ? scheme : getAppScheme();

  const [state, setState] = useState<CallbackState>('exchanging');
  const [errorState, setErrorState] = useState<ErrorState | null>(null);
  const [wasAutoLinked, setWasAutoLinked] = useState(false);
  const incomingUrl = Linking.useURL();
  // Guard against re-entry: useEffect's deps include code/callbackUrl/incomingUrl,
  // any of which can update from undefined → defined as expo-router parses the
  // route URL. Without this ref the effect fires twice — once before params
  // populate (showing the "authorization code missing" error) and once after
  // (succeeding). User sees a brief failure flash then a successful navigate,
  // which is what the prod-mobile bug was.
  const exchangeAttemptedRef = useRef(false);

  useEffect(() => {
    // ── Web path ──────────────────────────────────────────────────────────────
    if (Platform.OS === 'web') {
      // Bridge to native app only when running at the production native-bridge
      // host (app.foliolens.in). Preview deployments serve the web app on a
      // different hostname — mobile visitors there should get a web session, not
      // an app redirect.
      const ua = window.navigator.userAgent.toLowerCase();
      const nativeBridgeHostname = new URL(process.env.EXPO_PUBLIC_APP_BASE_URL ?? 'https://app.foliolens.in').hostname;
      const isNativeBridgeHost = window.location.hostname === nativeBridgeHostname;
      if (/iphone|ipad|ipod|android/.test(ua) && isNativeBridgeHost) {
        // Preserve both query params and hash fragments. Supabase OAuth can
        // return either `?code=...` (PKCE) or `#access_token=...` (implicit).
        window.location.replace(
          `${targetScheme}://auth/callback${window.location.search}${window.location.hash}`,
        );
      }
      // Desktop web, or mobile on a non-bridge host: Supabase detectSessionInUrl
      // auto-exchanges the code. Show spinner; AuthGate navigates once session appears.
      return;
    }

    // ── Native path ───────────────────────────────────────────────────────────
    if (oauthError) {
      const desc = error_description ?? oauthError;
      const isDuplicate =
        oauthError === 'access_denied' ||
        desc.toLowerCase().includes('already');
      setErrorState({
        message: isDuplicate
          ? 'This email already has a FolioLens account created with email sign-in. Sign in with your magic link first, then connect Google from Settings → Connected Accounts.'
          : `Sign-in failed: ${desc}`,
        isDuplicate,
      });
      setState('error');
      return;
    }

    // Wait for at least one input to populate before deciding anything. On
    // first render, expo-router may not have parsed the search params yet
    // (code, callbackUrl) and Linking.useURL() may not have the deep link.
    // Without this guard we'd briefly show an error and then succeed.
    if (!code && !callbackUrl && !incomingUrl) return;

    // Single-attempt guard. Code is single-use at the OAuth server, so a
    // second exchange attempt with the same code returns `invalid_grant`.
    if (exchangeAttemptedRef.current) return;
    exchangeAttemptedRef.current = true;

    async function exchange() {
      try {
        if (!code) {
          const sessionUrl =
            (typeof callbackUrl === 'string' && callbackUrl.length > 0 ? callbackUrl : null) ??
            incomingUrl;
          const sessionTokens = sessionUrl ? parseSessionFromUrl(sessionUrl) : null;

          if (sessionTokens) {
            const { error } = await authClient.setSession({
              access_token: sessionTokens.accessToken,
              refresh_token: sessionTokens.refreshToken,
            });

            if (error) {
              console.error('[auth/callback] setSession failed: %s', error.message);
              setErrorState({
                message: `Sign-in failed: ${error.message}`,
                isDuplicate: false,
              });
              setState('error');
              return;
            }

            setState('linked');
            router.replace('/(tabs)');
            return;
          }

          setErrorState({
            message: 'We could not complete Google sign-in because the authorization code was missing. Please try again.',
            isDuplicate: false,
          });
          setState('error');
          return;
        }

        const exchangeCode = code;
        const callbackHref = getNativeExchangeCallbackUrl(exchangeCode, callbackUrl);

        // Pass the full reconstructed URL; Supabase extracts the code param
        // and retrieves the stored PKCE verifier from AsyncStorage automatically.
        const { data, error } = await authClient.exchangeCodeForSession(callbackHref);

        if (error) {
          // Surface the verbatim Supabase error to logs so production crashes
          // can be diagnosed via adb logcat / device console without rebuilding.
          console.error(
            '[auth/callback] exchangeCodeForSession failed: %s (status=%s, code=%s)',
            error.message,
            (error as { status?: number }).status ?? 'n/a',
            (error as { code?: string }).code ?? 'n/a',
          );
          const isDuplicate = error.message.toLowerCase().includes('already');
          setErrorState({
            message: isDuplicate
              ? 'This email already has a FolioLens account. Sign in with your magic link first, then connect Google from Settings → Connected Accounts.'
              : `Sign-in failed: ${error.message}`,
            isDuplicate,
          });
          setState('error');
          return;
        }

        // Detect whether Supabase auto-linked an existing email account
        const identities = data.session?.user?.identities ?? [];
        const hasEmail = identities.some((id: { provider: string }) => id.provider === 'email');
        const hasGoogle = identities.some((id: { provider: string }) => id.provider === 'google');
        if (hasEmail && hasGoogle) {
          setWasAutoLinked(true);
        }

        setState('linked');
        router.replace('/(tabs)');
      } catch (err) {
        console.error(
          '[auth/callback] unexpected error during exchange: %s',
          err instanceof Error ? err.message : String(err),
        );
        setErrorState({
          message: 'An unexpected error occurred. Please try again.',
          isDuplicate: false,
        });
        setState('error');
      }
    }

    exchange();
  }, [callbackUrl, code, incomingUrl, oauthError, error_description, router, targetScheme]);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (Platform.OS === 'web') {
    return (
      <View style={styles.container}>
        <FolioLensLogo size={44} showWordmark />
        <ActivityIndicator size="large" color={cl.emerald} style={styles.spinner} />
        <Text style={styles.loadingText}>Signing you in…</Text>
      </View>
    );
  }

  if (state === 'error' && errorState) {
    return (
      <View style={styles.container}>
        <View style={styles.logoArea}>
          <FolioLensLogo size={44} showWordmark />
        </View>

        <View style={styles.messageCard}>
          <Text style={styles.cardTitle}>
            {errorState.isDuplicate ? 'Account already exists' : 'Sign-in failed'}
          </Text>
          <Text style={styles.cardBody}>{errorState.message}</Text>
        </View>

        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => router.replace('/auth')}
          activeOpacity={0.85}
        >
          <Text style={styles.primaryBtnText}>
            {errorState.isDuplicate ? 'Sign in with email instead' : 'Try again'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (state === 'linked' && wasAutoLinked) {
    return (
      <View style={styles.container}>
        <View style={styles.logoArea}>
          <FolioLensLogo size={44} showWordmark />
        </View>

        <View style={[styles.messageCard, styles.successCard]}>
          <Text style={styles.cardTitle}>Google account connected</Text>
          <Text style={styles.cardBody}>
            Your Google account has been connected to your existing FolioLens account.
            You can now sign in with either method.
          </Text>
        </View>

        <ActivityIndicator color={cl.emerald} />
        <Text style={styles.loadingText}>Taking you in…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.logoArea}>
        <FolioLensLogo size={44} showWordmark />
      </View>
      <ActivityIndicator size="large" color={cl.emerald} style={styles.spinner} />
      <Text style={styles.loadingText}>Completing sign-in…</Text>
    </View>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: cl.background,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: ClearLensSpacing.xl,
      gap: ClearLensSpacing.md,
    },
    logoArea: {
      position: 'absolute',
      top: Platform.OS === 'ios' ? 60 : 48,
      left: ClearLensSpacing.lg,
    },
    spinner: {
      marginVertical: ClearLensSpacing.sm,
    },
    loadingText: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      textAlign: 'center',
    },
    messageCard: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.md,
      padding: ClearLensSpacing.lg,
      gap: ClearLensSpacing.sm,
      width: '100%',
      borderWidth: 1,
      borderColor: cl.border,
    },
    successCard: {
      backgroundColor: cl.positiveBg,
      borderColor: cl.mint,
    },
    cardTitle: {
      ...ClearLensTypography.h2,
      color: cl.textPrimary,
    },
    cardBody: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      lineHeight: 22,
    },
    primaryBtn: {
      height: 52,
      backgroundColor: cl.emerald,
      borderRadius: ClearLensRadii.md,
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
    },
    primaryBtnText: {
      color: cl.textOnDark,
      fontSize: 16,
      fontWeight: '700',
    },
  });
}
