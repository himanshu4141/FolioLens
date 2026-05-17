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
import { perfEnd, perfStart } from '@/src/lib/perfMark';
import { fetchUserFunds } from '@/src/hooks/useUserFunds';
import { fetchUserTransactionCount, fetchUserTransactionsRemote } from '@/src/hooks/useUserTransactions';
import { BENCHMARK_OPTIONS } from '@/src/store/appStore';
import * as txRepo from '@/src/lib/db/tx';
import * as navRepo from '@/src/lib/db/nav';
import * as idxRepo from '@/src/lib/db/idx';
import * as syncStateRepo from '@/src/lib/db/syncState';

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
}

/**
 * Bootstrap / reconcile entry. Does a cheap count check against
 * Supabase first; if SQLite is in step, falls through to a watermark
 * delta (same cost as before). On mismatch, does a full pull to
 * repair. NAV + index history stay watermark-gated. See the inline
 * comment in `runSync` for the cost rationale.
 *
 * Idempotent: safe to call on every app open and on pull-to-refresh.
 */
export async function bootstrap(
  userId: string,
  schemeCodes: number[],
  indexSymbols: string[],
): Promise<SyncResult> {
  return runSync(userId, schemeCodes, indexSymbols, { mode: 'bootstrap' });
}

/**
 * Pure watermark delta — no drift check. Used by the short-idle
 * foreground-resume path where we trust SQLite is already in step
 * with the server. The bootstrap path is responsible for detecting
 * and repairing drift, so by the time short-idle delta runs we just
 * need to pick up what's new.
 */
export async function syncDelta(
  userId: string,
  schemeCodes: number[],
  indexSymbols: string[],
): Promise<SyncResult> {
  return runSync(userId, schemeCodes, indexSymbols, { mode: 'delta' });
}

