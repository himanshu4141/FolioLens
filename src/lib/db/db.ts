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

export const SCHEMA_VERSION = 1;
export const DB_NAME = 'foliolens.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

const DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tx (
    fund_id TEXT NOT NULL,
    transaction_date TEXT NOT NULL,
    transaction_type TEXT NOT NULL,
    units REAL NOT NULL,
    amount REAL NOT NULL,
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
  const db = await getDb();
  await dropAllTables(db);
  for (const stmt of DDL) await db.execAsync(stmt);
  await db.runAsync(
    'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
    ['schema_version', String(SCHEMA_VERSION)],
  );
}

/**
 * Test hook: replace the singleton with an in-memory DB so unit tests
 * can run repo code against a real SQLite instance without touching
 * disk. Pass `null` to reset and let the next call to `getDb()` reopen
 * from `DB_NAME`.
 */
export function __setDbForTests(promise: Promise<SQLite.SQLiteDatabase> | null): void {
  dbPromise = promise;
}
