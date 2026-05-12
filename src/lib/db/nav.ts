/**
 * Repo for the `nav` table — the local copy of `nav_history` rows.
 * Append-only; PK is `(scheme_code, nav_date)`.
 */
import { getDb } from '@/src/lib/db/db';

export interface DbNavRow {
  scheme_code: number;
  nav_date: string;
  nav: number;
}

const COLUMNS = 'scheme_code, nav_date, nav';

export async function readBySchemeCodes(
  schemeCodes: number[],
  options: { sinceDate?: string; orderDesc?: boolean; limit?: number } = {},
): Promise<DbNavRow[]> {
  if (schemeCodes.length === 0) return [];
  const db = await getDb();
  const placeholders = schemeCodes.map(() => '?').join(',');
  const direction = options.orderDesc ? 'DESC' : 'ASC';
  const sinceClause = options.sinceDate ? ' AND nav_date >= ?' : '';
  const limitClause = options.limit != null ? ` LIMIT ${options.limit}` : '';
  const params: (number | string)[] = [...schemeCodes];
  if (options.sinceDate) params.push(options.sinceDate);

  return db.getAllAsync<DbNavRow>(
    `SELECT ${COLUMNS} FROM nav WHERE scheme_code IN (${placeholders})${sinceClause} ORDER BY nav_date ${direction}${limitClause}`,
    params,
  );
}

export async function readBySchemeCode(
  schemeCode: number,
  options: { orderDesc?: boolean; limit?: number } = {},
): Promise<DbNavRow[]> {
  return readBySchemeCodes([schemeCode], options);
}

export async function bulkInsert(rows: DbNavRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    const stmt = await db.prepareAsync(
      `INSERT OR IGNORE INTO nav (${COLUMNS}) VALUES (?, ?, ?)`,
    );
    try {
      for (const row of rows) {
        await stmt.executeAsync([row.scheme_code, row.nav_date, row.nav]);
      }
    } finally {
      await stmt.finalizeAsync();
    }
  });
}

/**
 * Per-scheme watermark — used by the sync orchestrator to ask Supabase
 * for rows after this date. We track watermarks per scheme so a newly
 * added fund doesn't accidentally get treated as up-to-date because
 * other funds were synced more recently.
 */
export async function getWatermark(schemeCode: number): Promise<string | null> {
  const db = await getDb();
  const row = (await db.getFirstAsync<{ max_date: string | null }>(
    'SELECT MAX(nav_date) as max_date FROM nav WHERE scheme_code = ?',
    [schemeCode],
  )) as { max_date: string | null } | null;
  return row?.max_date ?? null;
}

export async function count(): Promise<number> {
  const db = await getDb();
  const row = (await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) as n FROM nav',
  )) as { n: number } | null;
  return row?.n ?? 0;
}

export async function clear(): Promise<void> {
  const db = await getDb();
  await db.execAsync('DELETE FROM nav');
}
