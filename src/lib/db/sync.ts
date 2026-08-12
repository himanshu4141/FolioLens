/**
 * Sync orchestrator — keeps the local SQLite cache in step with
 * Supabase for the read paths.
 *
 * Two entry points:
 *
 *   - `bootstrapIfEmpty(userId, schemeCodes, indexSymbols)`
 *       Runs on app launch. For each table+scope, checks the local
 *       watermark. If empty, pulls full history from Supabase. If
 *       already populated, does nothing — the delta sync handles
 *       incremental updates.
 *
 *   - `syncDelta(userId, schemeCodes, indexSymbols)`
 *       Runs on screen focus + pull-to-refresh. For each scope,
 *       uses `.gte(maxLocalDate)` so only new rows traverse the
 *       wire.
 *
 * Both are non-blocking: failures log + surface via analytics, but
 * the app continues rendering from whatever's in SQLite. The user
 * never sees a "sync failed" modal; instead, the Portfolio header
 * shows "Last synced N min ago" so they know how fresh the data is.
 */
import { navHistoryRepo } from '@/src/lib/data/navHistory';
import { indexHistoryRepo } from '@/src/lib/data/indexHistory';
import { analytics } from '@/src/lib/analytics';
import { bucketCount } from '@/src/lib/uxTelemetry';
import { perfEnd, perfStart } from '@/src/lib/perfMark';
import { beginSyncActivity } from '@/src/lib/performanceRuntimeState';
import { fetchUserFunds } from '@/src/hooks/useUserFunds';
import {
  fetchUserTransactionIdsRemote,
  fetchUserTransactionsRemote,
} from '@/src/hooks/useUserTransactions';
import { BENCHMARK_OPTIONS } from '@/src/store/appStore';
import * as txRepo from '@/src/lib/db/tx';
import * as navRepo from '@/src/lib/db/nav';
import * as idxRepo from '@/src/lib/db/idx';
import * as syncStateRepo from '@/src/lib/db/syncState';
import {
  captureDatabaseWriteScope,
  getDb,
  runSerializedDatabaseLifecycle,
  type DatabaseWriteScope,
} from '@/src/lib/db/db';

const NAV_PAGE_SIZE = 1000;
const IDX_PAGE_SIZE = 1000;

interface RawNavRow {
  scheme_code: number;
  nav_date: string;
  nav: number;
}

interface RawIdxRow {
  index_symbol: string;
  index_date: string;
  close_value: number;
}

async function fetchAllNavRows(
  schemeCodes: number[],
  sinceDate: string | null,
): Promise<RawNavRow[]> {
  if (schemeCodes.length === 0) return [];
  const rows: RawNavRow[] = [];
  for (let from = 0; ; from += NAV_PAGE_SIZE) {
    let q = navHistoryRepo
      .from()
      .select('scheme_code, nav_date, nav')
      .in('scheme_code', schemeCodes)
      .order('nav_date', { ascending: true })
      // `nav_date` is shared by every scheme. Offset pagination needs a
      // deterministic tie-breaker or a 1,000-row boundary can omit rows.
      .order('scheme_code', { ascending: true })
      .range(from, from + NAV_PAGE_SIZE - 1);
    if (sinceDate) q = q.gte('nav_date', sinceDate);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...((data ?? []) as RawNavRow[]));
    if ((data ?? []).length < NAV_PAGE_SIZE) break;
  }
  return rows;
}

async function fetchAllIndexRows(
  symbol: string,
  sinceDate: string | null,
): Promise<RawIdxRow[]> {
  const rows: RawIdxRow[] = [];
  for (let from = 0; ; from += IDX_PAGE_SIZE) {
    let q = indexHistoryRepo
      .from()
      .select('index_date, close_value')
      .eq('index_symbol', symbol)
      .order('index_date', { ascending: true })
      .range(from, from + IDX_PAGE_SIZE - 1);
    if (sinceDate) q = q.gte('index_date', sinceDate);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(
      ...((data ?? []) as { index_date: string; close_value: number }[]).map((r) => ({
        index_symbol: symbol,
        index_date: r.index_date,
        close_value: r.close_value,
      })),
    );
    if ((data ?? []).length < IDX_PAGE_SIZE) break;
  }
  return rows;
}

