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
import { countUserTransactionsRemote, fetchUserTransactionsRemote } from '@/src/hooks/useUserTransactions';
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
  /**
   * True when the post-sync tx count reconciliation detected drift
   * between local SQLite and the Supabase source of truth and rebuilt
   * the local table. See `reconcileTransactionCount`.
   */
  txRebuiltFromDrift?: boolean;
}

/**
 * Pure rebuild-decision helper. Exported for unit tests so the
 * tolerance thresholds can't drift silently.
 *
 * Returns `true` when the drift between local SQLite count and the
 * server's count is big enough — both absolutely (≥5 rows) and
 * relatively (>5%) — that we should treat the local cache as
 * unreliable and trigger a full rebuild.
 *
 * The dual threshold is deliberate:
 * - Absolute alone (e.g. ≥1) would rebuild on a 1-row-during-the-race
 *   case, which is just a sync-window artefact.
 * - Relative alone (e.g. >5%) would rebuild a 100-row portfolio over a
 *   single missing transaction (1%), again just race noise.
 * - Requiring both means we only rebuild when there's *meaningful*
 *   drift — the May 2026 user case (~25% of their portfolio worth of
 *   transactions missing) triggers cleanly; everyday sync races do not.
 */
export function shouldRebuildTxOnDrift(localCount: number, serverCount: number): boolean {
  const drift = Math.abs(serverCount - localCount);
  if (drift < 5) return false;
  const driftPct = serverCount > 0 ? drift / serverCount : 0;
  return driftPct > 0.05;
}

/**
 * After the tx delta sync settles, count what's on the server vs what
 * we have locally. If they disagree beyond the rebuild threshold,
 * re-fetch the full transaction history and merge it into the local
 * table via `INSERT OR IGNORE` — additive, not destructive.
 *
 * **Why this is needed.** The delta sync only fetches rows with
 * `created_at >= watermark`. If the local cache started life
 * incomplete — partial pre-PR-#175 bootstrap, a schema migration that
 * dropped rows, manual SQLite tampering, or any future bug we don't
 * know about yet — those historical gaps stay forever because no
 * delta can ever reach them. May 2026 incident: a user's main install
 * was ₹8L behind a side-by-side PR install because of exactly this.
 *
 * **Why we don't `clear()` first.** An earlier draft did
 * `txRepo.clear()` then `bulkInsert`. That opens a window between the
 * two operations where SQLite is empty — if the network drops mid-
 * rebuild, the user ends up worse off than they were with drift
 * (empty cache → screens show "no transactions"). `INSERT OR IGNORE`
 * over the full server set lands at the same end state for the
 * dominant drift case ("local is missing rows server has") without
 * the failure window. The one shape it doesn't repair is "local has
 * rows server doesn't" (e.g. account deletion mirrored late, or a
 * row deleted server-side) — that surfaces as a negative drift on
 * the `tx_cache_reconciled` event so we can investigate it as a
 * separate signal rather than silently overwriting.
 *
 * The reconciliation cost is one HTTP HEAD-style request per cold
 * launch (PostgREST `count: 'exact', head: true`); on the rare drift
 * detection it's one full re-fetch of the user's transactions.
 *
 * Returns `{ drift, rebuilt }`. `drift = null` when the remote count
 * was unavailable (network/permission error) — we don't rebuild on
 * unknown state.
 */
