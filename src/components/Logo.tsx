/**
 * FundLens logo mark — a lens/circle enclosing an upward-trending sparkline.
 * Rendered with react-native-svg so it is crisp at any screen density.
 *
 * Usage:
 *   <Logo size={48} />                   // icon only
 *   <Logo size={48} showWordmark />       // icon + "FundLens" wordmark beside it
 *   <Logo size={48} showWordmark light /> // white wordmark for dark backgrounds
 */

import Svg, { Circle, Path, G } from 'react-native-svg';
import { View, Text, StyleSheet } from 'react-native';
import { useClearLensTokens } from '@/src/context/ThemeContext';

interface LogoProps {
  size?: number;
  showWordmark?: boolean;
  /** Use white text/stroke — for dark/coloured backgrounds */
  light?: boolean;
  /** Override icon colour (defaults to brand primary) */
  color?: string;
}

export default function Logo({
  size = 40,
  showWordmark = false,
  light = false,
  color,
}: LogoProps) {
  const { compatible: colors } = useClearLensTokens();
  const iconColor = color ?? (light ? '#ffffff' : colors.primary);
  const textColor = light ? '#ffffff' : colors.textPrimary;
  const accentColor = light ? 'rgba(255,255,255,0.45)' : colors.primaryLight;

  return (
    <View style={[styles.row, showWordmark && styles.withWordmark]}>
      <Svg width={size} height={size} viewBox="0 0 40 40">
        {/* Outer lens circle — filled ring */}
        <Circle cx="20" cy="20" r="18" fill={accentColor} />
        <Circle cx="20" cy="20" r="18" fill="none" stroke={iconColor} strokeWidth="2.5" />

        {/* Inner sparkline — upward-trending chart path */}
        <G>
          {/* Baseline */}
          <Path
            d="M8 26 L32 26"
            stroke={iconColor}
            strokeWidth="1.2"
            strokeOpacity="0.35"
          />
          {/* Trend line */}
          <Path
            d="M8 23 L14 20 L20 22 L26 15 L32 12"
            fill="none"
            stroke={iconColor}
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Dot at the peak */}
          <Circle cx="32" cy="12" r="2.5" fill={iconColor} />
        </G>
      </Svg>

      {showWordmark && (
        <View style={styles.wordmark}>
          <Text style={[styles.fund, { color: textColor, fontSize: size * 0.45 }]}>Fund</Text>
          <Text style={[styles.lens, { color: iconColor, fontSize: size * 0.45 }]}>Lens</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  withWordmark: { gap: 10 },
  wordmark: { flexDirection: 'row', alignItems: 'baseline' },
  fund: {
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  lens: {
    fontWeight: '800',
    letterSpacing: -0.5,
  },
});