async function runSync(
  userId: string,
  schemeCodes: number[],
  indexSymbols: string[],
  options: { mode: 'bootstrap' | 'delta' },
): Promise<SyncResult> {
  perfStart(`db:sync:${options.mode}`);
  const errors: string[] = [];
  let txInserted = 0;
  let navInserted = 0;
  let idxInserted = 0;
  const nowIso = new Date().toISOString();

  // ── Transactions ──────────────────────────────────────────────────
  try {
    // The watermark (`max(created_at)` of local rows) is monotonic-
    // forward by design, which makes delta correct on the happy path
    // — but it also means the watermark can never tell us a row is
    // *missing* from SQLite. Once the local table drifts below the
    // server (interrupted sync, an earlier bug, a race during sign-in
    // clear/bootstrap), delta forever returns "no new rows" and the
    // user is stuck on a partial Money Trail with no recovery path.
    //
    // The two modes split on how aggressively we look for drift:
    //
    //   - `delta` — pure watermark pull, no drift check. Used by the
    //     short-idle foreground-resume sync (AppState 'active' within
    //     5 min of going to background). That path runs often (every
    //     notification swipe), so the extra round-trip would add up;
    //     drift in the middle of an active session is also a rare
    //     pattern compared to drift around sign-in/cold-launch.
    //
    //   - `bootstrap` — count-check first, full pull *only on
    //     mismatch*. Used by cold launch, pull-to-refresh, and the
    //     long-idle foreground path. The count check is a `head: true`
    //     query against the user_id index server-side: ~200 bytes, ~1
    //     round-trip, no row bodies. When the count matches local
    //     (the overwhelming majority of cold launches) we still take
    //     the cheap watermark delta — bootstrap is no more expensive
    //     than the previous always-delta path. Full pull only fires
    //     when SQLite genuinely diverged from the server.
    //
    // NAV / index history below stay watermark-gated in both modes;
    // those tables are orders of magnitude larger and don't have a
    // per-user write path, so the drift pattern we're defending
    // against doesn't apply.
    const localCount = await txRepo.count();
    let useFullPull = false;
    if (options.mode === 'bootstrap' && localCount > 0) {
      const serverCount = await fetchUserTransactionCount(userId);
      // Treat any mismatch as drift — including server < local, which
      // would mean a deleted row server-side that we never picked up.
      // null = count check itself failed; fall back to the cheap delta
      // path rather than punishing the user for a transient error.
      if (serverCount !== null && serverCount !== localCount) {
        useFullPull = true;
        analytics.track('db_sync_tx_drift_detected', {
          local: localCount,
          server: serverCount,
          delta: serverCount - localCount,
        });
        console.warn('[db/sync] tx drift detected — full pull', {
          local: localCount,
          server: serverCount,
        });
      }
    }
    const watermark = useFullPull ? null : await txRepo.getWatermark();
    const fresh = await fetchUserTransactionsRemote(userId, watermark);
    await txRepo.bulkInsert(fresh);
    const after = await txRepo.count();
    txInserted = after - localCount;
    if (useFullPull && txInserted > 0) {
      analytics.track('db_sync_tx_drift_repaired', {
        local_before: localCount,
        server_total: fresh.length,
        inserted: txInserted,
      });
    }
    await syncStateRepo.upsert(`tx:${userId}`, nowIso, (await txRepo.getWatermark()) ?? null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`tx: ${msg}`);
    console.warn('[db/sync] tx sync failed', err);
  }

  // ── NAV per scheme ────────────────────────────────────────────────
  if (schemeCodes.length > 0) {
    try {
      // Bucket by watermark — schemes that share a starting point can
      // be fetched in a single SELECT.
      const bucketByDate = new Map<string | null, number[]>();
      for (const code of schemeCodes) {
        const wm = await navRepo.getWatermark(code);
        const key = wm;
        const existing = bucketByDate.get(key) ?? [];
        existing.push(code);
        bucketByDate.set(key, existing);
      }

      for (const [sinceDate, codes] of bucketByDate) {
        const rows = await fetchAllNavRows(codes, sinceDate);
        await navRepo.bulkInsert(rows);
        navInserted += rows.length;
        for (const code of codes) {
          await syncStateRepo.upsert(
            `nav:${code}`,
            nowIso,
            (await navRepo.getWatermark(code)) ?? null,
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
      await idxRepo.bulkInsert(rows);
      idxInserted += rows.length;
      await syncStateRepo.upsert(
        `idx:${symbol}`,
        nowIso,
        (await idxRepo.getWatermark(symbol)) ?? null,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`idx:${symbol}: ${msg}`);
      console.warn('[db/sync] idx sync failed', { symbol, err });
    }
  }

  const result: SyncResult = { txInserted, navInserted, idxInserted, errors };
  perfEnd(`db:sync:${options.mode}`, {
    tx_inserted: txInserted,
    nav_inserted: navInserted,
    idx_inserted: idxInserted,
    error_count: errors.length,
    user_id_hint: userId.slice(0, 8),
  });
  analytics.track('db_sync_complete', {
    mode: options.mode,
    tx_inserted: txInserted,
    nav_inserted: navInserted,
    idx_inserted: idxInserted,
    error_count: errors.length,
  });
  return result;
}

/**
 * Total wipe used on sign-out. Call sites should not hold any cached
 * data after this returns.
 */
export async function clearAll(): Promise<void> {
  await Promise.all([txRepo.clear(), navRepo.clear(), idxRepo.clear(), syncStateRepo.clear()]);
}

let inFlightBootstrap: Promise<SyncResult> | null = null;

/**
 * High-level entry point for the layout's mount effect and for
 * pull-to-refresh. Derives the scope lists from the user's fund
 * roster + the global benchmark options, then runs `bootstrap`
 * (which does a full pull of transactions — see the inline comment
 * in `runSync` for why a delta isn't enough).
 *
 * Returns the same Promise on repeated calls during a single launch
 * so concurrent screen mounts don't pile up parallel sync runs.
 */
export async function bootstrapForUser(userId: string): Promise<SyncResult> {
  if (inFlightBootstrap) return inFlightBootstrap;
  inFlightBootstrap = (async () => {
    try {
      const funds = await fetchUserFunds(userId);
      const schemeCodes = funds
        .map((f) => f.scheme_code)
        .filter((c): c is number => typeof c === 'number');
      const indexSymbols = BENCHMARK_OPTIONS.map((b) => b.symbol);
      return await bootstrap(userId, schemeCodes, indexSymbols);
    } finally {
      // Clear the slot so the next launch (or a manual re-run) can
      // bootstrap again. The on-disk SQLite cache survives —
      // `INSERT OR IGNORE` makes the full-pull idempotent.
      inFlightBootstrap = null;
    }
  })();
  return inFlightBootstrap;
}

/**
 * Pull-to-refresh entry. Same code path as `bootstrapForUser` —
 * named separately so the call site reads as "force a full refresh"
 * instead of "bootstrap" (which would imply first-launch). Shares
 * the same in-flight slot so a PTR triggered while cold-launch
 * bootstrap is still running just awaits that run instead of
 * spawning a parallel pull.
 */
export async function syncFullForUser(userId: string): Promise<SyncResult> {
  return bootstrapForUser(userId);
}

let inFlightDelta: Promise<SyncResult> | null = null;

/**
 * Same but uses delta semantics — call on screen focus, foreground,
 * or pull-to-refresh.
 *
 * Single-flight: concurrent callers (pull-to-refresh + AppState
 * 'active' firing in the same tick) share one in-flight sync instead
 * of racing two parallel pulls against Supabase.
 */
export async function syncDeltaForUser(userId: string): Promise<SyncResult> {
  if (inFlightDelta) return inFlightDelta;
  inFlightDelta = (async () => {
    try {
      const funds = await fetchUserFunds(userId);
      const schemeCodes = funds
        .map((f) => f.scheme_code)
        .filter((c): c is number => typeof c === 'number');
      const indexSymbols = BENCHMARK_OPTIONS.map((b) => b.symbol);
      return await syncDelta(userId, schemeCodes, indexSymbols);
    } finally {
      inFlightDelta = null;
    }
  })();
  return inFlightDelta;
}
