/**
 * Cache debug screen — one panel per cache surface (SQLite tx / nav /
 * idx, `sync_state`, React Query persister, Zustand store, auth
 * session presence). Gated behind the 7-tap-on-version easter egg
 * (`debugUnlocked` in the appStore) and behind `SQLITE_AVAILABLE` —
 * on web there's no SQLite layer to inspect.
 *
 * Read-only. The mutation buttons ("Reset local cache") live on
 * Settings → Data sync; this screen is just for inspection.
 *
 * Each card collapses gracefully when its data source is empty or
 * errored — nulls render as "—" so screenshots are diagnostic
 * even when half the snapshot fails.
 */
import { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useQuery } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useSession } from '@/src/hooks/useSession';
import { useUserFunds } from '@/src/hooks/useUserFunds';
import { useAppStore } from '@/src/store/appStore';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { UtilityHeader } from '@/src/components/UtilityHeader';
import { SQLITE_AVAILABLE } from '@/src/lib/db/availability';
import { snapshotCache, type CacheDebugSnapshot } from '@/src/lib/db/debug';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';

function formatBytes(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('en-IN');
}

function formatIso(iso: string | null | undefined): string {
  if (!iso) return '—';
  // Try full timestamp first, then date-only.
  if (iso.includes('T')) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
  }
  return iso;
}

function driftColor(drift: number | null, tokens: ClearLensTokens): string {
  if (drift == null) return tokens.colors.textTertiary;
  if (drift === 0) return tokens.colors.emerald;
  if (Math.abs(drift) < 5) return tokens.colors.amber;
  return tokens.colors.negative;
}

