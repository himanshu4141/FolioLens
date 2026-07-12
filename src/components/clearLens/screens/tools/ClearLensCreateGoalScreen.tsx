import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { ClearLensCard, ClearLensHeader, ClearLensScreen, ClearLensSegmentedControl } from '@/src/components/clearLens/ClearLensPrimitives';
import { ToolTitleBlock } from '@/src/components/clearLens/tools/kit';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { useAppStore, type GoalReturnPreset } from '@/src/store/appStore';
import { yearsFromNow } from '@/src/utils/goalPlanner';

const PRESET_OPTIONS: { value: GoalReturnPreset; label: string }[] = [
  { value: 'cautious', label: 'Cautious' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'growth', label: 'Growth' },
];

export function ClearLensCreateGoalScreen() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const router = useRouter();
  const { editId } = useLocalSearchParams<{ editId?: string }>();
  const { goals, addGoal, updateGoal, returnAssumptions } = useAppStore(
    useShallow((state) => ({
      goals: state.goals,
      addGoal: state.addGoal,
      updateGoal: state.updateGoal,
      returnAssumptions: state.returnAssumptions,
    })),
  );

  const editGoal = editId ? (goals.find((g) => g.id === editId) ?? null) : null;
  const isEditing = editGoal !== null;

  const [name, setName] = useState(() => editGoal?.name ?? '');
  const [targetStr, setTargetStr] = useState(() => editGoal ? String(editGoal.targetAmount) : '');
  const [yearsStr, setYearsStr] = useState(() => {
    if (!editGoal?.targetDate) return '10';
    return String(Math.max(1, Math.round(yearsFromNow(editGoal.targetDate))));
  });
  const [currentMonthlyStr, setCurrentMonthlyStr] = useState(() => editGoal?.currentMonthly ? String(editGoal.currentMonthly) : '');
  const [returnPreset, setReturnPreset] = useState<GoalReturnPreset>(() => editGoal?.returnPreset ?? 'balanced');

  const presetRate = returnAssumptions[returnPreset];

  const targetAmount = useMemo(() => parseRupees(targetStr), [targetStr]);
  const years = useMemo(() => parsePositiveNumber(yearsStr), [yearsStr]);

  const isValid = name.trim().length > 0 && targetAmount > 0 && years > 0;

  function handleSave() {
    if (!isValid) return;

    const targetDate = toTargetDate(years);
    const fields = {
      name: name.trim(),
      targetAmount,
      targetDate,
      lumpSum: 0,
      currentMonthly: parseRupees(currentMonthlyStr),
      returnPreset,
    };

    if (isEditing) {
      updateGoal(editGoal!.id, fields);
    } else {
      addGoal(fields);
    }

    router.back();
  }

  return (
    <ClearLensScreen>
      <ClearLensHeader onPressBack={() => router.back()} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <ToolTitleBlock
            eyebrow="Goal Planner"
            title={isEditing ? 'Edit goal' : 'New goal'}
          />

          <ClearLensCard style={styles.formCard}>
            <InputRow label="Goal name">
              <TextInput
                style={styles.textInput}
                placeholder="e.g. Home, Education, Retirement"
                placeholderTextColor={tokens.colors.textTertiary}
                value={name}
                onChangeText={setName}
                returnKeyType="next"
                autoFocus
              />
            </InputRow>

            <Separator />

            <InputRow label="Target amount (₹)">
              <TextInput
                style={styles.textInput}
                placeholder="e.g. 50,00,000"
                placeholderTextColor={tokens.colors.textTertiary}
                value={targetStr}
                onChangeText={setTargetStr}
                keyboardType="numeric"
                returnKeyType="next"
              />
            </InputRow>

            <Separator />

            <InputRow label="Timeline (years)">
              <TextInput
                style={styles.textInput}
                placeholder="1–40"
                placeholderTextColor={tokens.colors.textTertiary}
                value={yearsStr}
                onChangeText={setYearsStr}
                keyboardType="numeric"
                returnKeyType="next"
              />
            </InputRow>

            <Separator />

            <InputRow label="Current monthly investment (₹)">
              <TextInput
                style={styles.textInput}
                placeholder="0"
                placeholderTextColor={tokens.colors.textTertiary}
                value={currentMonthlyStr}
                onChangeText={setCurrentMonthlyStr}
                keyboardType="numeric"
                returnKeyType="done"
              />
            </InputRow>

            <Separator />

            <View style={styles.presetRow}>
              <View style={styles.presetLabelRow}>
                <Text style={styles.inputLabel}>Return assumption</Text>
                <Text style={styles.presetRate}>{presetRate}% p.a.</Text>
              </View>
              <ClearLensSegmentedControl
                options={PRESET_OPTIONS}
                selected={returnPreset}
                onChange={setReturnPreset}
              />
              <Text style={styles.presetHint}>
                You can change these percentages in Settings → Preferences.
              </Text>
            </View>
          </ClearLensCard>

          <TouchableOpacity
            style={[styles.saveButton, !isValid && styles.saveButtonDisabled]}
            onPress={handleSave}
            activeOpacity={0.8}
            disabled={!isValid}
          >
            <Text style={styles.saveButtonText}>{isEditing ? 'Save Changes' : 'Save Goal'}</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </ClearLensScreen>
  );
}

function InputRow({ label, children }: { label: string; children: React.ReactNode }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.inputRow}>
      <Text style={styles.inputLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Separator() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return <View style={styles.separator} />;
}

function parseRupees(str: string): number {
  const n = parseFloat(str.replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parsePositiveNumber(str: string): number {
  const n = parseFloat(str);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toTargetDate(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + Math.round(years));
  return d.toISOString().split('T')[0];
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
  flex: { flex: 1 },
  scrollContent: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingTop: ClearLensSpacing.xs,
    paddingBottom: ClearLensSpacing.xxl,
    gap: ClearLensSpacing.md,
  },
  formCard: {
    padding: 0,
    overflow: 'hidden',
  },
  inputRow: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingVertical: ClearLensSpacing.sm + 2,
    gap: 6,
  },
  inputLabel: {
    ...ClearLensTypography.label,
    color: cl.textTertiary,
    letterSpacing: 0.4,
  },
  textInput: {
    fontFamily: ClearLensFonts.regular,
    fontSize: 15,
    color: cl.textPrimary,
    paddingVertical: 4,
  },
  separator: {
    height: 1,
    backgroundColor: cl.borderLight,
    marginHorizontal: ClearLensSpacing.md,
  },
  presetRow: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingVertical: ClearLensSpacing.sm + 2,
    gap: 8,
  },
  presetLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  presetRate: {
    fontFamily: ClearLensFonts.semiBold,
    fontSize: 13,
    color: cl.emerald,
  },
  presetHint: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
    lineHeight: 16,
  },
  saveButton: {
    backgroundColor: cl.emerald,
    borderRadius: ClearLensRadii.md,
    paddingVertical: ClearLensSpacing.sm + 4,
    alignItems: 'center',
  },
  saveButtonDisabled: { opacity: 0.45 },
  saveButtonText: {
    fontFamily: ClearLensFonts.semiBold,
    fontSize: 16,
    color: cl.textOnDark,
  },
});
}
