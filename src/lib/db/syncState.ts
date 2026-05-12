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
import { getDb } from '@/src/lib/db/db';

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

export async function upsert(
  scope: string,
  lastSyncedAt: string,
  watermarkDate: string | null,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO sync_state (scope, last_synced_at, watermark_date)
     VALUES (?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       last_synced_at = excluded.last_synced_at,
       watermark_date = excluded.watermark_date`,
    [scope, lastSyncedAt, watermarkDate],
  );
}

export async function clear(): Promise<void> {
  const db = await getDb();
  await db.execAsync('DELETE FROM sync_state');
}
