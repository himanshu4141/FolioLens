import { ReactNode, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useResponsiveLayout } from './useResponsiveLayout';
import { DesktopSidebar } from './DesktopSidebar';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import type { ClearLensTokens } from '@/src/constants/clearLensTheme';

/**
 * Wraps an out-of-tabs route (Fund Detail, Money Trail, Portfolio Insights,
 * Tools, etc.) with the desktop sidebar shell when the viewport is desktop.
 *
 * Topology invariant: regardless of layout, `children` sit inside the same
 * keyed inner <View> at the same React depth. So a desktop ↔ mobile resize
 * does NOT unmount/remount the screen — local React state (form inputs,
 * selected fund, segment-control choices, scroll position, etc.) survives
 * the breakpoint crossing. Without this invariant the wrapper used to swap
 * the React tree between `<DesktopShell><Screen/></DesktopShell>` and
 * `<>{children}</>` on every resize, and the resulting Screen unmount wiped
 * the user's tool selections.
 *
 * Only the DesktopSidebar appears as a sibling of the content View on
 * desktop. Mounting/unmounting a sibling does NOT affect the keyed
 * content's React identity.
 */
export function ResponsiveRouteFrame({ children }: { children: ReactNode }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const { layout } = useResponsiveLayout();
  const isDesktop = layout === 'desktop';

  return (
    <View style={isDesktop ? styles.shellDesktop : styles.shellMobile}>
      {isDesktop ? <DesktopSidebar /> : null}
      <View key="content" style={styles.content}>
        {children}
      </View>
    </View>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  return StyleSheet.create({
    shellDesktop: {
      flex: 1,
      flexDirection: 'row',
      backgroundColor: tokens.colors.background,
      minHeight: '100%',
    },
    shellMobile: {
      flex: 1,
    },
    content: {
      flex: 1,
    },
  });
}
