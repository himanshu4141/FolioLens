import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  ClearLensFonts,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';

/**
 * Standard title block for every Clear Lens tool screen.
 * Eyebrow (emerald all-caps) → h1 (navy ExtraBold) → optional subtitle.
 */
export function ToolTitleBlock({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.wrap}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    wrap: {
      gap: 4,
      paddingHorizontal: ClearLensSpacing.xs,
      paddingVertical: ClearLensSpacing.sm,
    },
    eyebrow: {
      fontSize: 10,
      fontFamily: ClearLensFonts.bold,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
      color: cl.emerald,
    },
    title: {
      ...ClearLensTypography.h1,
      fontFamily: ClearLensFonts.extraBold,
      color: cl.navy,
    },
    subtitle: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      lineHeight: 22,
    },
  });
}
