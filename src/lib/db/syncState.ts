/**
 * Repo for the `sync_state` table — tracks "when did we last pull
 * deltas for scope X". Scope is a free-form string like
 * `'tx:<userId>'`, `'nav:<scheme_code>'`, `'idx:<symbol>'`. The sync
 * orchestrator owns the scope vocabulary.
 *
 * `watermark_date` is informational (the max(date) we have on file
 * after the last successful sync); the repo's `getWatermark` methods
 * compute it from the underlying table directly so the orchestrator
 * doesn't need to trust this column.
 */
import {
  getDb,
  runSerializedDatabaseWrite,
  type SerializedDatabaseWriteOptions,
} from '@/src/lib/db/db';

export interface DbSyncStateRow {
  scope: string;
  last_synced_at: string;
  watermark_date: string | null;
}

export async function read(scope: string): Promise<DbSyncStateRow | null> {
  const db = await getDb();
  const row = (await db.getFirstAsync<DbSyncStateRow>(
    'SELECT scope, last_synced_at, watermark_date FROM sync_state WHERE scope = ?',
    [scope],
  )) as DbSyncStateRow | null;
  return row;
}

/**
 * Returns every row in `sync_state`. Used by the in-app cache debug
 * surface to render the full sync-history matrix (one row per scope:
 * `tx:<userId>`, `nav:<schemeCode>`, `idx:<symbol>`). Order matters
 * only for human reading — sort by `last_synced_at DESC` so the most
 * recently-active scopes are on top.
 */
export async function readAll(): Promise<DbSyncStateRow[]> {
  const db = await getDb();
  return db.getAllAsync<DbSyncStateRow>(
    'SELECT scope, last_synced_at, watermark_date FROM sync_state ORDER BY last_synced_at DESC',
  );
}

export async function upsert(
  scope: string,
  lastSyncedAt: string,
  watermarkDate: string | null,
  options: SerializedDatabaseWriteOptions = {},
): Promise<void> {
  await runSerializedDatabaseWrite(
    options.operation ?? 'sync_state_upsert',
    (db) => db.runAsync(
      `INSERT INTO sync_state (scope, last_synced_at, watermark_date)
       VALUES (?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         last_synced_at = excluded.last_synced_at,
         watermark_date = excluded.watermark_date`,
      [scope, lastSyncedAt, watermarkDate],
    ),
    options,
  );
}

export async function clear(options: SerializedDatabaseWriteOptions = {}): Promise<void> {
  await runSerializedDatabaseWrite(
    options.operation ?? 'sync_state_clear',
    (db) => db.execAsync('DELETE FROM sync_state'),
    options,
  );
}
