import { useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  ScrollView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { FolioLensLogo } from '@/src/components/clearLens/FolioLensLogo';
import { useResponsiveLayout } from '@/src/components/responsive';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { getAppScheme } from '@/src/utils/appScheme';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';

const TIPS = [
  { icon: 'time-outline' as const,           text: 'The link expires in 10 minutes.' },
  { icon: 'mail-outline' as const,           text: 'Check your spam folder if you don\'t see it.' },
  { icon: 'phone-portrait-outline' as const, text: 'Open the link on this device for the best experience.' },
];

export default function ConfirmScreen() {
  const router = useRouter();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const cl = tokens.colors;
  const { layout } = useResponsiveLayout();
  const isDesktop = layout === 'desktop';
  const { scheme, email } = useLocalSearchParams<{ scheme?: string; email?: string }>();
  const targetScheme = typeof scheme === 'string' && scheme.length > 0 ? scheme : getAppScheme();
  const displayEmail = typeof email === 'string' && email.length > 0 ? email : null;

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const hash = window.location.hash;
    if (!hash || hash.length <= 1) return;

    const ua = window.navigator.userAgent.toLowerCase();
    const nativeBridgeHostname = new URL(process.env.EXPO_PUBLIC_APP_BASE_URL ?? 'https://app.foliolens.in').hostname;
    const isNativeBridgeHost = window.location.hostname === nativeBridgeHostname;
    if (!/iphone|ipad|ipod|android/.test(ua) || !isNativeBridgeHost) return;

    window.location.replace(`${targetScheme}://auth/confirm${hash}`);
  }, [targetScheme]);

  async function handleResend() {
    router.replace('/auth');
  }

  return (
    <View style={styles.container}>
      <View style={styles.logoBar}>
        <FolioLensLogo size={30} showWordmark />
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, isDesktop && styles.scrollContentDesktop]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.illustrationWrap}>
          <View style={styles.envelope}>
            <View style={styles.envelopeFlap} />
            <View style={styles.envelopeBody}>
              <View style={styles.envelopeLine} />
              <View style={[styles.envelopeLine, styles.envelopeLineShort]} />
            </View>
            <View style={styles.badge}>
              <Ionicons name="checkmark" size={14} color="#fff" />
            </View>
          </View>
        </View>

        <Text style={styles.title}>Check your inbox</Text>

        <Text style={styles.body}>
          We sent a secure sign-in link to{'\n'}
          {displayEmail ? (
            <Text style={styles.emailHighlight}>{displayEmail}</Text>
          ) : (
            'your email address'
          )}
        </Text>

        <View style={styles.tipsCard}>
          <Text style={styles.tipsLabel}>Good to know</Text>
          {TIPS.map(({ icon, text }) => (
            <View key={text} style={styles.tipRow}>
              <Ionicons name={icon} size={15} color={cl.emerald} />
              <Text style={styles.tipText}>{text}</Text>
            </View>
          ))}
        </View>

        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={handleResend}
            activeOpacity={0.75}
          >
            <Text style={styles.secondaryBtnText}>Use a different email</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: cl.background },
    logoBar: {
      paddingTop: Platform.OS === 'ios' ? 60 : 48,
      paddingHorizontal: ClearLensSpacing.lg,
      paddingBottom: ClearLensSpacing.sm,
    },
    scrollContent: {
      flexGrow: 1,
      alignItems: 'center',
      paddingHorizontal: ClearLensSpacing.lg,
      paddingTop: ClearLensSpacing.xl,
      paddingBottom: ClearLensSpacing.xxl,
      gap: ClearLensSpacing.md,
    },
    scrollContentDesktop: {
      maxWidth: 460,
      width: '100%',
      alignSelf: 'center',
      justifyContent: 'center',
    } as never,

    illustrationWrap: { marginBottom: ClearLensSpacing.sm },
    envelope: { width: 96, height: 72, position: 'relative' },
    envelopeFlap: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 38,
      backgroundColor: cl.mint50,
      borderTopLeftRadius: ClearLensRadii.sm,
      borderTopRightRadius: ClearLensRadii.sm,
      borderWidth: 1.5,
      borderBottomWidth: 0,
      borderColor: cl.mint,
    },
    envelopeBody: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height: 52,
      backgroundColor: cl.surface,
      borderWidth: 1.5,
      borderColor: cl.mint,
      borderRadius: ClearLensRadii.sm,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
    },
    envelopeLine: { height: 3, width: 48, backgroundColor: cl.borderLight, borderRadius: 2 },
    envelopeLineShort: { width: 32 },
    badge: {
      position: 'absolute',
      top: -12,
      right: -12,
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: cl.emerald,
      alignItems: 'center',
      justifyContent: 'center',
    },

    title: { ...ClearLensTypography.h1, color: cl.navy, textAlign: 'center' },
    body: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      textAlign: 'center',
      lineHeight: 24,
    },
    emailHighlight: { fontFamily: ClearLensFonts.semiBold, color: cl.navy },

    tipsCard: {
      backgroundColor: cl.mint50,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.mint,
      padding: ClearLensSpacing.md,
      gap: ClearLensSpacing.sm,
      width: '100%',
    },
    tipsLabel: {
      ...ClearLensTypography.label,
      color: cl.emerald,
      textTransform: 'uppercase',
      marginBottom: 2,
    },
    tipRow: { flexDirection: 'row', alignItems: 'flex-start', gap: ClearLensSpacing.sm },
    tipText: { ...ClearLensTypography.bodySmall, color: cl.navy, flex: 1, lineHeight: 20 },

    actions: { marginTop: ClearLensSpacing.sm, width: '100%', alignItems: 'center' },
    secondaryBtn: {
      paddingVertical: ClearLensSpacing.sm + 2,
      paddingHorizontal: ClearLensSpacing.lg,
      borderWidth: 1.5,
      borderColor: cl.border,
      borderRadius: ClearLensRadii.md,
      minWidth: 200,
      alignItems: 'center',
    },
    secondaryBtnText: {
      ...ClearLensTypography.body,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.textSecondary,
    },
  });
}
