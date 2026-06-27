import { useRef, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ClearLensFonts } from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';

/**
 * Collapsible "See the …" disclosure shared by every tool screen.
 *
 * - Chevron rotates 180° on open (~200 ms, native driver).
 * - `dark` — uses textOnDarkMuted + white-alpha divider for use inside
 *   a ToolResultHero or other dark-surface cards.
 * - `accessibilityRole="button"` + `accessibilityState={{ expanded }}`
 *   so VoiceOver/TalkBack announce the state correctly.
 * - Default `label` / `openLabel` follows "See the X" / "Hide the X" convention.
 */
export function RevealSection({
  label,
  openLabel,
  dark = false,
  defaultOpen = false,
  children,
}: {
  label: string;
  openLabel?: string;
  dark?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const tokens = useClearLensTokens();
  const cl = tokens.colors;

  const [open, setOpen] = useState(defaultOpen);
  const chevronAnim = useRef(new Animated.Value(defaultOpen ? 1 : 0)).current;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    Animated.timing(chevronAnim, {
      toValue: next ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  };

  const chevronRotate = chevronAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '180deg'],
  });

  const mutedColor = dark ? cl.textOnDarkMuted : cl.textTertiary;
  const dividerColor = dark ? 'rgba(255,255,255,0.12)' : cl.borderLight;
  const closedLabel = label;
  const openedLabel = openLabel ?? label.replace(/^See /, 'Hide ');

  return (
    <View>
      <TouchableOpacity
        onPress={toggle}
        style={styles.trigger}
        accessibilityRole="button"
        accessibilityLabel={open ? openedLabel : closedLabel}
        accessibilityState={{ expanded: open }}
      >
        <Text style={[styles.triggerLabel, { color: mutedColor }]}>
          {open ? openedLabel : closedLabel}
        </Text>
        <Animated.View style={{ transform: [{ rotate: chevronRotate }] }}>
          <Ionicons name="chevron-down" size={14} color={mutedColor} />
        </Animated.View>
      </TouchableOpacity>

      {open ? (
        <View style={[styles.panel, { borderTopColor: dividerColor }]}>
          {children}
        </View>
      ) : null}
    </View>
  );
}

// Structural styles that don't depend on tokens stay in a module-level StyleSheet.
const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    minHeight: 40,
  },
  triggerLabel: {
    fontSize: 11,
    fontFamily: ClearLensFonts.bold,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  panel: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    gap: 8,
  },
});
