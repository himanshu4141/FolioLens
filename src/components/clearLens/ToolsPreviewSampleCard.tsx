import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ToolsPreviewBanner } from '@/src/components/clearLens/ToolsPreviewBanner';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';

/**
 * Frozen sample-output card for Tools Hub screens whose live pipeline
 * is non-trivial to wire into preview mode (Compare Funds, Past SIP
 * Check). Renders a header + hero metric + a short list of
 * supporting rows + a sign-up CTA via `ToolsPreviewBanner`.
 *
 * The values are hardcoded because the underlying logic in those tools
 * needs ~36 months of NAV history (Past SIP) or three parallel
 * Supabase fetches (Compare Funds), and a faithful preview would need
 * fixtures for each. This card is the smaller v1 — it visibly satisfies
 * "show how the output looks" while sidestepping the data layer.
 */
export function ToolsPreviewSampleCard({
  bannerMessage,
  heroLabel,
  heroValue,
  heroSubtitle,
  rows,
  footnote,
}: {
  bannerMessage: string;
  heroLabel: string;
  heroValue: string;
  heroSubtitle?: string;
  rows: { label: string; value: string; tone?: 'positive' | 'negative' | 'neutral' }[];
  footnote?: string;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const cl = tokens.colors;

  return (
    <View style={styles.wrap}>
      <ToolsPreviewBanner message={bannerMessage} />
      <View style={styles.heroCard}>
        <Text style={styles.heroLabel}>{heroLabel}</Text>
        <Text style={styles.heroValue}>{heroValue}</Text>
        {heroSubtitle ? <Text style={styles.heroSubtitle}>{heroSubtitle}</Text> : null}
      </View>
      <View style={styles.rowCard}>
        {rows.map((row, idx) => (
          <View key={`${row.label}-${idx}`} style={styles.row}>
            {idx > 0 ? <View style={styles.rowDivider} /> : null}
            <View style={styles.rowInner}>
              <Text style={styles.rowLabel}>{row.label}</Text>
              <Text
                style={[
                  styles.rowValue,
                  row.tone === 'positive' && { color: cl.positive },
                  row.tone === 'negative' && { color: cl.negative },
                ]}
              >
                {row.value}
              </Text>
            </View>
          </View>
        ))}
      </View>
      {footnote ? (
        <View style={styles.footnote}>
          <Ionicons name="information-circle-outline" size={14} color={cl.textTertiary} />
          <Text style={styles.footnoteText}>{footnote}</Text>
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    wrap: {
      gap: ClearLensSpacing.sm,
    },
    heroCard: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.border,
      ...ClearLensShadow,
      padding: ClearLensSpacing.md,
      gap: 4,
    },
    heroLabel: {
      ...ClearLensTypography.label,
      color: cl.textTertiary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    heroValue: {
      ...ClearLensTypography.h1,
      fontFamily: ClearLensFonts.extraBold,
      color: cl.navy,
    },
    heroSubtitle: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      paddingTop: 2,
    },
    rowCard: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.border,
      ...ClearLensShadow,
      overflow: 'hidden',
    },
    row: {
      paddingHorizontal: ClearLensSpacing.md,
    },
    rowDivider: {
      height: 1,
      backgroundColor: cl.borderLight,
    },
    rowInner: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: ClearLensSpacing.sm,
      gap: ClearLensSpacing.md,
    },
    rowLabel: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      flex: 1,
    },
    rowValue: {
      ...ClearLensTypography.body,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.navy,
    },
    footnote: {
      flexDirection: 'row',
      gap: 6,
      alignItems: 'flex-start',
      paddingHorizontal: ClearLensSpacing.xs,
    },
    footnoteText: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      flex: 1,
      lineHeight: 16,
    },
  });
}
