import { useMemo } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Line as SvgLine, Path as SvgPath } from 'react-native-svg';
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
export interface ToolsPreviewChartSeries {
  label: string;
  color: string;
  points: number[]; // 8-24 datapoints typically
}

export function ToolsPreviewSampleCard({
  bannerMessage,
  heroLabel,
  heroValue,
  heroSubtitle,
  rows,
  chart,
  footnote,
}: {
  bannerMessage: string;
  heroLabel: string;
  heroValue: string;
  heroSubtitle?: string;
  rows: { label: string; value: string; tone?: 'positive' | 'negative' | 'neutral' }[];
  /** Optional small line chart shown between the hero and the row card.
   * Pass 1-2 series with the same number of points each. */
  chart?: { series: ToolsPreviewChartSeries[]; xLabels?: string[] };
  footnote?: string;
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const cl = tokens.colors;
  const { width: windowWidth } = useWindowDimensions();
  const chartWidth = Math.min(windowWidth, 960) - ClearLensSpacing.md * 4;
  const chartHeight = 140;

  return (
    <View style={styles.wrap}>
      <ToolsPreviewBanner message={bannerMessage} />
      <View style={styles.heroCard}>
        <Text style={styles.heroLabel}>{heroLabel}</Text>
        <Text style={styles.heroValue}>{heroValue}</Text>
        {heroSubtitle ? <Text style={styles.heroSubtitle}>{heroSubtitle}</Text> : null}
        {chart && chart.series.length > 0 ? (
          <View style={styles.chartWrap}>
            <PreviewLineChart
              series={chart.series}
              width={chartWidth}
              height={chartHeight}
              tokens={tokens}
            />
            <View style={styles.chartLegend}>
              {chart.series.map((s) => (
                <View key={s.label} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: s.color }]} />
                  <Text style={styles.legendText}>{s.label}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
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

/**
 * Tiny SVG line chart for the sample card. Computes a shared y-scale
 * across all series so they overlay cleanly. No axes / labels — just
 * the curves + a subtle baseline. Two series max is what looks good at
 * this height; more would clutter.
 */
function PreviewLineChart({
  series,
  width,
  height,
  tokens,
}: {
  series: ToolsPreviewChartSeries[];
  width: number;
  height: number;
  tokens: ClearLensTokens;
}) {
  if (series.length === 0 || series[0].points.length < 2) return null;
  const cl = tokens.colors;
  const padX = 4;
  const padY = 8;
  const plotW = Math.max(40, width - padX * 2);
  const plotH = Math.max(40, height - padY * 2);
  const all = series.flatMap((s) => s.points);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  function toPath(points: number[]): string {
    return points
      .map((v, i) => {
        const x = padX + (i / (points.length - 1)) * plotW;
        const y = padY + (1 - (v - min) / span) * plotH;
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }
  return (
    <Svg width={width} height={height}>
      <SvgLine
        x1={padX}
        x2={padX + plotW}
        y1={padY + plotH}
        y2={padY + plotH}
        stroke={cl.borderLight}
        strokeWidth={1}
      />
      {series.map((s) => (
        <SvgPath key={s.label} d={toPath(s.points)} stroke={s.color} strokeWidth={2} fill="none" />
      ))}
    </Svg>
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
    chartWrap: {
      paddingTop: ClearLensSpacing.sm,
      gap: 6,
    },
    chartLegend: {
      flexDirection: 'row',
      gap: ClearLensSpacing.md,
      paddingTop: 2,
    },
    legendItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    legendDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    legendText: {
      ...ClearLensTypography.caption,
      color: cl.textSecondary,
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
