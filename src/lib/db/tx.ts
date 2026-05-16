/**
 * Repo for the `tx` table — the local copy of `transaction` rows from
 * Supabase. Append-only; deduped at write time via the composite PK.
 *
 * Shape mirrors `UserTransactionRow` so the read-through path in
 * `useUserTransactions.fetchUserTransactions` can return SQLite rows
 * directly to callers without a re-shape. The 5 PK columns are the
 * dedup key Portfolio + Fund Detail XIRR math relies on; the other 5
 * are nullable metadata that Money Trail + Wealth Journey display.
 */
import { getDb } from '@/src/lib/db/db';

export interface DbTxRow {
  fund_id: string;
  transaction_date: string;
  transaction_type: string;
  units: number;
  amount: number;
  id: string;
  nav_at_transaction: number | null;
  folio_number: string | null;
  cas_import_id: string | null;
  created_at: string | null;
}

const COLUMNS =
  'fund_id, transaction_date, transaction_type, units, amount, id, nav_at_transaction, folio_number, cas_import_id, created_at';

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
      `INSERT OR IGNORE INTO tx (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      for (const row of rows) {
        await stmt.executeAsync([
          row.fund_id,
          row.transaction_date,
          row.transaction_type,
          row.units,
          row.amount,
          row.id,
          row.nav_at_transaction,
          row.folio_number,
          row.cas_import_id,
          row.created_at,
        ]);
      }
    } finally {
      await stmt.finalizeAsync();
    }
  });
}

/**
 * Max(created_at) currently stored. Used by the sync orchestrator
 * to fetch only rows inserted server-side since the last sync.
 * Returns null when the table is empty.
 *
 * We watermark on `created_at` (server-side insertion timestamp), not
 * `transaction_date` (the trade date). CAS imports routinely write
 * rows whose trade date is older than what we already had — e.g. a
 * first-time CAS upload includes years of history; subsequent CAS
 * uploads might add a back-dated transaction that arrived late from
 * the registrar. Using `transaction_date` as the watermark would let
 * those rows fall on the wrong side of the `>= watermark` filter and
 * stay invisible to the client indefinitely.
 *
 * `transaction.created_at` is `now()` at server-side insert time.
 * Both `parse-cas-pdf` and `cas-webhook-resend` import via
 * `importCASData`, which inserts via Supabase's default `created_at`,
 * so the watermark always advances monotonically as new rows arrive.
 */
export async function getWatermark(): Promise<string | null> {
  const db = await getDb();
  const row = (await db.getFirstAsync<{ max_ts: string | null }>(
    'SELECT MAX(created_at) as max_ts FROM tx',
  )) as { max_ts: string | null } | null;
  return row?.max_ts ?? null;
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
