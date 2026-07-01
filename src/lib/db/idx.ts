/**
 * Repo for the `idx` table — the local copy of `index_history` rows.
 * Append-only; PK is `(index_symbol, index_date)`.
 */
import {
  getDb,
  runSerializedDatabaseTransaction,
  runSerializedDatabaseWrite,
  type SerializedDatabaseWriteOptions,
} from '@/src/lib/db/db';

export interface DbIdxRow {
  index_symbol: string;
  index_date: string;
  close_value: number;
}

const COLUMNS = 'index_symbol, index_date, close_value';

export async function readBySymbol(
  symbol: string,
  options: { sinceDate?: string; orderDesc?: boolean } = {},
): Promise<DbIdxRow[]> {
  const db = await getDb();
  const direction = options.orderDesc ? 'DESC' : 'ASC';
  const sinceClause = options.sinceDate ? ' AND index_date >= ?' : '';
  const params: string[] = [symbol];
  if (options.sinceDate) params.push(options.sinceDate);
  return db.getAllAsync<DbIdxRow>(
    `SELECT ${COLUMNS} FROM idx WHERE index_symbol = ?${sinceClause} ORDER BY index_date ${direction}`,
    params,
  );
}

export async function bulkInsert(
  rows: DbIdxRow[],
  options: SerializedDatabaseWriteOptions = {},
): Promise<void> {
  if (rows.length === 0) return;
  await runSerializedDatabaseTransaction(options.operation ?? 'idx_bulk_insert', async (db) => {
    const stmt = await db.prepareAsync(
      `INSERT OR IGNORE INTO idx (${COLUMNS}) VALUES (?, ?, ?)`,
    );
    try {
      for (const row of rows) {
        await stmt.executeAsync([row.index_symbol, row.index_date, row.close_value]);
      }
    } finally {
      await stmt.finalizeAsync();
    }
  }, options);
}

export async function getWatermark(symbol: string): Promise<string | null> {
  const db = await getDb();
  const row = (await db.getFirstAsync<{ max_date: string | null }>(
    'SELECT MAX(index_date) as max_date FROM idx WHERE index_symbol = ?',
    [symbol],
  )) as { max_date: string | null } | null;
  return row?.max_date ?? null;
}

export async function count(): Promise<number> {
  const db = await getDb();
  const row = (await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) as n FROM idx',
  )) as { n: number } | null;
  return row?.n ?? 0;
}

/**
 * Per-symbol row count. Used by the cache debug surface so we can
 * surface "Nifty 50 TRI has N rows locally, watermark X" per index.
 */
export async function countBySymbol(symbol: string): Promise<number> {
  const db = await getDb();
  const row = (await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) as n FROM idx WHERE index_symbol = ?',
    [symbol],
  )) as { n: number } | null;
  return row?.n ?? 0;
}

export async function clear(options: SerializedDatabaseWriteOptions = {}): Promise<void> {
  await runSerializedDatabaseWrite(
    options.operation ?? 'idx_clear',
    (db) => db.execAsync('DELETE FROM idx'),
    options,
  );
}
