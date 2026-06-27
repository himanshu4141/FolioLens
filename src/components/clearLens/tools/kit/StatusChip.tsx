import { useMemo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  ClearLensFonts,
  ClearLensRadii,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';

export type StatusChipTone = 'mint' | 'amber' | 'neutral';

/**
 * Small pill chip for tool result states.
 *
 * mint   → positiveBg / positive  (detected, on-track)
 * amber  → warningBg / warning    (gap, caution)
 * neutral→ surfaceSoft / textTertiary  (sample, preview)
 *
 * `onDark` switches to the translucent on-hero variant.
 */
export function StatusChip({
  tone = 'mint',
  onDark = false,
  children,
}: {
  tone?: StatusChipTone;
  onDark?: boolean;
  children: ReactNode;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens, tone, onDark), [tokens, tone, onDark]);
  return (
    <View style={styles.chip}>
      <View style={styles.dot} />
      <Text style={styles.label} numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}

function makeStyles(tokens: ClearLensTokens, tone: StatusChipTone, onDark: boolean) {
  const cl = tokens.colors;

  const map: Record<StatusChipTone, { bg: string; fg: string; dot: string }> = {
    mint: {
      bg: onDark ? 'rgba(167,243,208,0.16)' : cl.positiveBg,
      fg: onDark ? '#A7F3D0' : cl.positive,
      dot: cl.positive,
    },
    amber: {
      bg: onDark ? 'rgba(251,191,36,0.18)' : cl.warningBg,
      fg: onDark ? '#FBBF24' : cl.warning,
      dot: cl.amber,
    },
    neutral: {
      bg: onDark ? 'rgba(255,255,255,0.10)' : cl.surfaceSoft,
      fg: onDark ? cl.textOnDarkMuted : cl.textTertiary,
      dot: onDark ? cl.textOnDarkMuted : cl.textTertiary,
    },
  };

  const c = map[tone];

  return StyleSheet.create({
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 5,
      paddingLeft: 9,
      paddingRight: 11,
      borderRadius: ClearLensRadii.full,
      backgroundColor: c.bg,
      flexShrink: 0,
    },
    dot: {
      width: 6,
      height: 6,
      borderRadius: ClearLensRadii.full,
      backgroundColor: c.dot,
      flexShrink: 0,
    },
    label: {
      fontSize: 11,
      fontFamily: ClearLensFonts.bold,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      color: c.fg,
    },
  });
}
