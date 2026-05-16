import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useIsRestoring } from '@tanstack/react-query';
import {
  ClearLensCard,
  ClearLensHeader,
  ClearLensScreen,
} from '@/src/components/clearLens/ClearLensPrimitives';
import { useMoneyTrail } from '@/src/hooks/useMoneyTrail';
import { ResponsiveRouteFrame } from '@/src/components/responsive';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { formatCurrency } from '@/src/utils/formatting';
import {
  directionLabel,
  formatMoneyTrailDate,
  statusLabel,
  transactionUseExplanation,
  type PortfolioTransaction,
} from '@/src/utils/moneyTrail';
import { exportMoneyTrailCsv } from '@/src/utils/moneyTrailExport';

function valueOrDash(value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === '') return 'Not available';
  return String(value);
}

function DetailRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'muted';
}) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text
        style={[
          styles.detailValue,
          tone === 'positive' && styles.detailPositive,
          tone === 'muted' && styles.detailMuted,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

function topIconFor(transaction: PortfolioTransaction): keyof typeof Ionicons.glyphMap {
  if (transaction.hiddenByDefault) return 'remove-circle-outline';
  if (transaction.direction === 'money_in') return 'arrow-down-circle-outline';
  if (transaction.direction === 'money_out') return 'arrow-up-circle-outline';
  if (transaction.direction === 'internal') return 'swap-horizontal-outline';
  return 'ellipse-outline';
}

function topColorFor(transaction: PortfolioTransaction, tokens: ClearLensTokens): string {
  const cl = tokens.colors;
  if (transaction.hiddenByDefault) return cl.textTertiary;
  if (transaction.direction === 'money_in' || transaction.type === 'dividend_reinvestment') {
    return cl.emeraldDeep;
  }
  if (transaction.direction === 'money_out') return cl.amber;
  return cl.textPrimary;
}

function ExplanationCard({ transaction }: { transaction: PortfolioTransaction }) {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  return (
    <ClearLensCard style={styles.explainerCard}>
      <View style={styles.explainerTitleRow}>
        <Text style={styles.sectionTitle}>How FolioLens uses this</Text>
        <Ionicons name="information-circle-outline" size={18} color={tokens.colors.textTertiary} />
      </View>
      <DetailRow
        label="Included in invested amount"
        value={transaction.includedInInvestedAmount ? 'Yes' : 'No'}
        tone={transaction.includedInInvestedAmount ? 'positive' : 'muted'}
      />
      <DetailRow
        label="Used in XIRR calculation"
        value={transaction.includedInXirr ? 'Yes' : 'No'}
        tone={transaction.includedInXirr ? 'positive' : 'muted'}
      />
      <DetailRow
        label="Included in current holdings"
        value={transaction.includedInCurrentHoldings ? 'Yes' : 'No'}
        tone={transaction.includedInCurrentHoldings ? 'positive' : 'muted'}
      />
      <Text style={styles.explainerText}>{transactionUseExplanation(transaction)}</Text>
    </ClearLensCard>
  );
}

export default function MoneyTrailDetailScreen() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const { data, isLoading } = useMoneyTrail();
  // See `app/money-trail/index.tsx` for why this is needed — same
  // flash-of-empty-state on cold launch while the persister rehydrates.
  const isRestoring = useIsRestoring();
  const showFirstLoad = isRestoring || isLoading || data === undefined;
  const transaction = useMemo(
    () => data?.transactions.find((item) => item.id === id) ?? null,
    [data?.transactions, id],
  );

  async function handleShare(tx: PortfolioTransaction) {
    await Share.share({
      title: 'FolioLens Money Trail',
      message: `${tx.userFacingType}\n${tx.fundName}\n${formatMoneyTrailDate(tx.date)}\n${formatCurrency(tx.amount)}`,
    });
  }

  async function handleExport(tx: PortfolioTransaction) {
    setExportResult(null);
    setExportError(null);
    try {
      const result = await exportMoneyTrailCsv([tx]);
      setExportResult(result.message);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Please try again.');
    }
  }

  return (
    <ResponsiveRouteFrame>
    <ClearLensScreen>
      <Stack.Screen options={{ headerShown: false }} />
      <ClearLensHeader onPressBack={() => router.back()} />

      {showFirstLoad ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={tokens.colors.emerald} />
        </View>
      ) : !transaction ? (
        <View style={styles.centered}>
          <Ionicons name="document-text-outline" size={40} color={tokens.colors.textTertiary} />
          <Text style={styles.emptyTitle}>Transaction not found</Text>
          <Text style={styles.emptyText}>It may have been removed by a newer CAS import.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <View style={styles.titleBlock}>
            <Text style={styles.eyebrow}>Money Trail</Text>
            <Text style={styles.title}>Transaction details</Text>
          </View>
          <ClearLensCard style={styles.heroCard}>
            <View style={styles.heroTop}>
              <View style={[styles.heroIcon, { backgroundColor: transaction.hiddenByDefault ? tokens.colors.grey50 : tokens.colors.mint50 }]}>
                <Ionicons name={topIconFor(transaction)} size={21} color={topColorFor(transaction, tokens)} />
              </View>
              <View style={styles.heroTitleBlock}>
                <Text style={styles.transactionType}>{transaction.userFacingType}</Text>
                <Text style={styles.directionLabel}>{directionLabel(transaction.direction)}</Text>
              </View>
              <View style={styles.statusPill}>
                <Text style={styles.statusPillText}>{statusLabel(transaction.status)}</Text>
              </View>
            </View>

            <View style={styles.amountBlock}>
              <Text style={styles.amountLabel}>Amount</Text>
              <Text style={[styles.amountValue, { color: topColorFor(transaction, tokens) }]}>
                {formatCurrency(transaction.amount)}
              </Text>
            </View>

            <DetailRow label="Date" value={formatMoneyTrailDate(transaction.date)} />
            <DetailRow label="Fund" value={transaction.fundName} />
            <DetailRow label="AMC" value={valueOrDash(transaction.amcName)} />
          </ClearLensCard>

          <ClearLensCard style={styles.detailsCard}>
            <Text style={styles.sectionTitle}>More details</Text>
            <DetailRow label="Folio number" value={valueOrDash(transaction.folioNumber)} />
            <DetailRow label="Units allotted / redeemed" value={valueOrDash(transaction.units?.toFixed(3))} />
            <DetailRow label="NAV / price per unit" value={transaction.nav != null ? `₹${transaction.nav.toFixed(4)}` : 'Not available'} />
            <DetailRow label="Transaction type" value={transaction.userFacingType} />
            <DetailRow label="Payment mode" value={valueOrDash(transaction.paymentMode)} />
            <DetailRow label="Instalment number" value={valueOrDash(transaction.installmentNumber)} />
            <DetailRow label="Reference ID" value={valueOrDash(transaction.referenceId)} />
            <DetailRow label="Source" value="CAS" />
          </ClearLensCard>

          {(transaction.units == null || transaction.nav == null) && (
            <View style={styles.partialBox}>
              <Text style={styles.partialTitle}>Some details are missing</Text>
              <Text style={styles.partialText}>
                This transaction came from your statement, but a few optional details were not available.
              </Text>
            </View>
          )}

          <ExplanationCard transaction={transaction} />

          {exportResult && <Text style={styles.exportResult}>{exportResult}</Text>}
          {exportError && (
            <View style={styles.errorBox}>
              <Text style={styles.errorBoxTitle}>Couldn&apos;t export CSV</Text>
              <Text style={styles.errorBoxText}>{exportError}</Text>
            </View>
          )}

          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => handleShare(transaction)} activeOpacity={0.76}>
              <Ionicons name="share-social-outline" size={18} color={tokens.colors.navy} />
              <Text style={styles.secondaryButtonText}>Share</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.primaryButton} onPress={() => handleExport(transaction)} activeOpacity={0.82}>
              <Ionicons name="download-outline" size={18} color={tokens.colors.textOnDark} />
              <Text style={styles.primaryButtonText}>Export CSV</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}
    </ClearLensScreen>
    </ResponsiveRouteFrame>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
  scroll: {
    paddingHorizontal: ClearLensSpacing.md,
    paddingBottom: ClearLensSpacing.xxl,
    gap: ClearLensSpacing.md,
  },
  titleBlock: {
    gap: 4,
  },
  eyebrow: {
    ...ClearLensTypography.label,
    color: cl.emerald,
    textTransform: 'uppercase',
  },
  title: {
    ...ClearLensTypography.h1,
    color: cl.navy,
  },
  heroCard: {
    gap: ClearLensSpacing.md,
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ClearLensSpacing.sm,
  },
  heroIcon: {
    width: 40,
    height: 40,
    borderRadius: ClearLensRadii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroTitleBlock: {
    flex: 1,
    gap: 2,
  },
  transactionType: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  directionLabel: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  statusPill: {
    minHeight: 28,
    paddingHorizontal: ClearLensSpacing.sm,
    borderRadius: ClearLensRadii.full,
    backgroundColor: cl.mint50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusPillText: {
    ...ClearLensTypography.caption,
    color: cl.emeraldDeep,
    fontFamily: ClearLensFonts.bold,
  },
  amountBlock: {
    gap: 2,
  },
  amountLabel: {
    ...ClearLensTypography.caption,
    color: cl.textTertiary,
  },
  amountValue: {
    ...ClearLensTypography.h1,
  },
  detailsCard: {
    gap: ClearLensSpacing.sm,
  },
  sectionTitle: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  detailRow: {
    minHeight: 36,
    paddingVertical: ClearLensSpacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: cl.borderLight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: ClearLensSpacing.md,
  },
  detailLabel: {
    ...ClearLensTypography.bodySmall,
    flex: 1,
    color: cl.textTertiary,
  },
  detailValue: {
    ...ClearLensTypography.bodySmall,
    flex: 1,
    textAlign: 'right',
    color: cl.navy,
    fontFamily: ClearLensFonts.semiBold,
  },
  detailPositive: {
    color: cl.emeraldDeep,
  },
  detailMuted: {
    color: cl.textTertiary,
  },
  partialBox: {
    padding: ClearLensSpacing.md,
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.surfaceSoft,
    gap: 3,
  },
  partialTitle: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  partialText: {
    ...ClearLensTypography.caption,
    color: cl.textSecondary,
  },
  explainerCard: {
    gap: ClearLensSpacing.sm,
    backgroundColor: cl.mint50,
  },
  explainerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  explainerText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
  },
  actionRow: {
    flexDirection: 'row',
    gap: ClearLensSpacing.sm,
  },
  secondaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: ClearLensRadii.md,
    borderWidth: 1,
    borderColor: cl.border,
    backgroundColor: cl.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: ClearLensSpacing.sm,
  },
  primaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.emeraldDeep,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: ClearLensSpacing.sm,
  },
  secondaryButtonText: {
    ...ClearLensTypography.bodySmall,
    color: cl.navy,
    fontFamily: ClearLensFonts.bold,
  },
  primaryButtonText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textOnDark,
    fontFamily: ClearLensFonts.bold,
  },
  exportResult: {
    ...ClearLensTypography.caption,
    color: cl.emeraldDeep,
    textAlign: 'center',
  },
  errorBox: {
    padding: ClearLensSpacing.md,
    borderRadius: ClearLensRadii.md,
    backgroundColor: cl.negativeBg,
    gap: 2,
  },
  errorBoxTitle: {
    ...ClearLensTypography.bodySmall,
    color: tokens.semantic.sentiment.negativeText,
    fontFamily: ClearLensFonts.bold,
  },
  errorBoxText: {
    ...ClearLensTypography.caption,
    color: tokens.semantic.sentiment.negativeText,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: ClearLensSpacing.sm,
    paddingHorizontal: ClearLensSpacing.lg,
  },
  emptyTitle: {
    ...ClearLensTypography.h3,
    color: cl.navy,
  },
  emptyText: {
    ...ClearLensTypography.bodySmall,
    color: cl.textSecondary,
    textAlign: 'center',
  },
});
}