export default function CacheDebugScreen() {
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const router = useRouter();
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const debugUnlocked = useAppStore((s) => s.debugUnlocked);
  const debugSupported = SQLITE_AVAILABLE && Platform.OS !== 'web';

  // Pull fund metadata so the per-scheme NAV breakdown can label
  // rows with the scheme name instead of bare scheme codes.
  const { data: funds } = useUserFunds();

  const snapshotQuery = useQuery({
    queryKey: ['cache-debug-snapshot', userId, funds?.length ?? 0],
    enabled: debugSupported && debugUnlocked && !!userId,
    queryFn: () => snapshotCache(userId!, funds ?? []),
    staleTime: 0,
  });

  const [copyState, setCopyState] = useState<'idle' | 'done'>('idle');

  async function handleCopyJson() {
    if (!snapshotQuery.data) return;
    // Include the live Zustand snapshot too — that's not in the
    // SQLite-focused `snapshotCache` but useful when copying state
    // for a support thread.
    const payload = {
      ...snapshotQuery.data,
      zustand: serializeZustand(useAppStore.getState() as unknown as Record<string, unknown>),
      env: {
        platform: Platform.OS,
        userIdHint: userId?.slice(0, 8) ?? null,
      },
    };
    await Clipboard.setStringAsync(JSON.stringify(payload, null, 2));
    setCopyState('done');
    setTimeout(() => setCopyState('idle'), 2000);
  }

  // ── Render path: gates ────────────────────────────────────────────
  if (!debugSupported) {
    return (
      <SafeAreaView style={styles.container}>
        <UtilityHeader title="Cache debug" />
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>
            Cache debug is native-only — web has no local SQLite layer to inspect.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!debugUnlocked) {
    return (
      <SafeAreaView style={styles.container}>
        <UtilityHeader title="Cache debug" />
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>
            Debug mode is locked. Go to Settings → About and tap the version row 7 times to unlock.
          </Text>
          <TouchableOpacity
            style={styles.placeholderButton}
            onPress={() => router.push('/settings/about')}
            activeOpacity={0.8}
          >
            <Text style={styles.placeholderButtonText}>Go to About</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const snap = snapshotQuery.data;
  const loading = snapshotQuery.isLoading || (snapshotQuery.isFetching && !snap);

  return (
    <SafeAreaView style={styles.container}>
      <UtilityHeader title="Cache debug" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.frame}>
          {/* Toolbar */}
          <View style={styles.toolbar}>
            <Text style={styles.toolbarMeta}>
              {snap ? `Snapshot · ${formatIso(snap.generatedAt)}` : 'Snapshot · —'}
            </Text>
            <View style={styles.toolbarActions}>
              <TouchableOpacity
                style={styles.toolbarBtn}
                onPress={() => snapshotQuery.refetch()}
                disabled={loading}
                activeOpacity={0.75}
              >
                {loading ? (
                  <ActivityIndicator size="small" color={tokens.colors.emerald} />
                ) : (
                  <Ionicons name="refresh-outline" size={14} color={tokens.colors.emerald} />
                )}
                <Text style={styles.toolbarBtnText}>Refresh</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.toolbarBtn}
                onPress={handleCopyJson}
                disabled={!snap}
                activeOpacity={0.75}
              >
                <Ionicons
                  name={copyState === 'done' ? 'checkmark' : 'copy-outline'}
                  size={14}
                  color={tokens.colors.emerald}
                />
                <Text style={styles.toolbarBtnText}>
                  {copyState === 'done' ? 'Copied' : 'Copy JSON'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {!snap && loading ? (
            <View style={styles.placeholder}>
              <ActivityIndicator size="large" color={tokens.colors.emerald} />
            </View>
          ) : !snap ? (
            <View style={styles.placeholder}>
              <Text style={styles.placeholderText}>Couldn&apos;t build snapshot. Try refresh.</Text>
            </View>
          ) : (
            <>
              <TxCard snap={snap.tx} styles={styles} tokens={tokens} />
              <NavCard snap={snap.nav} styles={styles} />
              <IdxCard snap={snap.idx} styles={styles} />
              <SyncStateCard rows={snap.syncState} styles={styles} />
              <PersisterCard snap={snap.persister} styles={styles} tokens={tokens} />
              <AsyncStorageCard styles={styles} />
              <ZustandCard styles={styles} />
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Cards ──────────────────────────────────────────────────────────

function CardHeader({ title, subtitle, styles }: { title: string; subtitle?: string; styles: Styles }) {
  return (
    <View style={styles.cardHeader}>
      <Text style={styles.cardTitle}>{title}</Text>
      {subtitle ? <Text style={styles.cardSubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

function Row({
  label,
  value,
  valueColor,
  styles,
}: {
  label: string;
  value: string;
  valueColor?: string;
  styles: Styles;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
    </View>
  );
}

function TxCard({
  snap,
  styles,
  tokens,
}: {
  snap: CacheDebugSnapshot['tx'];
  styles: Styles;
  tokens: ClearLensTokens;
}) {
  return (
    <View style={styles.card}>
      <CardHeader title="Transactions (SQLite)" styles={styles} />
      <Row label="Local count" value={formatNumber(snap.localCount)} styles={styles} />
      <Row label="Server count" value={formatNumber(snap.serverCount)} styles={styles} />
      <Row
        label="Drift"
        value={snap.drift == null ? '—' : (snap.drift > 0 ? `+${snap.drift}` : `${snap.drift}`)}
        valueColor={driftColor(snap.drift, tokens)}
        styles={styles}
      />
      <Row label="Latest trade date" value={snap.latestTransactionDate ?? '—'} styles={styles} />
      <Row label="Watermark (created_at)" value={formatIso(snap.watermarkCreatedAt)} styles={styles} />
    </View>
  );
}

function NavCard({ snap, styles }: { snap: CacheDebugSnapshot['nav']; styles: Styles }) {
  return (
    <View style={styles.card}>
      <CardHeader
        title="NAV history (SQLite)"
        subtitle={`${formatNumber(snap.totalCount)} rows across ${snap.perScheme.length} schemes`}
        styles={styles}
      />
      {snap.perScheme.length === 0 ? (
        <Row label="—" value="No schemes" styles={styles} />
      ) : (
        snap.perScheme.map((s) => (
          <Row
            key={s.schemeCode}
            label={s.schemeName ?? `Scheme ${s.schemeCode}`}
            value={`${formatNumber(s.rowCount)} rows · ${s.watermark ?? '—'}`}
            styles={styles}
          />
        ))
      )}
    </View>
  );
}

function IdxCard({ snap, styles }: { snap: CacheDebugSnapshot['idx']; styles: Styles }) {
  return (
    <View style={styles.card}>
      <CardHeader
        title="Index history (SQLite)"
        subtitle={`${formatNumber(snap.totalCount)} rows across ${snap.perSymbol.length} indexes`}
        styles={styles}
      />
      {snap.perSymbol.map((s) => (
        <Row
          key={s.symbol}
          label={s.label}
          value={`${formatNumber(s.rowCount)} rows · ${s.watermark ?? '—'}`}
          styles={styles}
        />
      ))}
    </View>
  );
}

function SyncStateCard({ rows, styles }: { rows: CacheDebugSnapshot['syncState']; styles: Styles }) {
  return (
    <View style={styles.card}>
      <CardHeader
        title="Sync state"
        subtitle={`${rows.length} scope${rows.length === 1 ? '' : 's'} tracked`}
        styles={styles}
      />
      {rows.length === 0 ? (
        <Row label="—" value="No sync yet" styles={styles} />
      ) : (
        rows.map((r) => (
          <Row
            key={r.scope}
            label={r.scope}
            value={`${formatIso(r.lastSyncedAt)} · wm ${r.watermarkDate ?? '—'}`}
            styles={styles}
          />
        ))
      )}
    </View>
  );
}

function PersisterCard({
  snap,
  styles,
  tokens,
}: {
  snap: CacheDebugSnapshot['persister'];
  styles: Styles;
  tokens: ClearLensTokens;
}) {
  return (
    <View style={styles.card}>
      <CardHeader
        title="React Query persister"
        subtitle="AsyncStorage blob of cached query results"
        styles={styles}
      />
      <Row
        label="Blob size"
        value={formatBytes(snap.blobSizeBytes)}
        valueColor={
          snap.blobSizeBytes != null && snap.blobSizeBytes > 5 * 1024 * 1024
            ? tokens.colors.negative
            : snap.blobSizeBytes != null && snap.blobSizeBytes > 2 * 1024 * 1024
              ? tokens.colors.amber
              : undefined
        }
        styles={styles}
      />
      <Row label="Buster" value={snap.buster ?? '—'} styles={styles} />
      <Row label="Persisted at" value={snap.timestamp ? formatIso(new Date(snap.timestamp).toISOString()) : '—'} styles={styles} />
      <Row label="Total entries" value={formatNumber(snap.entryCount)} styles={styles} />
      {snap.parseError ? (
        <Row label="Parse error" value={snap.parseError} valueColor={tokens.colors.negative} styles={styles} />
      ) : null}
      {snap.byKeyPrefix.map((p) => (
        <Row key={p.prefix} label={p.prefix} value={`${formatNumber(p.count)} entries`} styles={styles} />
      ))}
    </View>
  );
}

function AsyncStorageCard({ styles }: { styles: Styles }) {
  // Presence-only — never read these. The Supabase session token and
  // the onboarding draft both contain PII; this card's only job is
  // to confirm whether they exist on device.
  const presence = useQuery({
    queryKey: ['async-storage-presence'],
    queryFn: async () => {
      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
      const projectRef = supabaseUrl.match(/https:\/\/([a-z0-9]+)\./)?.[1] ?? '?';
      const authKey = `sb-${projectRef}-auth-token`;
      const draftKey = 'foliolens-onboarding-draft-v1';
      const [auth, draft] = await Promise.all([
        AsyncStorage.getItem(authKey),
        AsyncStorage.getItem(draftKey),
      ]);
      return {
        authPresent: auth != null,
        authSizeBytes: auth?.length ?? null,
        draftPresent: draft != null,
        draftSizeBytes: draft?.length ?? null,
      };
    },
    staleTime: 0,
  });

  return (
    <View style={styles.card}>
      <CardHeader title="AsyncStorage (other)" subtitle="PII-containing blobs — presence + size only" styles={styles} />
      <Row
        label="Supabase auth token"
        value={
          !presence.data
            ? '—'
            : presence.data.authPresent
              ? `Present (${formatBytes(presence.data.authSizeBytes)})`
              : 'Absent'
        }
        styles={styles}
      />
      <Row
        label="Onboarding draft"
        value={
          !presence.data
            ? '—'
            : presence.data.draftPresent
              ? `Present (${formatBytes(presence.data.draftSizeBytes)})`
              : 'Absent'
        }
        styles={styles}
      />
    </View>
  );
}

function ZustandCard({ styles }: { styles: Styles }) {
  // Pull every field via individual selectors so the card re-renders
  // when the user changes a preference live. Cheap — these are scalar
  // reads off the store.
  const defaultBenchmark = useAppStore((s) => s.defaultBenchmarkSymbol);
  const colorScheme = useAppStore((s) => s.appColorScheme);
  const fundsSortBy = useAppStore((s) => s.fundsSortBy);
  const moneyTrailSortBy = useAppStore((s) => s.moneyTrailSortBy);
  const portfolioChartWindow = useAppStore((s) => s.portfolioChartWindow);
  const previewMode = useAppStore((s) => s.previewMode);
  const importGateVisible = useAppStore((s) => s.importGateVisible);
  const debugUnlocked = useAppStore((s) => s.debugUnlocked);
  const goalsCount = useAppStore((s) => s.goals.length);

  return (
    <View style={styles.card}>
      <CardHeader title="Zustand store" subtitle="Persisted preferences + in-memory state" styles={styles} />
      <Row label="defaultBenchmarkSymbol" value={defaultBenchmark} styles={styles} />
      <Row label="appColorScheme" value={colorScheme} styles={styles} />
      <Row label="fundsSortBy" value={fundsSortBy} styles={styles} />
      <Row label="moneyTrailSortBy" value={moneyTrailSortBy} styles={styles} />
      <Row label="portfolioChartWindow" value={portfolioChartWindow} styles={styles} />
      <Row label="previewMode" value={String(previewMode)} styles={styles} />
      <Row label="importGateVisible" value={String(importGateVisible)} styles={styles} />
      <Row label="debugUnlocked" value={String(debugUnlocked)} styles={styles} />
      <Row label="goals.length" value={String(goalsCount)} styles={styles} />
    </View>
  );
}

// ── Serialisation for clipboard ────────────────────────────────────

function serializeZustand(state: Record<string, unknown>): Record<string, unknown> {
  // Drop functions (every action), keep data. JSON.stringify already
  // drops them but doing it explicitly here keeps the payload shape
  // predictable when grepping a pasted blob.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (typeof v === 'function') continue;
    out[k] = v;
  }
  return out;
}

// ── Styles ──────────────────────────────────────────────────────────

type Styles = ReturnType<typeof makeStyles>;

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
    frame: { width: '100%', maxWidth: 960, gap: ClearLensSpacing.sm },

    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: ClearLensSpacing.sm,
      paddingHorizontal: ClearLensSpacing.xs,
    },
    toolbarMeta: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      flex: 1,
    },
    toolbarActions: {
      flexDirection: 'row',
      gap: 8,
    },
    toolbarBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 6,
      backgroundColor: cl.mint50,
      borderRadius: ClearLensRadii.full,
    },
    toolbarBtnText: {
      ...ClearLensTypography.caption,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.emerald,
    },

    card: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.lg,
      borderWidth: 1,
      borderColor: cl.border,
      overflow: 'hidden',
      ...ClearLensShadow,
    },
    cardHeader: {
      paddingHorizontal: ClearLensSpacing.md,
      paddingTop: ClearLensSpacing.md,
      paddingBottom: 6,
      gap: 2,
    },
    cardTitle: {
      ...ClearLensTypography.h3,
      color: cl.navy,
    },
    cardSubtitle: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
    },

    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: 10,
      gap: ClearLensSpacing.sm,
      borderTopWidth: 1,
      borderTopColor: cl.borderLight,
    },
    rowLabel: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
      flex: 1,
    },
    rowValue: {
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
      fontFamily: ClearLensFonts.semiBold,
      textAlign: 'right',
      flex: 1,
    },

    placeholder: {
      paddingHorizontal: ClearLensSpacing.lg,
      paddingVertical: ClearLensSpacing.xl,
      alignItems: 'center',
      gap: ClearLensSpacing.md,
    },
    placeholderText: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
      textAlign: 'center',
    },
    placeholderButton: {
      paddingHorizontal: ClearLensSpacing.lg,
      paddingVertical: 10,
      borderRadius: ClearLensRadii.full,
      backgroundColor: cl.mint50,
    },
    placeholderButtonText: {
      ...ClearLensTypography.bodySmall,
      color: cl.emerald,
      fontFamily: ClearLensFonts.semiBold,
    },
  });
}
