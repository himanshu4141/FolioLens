/**
 * Repo for the `nav` table — the local copy of `nav_history` rows.
 * Append-only; PK is `(scheme_code, nav_date)`.
 */
import {
  getDb,
  runSerializedDatabaseTransaction,
  runSerializedDatabaseWrite,
  type SerializedDatabaseWriteOptions,
} from '@/src/lib/db/db';

export interface DbNavRow {
  scheme_code: number;
  nav_date: string;
  nav: number;
}

const COLUMNS = 'scheme_code, nav_date, nav';
const COVERAGE_SCOPE_PREFIX = 'nav-coverage:';

export interface NavHistoryCoverage {
  known: boolean;
  /** `null` means an unbounded upstream fetch proved full history. */
  startDate: string | null;
}

export function navHistoryCoverageScope(schemeCode: number): string {
  return `${COVERAGE_SCOPE_PREFIX}${schemeCode}`;
}

/**
 * Authoritative lower-bound coverage for one scheme.
 *
 * Row absence means the local series may be only a recent slice. Row presence
 * proves a completed upstream read; `watermark_date = NULL` is the strongest
 * state and means that read was unbounded. This metadata deliberately lives in
 * `sync_state` so sign-out/reset clears rows and their proof together.
 */
export async function getHistoryCoverage(schemeCode: number): Promise<NavHistoryCoverage> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ watermark_date: string | null }>(
    'SELECT watermark_date FROM sync_state WHERE scope = ?',
    [navHistoryCoverageScope(schemeCode)],
  );
  if (!row) return { known: false, startDate: null };
  return { known: true, startDate: row.watermark_date };
}

export async function hasHistoryCoverage(
  schemeCode: number,
  requiredStartDate: string | null,
): Promise<boolean> {
  const coverage = await getHistoryCoverage(schemeCode);
  if (!coverage.known) return false;
  if (coverage.startDate === null) return true;
  if (requiredStartDate === null) return false;
  return coverage.startDate <= requiredStartDate;
}

/**
 * Record a successful upstream interval after its rows are durably inserted.
 * The SQL merge is monotonic under concurrent repairs: full history (`NULL`)
 * can never be weakened, while bounded coverage can only move earlier.
 */
export async function markHistoryCoverage(
  schemeCodes: number[],
  requestedStartDate: string | null,
  options: SerializedDatabaseWriteOptions = {},
): Promise<void> {
  if (schemeCodes.length === 0) return;
  const nowIso = new Date().toISOString();
  await runSerializedDatabaseTransaction(
    options.operation ?? 'nav_history_coverage_mark',
    async (db) => {
      const stmt = await db.prepareAsync(
        `INSERT INTO sync_state (scope, last_synced_at, watermark_date)
         VALUES (?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           last_synced_at = excluded.last_synced_at,
           watermark_date = excluded.watermark_date`,
      );
      try {
        for (const schemeCode of new Set(schemeCodes)) {
          const scope = navHistoryCoverageScope(schemeCode);
          const existing = await db.getFirstAsync<{ watermark_date: string | null }>(
            'SELECT watermark_date FROM sync_state WHERE scope = ?',
            [scope],
          );
          const nextStart = existing
            ? existing.watermark_date === null || requestedStartDate === null
              ? null
              : existing.watermark_date < requestedStartDate
                ? existing.watermark_date
                : requestedStartDate
            : requestedStartDate;
          await stmt.executeAsync([
            scope,
            nowIso,
            nextStart,
          ]);
        }
      } finally {
        await stmt.finalizeAsync();
      }
    },
    options,
  );
}

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
  options: { sinceDate?: string; orderDesc?: boolean; limit?: number } = {},
): Promise<DbNavRow[]> {
  return readBySchemeCodes([schemeCode], options);
}

export async function bulkInsert(
  rows: DbNavRow[],
  options: SerializedDatabaseWriteOptions = {},
): Promise<void> {
  if (rows.length === 0) return;
  await runSerializedDatabaseTransaction(options.operation ?? 'nav_bulk_insert', async (db) => {
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
  }, options);
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

/**
 * Per-scheme row count. Used by the cache debug surface to surface
 * "scheme X has N NAV rows locally" alongside the per-scheme
 * watermark — gives a quick visual of which schemes are fully synced
 * vs partially.
 */
export async function countBySchemeCode(schemeCode: number): Promise<number> {
  const db = await getDb();
  const row = (await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) as n FROM nav WHERE scheme_code = ?',
    [schemeCode],
  )) as { n: number } | null;
  return row?.n ?? 0;
}

export async function clear(options: SerializedDatabaseWriteOptions = {}): Promise<void> {
  await runSerializedDatabaseWrite(
    options.operation ?? 'nav_clear',
    (db) => db.execAsync('DELETE FROM nav'),
    options,
  );
}
