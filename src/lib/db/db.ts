/**
 * SQLite connection + schema for the offline-first read cache.
 *
 * Owns the singleton `SQLiteDatabase` instance and the `CREATE TABLE
 * IF NOT EXISTS` migration. Every repo module imports `getDb()` and
 * runs statements against the same connection.
 *
 * Schema overview:
 *   tx          — per-transaction rows (append-only).
 *   nav         — per-scheme daily NAV (append-only).
 *   idx         — per-index daily close (append-only).
 *   sync_state  — last-synced-at watermark per scope.
 *   meta        — single-row key/value, currently holds SCHEMA_VERSION.
 *
 * Primary keys are composite natural keys. Inserts use `INSERT OR
 * IGNORE`, so re-running a sync that overlaps with rows already on
 * disk is a no-op rather than a constraint violation.
 *
 * On `SCHEMA_VERSION` mismatch (or first ever open), we `DROP` and
 * `CREATE`. The cache is treated as discardable — Supabase remains
 * the source of truth and a re-bootstrap rebuilds it.
 */
import * as SQLite from 'expo-sqlite';
import { perfEnd, perfStart } from '@/src/lib/perfMark';

// v2 (2026-05-12): widen `tx` to mirror the 10 columns now returned by
// `fetchUserTransactions` (PR #142). The v1 schema stored only the 5 PK
// columns, so `tx.readAll()` returned rows that were missing the extras
// that Money Trail + Wealth Journey rely on (`id`, `nav_at_transaction`,
// `folio_number`, `cas_import_id`, `created_at`). Bumping forces a clean
// re-sync from Supabase on next launch.
export const SCHEMA_VERSION = 2;
export const DB_NAME = 'foliolens.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * Token captured by an async flow before it performs remote work that may
 * later write into SQLite. Cleanup advances the generation synchronously;
 * an older flow can still finish its network request, but its queued write
 * rejects before touching the new user's/reset cache.
 */
export interface DatabaseWriteScope {
  readonly generation: number;
}

export interface SerializedDatabaseWriteOptions {
  scope?: DatabaseWriteScope;
  attempt?: number;
  operation?: string;
}

export class StaleDatabaseWriteError extends Error {
  constructor(operation: string) {
    super(`SQLite write "${operation}" belongs to an invalidated cache lifecycle`);
    this.name = 'StaleDatabaseWriteError';
  }
}

let writeGeneration = 0;
let writeQueueTail: Promise<void> = Promise.resolve();
let queuedWriteCount = 0;

export function captureDatabaseWriteScope(): DatabaseWriteScope {
  return { generation: writeGeneration };
}

export function isStaleDatabaseWriteError(error: unknown): error is StaleDatabaseWriteError {
  return error instanceof StaleDatabaseWriteError;
}

/**
 * One FIFO for every write using the singleton connection. The stored tail
 * always recovers so a rejected entry cannot poison later work; callers await
 * the unrecovered entry promise and therefore still receive the original
 * error. Queue callbacks contain direct SQLite statements only — they never
 * call another public queued repository method, avoiding re-entrant waits.
 */
function enqueueSerializedDatabaseOperation<T>(
  operation: string,
  task: () => Promise<T>,
  options: SerializedDatabaseWriteOptions = {},
): Promise<T> {
  const scope = options.scope ?? captureDatabaseWriteScope();
  const depthAtEnqueue = ++queuedWriteCount;
  const waitSpanId = perfStart('db:write_queue_wait');

  const entry = writeQueueTail.then(async () => {
    queuedWriteCount -= 1;
    perfEnd(waitSpanId, {
      operation,
      queue_depth: depthAtEnqueue,
      attempt: options.attempt ?? 1,
    });

    const writeSpanId = perfStart('db:write');
    if (scope.generation !== writeGeneration) {
      perfEnd(writeSpanId, {
        operation,
        status: 'stale',
        attempt: options.attempt ?? 1,
      });
      throw new StaleDatabaseWriteError(operation);
    }

    try {
      const result = await task();
      perfEnd(writeSpanId, {
        operation,
        status: 'ok',
        attempt: options.attempt ?? 1,
      });
      return result;
    } catch (error) {
      perfEnd(writeSpanId, {
        operation,
        status: 'error',
        attempt: options.attempt ?? 1,
      });
      throw error;
    }
  });

  writeQueueTail = entry.then(
    () => undefined,
    () => undefined,
  );
  return entry;
}

export function runSerializedDatabaseWrite<T>(
  operation: string,
  task: (db: SQLite.SQLiteDatabase) => Promise<T>,
  options: SerializedDatabaseWriteOptions = {},
): Promise<T> {
  return enqueueSerializedDatabaseOperation(
    operation,
    async () => task(await getDb()),
    options,
  );
}

