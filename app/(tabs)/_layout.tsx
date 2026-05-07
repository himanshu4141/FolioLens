import { StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { ClearLensFonts } from '@/src/constants/clearLensTheme';
import { DesktopSidebar, useResponsiveLayout } from '@/src/components/responsive';

/**
 * Renders the same `<Tabs>` navigator in both layouts. On desktop the bottom
 * tab bar is hidden via `display: none` and the Clear Lens sidebar is rendered
 * as a sibling to the left. Keeping the navigator instance mounted across the
 * mobile↔desktop breakpoint preserves the active route and any per-screen
 * state when the user resizes the browser window.
 */
export default function TabLayout() {
  const cl = useClearLensTokens().colors;
  const insets = useSafeAreaInsets();
  const { layout } = useResponsiveLayout();
  const isDesktop = layout === 'desktop';

  return (
    <View style={[styles.shell, isDesktop && styles.shellDesktop, { backgroundColor: cl.background }]}>
      <View style={[styles.sidebarSlot, !isDesktop && styles.hidden]}>
        {isDesktop ? <DesktopSidebar /> : null}
      </View>
      <View style={styles.contentSlot}>
        <Tabs
          screenOptions={{
            tabBarActiveTintColor: cl.emerald,
            tabBarInactiveTintColor: cl.textTertiary,
            headerShown: false,
            // sceneStyle paints the per-screen container background. Without
            // this React Navigation defaults to white, which bleeds through
            // anywhere a screen child doesn't fully cover its parent — most
            // visibly on the empty-portfolio state in dark mode where the
            // light container shows behind the (correctly dark) content.
            sceneStyle: { backgroundColor: cl.background },
            tabBarStyle: isDesktop
              ? { display: 'none' }
              : {
                  backgroundColor: cl.surface,
                  borderTopColor: cl.borderLight,
                  borderTopWidth: 1,
                  elevation: 0,
                  shadowOpacity: 0,
                  // Give the icon + label stack enough vertical room on phone-sized
                  // viewports where font metrics tend to clip label descenders. The
                  // bar grows tall enough to fit a two-line label ("Wealth Journey")
                  // on narrow widths without clipping the icon above it.
                  paddingTop: 6,
                  paddingBottom: Math.max(insets.bottom, 10),
                  height: 78 + Math.max(insets.bottom, 10),
                },
            // Force each visible tab item to fill its fair share of the bar width
            // and center content so icons don't bunch left on wider screens / web
            tabBarItemStyle: {
              flex: 1,
              justifyContent: 'center',
              alignItems: 'center',
              paddingTop: 4,
              paddingBottom: 6,
            },
            tabBarIconStyle: {
              marginTop: 2,
            },
            tabBarLabelStyle: {
              fontSize: 11,
              fontWeight: '600',
              fontFamily: ClearLensFonts.semiBold,
              lineHeight: 14,
              marginTop: 2,
              marginBottom: 0,
              textAlign: 'center',
            },
          }}
        >
          <Tabs.Screen
            name="index"
            options={{
              title: 'Portfolio',
              tabBarIcon: ({ color, size }) => (
                <Ionicons name="pie-chart-outline" size={size} color={color} />
              ),
            }}
          />
          <Tabs.Screen
            name="funds"
            options={{
              title: 'Funds',
              tabBarIcon: ({ color, size }) => (
                <Ionicons name="list-outline" size={size} color={color} />
              ),
            }}
          />
          <Tabs.Screen
            name="wealth-journey"
            options={{
              title: 'Wealth Journey',
              freezeOnBlur: true,
              tabBarIcon: ({ color, size }) => (
                <Ionicons name="calculator-outline" size={size} color={color} />
              ),
            }}
          />
          {/* Settings hidden from tab bar — accessible via the shared overflow menu */}
          <Tabs.Screen
            name="settings"
            options={{
              tabBarButton: () => null,
              tabBarItemStyle: { display: 'none' },
            }}
          />
        </Tabs>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    flexDirection: 'column',
  },
  shellDesktop: {
    flexDirection: 'row',
  },
  sidebarSlot: {
    // Width is set by DesktopSidebar (240px); on mobile the slot is hidden.
  },
  hidden: {
    display: 'none',
  },
  contentSlot: {
    flex: 1,
  },
});
