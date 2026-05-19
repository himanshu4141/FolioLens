import { useState, useMemo } from 'react';
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
import { useIsRestoring, useQuery, useQueryClient } from '@tanstack/react-query';
import { navHistoryRepo } from '@/src/lib/data/navHistory';
import { transactionRepo } from '@/src/lib/data/transaction';
import { functionsClient } from '@/src/lib/functions';
import { useSession } from '@/src/hooks/useSession';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { SQLITE_AVAILABLE } from '@/src/lib/db/availability';
import * as txRepo from '@/src/lib/db/tx';
import * as navRepo from '@/src/lib/db/nav';
import * as idxRepo from '@/src/lib/db/idx';
import * as syncStateRepo from '@/src/lib/db/syncState';
import { bootstrapForUser } from '@/src/lib/db/sync';
import { analytics } from '@/src/lib/analytics';
import { UtilityHeader } from '@/src/components/UtilityHeader';
import { navStatusBadge } from './index';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';

export default function DataSyncScreen() {
  const tokens = useClearLensTokens();
  const colors = tokens.colors;
  const queryClient = useQueryClient();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

  // `useIsRestoring` returns true while the React Query persister is
  // rehydrating the cache from disk on a fresh mount. During that window
  // any query that depends on persisted state would render different
  // markup on server (no data → `'—'`) vs client (rehydrated date), and
  // React's hydration matcher would bail with error #418. Gating the
  // display value on this flag makes both sides emit the same fallback
  // until rehydration completes.
  const isRestoring = useIsRestoring();

  const { data: latestNavRow } = useQuery({
    queryKey: ['latest-nav-date'],
    queryFn: async () => {
      const { data } = await navHistoryRepo
        .from()
        .select('nav_date')
        .order('nav_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.nav_date as string | null ?? null;
    },
    staleTime: 10 * 60 * 1000,
  });

  // Hide the real value behind the same `'—'` placeholder both server-
  // rendered HTML and the very first client render use — only switch to
  // the actual date once the cache is restored and React's hydration
  // pass is complete.
  const displayedNavDate = isRestoring ? null : latestNavRow ?? null;
  const navBadge = navStatusBadge(displayedNavDate, colors);

  function formatNavDate(navDate: string | null | undefined): string {
    if (!navDate) return '—';
    const today = new Date().toISOString().split('T')[0];
    if (navDate === today) return 'Today';
    const d = new Date(navDate);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  type SyncState = 'idle' | 'syncing' | 'done' | 'error';
  const [syncState, setSyncState] = useState<SyncState>('idle');

  // ── Local cache debug surface ────────────────────────────────────────
  // Two counts side-by-side — what SQLite has vs what Supabase has — so
  // the user (or anyone helping them debug) can see drift live. Same
  // shape PostHog's `db_sync_bootstrap_started.local_tx_count_before`
  // event records, but in-app and observable in real time.
  //
  // Web has no SQLite layer, so the section is gated to native. The
  // server-count query uses PostgREST `count: 'exact', head: true` —
  // ~200 bytes over the wire, no row bodies.
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const localCacheEnabled = SQLITE_AVAILABLE && Platform.OS !== 'web';

  const { data: localTxCount } = useQuery({
    queryKey: ['debug-local-tx-count'],
    enabled: localCacheEnabled,
    queryFn: () => txRepo.count().catch(() => null as number | null),
    staleTime: 0,
  });
  const { data: serverTxCount } = useQuery({
    queryKey: ['debug-server-tx-count', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { count, error } = await transactionRepo
        .from()
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId!);
      if (error) return null;
      return count ?? 0;
    },
    staleTime: 0,
  });

  const driftAmount =
    localTxCount != null && serverTxCount != null ? serverTxCount - localTxCount : null;
  const driftSeverity: 'ok' | 'minor' | 'major' =
    driftAmount === null ? 'ok'
    : driftAmount === 0 ? 'ok'
    : Math.abs(driftAmount) < 5 ? 'minor'
    : 'major';

  type ResetState = 'idle' | 'resetting' | 'done' | 'error';
  const [resetState, setResetState] = useState<ResetState>('idle');

  async function handleResetLocalCache() {
    if (!userId || !localCacheEnabled) return;
    setResetState('resetting');
    analytics.track('debug_local_cache_reset_started', {
      local_before: localTxCount ?? null,
      server: serverTxCount ?? null,
    });
    try {
      // Wipe and re-bootstrap. The next read-through (or the bootstrap
      // itself) repopulates from Supabase. This is the recovery lever
      // surfaced for the May 2026 drift bug — if a user reports wrong
      // numbers, they (or support) can tap this without needing to
      // sign out.
      await Promise.all([
        txRepo.clear(),
        navRepo.clear(),
        idxRepo.clear(),
        syncStateRepo.clear(),
      ]);
      await bootstrapForUser(userId);
      // Refresh the debug counts + every downstream tx-derived cache.
      await queryClient.invalidateQueries({ queryKey: ['debug-local-tx-count'] });
      await queryClient.invalidateQueries({ queryKey: ['debug-server-tx-count'] });
      await queryClient.invalidateQueries();
      analytics.track('debug_local_cache_reset_completed');
      setResetState('done');
      setTimeout(() => setResetState('idle'), 3000);
    } catch (err) {
      console.warn('[debug] local cache reset failed', err);
      analytics.track('debug_local_cache_reset_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      setResetState('error');
      setTimeout(() => setResetState('idle'), 4000);
    }
  }

  async function handleSync() {
    setSyncState('syncing');
    functionsClient.invoke('sync-fund-portfolios').catch(() => {});
    functionsClient.invoke('sync-fund-meta').catch(() => {});
    const [navResult, idxResult] = await Promise.allSettled([
      functionsClient.invoke('sync-nav'),
      functionsClient.invoke('sync-index'),
    ]);
    const navOk = navResult.status === 'fulfilled' && !navResult.value.error;
    const idxOk = idxResult.status === 'fulfilled' && !idxResult.value.error;
    if (navOk || idxOk) {
      // Edge functions kick off async ingestion — they return success
      // before the new nav_history row is committed. Poll the freshness
      // query a few times (up to ~6s) so the UI eventually reflects the
      // new "Last sync" date instead of leaving the user staring at the
      // pre-sync date despite the button reading "Done".
      const before = latestNavRow ?? null;
      for (let attempt = 0; attempt < 4; attempt++) {
        await queryClient.refetchQueries({ queryKey: ['latest-nav-date'] });
        const fresh = queryClient.getQueryData<string | null>(['latest-nav-date']);
        if (fresh && fresh !== before) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      // Anything that renders fund value, "as of" date, or per-fund NAV
      // points is now stale relative to the freshly published row. Drop
      // those entries so the next mount reads the new data.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['portfolio'] }),
        queryClient.invalidateQueries({ queryKey: ['fund-detail'] }),
        queryClient.invalidateQueries({ queryKey: ['fund-nav-history'] }),
        queryClient.invalidateQueries({ queryKey: ['fund-detail-index'] }),
        queryClient.invalidateQueries({ queryKey: ['investmentVsBenchmarkTimeline'] }),
        queryClient.invalidateQueries({ queryKey: ['performance-timeline'] }),
        queryClient.invalidateQueries({ queryKey: ['portfolio-timeline'] }),
        queryClient.invalidateQueries({ queryKey: ['money-trail'] }),
      ]);
      setSyncState('done');
      setTimeout(() => setSyncState('idle'), 3000);
    } else {
      setSyncState('error');
      setTimeout(() => setSyncState('idle'), 4000);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <UtilityHeader title="Data sync" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.frame}>
        <View style={styles.card}>
          {/* NAV data status */}
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Text style={styles.rowValue}>NAV data</Text>
              <Text style={styles.rowSub}>Updated hourly on weekdays via AMFI</Text>
            </View>
            <View style={styles.badge}>
              <View style={[styles.badgeDot, { backgroundColor: navBadge.dot }]} />
              <Text style={[styles.badgeText, { color: navBadge.color }]}>{navBadge.label}</Text>
            </View>
          </View>

          {/* Last sync */}
          <View style={[styles.row, styles.borderTop]}>
            <View style={styles.rowLeft}>
              <Text style={styles.rowValue}>Last sync</Text>
            </View>
            <Text style={styles.syncDate}>{formatNavDate(displayedNavDate)}</Text>
          </View>

          {/* Manual sync */}
          <View style={[styles.row, styles.borderTop]}>
            <View style={styles.rowLeft}>
              <Text style={styles.rowValue}>Manual sync</Text>
              <Text style={styles.rowSub}>
                {syncState === 'done'
                  ? 'Sync complete — NAV and index data updated'
                  : syncState === 'error'
                    ? 'Sync failed — check your connection and try again'
                    : 'Fetch latest NAV, index, portfolio composition, and fund metadata'}
              </Text>
            </View>
            <TouchableOpacity
              onPress={handleSync}
              disabled={syncState === 'syncing'}
              style={[
                styles.syncBtn,
                syncState === 'done' && styles.syncBtnDone,
                syncState === 'error' && styles.syncBtnError,
              ]}
              activeOpacity={0.75}
            >
              {syncState === 'syncing' ? (
                <ActivityIndicator size="small" color={tokens.colors.emerald} />
              ) : (
                <Ionicons
                  name={
                    syncState === 'done' ? 'checkmark'
                    : syncState === 'error' ? 'alert-circle-outline'
                    : 'refresh-outline'
                  }
                  size={14}
                  color={
                    syncState === 'done' ? tokens.colors.emerald
                    : syncState === 'error' ? tokens.colors.negative
                    : tokens.colors.emerald
                  }
                />
              )}
              <Text style={[
                styles.syncBtnText,
                syncState === 'done' && { color: tokens.colors.emerald },
                syncState === 'error' && { color: tokens.colors.negative },
              ]}>
                {syncState === 'syncing' ? 'Syncing…'
                  : syncState === 'done' ? 'Done'
                  : syncState === 'error' ? 'Failed'
                  : 'Sync now'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {localCacheEnabled && (
          <View style={styles.card}>
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Text style={styles.rowValue}>Local cache</Text>
                <Text style={styles.rowSub}>
                  On-device copy of your transactions for instant load.
                </Text>
              </View>
              <View style={styles.badge}>
                <View
                  style={[
                    styles.badgeDot,
                    {
                      backgroundColor:
                        driftSeverity === 'major' ? tokens.colors.negative
                        : driftSeverity === 'minor' ? tokens.colors.amber
                        : tokens.colors.emerald,
                    },
                  ]}
                />
                <Text
                  style={[
                    styles.badgeText,
                    {
                      color:
                        driftSeverity === 'major' ? tokens.colors.negative
                        : driftSeverity === 'minor' ? tokens.colors.amber
                        : tokens.colors.emerald,
                    },
                  ]}
                >
                  {driftSeverity === 'major' ? 'Drift'
                    : driftSeverity === 'minor' ? 'Catching up'
                    : 'In sync'}
                </Text>
              </View>
            </View>

            <View style={[styles.row, styles.borderTop]}>
              <View style={styles.rowLeft}>
                <Text style={styles.rowValue}>On device</Text>
                <Text style={styles.rowSub}>Transactions in SQLite right now</Text>
              </View>
              <Text style={styles.syncDate}>
                {localTxCount == null ? '—' : localTxCount.toLocaleString('en-IN')}
              </Text>
            </View>

            <View style={[styles.row, styles.borderTop]}>
              <View style={styles.rowLeft}>
                <Text style={styles.rowValue}>On server</Text>
                <Text style={styles.rowSub}>Transactions Supabase has for your account</Text>
              </View>
              <Text style={styles.syncDate}>
                {serverTxCount == null ? '—' : serverTxCount.toLocaleString('en-IN')}
              </Text>
            </View>

            <View style={[styles.row, styles.borderTop]}>
              <View style={styles.rowLeft}>
                <Text style={styles.rowValue}>Reset local cache</Text>
                <Text style={styles.rowSub}>
                  {resetState === 'done'
                    ? 'Reset complete — fresh copy pulled from server'
                    : resetState === 'error'
                      ? 'Reset failed — check your connection and try again'
                      : driftSeverity === 'major'
                        ? 'Recommended — local copy is missing rows the server has'
                        : 'Wipes the on-device cache and pulls a fresh copy'}
                </Text>
              </View>
              <TouchableOpacity
                onPress={handleResetLocalCache}
                disabled={resetState === 'resetting' || !userId}
                style={[
                  styles.syncBtn,
                  resetState === 'done' && styles.syncBtnDone,
                  resetState === 'error' && styles.syncBtnError,
                ]}
                activeOpacity={0.75}
              >
                {resetState === 'resetting' ? (
                  <ActivityIndicator size="small" color={tokens.colors.emerald} />
                ) : (
                  <Ionicons
                    name={
                      resetState === 'done' ? 'checkmark'
                      : resetState === 'error' ? 'alert-circle-outline'
                      : 'refresh-outline'
                    }
                    size={14}
                    color={
                      resetState === 'done' ? tokens.colors.emerald
                      : resetState === 'error' ? tokens.colors.negative
                      : tokens.colors.emerald
                    }
                  />
                )}
                <Text style={[
                  styles.syncBtnText,
                  resetState === 'done' && { color: tokens.colors.emerald },
                  resetState === 'error' && { color: tokens.colors.negative },
                ]}>
                  {resetState === 'resetting' ? 'Resetting…'
                    : resetState === 'done' ? 'Done'
                    : resetState === 'error' ? 'Failed'
                    : 'Reset'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Info note */}
        <View style={styles.infoNote}>
          <Ionicons name="information-circle-outline" size={16} color={tokens.colors.textTertiary} />
          <Text style={styles.infoNoteText}>
            We keep your data up to date so your insights are always relevant.
          </Text>
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
    frame: { width: '100%', maxWidth: 960, gap: ClearLensSpacing.sm },

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

    badge: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    badgeDot: { width: 7, height: 7, borderRadius: 4 },
    badgeText: { ...ClearLensTypography.caption, fontFamily: ClearLensFonts.semiBold },

    syncDate: {
      ...ClearLensTypography.bodySmall,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.textSecondary,
    },

    syncBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 6,
      backgroundColor: cl.mint50,
      borderRadius: ClearLensRadii.full,
    },
    syncBtnDone: { backgroundColor: cl.positiveBg },
    syncBtnError: { backgroundColor: cl.negativeBg },
    syncBtnText: {
      ...ClearLensTypography.caption,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.emerald,
    },

    infoNote: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: ClearLensSpacing.xs,
      paddingHorizontal: ClearLensSpacing.xs,
    },
    infoNoteText: {
      ...ClearLensTypography.bodySmall,
      color: cl.textTertiary,
      flex: 1,
    },
  });
}
