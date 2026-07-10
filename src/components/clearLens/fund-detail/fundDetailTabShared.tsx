import { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { TimeWindow } from '@/src/hooks/useFundDetail';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensCompatibleTokens,
} from '@/src/constants/clearLensTheme';

export const FUND_DETAIL_CHART_MAX = 960;

const TIME_WINDOWS: TimeWindow[] = ['1M', '3M', '6M', '1Y', '3Y', 'All'];

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format a YYYY-MM-DD NAV date for staleness display: "2026-03-20" → "20 Mar" */
export function formatNavDate(iso: string): string {
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  const [, month, day] = parts;
  return `${parseInt(day, 10)} ${MONTH_ABBR[parseInt(month, 10) - 1]}`;
}

/** Format a YYYY-MM-DD date string for x-axis labels based on the selected window. */
export function formatChartDate(dateStr: string, window: TimeWindow): string {
  const [year, month, day] = dateStr.split('-');
  const mon = MONTH_ABBR[parseInt(month, 10) - 1] ?? month;
  const yr2 = year.slice(2);
  switch (window) {
    case '1M': return `${parseInt(day, 10)} ${mon}`;   // "5 Feb"
    case '3M': return `${parseInt(day, 10)} ${mon}`;   // "20 Dec"
    case '6M': return `${mon} '${yr2}`;                // "Sep '24"
    case '1Y': return `${mon} '${yr2}`;                // "Mar '25"
    case '3Y':
    case '5Y':
    case '10Y':
    case '15Y':
    case 'All': return `${mon} '${yr2}`;               // "Jan '22"
  }
}

