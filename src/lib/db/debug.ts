/**
 * Cache debug snapshot — aggregates every client-side cache surface
 * into one object the in-app debug screen can render. Read-only;
 * mutations live elsewhere (the Reset button in `data-sync.tsx`,
 * sign-out's `clearAll` in `_layout.tsx`).
 *
 * Surfaces covered:
 *   - SQLite `tx`   — local transactions + server count for drift
 *   - SQLite `nav`  — per-scheme row count + watermark
 *   - SQLite `idx`  — per-symbol row count + watermark
 *   - SQLite `sync_state` — last-synced-at per scope
 *   - React Query persister — blob size + entry count + breakdown
 *
 * Each section gracefully degrades on error: SQLite I/O errors leave
 * a `null` count rather than throwing the whole snapshot. The debug
 * screen surfaces nulls as "—" so the user (and us reading the
 * screenshot) can tell which subsystem failed.
 *
 * Not covered (intentionally):
 *   - Supabase auth session blob (PII, opaque to us)
 *   - Onboarding draft (PII)
 *   - Zustand appStore (mostly user prefs; render directly from
 *     the store in the screen rather than snapshotting here)
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { transactionRepo } from '@/src/lib/data/transaction';
import * as txRepo from '@/src/lib/db/tx';
import * as navRepo from '@/src/lib/db/nav';
import * as idxRepo from '@/src/lib/db/idx';
import * as syncStateRepo from '@/src/lib/db/syncState';
import { PERSIST_KEY } from '@/src/lib/queryClient';
import { BENCHMARK_OPTIONS } from '@/src/store/appStore';

export interface TxScopeSnapshot {
  localCount: number | null;
  serverCount: number | null;
  drift: number | null;
  latestTransactionDate: string | null;
  watermarkCreatedAt: string | null;
}

export interface NavSchemeSnapshot {
  schemeCode: number;
  schemeName: string | null;
  rowCount: number;
  watermark: string | null;
}

export interface IdxSymbolSnapshot {
  symbol: string;
  label: string;
  rowCount: number;
  watermark: string | null;
}

export interface SyncStateRowSnapshot {
  scope: string;
  lastSyncedAt: string;
  watermarkDate: string | null;
}

export interface PersisterSnapshot {
  blobSizeBytes: number | null;
  buster: string | null;
  timestamp: number | null;
  entryCount: number | null;
  byKeyPrefix: { prefix: string; count: number }[];
  parseError: string | null;
}

export interface CacheDebugSnapshot {
  tx: TxScopeSnapshot;
  nav: {
    totalCount: number | null;
    perScheme: NavSchemeSnapshot[];
  };
  idx: {
    totalCount: number | null;
    perSymbol: IdxSymbolSnapshot[];
  };
  syncState: SyncStateRowSnapshot[];
  persister: PersisterSnapshot;
  generatedAt: string;
}

interface FundForSnapshot {
  scheme_code: number | null;
  scheme_name: string | null;
}

async function snapshotTx(userId: string): Promise<TxScopeSnapshot> {
  const [localCount, latestTransactionDate, watermarkCreatedAt] = await Promise.all([
    txRepo.count().catch(() => null as number | null),
    txRepo.getLatestTransactionDate().catch(() => null as string | null),
    txRepo.getWatermark().catch(() => null as string | null),
  ]);

  let serverCount: number | null = null;
  try {
    const { count, error } = await transactionRepo
      .from()
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    serverCount = error ? null : count ?? 0;
  } catch {
    serverCount = null;
  }

  const drift =
    localCount != null && serverCount != null ? serverCount - localCount : null;

  return { localCount, serverCount, drift, latestTransactionDate, watermarkCreatedAt };
}

async function snapshotNav(funds: FundForSnapshot[]): Promise<CacheDebugSnapshot['nav']> {
  const totalCount = await navRepo.count().catch(() => null as number | null);
  const codes = funds
    .map((f) => f.scheme_code)
    .filter((c): c is number => typeof c === 'number');

  const perScheme = await Promise.all(
    codes.map(async (code): Promise<NavSchemeSnapshot> => {
      const [rowCount, watermark] = await Promise.all([
        navRepo.countBySchemeCode(code).catch(() => 0),
        navRepo.getWatermark(code).catch(() => null as string | null),
      ]);
      const fund = funds.find((f) => f.scheme_code === code);
      return {
        schemeCode: code,
        schemeName: fund?.scheme_name ?? null,
        rowCount,
        watermark,
      };
    }),
  );

  // Sort by row count descending so heaviest schemes are on top —
  // makes the "where is my blob size going" question one glance.
  perScheme.sort((a, b) => b.rowCount - a.rowCount);

  return { totalCount, perScheme };
}

async function snapshotIdx(): Promise<CacheDebugSnapshot['idx']> {
  const totalCount = await idxRepo.count().catch(() => null as number | null);
  const perSymbol = await Promise.all(
    BENCHMARK_OPTIONS.map(async (option): Promise<IdxSymbolSnapshot> => {
      const [rowCount, watermark] = await Promise.all([
        idxRepo.countBySymbol(option.symbol).catch(() => 0),
        idxRepo.getWatermark(option.symbol).catch(() => null as string | null),
      ]);
      return {
        symbol: option.symbol,
        label: option.label,
        rowCount,
        watermark,
      };
    }),
  );
  return { totalCount, perSymbol };
}

async function snapshotSyncState(): Promise<SyncStateRowSnapshot[]> {
  try {
    const rows = await syncStateRepo.readAll();
    return rows.map((r) => ({
      scope: r.scope,
      lastSyncedAt: r.last_synced_at,
      watermarkDate: r.watermark_date,
    }));
  } catch {
    return [];
  }
}

/**
 * Inspect the persisted React Query blob without going through the
 * persister's parse pipeline — that way a corrupted blob (which is
 * the load-bearing failure mode for the May 2026 persister-failure
 * investigation) shows up as `parseError` here instead of an empty
 * snapshot. The byte length comes from the raw string before any
 * parse attempt.
 */
