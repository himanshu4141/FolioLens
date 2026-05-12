import { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  useAppStore,
  BENCHMARK_OPTIONS,
  DEFAULT_RETURN_ASSUMPTIONS,
  type AppColorScheme,
  type ReturnAssumptions,
} from '@/src/store/appStore';
import { UtilityHeader } from '@/src/components/UtilityHeader';
import { useTheme, useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';

const THEME_OPTIONS: { value: AppColorScheme; label: string; desc: string; icon: keyof typeof import('@expo/vector-icons').Ionicons.glyphMap }[] = [
  { value: 'light', label: 'Light', desc: 'Always use the light Clear Lens palette', icon: 'sunny-outline' },
  { value: 'dark', label: 'Dark', desc: 'Always use the new dark Clear Lens palette', icon: 'moon-outline' },
  { value: 'system', label: 'System', desc: 'Match the system appearance', icon: 'phone-portrait-outline' },
];

const PRESET_KEYS: { key: keyof ReturnAssumptions; label: string }[] = [
  { key: 'cautious', label: 'Cautious' },
  { key: 'balanced', label: 'Balanced' },
  { key: 'growth', label: 'Growth' },
];

export default function PreferencesScreen() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const cl = tokens.colors;
  const { colorScheme, resolvedScheme, setColorScheme } = useTheme();
  const {
    defaultBenchmarkSymbol,
    setDefaultBenchmarkSymbol,
    returnAssumptions,
    setReturnAssumption,
  } = useAppStore();
  const [saved, setSaved] = useState(false);

  const [assumptionDrafts, setAssumptionDrafts] = useState<Record<keyof ReturnAssumptions, string>>(
    {
      cautious: String(returnAssumptions.cautious),
      balanced: String(returnAssumptions.balanced),
      growth: String(returnAssumptions.growth),
    },
  );

  function selectBenchmark(symbol: string) {
    setDefaultBenchmarkSymbol(symbol);
    showSaved();
  }

  function showSaved() {
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function commitAssumption(key: keyof ReturnAssumptions, draft: string) {
    const value = parseFloat(draft);
    if (Number.isFinite(value) && value >= 1 && value <= 30) {
      setReturnAssumption(key, Number(value.toFixed(1)));
      setAssumptionDrafts((prev) => ({ ...prev, [key]: String(Number(value.toFixed(1))) }));
      showSaved();
    } else {
      setAssumptionDrafts((prev) => ({ ...prev, [key]: String(returnAssumptions[key]) }));
    }
  }

  function resetAssumptions() {
    const d = DEFAULT_RETURN_ASSUMPTIONS;
    setReturnAssumption('cautious', d.cautious);
    setReturnAssumption('balanced', d.balanced);
    setReturnAssumption('growth', d.growth);
    setAssumptionDrafts({
      cautious: String(d.cautious),
      balanced: String(d.balanced),
      growth: String(d.growth),
    });
    showSaved();
  }

  return (
    <SafeAreaView style={styles.container}>
      <UtilityHeader title="Preferences" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.frame}>
        {/* Theme */}
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionLabel}>Appearance</Text>
          {saved && <Text style={styles.savedBadge}>✓ Saved</Text>}
        </View>
        <Text style={styles.sectionDesc}>
          {colorScheme === 'system'
            ? `Following system — currently ${resolvedScheme}.`
            : `Always use the ${colorScheme} Clear Lens palette.`}
        </Text>
        <View style={styles.card}>
          {THEME_OPTIONS.map((option, idx) => (
            <TouchableOpacity
              key={option.value}
              style={[styles.row, idx > 0 && styles.borderTop]}
              onPress={() => {
                setColorScheme(option.value);
                showSaved();
              }}
              activeOpacity={0.7}
            >
              <View style={styles.iconBubble}>
                <Ionicons name={option.icon} size={18} color={cl.emerald} />
              </View>
              <View style={styles.rowLeft}>
                <Text style={styles.rowValue}>{option.label}</Text>
                <Text style={styles.rowSub}>{option.desc}</Text>
              </View>
              <Ionicons
                name={colorScheme === option.value ? 'radio-button-on' : 'radio-button-off'}
                size={20}
                color={colorScheme === option.value ? cl.emerald : cl.textTertiary}
              />
            </TouchableOpacity>
          ))}
        </View>

        {/* Default benchmark */}
        <Text style={[styles.sectionLabel, { marginTop: ClearLensSpacing.md }]}>Default Benchmark</Text>
        <Text style={styles.sectionDesc}>
          Used for &ldquo;You vs Market&rdquo; on the home screen
        </Text>
        <View style={styles.card}>
          {BENCHMARK_OPTIONS.map((opt, idx) => (
            <TouchableOpacity
              key={opt.symbol}
              style={[styles.row, idx > 0 && styles.borderTop]}
              onPress={() => selectBenchmark(opt.symbol)}
              activeOpacity={0.7}
            >
              <Text style={[styles.rowValue, { flex: 1 }]}>{opt.label}</Text>
              {defaultBenchmarkSymbol === opt.symbol && (
                <Ionicons name="checkmark" size={18} color={cl.emerald} />
              )}
            </TouchableOpacity>
          ))}
        </View>

        {/* Return assumptions */}
        <View style={[styles.sectionHeaderRow, { marginTop: ClearLensSpacing.md }]}>
          <Text style={styles.sectionLabel}>Return Assumptions</Text>
          <TouchableOpacity onPress={resetAssumptions}>
            <Text style={styles.resetLink}>Reset</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.sectionDesc}>
          Annual return % used by Goal Planner, Wealth Journey, and other tools.
        </Text>
        <View style={styles.card}>
          {PRESET_KEYS.map(({ key, label }, idx) => (
            <View key={key} style={[styles.row, idx > 0 && styles.borderTop]}>
              <Text style={[styles.rowValue, { flex: 1 }]}>{label}</Text>
              <View style={styles.assumptionInputWrap}>
                <TextInput
                  style={styles.assumptionInput}
                  value={assumptionDrafts[key]}
                  onChangeText={(t) => setAssumptionDrafts((prev) => ({ ...prev, [key]: t }))}
                  onBlur={() => commitAssumption(key, assumptionDrafts[key])}
                  onSubmitEditing={() => commitAssumption(key, assumptionDrafts[key])}
                  keyboardType="decimal-pad"
                  returnKeyType="done"
                  maxLength={4}
                />
                <Text style={styles.assumptionUnit}>%</Text>
              </View>
            </View>
          ))}
        </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: cl.background },
    content: {
      paddingHorizontal: ClearLensSpacing.md,
      paddingTop: ClearLensSpacing.md,
      paddingBottom: ClearLensSpacing.xxl,
      alignItems: 'center',
    },
    frame: { width: '100%', maxWidth: 960, gap: ClearLensSpacing.xs },

    sectionHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: ClearLensSpacing.xs,
    },
    sectionLabel: {
      ...ClearLensTypography.label,
      color: cl.textTertiary,
      textTransform: 'uppercase',
      marginBottom: 2,
    },
    sectionDesc: {
      ...ClearLensTypography.bodySmall,
      color: cl.textTertiary,
      marginBottom: ClearLensSpacing.xs,
    },
    savedBadge: {
      ...ClearLensTypography.caption,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.emerald,
    },
    resetLink: {
      ...ClearLensTypography.bodySmall,
      color: cl.emerald,
      fontFamily: ClearLensFonts.semiBold,
    },

    card: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.border,
      overflow: 'hidden',
      ...ClearLensShadow,
    },

    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: 14,
      gap: ClearLensSpacing.md,
    },
    borderTop: { borderTopWidth: 1, borderTopColor: cl.borderLight },
    rowLeft: { flex: 1, gap: 3 },
    rowValue: {
      ...ClearLensTypography.h3,
      color: cl.navy,
    },
    rowSub: {
      ...ClearLensTypography.bodySmall,
      color: cl.textTertiary,
    },
    iconBubble: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: cl.mint50,
      alignItems: 'center',
      justifyContent: 'center',
    },

    assumptionInputWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    assumptionInput: {
      fontFamily: ClearLensFonts.semiBold,
      fontSize: 15,
      color: cl.navy,
      borderWidth: 1,
      borderColor: cl.borderLight,
      borderRadius: ClearLensRadii.sm,
      paddingHorizontal: ClearLensSpacing.sm,
      paddingVertical: 6,
      width: 52,
      textAlign: 'right',
      backgroundColor: cl.surfaceSoft,
    },
    assumptionUnit: {
      fontFamily: ClearLensFonts.semiBold,
      fontSize: 15,
      color: cl.textSecondary,
    },
  });
}