export function TimeWindowSelector({
  selected,
  onChange,
}: {
  selected: TimeWindow;
  onChange: (w: TimeWindow) => void;
}) {
  const { compatible: colors } = useClearLensTokens();
  const s = useMemo(() => makeFundDetailTabStyles(colors), [colors]);
  return (
    <View style={s.windowRow}>
      {TIME_WINDOWS.map((w) => (
        <TouchableOpacity
          key={w}
          style={[
            s.windowPill,
            selected === w && s.windowPillActive,
          ]}
          onPress={() => onChange(w)}
          activeOpacity={0.75}
        >
          <Text style={[s.windowPillText, selected === w && s.windowPillTextActive]}>
            {w}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export function makeFundDetailTabStyles(colors: ClearLensCompatibleTokens) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },

    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
    errorText: { ...ClearLensTypography.body, color: colors.textSecondary },
    backLink: { color: colors.primary, fontSize: 14, fontWeight: '600' as const },

    // ── Fund header ──
    fundHeader: {
      backgroundColor: colors.surface,
      margin: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
      gap: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    fundName: { fontSize: 17, fontWeight: '700' as const, color: colors.textPrimary, lineHeight: 24 },
    fundCategory: { ...ClearLensTypography.bodySmall, color: colors.textTertiary, marginBottom: 6, fontWeight: '600' as const },

    holdingRow: { flexDirection: 'row', marginTop: 2 },
    holdingStat: { flex: 1, alignItems: 'center', gap: 4 },
    holdingValue: { fontSize: 15, fontWeight: '800' as const, color: colors.textPrimary },
    holdingValuePending: { fontSize: 13, fontWeight: '500' as const, color: colors.textTertiary, fontStyle: 'italic' },
    navStaleLabel: { fontSize: 11, color: colors.textTertiary, fontStyle: 'italic' },

    gainRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
    gainValue: { fontSize: 14, fontWeight: '700' as const },

    xirrHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, flexWrap: 'wrap' },
    xirrHeaderValue: { fontSize: 14, fontWeight: '700' as const },
    xirrHeaderHint: { fontSize: 11, color: colors.textTertiary, fontWeight: '600' as const },

    // ── Tab bar ──
    tabBar: {
      flexDirection: 'row',
      marginHorizontal: ClearLensSpacing.md,
      backgroundColor: colors.borderLight,
      borderRadius: ClearLensRadii.md,
      padding: 4,
      marginBottom: ClearLensSpacing.xs,
    },
    tab: {
      flex: 1,
      paddingVertical: 9,
      alignItems: 'center',
      borderRadius: ClearLensRadii.sm,
    },
    tabActive: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    tabText: { fontSize: 13, fontWeight: '600' as const, color: colors.textTertiary },
    tabTextActive: { color: colors.textPrimary, fontWeight: '700' as const },

    // ── Tab content ──
    tabContent: { paddingHorizontal: ClearLensSpacing.md, gap: 14 },

    // XIRR card
    xirrCard: {
      backgroundColor: colors.surface,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
      gap: ClearLensSpacing.md,
      marginTop: ClearLensSpacing.sm,
      borderWidth: 1,
      borderColor: colors.border,
    },
    comparisonRow: { flexDirection: 'row', alignItems: 'flex-start' },
    comparisonCol: { flex: 1, gap: 4 },
    comparisonHint: {
      fontSize: 11,
      lineHeight: 16,
      color: colors.textTertiary,
      fontWeight: '600' as const,
    },
    xirrDivider: { width: 1, backgroundColor: colors.borderLight, marginHorizontal: 12 },
    xirrValue: { fontSize: 22, fontWeight: '800' as const, color: colors.textPrimary, letterSpacing: -0.5 },
    verdictRow: {
      marginTop: 10,
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: colors.borderLight,
    },
    verdictText: { fontSize: 13, fontWeight: '600' as const },

    // Chart
    chartCard: {
      backgroundColor: colors.surface,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
      gap: 10,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: colors.border,
    },
    chartWrap: {
      alignItems: 'center',
      overflow: 'hidden',
    },
    chartLegendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    legendDot: { width: 10, height: 10, borderRadius: 5 },
    legendLabel: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' as const },
    // Header above the chart — title + subtitle on the left, "vs <benchmark>"
    // pill on the right, mirroring the Portfolio "How your money grew" card.
    chartHeaderRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: ClearLensSpacing.sm,
    },
    chartHeaderCopy: { flex: 1, gap: 2, minWidth: 0 },
    chartHeaderTitle: { fontSize: 16, fontWeight: '700' as const, color: colors.textPrimary },
    chartHeaderSubtitle: { fontSize: 12, color: colors.textSecondary },
    chartHeaderBadge: {
      paddingHorizontal: ClearLensSpacing.sm,
      paddingVertical: 4,
      borderRadius: ClearLensRadii.full,
      backgroundColor: colors.surfaceAlt,
      borderWidth: 1,
      borderColor: colors.border,
    },
    chartHeaderBadgeText: { fontSize: 12, color: colors.textPrimary, fontWeight: '600' as const },

    returnSummary: { gap: 6, marginTop: 4 },
    summaryDateLabel: { fontSize: 11, color: colors.textTertiary, marginBottom: 2 },
    returnRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    returnLabel: { fontSize: 13, color: colors.textSecondary, fontWeight: '600' as const },
    returnVal: { fontSize: 14, color: colors.textPrimary, fontWeight: '700' as const },

    navStatsRow: { flexDirection: 'row' },
    navStat: { flex: 1, alignItems: 'center', gap: 3 },
    navStatValue: { fontSize: 13, fontWeight: '700' as const, color: colors.textPrimary },

    statLabel: { ...ClearLensTypography.caption, color: colors.textTertiary, textTransform: 'uppercase' },

    windowRow: { flexDirection: 'row', gap: 6 },
    // Inactive pill: subtle surface lift + hairline border so it reads as a
    // discrete chip in both schemes. The previous `borderLight` background
    // matched the dark-mode page bg almost exactly, leaving the unselected
    // pills feeling like floating text.
    windowPill: {
      flex: 1,
      paddingVertical: 6,
      borderRadius: ClearLensRadii.full,
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    windowPillActive: { backgroundColor: colors.primaryLight, borderWidth: 1, borderColor: colors.primary },
    windowPillText: { fontSize: 12, fontWeight: '600' as const, color: colors.textTertiary },
    windowPillTextActive: { color: colors.primary, fontWeight: '700' as const },

    chartAxisLabel: { fontSize: 9, color: colors.textTertiary },

    chartExplainer: {
      fontSize: 11,
      color: colors.textTertiary,
      fontStyle: 'italic',
      textAlign: 'center',
      lineHeight: 16,
    },
    noBenchmarkNote: {
      fontSize: 12,
      color: colors.textTertiary,
      textAlign: 'center',
      marginTop: 2,
    },
    benchmarkDisclosure: {
      fontSize: 11,
      color: colors.textTertiary,
      textAlign: 'center',
      lineHeight: 15,
      paddingHorizontal: 12,
      paddingTop: 12,
    },

    benchmarkSelectorContent: {
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: 0,
    },
    benchmarkPill: {
      paddingVertical: 5,
      paddingHorizontal: 10,
      borderRadius: ClearLensRadii.full,
      backgroundColor: colors.borderLight,
    },
    benchmarkPillActive: { backgroundColor: colors.primaryLight, borderWidth: 1, borderColor: colors.primary },
    benchmarkPillText: { fontSize: 11, fontWeight: '600' as const, color: colors.textTertiary },
    benchmarkPillTextActive: { color: colors.primary, fontWeight: '700' as const },

    pointerLabel: {
      backgroundColor: colors.surface,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 5,
      borderWidth: 1,
      borderColor: colors.borderLight,
      gap: 2,
    },
    pointerDate: { fontSize: 10, color: colors.textTertiary, fontWeight: '600' as const },
    pointerSeriesText: { fontSize: 11, color: colors.textSecondary },

    noData: { padding: 40, alignItems: 'center', gap: 10 },
    noDataText: { ...ClearLensTypography.body, color: colors.textTertiary, textAlign: 'center' },

    bottomPad: { height: 32 },
  });
}
