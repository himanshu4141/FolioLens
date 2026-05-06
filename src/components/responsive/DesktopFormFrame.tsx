import { ReactNode, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { ClearLensSpacing, type ClearLensTokens } from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { useResponsiveLayout } from './useResponsiveLayout';
import { ResponsiveRouteFrame } from './ResponsiveRouteFrame';

/**
 * Desktop wrapper for "form-style" screens (onboarding wizards, settings forms,
 * post-auth pages with vertical content) that don't need the full max-content
 * width. On desktop the children are centered in a 720px column inside the
 * sidebar shell. On mobile the children render unchanged width-wise — the
 * keyed wrapper is layout-transparent.
 *
 * Topology invariant — same as ResponsiveRouteFrame: the keyed inner <View>
 * stays at the same React depth across desktop ↔ mobile resizes so children
 * keep their local state. Previously this conditionally returned
 * `<>{children}</>` on mobile, which made the entire form's React tree
 * reshuffle on every breakpoint crossing — wiping any in-progress user input.
 */
export function DesktopFormFrame({
  children,
  maxWidth = 720,
}: {
  children: ReactNode;
  maxWidth?: number;
}) {
  const { layout } = useResponsiveLayout();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const isDesktop = layout === 'desktop';
  return (
    <ResponsiveRouteFrame>
      <View
        key="form-content"
        style={isDesktop ? [styles.frame, { maxWidth }] : styles.frameMobile}
      >
        {children}
      </View>
    </ResponsiveRouteFrame>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  return StyleSheet.create({
    frame: {
      flex: 1,
      width: '100%',
      alignSelf: 'center',
      paddingHorizontal: ClearLensSpacing.md,
      backgroundColor: tokens.colors.background,
    },
    // Layout-transparent on mobile — preserves the original behaviour where
    // the form rendered without any extra width constraint or padding.
    frameMobile: {
      flex: 1,
      width: '100%',
    },
  });
}
