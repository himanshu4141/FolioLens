import { useMemo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { ClearLensCard } from '@/src/components/clearLens/ClearLensPrimitives';

/**
 * Dark "heroSurface" answer card used by Clear Lens tool screens.
 *
 * Built on ClearLensCard so radius (18), shadow, and border treatment
 * match the established hero pattern used across the app (PortfolioHero etc.).
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
    <ClearLensCard style={styles.hero}>
      <View style={styles.header}>
        <Text style={styles.label} numberOfLines={2}>
          {label}
        </Text>
        {chip ?? null}
      </View>

      <Text style={styles.value}>{value}</Text>

      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}

      {children ?? null}
    </ClearLensCard>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    hero: {
      backgroundColor: cl.heroSurface,
      borderColor: cl.heroSurface,
      padding: ClearLensSpacing.lg,
      gap: ClearLensSpacing.sm,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    label: {
      flex: 1,
      ...ClearLensTypography.label,
      color: cl.mint,
    },
    value: {
      ...ClearLensTypography.hero,
      color: cl.textOnDark,
    },
    subtitle: {
      ...ClearLensTypography.bodySmall,
      color: cl.textOnDarkMuted,
    },
  });
}