export function runSerializedDatabaseTransaction<T>(
  operation: string,
  task: (db: SQLite.SQLiteDatabase) => Promise<T>,
  options: SerializedDatabaseWriteOptions = {},
): Promise<T> {
  return runSerializedDatabaseWrite(
    operation,
    async (db) => {
      let result: T | undefined;
      await db.withTransactionAsync(async () => {
        result = await task(db);
      });
      return result as T;
    },
    options,
  );
}

/**
 * Advance the lifecycle before queueing cleanup. Active work finishes first;
 * queued or later-arriving work holding an older scope rejects without I/O.
 * Because this function enqueues synchronously before returning, new-scope
 * writes called afterward are ordered behind the lifecycle operation.
 */
export function runSerializedDatabaseLifecycle<T>(
  operation: string,
  task: () => Promise<T>,
): Promise<T> {
  writeGeneration += 1;
  return enqueueSerializedDatabaseOperation(operation, task, {
    scope: captureDatabaseWriteScope(),
  });
}

export async function waitForSerializedDatabaseWrites(): Promise<void> {
  await writeQueueTail;
}

const DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tx (
    fund_id TEXT NOT NULL,
    transaction_date TEXT NOT NULL,
    transaction_type TEXT NOT NULL,
    units REAL NOT NULL,
    amount REAL NOT NULL,
    id TEXT NOT NULL,
    nav_at_transaction REAL,
    folio_number TEXT,
    cas_import_id TEXT,
    created_at TEXT,
    PRIMARY KEY (fund_id, transaction_date, transaction_type, units, amount)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tx_fund_date ON tx (fund_id, transaction_date)`,
  `CREATE TABLE IF NOT EXISTS nav (
    scheme_code INTEGER NOT NULL,
    nav_date TEXT NOT NULL,
    nav REAL NOT NULL,
    PRIMARY KEY (scheme_code, nav_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nav_scheme_date ON nav (scheme_code, nav_date)`,
  `CREATE TABLE IF NOT EXISTS idx (
    index_symbol TEXT NOT NULL,
    index_date TEXT NOT NULL,
    close_value REAL NOT NULL,
    PRIMARY KEY (index_symbol, index_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_idx_symbol_date ON idx (index_symbol, index_date)`,
  `CREATE TABLE IF NOT EXISTS sync_state (
    scope TEXT NOT NULL PRIMARY KEY,
    last_synced_at TEXT NOT NULL,
    watermark_date TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync('PRAGMA journal_mode = WAL');

  // Run all DDL — IF NOT EXISTS keeps it idempotent.
  for (const stmt of DDL) {
    await db.execAsync(stmt);
  }

  // Check schema version and drop everything if mismatched.
  const row = (await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM meta WHERE key = ?',
    ['schema_version'],
  )) as { value: string } | null;
  const storedVersion = row ? Number(row.value) : null;

  if (storedVersion !== SCHEMA_VERSION) {
    await dropAllTables(db);
    for (const stmt of DDL) await db.execAsync(stmt);
    await db.runAsync(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
      ['schema_version', String(SCHEMA_VERSION)],
    );
  }

  return db;
}

async function dropAllTables(db: SQLite.SQLiteDatabase): Promise<void> {
  // Order matters only for foreign keys (we have none); listing every
  // table keeps the wipe explicit.
  for (const table of ['tx', 'nav', 'idx', 'sync_state', 'meta']) {
    await db.execAsync(`DROP TABLE IF EXISTS ${table}`);
  }
}

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = openAndMigrate();
  return dbPromise;
}

/**
 * Wipe every table and recreate the schema. Used on signout (PII must
 * not survive past logout) and as a recovery hatch when the SCHEMA
 * mismatches what we expect.
 */
export async function dropAndRecreate(): Promise<void> {
  await runSerializedDatabaseLifecycle('database_drop_and_recreate', async () => {
    const db = await getDb();
    await dropAllTables(db);
    for (const stmt of DDL) await db.execAsync(stmt);
    await db.runAsync(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
      ['schema_version', String(SCHEMA_VERSION)],
    );
  });
}

/**
 * Test hook: replace the singleton with an in-memory DB so unit tests
 * can run repo code against a real SQLite instance without touching
 * disk. Pass `null` to reset and let the next call to `getDb()` reopen
 * from `DB_NAME`.
 */
export async function __setDbForTests(
  promise: Promise<SQLite.SQLiteDatabase> | null,
): Promise<void> {
  await runSerializedDatabaseLifecycle('database_test_reset', async () => {
    dbPromise = promise;
  });
}