export interface SyncResult {
  txInserted: number;
  navInserted: number;
  idxInserted: number;
  errors: string[];
  /**
   * True when immutable transaction IDs differed from the Supabase source of
   * truth and SQLite was atomically replaced from a full server snapshot.
   */
  txRebuiltFromDrift?: boolean;
}

/**
 * Pure predicate: returns true when a SyncResult indicates that SQLite
 * data actually changed — new rows were inserted or the tx table was
 * rebuilt from drift. The layout uses this to decide whether to map the
 * changed input families to granular React Query prefixes so screens
 * recompute against the fresh rows.
 *
 * Extracted here so the cold-start bootstrap path and the AppState
 * foreground-sync path share identical logic with no duplication.
 */
export function didSyncChangeData(result: SyncResult): boolean {
  return (
    result.txInserted > 0 ||
    result.navInserted > 0 ||
    result.idxInserted > 0 ||
    result.txRebuiltFromDrift === true
  );
}

export function transactionIdSetsDiffer(localIds: string[], serverIds: string[]): boolean {
  if (localIds.length !== serverIds.length) return true;
  return localIds.some((id, index) => id !== serverIds[index]);
}

/**
 * Delta sync cannot observe deletes because deleted rows have no newer
 * `created_at`. Compare immutable server IDs on every sync and atomically
 * replace SQLite from a full snapshot on any difference — including a single
 * stale local row or equal counts with different IDs. The replacement itself
 * is one SQLite transaction, so network/refill failure preserves the previous
 * cache rather than exposing an empty intermediate state.
 */
async function reconcileTransactionSnapshot(
  userId: string,
  writeScope: DatabaseWriteScope,
  mode: 'bootstrap' | 'delta',
): Promise<{ drift: number | null; rebuilt: boolean; serverCount: number | null; localCount: number }> {
  const [localIds, serverIds] = await Promise.all([
    txRepo.readIds(),
    fetchUserTransactionIdsRemote(userId),
  ]);
  const localCount = localIds.length;
  const serverCount = serverIds.length;
  const drift = serverCount - localCount;
  if (!transactionIdSetsDiffer(localIds, serverIds)) {
    return { drift, rebuilt: false, serverCount, localCount };
  }

  console.warn(
    '[db/sync] tx snapshot drift detected local=%s server=%s drift=%s direction=%s; rebuilding',
    bucketCount(localCount),
    bucketCount(serverCount),
    bucketCount(Math.abs(drift)),
    drift < 0 ? 'server_lower' : drift > 0 ? 'server_higher' : 'ids_changed',
  );
  try {
    const fresh = await fetchUserTransactionsRemote(userId, null);
    await txRepo.replaceAll(fresh, {
      scope: writeScope,
      operation: `${mode}_tx_repair`,
    });
    return { drift, rebuilt: true, serverCount, localCount };
  } catch (err) {
    console.warn('[db/sync] tx rebuild after drift failed', err);
    return { drift, rebuilt: false, serverCount, localCount };
  }
}

/**
 * Ensure each scope (transactions, NAVs per scheme, indexes per
 * symbol) has *some* data locally. Caller passes the lists of scheme
 * codes and index symbols the app cares about.
 *
 * Idempotent: safe to call on every app open. Scopes already
 * populated get skipped via watermark check.
 */
export async function bootstrap(
  userId: string,
  schemeCodes: number[],
  indexSymbols: string[],
  writeScope: DatabaseWriteScope = captureDatabaseWriteScope(),
): Promise<SyncResult> {
  const finishSyncActivity = beginSyncActivity();
  try {
    return await runSync(userId, schemeCodes, indexSymbols, { mode: 'bootstrap' }, writeScope);
  } finally {
    finishSyncActivity();
  }
}

