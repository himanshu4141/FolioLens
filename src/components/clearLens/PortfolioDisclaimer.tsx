import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';

type Variant = 'inline' | 'compact';

interface PortfolioDisclaimerProps {
  variant?: Variant;
}

const INLINE_COPY =
  'FolioLens is a portfolio analysis and clarity tool. The numbers, charts, and comparisons shown here are not investment advice, recommendations, or a solicitation to buy, sell, or hold any mutual fund. Consult a SEBI-registered investment adviser before making financial decisions.';

const COMPACT_COPY =
  'Not investment advice. Calculated from your CAS data and AMFI disclosures.';

export function PortfolioDisclaimer({ variant = 'inline' }: PortfolioDisclaimerProps) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const copy = variant === 'compact' ? COMPACT_COPY : INLINE_COPY;
  const containerStyle = variant === 'compact' ? styles.compactContainer : styles.inlineContainer;
  const textStyle = variant === 'compact' ? styles.compactText : styles.inlineText;
  const iconSize = variant === 'compact' ? 14 : 16;

  return (
    <View
      style={containerStyle}
      accessible
      accessibilityRole="text"
      accessibilityLabel={copy}
    >
      <Ionicons
        name="information-circle-outline"
        size={iconSize}
        color={tokens.colors.textTertiary}
      />
      <Text style={textStyle}>{copy}</Text>
    </View>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    inlineContainer: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: ClearLensSpacing.xs,
      paddingVertical: ClearLensSpacing.md,
      paddingHorizontal: ClearLensSpacing.md,
      marginTop: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.borderLight,
    },
    inlineText: {
      ...ClearLensTypography.caption,
      color: cl.textSecondary,
      flex: 1,
      lineHeight: 18,
    },
    compactContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: ClearLensSpacing.xs,
      paddingTop: ClearLensSpacing.xs,
    },
    compactText: {
      ...ClearLensTypography.caption,
      fontFamily: ClearLensFonts.regular,
      color: cl.textTertiary,
      flex: 1,
    },
  });
}

export default PortfolioDisclaimer;
