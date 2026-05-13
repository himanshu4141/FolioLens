import { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';
import { authClient } from '@/src/lib/auth';
import { canShowDevAuthShortcut, getDevAuthCredentials } from '@/src/lib/devAuth';
import { FolioLensLogo } from '@/src/components/clearLens/FolioLensLogo';
import { GoogleIcon } from '@/src/components/GoogleIcon';
import { getNativeAuthOrigin, getNativeBridgeUrl } from '@/src/utils/appScheme';
import { parseOAuthCode } from '@/src/utils/authUtils';
import { useResponsiveLayout } from '@/src/components/responsive';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';

function getRedirectUrl(): string {
  if (Platform.OS !== 'web') return getNativeBridgeUrl('/auth/confirm');
  return `${window.location.origin}/auth/confirm`;
}

const VALUE_PROPS = [
  { icon: 'trending-up-outline' as const, text: 'Your actual SIP returns, not misleading averages' },
  { icon: 'scale-outline' as const, text: 'Beat the market? Know in one glance' },
  { icon: 'search-outline' as const, text: 'Fund vs. benchmark, the honest way' },
];

export default function SignInScreen() {
  const router = useRouter();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const cl = tokens.colors;
  const { layout } = useResponsiveLayout();
  const isDesktop = layout === 'desktop';
  const [email, setEmail] = useState('');
  const [loadingMode, setLoadingMode] = useState<'magic' | 'google' | 'demo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMagicLinkInfo, setShowMagicLinkInfo] = useState(false);
  const showDevAuthShortcut = canShowDevAuthShortcut();

  async function handleSendMagicLink() {
    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }

    setError(null);
    setLoadingMode('magic');

    const { error } = await authClient.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: getRedirectUrl(),
      },
    });

    setLoadingMode(null);

    if (error) {
      setError(error.message);
      return;
    }

    router.push(`/auth/confirm?email=${encodeURIComponent(email.trim())}`);
  }

  async function handleGoogleSignIn() {
    setError(null);
    setLoadingMode('google');

    const redirectTo = Platform.OS === 'web'
      ? `${window.location.origin}/auth/callback`
      : getNativeBridgeUrl('/auth/callback');

    const { data, error } = await authClient.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    });

    if (error || !data?.url) {
      setError(error?.message ?? 'Could not start Google sign-in. Please try again.');
      setLoadingMode(null);
      return;
    }

    if (Platform.OS === 'web') {
      window.location.href = data.url;
      return;
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, getNativeAuthOrigin());
    setLoadingMode(null);

    if (result.type === 'success') {
      const code = parseOAuthCode(result.url);
      if (code) {
        router.push(
          `/auth/callback?code=${encodeURIComponent(code)}&callbackUrl=${encodeURIComponent(result.url)}`,
        );
      }
    }
  }

  async function handleDevSignIn() {
    const { email: devEmail, password: devPassword } = getDevAuthCredentials();

    if (!devEmail || !devPassword) {
      setError(
        'Dev auth is enabled, but EXPO_PUBLIC_DEV_AUTH_EMAIL or EXPO_PUBLIC_DEV_AUTH_PASSWORD is missing in .env.local.',
      );
      return;
    }

    setError(null);
    setLoadingMode('demo');

    const { error } = await authClient.signInWithPassword({
      email: devEmail,
      password: devPassword,
    });

    setLoadingMode(null);

    if (error) {
      setError(error.message);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={[styles.scroll, isDesktop && styles.scrollDesktop]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={isDesktop ? styles.cardDesktop : styles.cardMobile}>
          {/* Hero */}
          <LinearGradient
            colors={tokens.compatible.gradientHero}
            style={[styles.hero, isDesktop && styles.heroDesktopColumn]}
          >
            <FolioLensLogo size={36} light showWordmark />

            <View style={styles.heroTextBlock}>
              <Text style={styles.heroHeadline}>
                Know if you&apos;re{'\n'}beating the market.
              </Text>
              <Text style={styles.heroAccent}>No jargon. No noise.</Text>
            </View>

            <View style={styles.valueProps}>
              {VALUE_PROPS.map(({ icon, text }) => (
                <View key={text} style={styles.valuePropRow}>
                  <View style={styles.valuePropIconWrap}>
                    <Ionicons name={icon} size={15} color={cl.mint} />
                  </View>
                  <Text style={styles.valuePropText}>{text}</Text>
                </View>
              ))}
            </View>
          </LinearGradient>

          {/* Form panel */}
          <View style={[styles.formPanel, isDesktop && styles.formPanelDesktop]}>
            <Text style={styles.formTitle}>Sign in</Text>
            <Text style={styles.formSubtitle}>
              Enter your email — we&apos;ll send a secure link. No password needed.
            </Text>

            <TextInput
              style={[styles.input, error ? styles.inputError : null]}
              placeholder="you@example.com"
              placeholderTextColor={cl.textTertiary}
              value={email}
              onChangeText={(v) => { setEmail(v); setError(null); }}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              editable={!loadingMode}
              returnKeyType="send"
              onSubmitEditing={handleSendMagicLink}
            />

            {error && <Text style={styles.errorText}>{error}</Text>}

            <TouchableOpacity
              style={[styles.button, loadingMode !== null && styles.buttonDisabled]}
              onPress={handleSendMagicLink}
              disabled={loadingMode !== null}
              activeOpacity={0.85}
            >
              {loadingMode === 'magic' ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Send secure link →</Text>
              )}
            </TouchableOpacity>

            <View style={styles.dividerRow}>
              <View style={styles.divider} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.divider} />
            </View>

            <TouchableOpacity
              style={[styles.googleButton, loadingMode !== null && styles.buttonDisabled]}
              onPress={handleGoogleSignIn}
              disabled={loadingMode !== null}
              activeOpacity={0.85}
            >
              {loadingMode === 'google' ? (
                <ActivityIndicator color={cl.textSecondary} />
              ) : (
                <>
                  <GoogleIcon size={20} />
                  <Text style={styles.googleButtonText}>Continue with Google</Text>
                </>
              )}
            </TouchableOpacity>

            {showDevAuthShortcut && (
              <>
                <View style={styles.devDividerRow}>
                  <View style={styles.devDivider} />
                  <Text style={styles.devDividerText}>Local development only</Text>
                  <View style={styles.devDivider} />
                </View>

                <TouchableOpacity
                  style={[styles.devButton, loadingMode !== null && styles.buttonDisabled]}
                  onPress={handleDevSignIn}
                  disabled={loadingMode !== null}
                  activeOpacity={0.85}
                >
                  {loadingMode === 'demo' ? (
                    <ActivityIndicator color={cl.emerald} />
                  ) : (
                    <Text style={styles.devButtonText}>Continue as demo user</Text>
                  )}
                </TouchableOpacity>

                <Text style={styles.devHint}>
                  Uses locally configured demo credentials. Keep this disabled outside local development.
                </Text>
              </>
            )}

            <TouchableOpacity
              style={styles.infoToggle}
              onPress={() => setShowMagicLinkInfo((v) => !v)}
              activeOpacity={0.7}
            >
              <Text style={styles.infoToggleText}>
                {showMagicLinkInfo ? '▲' : '▼'} What is a magic link?
              </Text>
            </TouchableOpacity>

            {showMagicLinkInfo && (
              <View style={styles.infoBox}>
                <Text style={styles.infoBoxText}>
                  A magic link is a one-time, expiring link we email you. Tap it to sign in
                  instantly — no password to remember, nothing to forget. The link expires in
                  10 minutes and can only be used once.
                </Text>
              </View>
            )}

            <View style={styles.securityNote}>
              <Ionicons name="lock-closed-outline" size={12} color={cl.textTertiary} />
              <Text style={styles.securityNoteText}>
                Your data is private and encrypted. We never share it.
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: tokens.compatible.gradientHero[0],
    },
    scroll: { flexGrow: 1 },
    scrollDesktop: {
      paddingVertical: ClearLensSpacing.lg,
      paddingHorizontal: ClearLensSpacing.lg,
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100%',
    } as never,
    cardMobile: { flex: 1 },
    cardDesktop: {
      width: '100%',
      maxWidth: 920,
      flexDirection: 'row',
      alignItems: 'stretch',
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.xl,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.18,
      shadowRadius: 32,
      elevation: 12,
    },
    heroDesktopColumn: {
      flex: 1,
      paddingTop: ClearLensSpacing.xxl,
      paddingBottom: ClearLensSpacing.xxl,
      paddingHorizontal: ClearLensSpacing.lg,
      justifyContent: 'center',
    },
    formPanelDesktop: {
      flex: 1,
      marginTop: 0,
      borderTopLeftRadius: 0,
      borderTopRightRadius: 0,
      paddingTop: ClearLensSpacing.xxl,
      paddingBottom: ClearLensSpacing.xxl,
      paddingHorizontal: ClearLensSpacing.xl,
      justifyContent: 'center',
      shadowOpacity: 0,
      elevation: 0,
    },

    hero: {
      paddingTop: Platform.OS === 'ios' ? 64 : 48,
      paddingBottom: ClearLensSpacing.xl + ClearLensRadii.xl,
      paddingHorizontal: ClearLensSpacing.lg,
      gap: ClearLensSpacing.lg,
    },
    heroTextBlock: { gap: ClearLensSpacing.xs, marginTop: ClearLensSpacing.sm },
    heroHeadline: {
      fontFamily: ClearLensFonts.extraBold,
      fontSize: 28,
      lineHeight: 34,
      color: cl.textOnDark,
      letterSpacing: 0,
    },
    heroAccent: {
      fontFamily: ClearLensFonts.bold,
      fontSize: 22,
      lineHeight: 28,
      color: cl.emerald,
      letterSpacing: 0,
    },
    valueProps: { gap: ClearLensSpacing.sm, marginTop: ClearLensSpacing.xs },
    valuePropRow: { flexDirection: 'row', alignItems: 'center', gap: ClearLensSpacing.sm },
    valuePropIconWrap: {
      width: 28,
      height: 28,
      borderRadius: ClearLensRadii.sm,
      backgroundColor: 'rgba(255,255,255,0.10)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    valuePropText: {
      ...ClearLensTypography.bodySmall,
      color: 'rgba(255,255,255,0.78)',
      flex: 1,
    },

    formPanel: {
      backgroundColor: cl.surface,
      borderTopLeftRadius: ClearLensRadii.xl,
      borderTopRightRadius: ClearLensRadii.xl,
      marginTop: -ClearLensRadii.xl,
      flex: 1,
      paddingHorizontal: ClearLensSpacing.lg,
      paddingTop: ClearLensSpacing.xl,
      paddingBottom: ClearLensSpacing.xxl,
      gap: ClearLensSpacing.md,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 0.06,
      shadowRadius: 12,
      elevation: 6,
    },
    formTitle: { ...ClearLensTypography.h2, color: cl.navy },
    formSubtitle: {
      ...ClearLensTypography.body,
      color: cl.textTertiary,
      marginTop: -ClearLensSpacing.sm,
    },

    input: {
      height: 52,
      borderWidth: 1.5,
      borderColor: cl.border,
      borderRadius: ClearLensRadii.md,
      paddingHorizontal: ClearLensSpacing.md,
      fontSize: 16,
      color: cl.textPrimary,
      backgroundColor: cl.surfaceSoft,
    },
    inputError: { borderColor: cl.negative },
    errorText: { color: cl.negative, fontSize: 13, marginTop: -ClearLensSpacing.sm },

    button: {
      height: 54,
      backgroundColor: cl.emerald,
      borderRadius: ClearLensRadii.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonDisabled: { opacity: 0.6 },
    buttonText: {
      ...ClearLensTypography.h3,
      color: '#ffffff',
      letterSpacing: 0.2,
    },

    dividerRow: { flexDirection: 'row', alignItems: 'center', gap: ClearLensSpacing.sm },
    divider: { flex: 1, height: 1, backgroundColor: cl.border },
    dividerText: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      textTransform: 'uppercase',
    },

    googleButton: {
      height: 52,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: ClearLensSpacing.sm,
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.md,
      borderWidth: 1.5,
      borderColor: cl.border,
    },
    googleButtonText: {
      ...ClearLensTypography.body,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.navy,
    },

    devDividerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      marginTop: ClearLensSpacing.xs,
    },
    devDivider: { flex: 1, height: 1, backgroundColor: cl.border },
    devDividerText: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      textTransform: 'uppercase',
    },
    devButton: {
      height: 48,
      borderRadius: ClearLensRadii.md,
      borderWidth: 1,
      borderColor: cl.emerald,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: cl.mint50,
    },
    devButtonText: {
      ...ClearLensTypography.body,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.emerald,
    },
    devHint: {
      ...ClearLensTypography.bodySmall,
      color: cl.textTertiary,
      marginTop: -ClearLensSpacing.xs,
    },

    infoToggle: { alignSelf: 'center', paddingVertical: ClearLensSpacing.xs },
    infoToggleText: {
      ...ClearLensTypography.bodySmall,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.emerald,
    },
    infoBox: {
      backgroundColor: cl.mint50,
      borderRadius: ClearLensRadii.md,
      padding: ClearLensSpacing.md,
      marginTop: -ClearLensSpacing.sm,
      borderWidth: 1,
      borderColor: cl.mint,
    },
    infoBoxText: { ...ClearLensTypography.bodySmall, color: cl.navy, lineHeight: 20 },

    securityNote: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      marginTop: ClearLensSpacing.sm,
    },
    securityNoteText: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      textAlign: 'center',
    },
  });
}