async function reconcileTransactionCount(
  userId: string,
): Promise<{ drift: number | null; rebuilt: boolean; serverCount: number | null; localCount: number }> {
  const [localCount, serverCount] = await Promise.all([
    txRepo.count(),
    countUserTransactionsRemote(userId),
  ]);
  if (serverCount === null) {
    // Network or permission error — don't disrupt the user's existing
    // cache on an unknown signal.
    return { drift: null, rebuilt: false, serverCount: null, localCount };
  }
  const drift = serverCount - localCount;
  if (!shouldRebuildTxOnDrift(localCount, serverCount)) {
    return { drift, rebuilt: false, serverCount, localCount };
  }

  console.warn(
    '[db/sync] tx count drift detected: local=%d server=%d drift=%d; rebuilding',
    localCount, serverCount, drift,
  );
  try {
    // Additive merge — see the comment above for why we don't `clear()`
    // first. `INSERT OR IGNORE` makes this a no-op for rows already
    // local, and writes the rows that were missing.
    const fresh = await fetchUserTransactionsRemote(userId, null);
    await txRepo.bulkInsert(fresh);
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
): Promise<SyncResult> {
  return runSync(userId, schemeCodes, indexSymbols, { mode: 'bootstrap' });
}

/**
 * Pull only new rows since the local watermark.
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
    await txRepo.bulkInsert(fresh);
    const after = await txRepo.count();
    txInserted = after - before;
    await syncStateRepo.upsert(`tx:${userId}`, nowIso, (await txRepo.getWatermark()) ?? null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`tx: ${msg}`);
    console.warn('[db/sync] tx sync failed', err);
  }

  // ── Reconciliation ────────────────────────────────────────────────
  // Verify the local tx count matches the server. Catches cache drift
  // that the delta sync alone can't repair — see
  // `reconcileTransactionCount`. Cheap enough to run on every sync
  // (one HEAD-style count query); rebuild only fires when drift is
  // both absolute (≥5 rows) and relative (>5%).
  let txRebuiltFromDrift = false;
  try {
    const reconciliation = await reconcileTransactionCount(userId);
    txRebuiltFromDrift = reconciliation.rebuilt;
    // Visibility threshold ≠ rebuild threshold. We rebuild only on
    // meaningful drift (≥5 absolute AND >5% relative — see
    // `shouldRebuildTxOnDrift`) to avoid thrashing on the sync-race
    // window. But we emit the analytics event on *any* non-zero
    // drift so the below-rebuild-threshold cases are still visible
    // in PostHog: that's the signal we'd watch to find caching bugs
    // the auto-rebuild would otherwise mask. `rebuilt: false` rows
    // in the event let us separate "noise we tolerated" from
    // "actually broken, we fixed it".
    if (reconciliation.drift !== null && reconciliation.drift !== 0) {
      analytics.track('tx_cache_reconciled', {
        mode: options.mode,
        local_count: reconciliation.localCount,
        server_count: reconciliation.serverCount,
        drift: reconciliation.drift,
        rebuilt: reconciliation.rebuilt,
      });
    }
    if (reconciliation.rebuilt) {
      // Update the watermark — the local table was just refilled from
      // server, so its MAX(created_at) is now authoritative again.
      // `txInserted` stays as the delta-step's contribution; the
      // separate `txRebuiltFromDrift` flag tells callers a full
      // rebuild happened so they can invalidate React Query / etc.
      await syncStateRepo.upsert(`tx:${userId}`, nowIso, (await txRepo.getWatermark()) ?? null);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`tx-reconcile: ${msg}`);
    console.warn('[db/sync] tx reconciliation failed', err);
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
        // Count net inserts, not fetched rows. `fetchAllNavRows` uses
        // `.gte(sinceDate)` (inclusive on the watermark), so the boundary
        // row is always re-fetched even when nothing new is upstream.
        // `INSERT OR IGNORE` drops it on the SQLite side, but counting
        // `rows.length` here would still flag every sync as "changed",
        // firing a phantom `queryClient.invalidateQueries()` in the
        // foreground handler and leaving the user with a spinner that
        // doesn't change any values.
        const before = await navRepo.count();
        await navRepo.bulkInsert(rows);
        const after = await navRepo.count();
        navInserted += after - before;
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
      // Net delta, same reasoning as nav above.
      const before = await idxRepo.count();
      await idxRepo.bulkInsert(rows);
      const after = await idxRepo.count();
      idxInserted += after - before;
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

  const result: SyncResult = { txInserted, navInserted, idxInserted, errors, txRebuiltFromDrift };
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
 * High-level entry point for the layout's mount effect. Derives the
 * scope lists from the user's fund roster + the global benchmark
 * options, then runs `bootstrap` (which is idempotent on already-
 * populated scopes).
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
      // bootstrap again. The on-disk SQLite cache survives — bootstrap
      // is idempotent and skips populated scopes via watermark.
      inFlightBootstrap = null;
    }
  })();
  return inFlightBootstrap;
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