async function snapshotPersister(): Promise<PersisterSnapshot> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(PERSIST_KEY);
  } catch {
    return {
      blobSizeBytes: null,
      buster: null,
      timestamp: null,
      entryCount: null,
      byKeyPrefix: [],
      parseError: 'AsyncStorage.getItem threw',
    };
  }

  if (raw == null) {
    return {
      blobSizeBytes: null,
      buster: null,
      timestamp: null,
      entryCount: 0,
      byKeyPrefix: [],
      parseError: null,
    };
  }

  const blobSizeBytes = raw.length;
  try {
    const parsed = JSON.parse(raw) as {
      buster?: string;
      timestamp?: number;
      clientState?: { queries?: { queryKey?: unknown[] }[] };
    };
    const queries = parsed.clientState?.queries ?? [];
    const counts = new Map<string, number>();
    for (const q of queries) {
      const head = q.queryKey?.[0];
      const prefix = typeof head === 'string' ? head : '<non-string>';
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    const byKeyPrefix = [...counts.entries()]
      .map(([prefix, count]) => ({ prefix, count }))
      .sort((a, b) => b.count - a.count);
    return {
      blobSizeBytes,
      buster: parsed.buster ?? null,
      timestamp: parsed.timestamp ?? null,
      entryCount: queries.length,
      byKeyPrefix,
      parseError: null,
    };
  } catch (err) {
    return {
      blobSizeBytes,
      buster: null,
      timestamp: null,
      entryCount: null,
      byKeyPrefix: [],
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function snapshotCache(
  userId: string,
  funds: FundForSnapshot[],
): Promise<CacheDebugSnapshot> {
  const [tx, nav, idx, syncState, persister] = await Promise.all([
    snapshotTx(userId),
    snapshotNav(funds),
    snapshotIdx(),
    snapshotSyncState(),
    snapshotPersister(),
  ]);
  return {
    tx,
    nav,
    idx,
    syncState,
    persister,
    generatedAt: new Date().toISOString(),
  };
}
