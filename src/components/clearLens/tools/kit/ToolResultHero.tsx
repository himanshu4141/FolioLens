import { useMemo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  ClearLensFonts,
  ClearLensRadii,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';

/**
 * Dark "heroSurface" answer card used by every Clear Lens tool.
 *
 * Renders:
 *   header row  — label (caps/muted) + optional chip (right-aligned)
 *   value       — 36 px ExtraBold white, tabular-nums
 *   subtitle    — 13 px muted
 *   children    — optional slot for extra content inside the hero
 *
 * The radial emerald glow is approximated with an absolutely-positioned
 * circle (RN has no native radial-gradient; the soft bleed reads fine on
 * the dark surface). The card clips it via overflow:hidden.
 */
export function ToolResultHero({
  label,
  value,
  subtitle,
  chip,
  children,
}: {
  label: string;
  value: string;
  subtitle?: string;
  chip?: ReactNode;
  children?: ReactNode;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

  return (
    <View style={styles.hero}>
      {/* Approximate radial glow — clipped by overflow:hidden on parent */}
      <View style={styles.glow} pointerEvents="none" />

      <View style={styles.header}>
        <Text style={styles.label} numberOfLines={2}>
          {label}
        </Text>
        {chip ?? null}
      </View>

      <Text style={styles.value}>{value}</Text>

      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}

      {children ?? null}
    </View>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    hero: {
      backgroundColor: cl.heroSurface,
      borderRadius: ClearLensRadii.xl,
      padding: 18,
      gap: 10,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 24 },
      shadowOpacity: 0.22,
      shadowRadius: 60,
      elevation: 8,
      overflow: 'hidden',
    },
    glow: {
      position: 'absolute',
      right: -40,
      bottom: -50,
      width: 160,
      height: 160,
      borderRadius: 80,
      backgroundColor: 'rgba(16,185,129,0.18)',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      zIndex: 1,
    },
    label: {
      flex: 1,
      fontSize: 11,
      fontFamily: ClearLensFonts.bold,
      letterSpacing: 1,
      textTransform: 'uppercase',
      color: cl.textOnDarkMuted,
    },
    value: {
      fontFamily: ClearLensFonts.extraBold,
      fontSize: 36,
      lineHeight: 42,
      color: cl.textOnDark,
      fontVariant: ['tabular-nums'],
      zIndex: 1,
    },
    subtitle: {
      fontSize: 13,
      fontFamily: ClearLensFonts.medium,
      lineHeight: 20,
      color: cl.textOnDarkMuted,
      zIndex: 1,
    },
  });
}
