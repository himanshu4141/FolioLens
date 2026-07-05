import { useEffect, useMemo, useState } from 'react';
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
import { FolioLensLogo } from '@/src/components/clearLens/FolioLensLogo';
import { getAppScheme } from '@/src/utils/appScheme';
import { resolveNativeOAuthCallbackUrl } from '@/src/utils/authUtils';
import { useOAuthCompletion } from '@/src/hooks/useOAuthCompletion';
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

const CALLBACK_INPUT_TIMEOUT_MS = 10_000;

export default function OAuthCallbackScreen() {
  const router = useRouter();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const cl = tokens.colors;
  const { code, error: oauthError, scheme, callbackUrl } = useLocalSearchParams<{
    code?: string;
    error?: string;
    scheme?: string;
    callbackUrl?: string;
  }>();
  const targetScheme = typeof scheme === 'string' && scheme.length > 0 ? scheme : getAppScheme();

  const [state, setState] = useState<CallbackState>('exchanging');
  const [errorState, setErrorState] = useState<ErrorState | null>(null);
  const [wasAutoLinked, setWasAutoLinked] = useState(false);
  const incomingUrl = Linking.useURL();
  const oauth = useOAuthCompletion();

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
    const callback = resolveNativeOAuthCallbackUrl({
      scheme: targetScheme,
      callbackUrl: typeof callbackUrl === 'string' ? callbackUrl : undefined,
      incomingUrl,
      code: typeof code === 'string' ? code : undefined,
      error: typeof oauthError === 'string' ? oauthError : undefined,
    });
    if (!callback) {
      const timeout = setTimeout(() => {
        setErrorState({
          message: 'FolioLens did not receive the Google callback. Please return and try again.',
          isDuplicate: false,
        });
        setState('error');
      }, CALLBACK_INPUT_TIMEOUT_MS);
      return () => clearTimeout(timeout);
    }

    let active = true;
    void oauth.completeCallback(callback, 'router').then((result) => {
      if (!active) return;
      if (result.status === 'success') {
        setWasAutoLinked(result.wasAutoLinked);
        setState('linked');
        return;
      }
      setErrorState({ message: result.message, isDuplicate: result.isDuplicate });
      setState('error');
    });
    return () => { active = false; };
  }, [callbackUrl, code, incomingUrl, oauth, oauthError, targetScheme]);

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
