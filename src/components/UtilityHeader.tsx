import { useMemo } from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';

interface UtilityHeaderProps {
  title: string;
  onBackPress?: () => void;
}

export function UtilityHeader({ title, onBackPress }: UtilityHeaderProps) {
  const router = useRouter();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

  return (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={onBackPress ?? (() => router.back())}
        style={styles.backBtn}
        activeOpacity={0.7}
      >
        <Ionicons name="chevron-back" size={22} color={tokens.colors.navy} />
      </TouchableOpacity>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: ClearLensSpacing.md,
      paddingTop: ClearLensSpacing.sm,
      paddingBottom: ClearLensSpacing.sm,
      borderBottomWidth: 1,
      backgroundColor: cl.background,
      borderBottomColor: cl.borderLight,
    },
    backBtn: {
      width: 38,
      height: 38,
      borderRadius: ClearLensRadii.full,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: cl.surface,
      borderWidth: 1,
      borderColor: cl.border,
    },
    title: {
      ...ClearLensTypography.h3,
      fontFamily: ClearLensFonts.bold,
      fontWeight: '700',
      flex: 1,
      color: cl.navy,
    },
  });
}
