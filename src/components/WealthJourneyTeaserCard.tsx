import { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useSession } from '@/src/hooks/useSession';
import { supabase } from '@/src/lib/supabase';
import {
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { useAppStore } from '@/src/store/appStore';
import { buildReturnProfile, buildWealthJourneyTeaser, estimateRecurringMonthlySip } from '@/src/utils/wealthJourney';

interface Props {
  currentCorpus: number;
  xirr: number;
}

export function WealthJourneyTeaserCard({ currentCorpus, xirr }: Props) {
  const router = useRouter();
  const { session } = useSession();
  const userId = session?.user.id;
  const { compatible: colors } = useClearLensTokens();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { wealthJourney } = useAppStore();

  const sixMonthsAgo = useMemo(() => {
    const date = new Date();
    date.setMonth(date.getMonth() - 6);
    return date.toISOString().split('T')[0];
  }, []);

  const { data: transactions, isLoading } = useQuery({
    queryKey: ['wealth-journey-teaser-transactions', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('transaction')
        .select('transaction_date, amount, transaction_type, fund_id')
        .eq('user_id', userId!)
        .gte('transaction_date', sixMonthsAgo);
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const detectedSip = useMemo(
    () => estimateRecurringMonthlySip(transactions ?? []),
    [transactions],
  );
  const returnProfile = useMemo(() => buildReturnProfile(xirr), [xirr]);
  const annualReturn = wealthJourney.expectedReturn ?? returnProfile.presets.find(
    (preset) => preset.key === returnProfile.defaultPresetKey,
  )?.value ?? 10;

  const teaser = buildWealthJourneyTeaser({
    hasOpened: wealthJourney.hasOpened,
    hasSavedPlan: wealthJourney.hasSavedPlan,
    currentCorpus,
    monthlySip:
      wealthJourney.futureSipTarget ??
      (wealthJourney.currentSipOverride ?? detectedSip) + wealthJourney.monthlySipIncrease,
    annualReturn,
    lastUsedHorizonYears: wealthJourney.hasSavedPlan ? wealthJourney.yearsToRetirement : null,
  });

  return (
    <View style={styles.wrapper}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>{teaser.eyebrow}</Text>
        <Ionicons name="sparkles-outline" size={16} color={colors.primary} />
      </View>
      <Text style={styles.title}>{teaser.title}</Text>
      <Text style={styles.supportingText}>{teaser.supportingText}</Text>
      <TouchableOpacity
        style={styles.cta}
        onPress={() => router.push('/wealth-journey' as never)}
        activeOpacity={0.85}
      >
        {isLoading ? <ActivityIndicator size="small" color="#fff" /> : null}
        <Text style={styles.ctaText}>{teaser.cta}</Text>
      </TouchableOpacity>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useClearLensTokens>['compatible']) {
  return StyleSheet.create({
    wrapper: {
      marginHorizontal: ClearLensSpacing.md,
      marginTop: ClearLensSpacing.md,
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      gap: 8,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    eyebrow: {
      fontSize: 11,
      fontWeight: '800',
      color: colors.primary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    title: {
      ...ClearLensTypography.h3,
      color: colors.textPrimary,
      lineHeight: 24,
    },
    supportingText: {
      ...ClearLensTypography.bodySmall,
      color: colors.textSecondary,
      lineHeight: 19,
    },
    cta: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: ClearLensRadii.full,
      backgroundColor: colors.primaryLight,
      borderWidth: 1,
      borderColor: colors.border,
    },
    ctaText: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: '800',
    },
  });
}
