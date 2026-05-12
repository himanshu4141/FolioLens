/**
 * Repo for the `tx` table — the local copy of `transaction` rows from
 * Supabase. Append-only; deduped at write time via the composite PK.
 */
import { getDb } from '@/src/lib/db/db';

export interface DbTxRow {
  fund_id: string;
  transaction_date: string;
  transaction_type: string;
  units: number;
  amount: number;
}

const COLUMNS = 'fund_id, transaction_date, transaction_type, units, amount';

export async function readAll(): Promise<DbTxRow[]> {
  const db = await getDb();
  return db.getAllAsync<DbTxRow>(
    `SELECT ${COLUMNS} FROM tx ORDER BY transaction_date ASC`,
  );
}

export async function readByFundId(fundId: string): Promise<DbTxRow[]> {
  const db = await getDb();
  return db.getAllAsync<DbTxRow>(
    `SELECT ${COLUMNS} FROM tx WHERE fund_id = ? ORDER BY transaction_date ASC`,
    [fundId],
  );
}

export async function bulkInsert(rows: DbTxRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    const stmt = await db.prepareAsync(
      `INSERT OR IGNORE INTO tx (${COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
    );
    try {
      for (const row of rows) {
        await stmt.executeAsync([
          row.fund_id,
          row.transaction_date,
          row.transaction_type,
          row.units,
          row.amount,
        ]);
      }
    } finally {
      await stmt.finalizeAsync();
    }
  });
}

/**
 * Max(transaction_date) currently stored. Used by the sync orchestrator
 * to fetch only newer rows. Returns null when the table is empty.
 */
export async function getWatermark(): Promise<string | null> {
  const db = await getDb();
  const row = (await db.getFirstAsync<{ max_date: string | null }>(
    'SELECT MAX(transaction_date) as max_date FROM tx',
  )) as { max_date: string | null } | null;
  return row?.max_date ?? null;
}

export async function count(): Promise<number> {
  const db = await getDb();
  const row = (await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) as n FROM tx',
  )) as { n: number } | null;
  return row?.n ?? 0;
}

export async function clear(): Promise<void> {
  const db = await getDb();
  await db.execAsync('DELETE FROM tx');
}