/**
 * Pull only new rows since the local watermark.
 */
export async function syncDelta(
  userId: string,
  schemeCodes: number[],
  indexSymbols: string[],
  writeScope: DatabaseWriteScope = captureDatabaseWriteScope(),
): Promise<SyncResult> {
  const finishSyncActivity = beginSyncActivity();
  try {
    return await runSync(userId, schemeCodes, indexSymbols, { mode: 'delta' }, writeScope);
  } finally {
    finishSyncActivity();
  }
}

async function runSync(
  userId: string,
  schemeCodes: number[],
  indexSymbols: string[],
  options: { mode: 'bootstrap' | 'delta' },
  writeScope: DatabaseWriteScope,
): Promise<SyncResult> {
  const syncSpanId = perfStart(`db:sync:${options.mode}`);
  const errors: string[] = [];
  let txInserted = 0;
  let navInserted = 0;
  let idxInserted = 0;
  const nowIso = new Date().toISOString();

  // ── Transactions ──────────────────────────────────────────────────
  try {
    // Always sync. The watermark naturally handles bootstrap vs delta:
    // null watermark → first launch / fresh SQLite → full fetch;
    // non-null watermark → fetch only rows newer than the watermark.
    //
    // Previously this was gated on `watermark === null || mode === 'delta'`,
    // which silently skipped the tx fetch on every cold launch when SQLite
    // had pre-existing rows. That left server-side imports (auto-forwarded
    // CAS via Resend Inbound, web-uploaded CAS while mobile was closed)
    // invisible until the user backgrounded + foregrounded the app — and
    // AppState 'change' never fires on a fresh process launch (the OS
    // starts the app 'active' before our listener registers). NAV and
    // index sync below have always run unconditionally; bringing tx in
    // line keeps the three repos symmetric.
    const watermark = await txRepo.getWatermark();
    const fresh = await fetchUserTransactionsRemote(userId, watermark);
    const before = await txRepo.count();
    await txRepo.bulkInsert(fresh, {
      scope: writeScope,
      operation: `${options.mode}_tx_write`,
    });
    const after = await txRepo.count();
    txInserted = after - before;
    await syncStateRepo.upsert(
      `tx:${userId}`,
      nowIso,
      (await txRepo.getWatermark()) ?? null,
      { scope: writeScope, operation: `${options.mode}_tx_sync_state` },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`tx: ${msg}`);
    console.warn('[db/sync] tx sync failed', err);
  }

  // ── Reconciliation ────────────────────────────────────────────────
  // Exact immutable-ID reconciliation catches both missing and deleted rows;
  // count-only thresholds cannot represent a one-row server reversal.
  let txRebuiltFromDrift = false;
  try {
    const reconciliation = await reconcileTransactionSnapshot(userId, writeScope, options.mode);
    txRebuiltFromDrift = reconciliation.rebuilt;
    if (reconciliation.rebuilt || reconciliation.drift !== 0) {
      analytics.track('tx_cache_reconciled', {
        mode: options.mode,
        local_count_bucket: bucketCount(reconciliation.localCount),
        server_count_bucket: bucketCount(reconciliation.serverCount),
        drift_bucket: bucketCount(Math.abs(reconciliation.drift ?? 0)),
        drift_direction: (reconciliation.drift ?? 0) < 0
          ? 'server_lower'
          : (reconciliation.drift ?? 0) > 0
            ? 'server_higher'
            : 'ids_changed',
        rebuilt: reconciliation.rebuilt,
      });
    }
    if (reconciliation.rebuilt) {
      // Update the watermark — the local table was just refilled from
      // server, so its MAX(created_at) is now authoritative again.
      // `txInserted` stays as the delta-step's contribution; the
      // separate `txRebuiltFromDrift` flag tells callers a full
      // rebuild happened so they can invalidate React Query / etc.
      await syncStateRepo.upsert(
        `tx:${userId}`,
        nowIso,
        (await txRepo.getWatermark()) ?? null,
        { scope: writeScope, operation: `${options.mode}_tx_repair_sync_state` },
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`tx-reconcile: ${msg}`);
    console.warn('[db/sync] tx reconciliation failed', err);
  }

  // ── NAV per scheme ────────────────────────────────────────────────
  if (schemeCodes.length > 0) {
    try {
      // A latest watermark proves only the upper edge of a local series. A
      // recent-only Portfolio write can create that watermark without any
      // historical rows, so bootstrap must first establish an authoritative
      // lower bound. Schemes without an unbounded coverage marker receive one
      // full fetch; only proven-complete schemes use ordinary delta watermarks.
      const bucketByDate = new Map<string, {
        sinceDate: string | null;
        codes: number[];
        markFullHistory: boolean;
      }>();
      for (const code of schemeCodes) {
        const coverage = await navRepo.getHistoryCoverage(code);
        const hasFullHistory = coverage.known && coverage.startDate === null;
        const wm = hasFullHistory ? await navRepo.getWatermark(code) : null;
        const key = hasFullHistory ? `delta:${wm ?? '<empty>'}` : 'repair:full';
        const existing = bucketByDate.get(key) ?? {
          sinceDate: wm,
          codes: [],
          markFullHistory: !hasFullHistory,
        };
        existing.codes.push(code);
        bucketByDate.set(key, existing);
      }

      for (const { sinceDate, codes, markFullHistory } of bucketByDate.values()) {
        const rows = await fetchAllNavRows(codes, sinceDate);
        // Count net inserts, not fetched rows. `fetchAllNavRows` uses
        // `.gte(sinceDate)` (inclusive on the watermark), so the boundary
        // row is always re-fetched even when nothing new is upstream.
        // `INSERT OR IGNORE` drops it on the SQLite side, but counting
        // `rows.length` here would still flag every sync as "changed",
        // firing phantom foreground invalidation and leaving the user
        // with a spinner that doesn't change any values.
        const before = await navRepo.count();
        await navRepo.bulkInsert(rows, {
          scope: writeScope,
          operation: `${options.mode}_nav_write`,
        });
        if (markFullHistory) {
          // Mark even when one requested scheme returned no rows: the
          // completed unbounded query authoritatively proves that empty/NFO
          // interval and prevents history consumers from refetching forever.
          await navRepo.markHistoryCoverage(codes, null, {
            scope: writeScope,
            operation: `${options.mode}_nav_full_coverage`,
          });
        }
        const after = await navRepo.count();
        navInserted += after - before;
        for (const code of codes) {
          await syncStateRepo.upsert(
            `nav:${code}`,
            nowIso,
            (await navRepo.getWatermark(code)) ?? null,
            { scope: writeScope, operation: `${options.mode}_nav_sync_state` },
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`nav: ${msg}`);
      console.warn('[db/sync] nav sync failed', err);
    }
  }

  // ── Index per symbol ──────────────────────────────────────────────
  for (const symbol of indexSymbols) {
    try {
      const wm = await idxRepo.getWatermark(symbol);
      const rows = await fetchAllIndexRows(symbol, wm);
      // Net delta, same reasoning as nav above.
      const before = await idxRepo.count();
      await idxRepo.bulkInsert(rows, {
        scope: writeScope,
        operation: `${options.mode}_index_write`,
      });
      const after = await idxRepo.count();
      idxInserted += after - before;
      await syncStateRepo.upsert(
        `idx:${symbol}`,
        nowIso,
        (await idxRepo.getWatermark(symbol)) ?? null,
        { scope: writeScope, operation: `${options.mode}_index_sync_state` },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`idx:${symbol}: ${msg}`);
      console.warn('[db/sync] idx sync failed', { symbol, err });
    }
  }

  const result: SyncResult = { txInserted, navInserted, idxInserted, errors, txRebuiltFromDrift };
  perfEnd(syncSpanId, {
    tx_inserted_bucket: bucketCount(txInserted),
    nav_inserted_bucket: bucketCount(navInserted),
    idx_inserted_bucket: bucketCount(idxInserted),
    error_count_bucket: bucketCount(errors.length),
  });
  analytics.track('db_sync_complete', {
    mode: options.mode,
    tx_inserted_bucket: bucketCount(txInserted),
    nav_inserted_bucket: bucketCount(navInserted),
    idx_inserted_bucket: bucketCount(idxInserted),
    error_count_bucket: bucketCount(errors.length),
  });
  return result;
}

/**
 * Total wipe used on sign-out. Call sites should not hold any cached
 * data after this returns.
 */
export async function clearAll(): Promise<void> {
  await runSerializedDatabaseLifecycle('database_clear_all', async () => {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.execAsync('DELETE FROM tx');
      await db.execAsync('DELETE FROM nav');
      await db.execAsync('DELETE FROM idx');
      await db.execAsync('DELETE FROM sync_state');
    });
  });
}

function userSyncKey(userId: string, writeScope: DatabaseWriteScope): string {
  return `${userId}:${writeScope.generation}`;
}

const inFlightBootstraps = new Map<string, Promise<SyncResult>>();

/**
 * High-level entry point for the layout's mount effect. Derives the
 * scope lists from the user's fund roster + the global benchmark
 * options, then runs `bootstrap` (which is idempotent on already-
 * populated scopes).
 *
 * Returns the same Promise on repeated calls during a single launch
 * so concurrent screen mounts don't pile up parallel sync runs.
 */
export function bootstrapForUser(userId: string): Promise<SyncResult> {
  // Capture before roster I/O. If sign-out/reset advances the generation
  // while fetchUserFunds is pending, every later write from this flow remains
  // tied to the old scope and rejects before touching the cleared cache.
  const writeScope = captureDatabaseWriteScope();
  const key = userSyncKey(userId, writeScope);
  const existing = inFlightBootstraps.get(key);
  if (existing) return existing;
  const finishSyncActivity = beginSyncActivity();
  const work = (async () => {
    const funds = await fetchUserFunds(userId);
    const schemeCodes = funds
      .map((f) => f.scheme_code)
      .filter((c): c is number => typeof c === 'number');
    const indexSymbols = BENCHMARK_OPTIONS.map((b) => b.symbol);
    return bootstrap(userId, schemeCodes, indexSymbols, writeScope);
  })();
  let promise: Promise<SyncResult>;
  promise = work.finally(() => {
    // An older user/generation may finish after a replacement entry starts.
    // Delete only when this key still points at this exact promise.
    if (inFlightBootstraps.get(key) === promise) inFlightBootstraps.delete(key);
    finishSyncActivity();
  });
  inFlightBootstraps.set(key, promise);
  return promise;
}

const inFlightDeltas = new Map<string, Promise<SyncResult>>();

/**
 * Same but uses delta semantics — call on screen focus, foreground,
 * or pull-to-refresh.
 *
 * Single-flight: concurrent callers (pull-to-refresh + AppState
 * 'active' firing in the same tick) share one in-flight sync instead
 * of racing two parallel pulls against Supabase.
 */
export function syncDeltaForUser(userId: string): Promise<SyncResult> {
  const writeScope = captureDatabaseWriteScope();
  const key = userSyncKey(userId, writeScope);
  const existing = inFlightDeltas.get(key);
  if (existing) return existing;
  const finishSyncActivity = beginSyncActivity();
  const work = (async () => {
    const funds = await fetchUserFunds(userId);
    const schemeCodes = funds
      .map((f) => f.scheme_code)
      .filter((c): c is number => typeof c === 'number');
    const indexSymbols = BENCHMARK_OPTIONS.map((b) => b.symbol);
    return syncDelta(userId, schemeCodes, indexSymbols, writeScope);
  })();
  let promise: Promise<SyncResult>;
  promise = work.finally(() => {
    if (inFlightDeltas.get(key) === promise) inFlightDeltas.delete(key);
    finishSyncActivity();
  });
  inFlightDeltas.set(key, promise);
  return promise;
}
