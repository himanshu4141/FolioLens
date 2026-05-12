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
import { supabase } from '@/src/lib/supabase';
import { analytics } from '@/src/lib/analytics';
import { perfEnd, perfStart } from '@/src/lib/perfMark';
import { fetchUserFunds } from '@/src/hooks/useUserFunds';
import { fetchUserTransactions } from '@/src/hooks/useUserTransactions';
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
    let q = supabase
      .from('nav_history')
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
    let q = supabase
      .from('index_history')
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
    const watermark = await txRepo.getWatermark();
    if (watermark === null || options.mode === 'delta') {
      const fresh = await fetchUserTransactions(userId);
      const newRows =
        watermark === null
          ? fresh
          : fresh.filter((r) => r.transaction_date >= watermark);
      await txRepo.bulkInsert(newRows);
      txInserted = newRows.length;
      await syncStateRepo.upsert(`tx:${userId}`, nowIso, (await txRepo.getWatermark()) ?? null);
    }
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

/**
 * Same but uses delta semantics — call on screen focus or
 * pull-to-refresh.
 */
export async function syncDeltaForUser(userId: string): Promise<SyncResult> {
  const funds = await fetchUserFunds(userId);
  const schemeCodes = funds
    .map((f) => f.scheme_code)
    .filter((c): c is number => typeof c === 'number');
  const indexSymbols = BENCHMARK_OPTIONS.map((b) => b.symbol);
  return syncDelta(userId, schemeCodes, indexSymbols);
}
