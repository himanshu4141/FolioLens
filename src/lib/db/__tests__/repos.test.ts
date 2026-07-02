/**
 * Repo-level smoke tests against the in-memory SQLite mock from
 * `__mocks__/expo-sqlite.ts`. Verifies that:
 *
 *   - `bulkInsert` is idempotent (re-inserting the same row leaves a
 *     single copy).
 *   - `readAll` / `readBySchemeCodes` / `readBySymbol` respect the PK
 *     order and the `sinceDate` filter.
 *   - `getWatermark` returns the maximum date currently stored.
 *   - `clear` empties the table.
 *   - The schema migration in `db.ts` survives a `dropAndRecreate` and
 *     stamps the current `SCHEMA_VERSION`.
 *
 * The SQL parser in the mock is intentionally narrow: any new SQL the
 * repos emit must keep that parser happy or be added to the mock. This
 * test file is the place where that contract is enforced.
 */
import * as txRepo from '@/src/lib/db/tx';
import type { DbTxRow } from '@/src/lib/db/tx';
import * as navRepo from '@/src/lib/db/nav';
import * as idxRepo from '@/src/lib/db/idx';
import * as syncStateRepo from '@/src/lib/db/syncState';
import { __setDbForTests, dropAndRecreate } from '@/src/lib/db/db';

beforeEach(async () => {
  await __setDbForTests(null);
});

// Tx fixture helper — the 5 PK columns drive every assertion in this file,
// but DbTxRow now also carries 5 nullable metadata columns (Money Trail +
// Wealth Journey rely on them). Default the extras here so each test stays
// readable. `created_at` is optional — pass it explicitly when a test
// exercises the sync watermark, otherwise it defaults to null.
function mkTx(
  partial: Pick<DbTxRow, 'fund_id' | 'transaction_date' | 'transaction_type' | 'units' | 'amount'>
    & Partial<Pick<DbTxRow, 'created_at'>>,
): DbTxRow {
  return {
    ...partial,
    id: `t-${partial.fund_id}-${partial.transaction_date}`,
    nav_at_transaction: null,
    folio_number: null,
    cas_import_id: null,
    created_at: partial.created_at ?? null,
  };
}

describe('tx repo', () => {
  it('bulkInsert + readAll', async () => {
    await txRepo.bulkInsert([
      mkTx({ fund_id: 'f1', transaction_date: '2024-01-01', transaction_type: 'purchase', units: 100, amount: 10000 }),
      mkTx({ fund_id: 'f1', transaction_date: '2024-06-01', transaction_type: 'purchase', units: 50, amount: 6000 }),
      mkTx({ fund_id: 'f2', transaction_date: '2024-03-01', transaction_type: 'purchase', units: 200, amount: 20000 }),
    ]);
    const rows = await txRepo.readAll();
    expect(rows).toHaveLength(3);
    expect(rows[0].transaction_date).toBe('2024-01-01');
    expect(rows[rows.length - 1].transaction_date).toBe('2024-06-01');
  });

  it('bulkInsert is idempotent — re-inserting the same row does not duplicate', async () => {
    const row = mkTx({
      fund_id: 'f1',
      transaction_date: '2024-01-01',
      transaction_type: 'purchase',
      units: 100,
      amount: 10000,
    });
    await txRepo.bulkInsert([row]);
    await txRepo.bulkInsert([row, row]);
    expect(await txRepo.count()).toBe(1);
  });

  it('readByFundId filters by fund_id', async () => {
    await txRepo.bulkInsert([
      mkTx({ fund_id: 'f1', transaction_date: '2024-01-01', transaction_type: 'purchase', units: 100, amount: 10000 }),
      mkTx({ fund_id: 'f2', transaction_date: '2024-02-01', transaction_type: 'purchase', units: 200, amount: 20000 }),
    ]);
    expect(await txRepo.readByFundId('f1')).toHaveLength(1);
    expect(await txRepo.readByFundId('f2')).toHaveLength(1);
    expect(await txRepo.readByFundId('f3')).toHaveLength(0);
  });

  it('getWatermark returns max(created_at) or null', async () => {
    expect(await txRepo.getWatermark()).toBeNull();
    await txRepo.bulkInsert([
      mkTx({ fund_id: 'f1', transaction_date: '2024-01-01', transaction_type: 'purchase', units: 100, amount: 10000, created_at: '2024-01-02T03:04:05Z' }),
      mkTx({ fund_id: 'f1', transaction_date: '2024-06-01', transaction_type: 'purchase', units: 50, amount: 6000, created_at: '2024-06-02T10:11:12Z' }),
    ]);
    expect(await txRepo.getWatermark()).toBe('2024-06-02T10:11:12Z');
  });

  it('getWatermark tracks server-side insertion order, not trade order (back-dated CAS rows)', async () => {
    // Regression for the auto-forward CAS bug (May 2026): a CAS that
    // arrives today can contain transactions whose `transaction_date`
    // is earlier than rows we already have. The watermark must reflect
    // when the row was *inserted server-side* (`created_at`), not when
    // the trade happened (`transaction_date`) — otherwise the delta
    // sync's `created_at >= watermark` filter would miss the late
    // arrival entirely.
    await txRepo.bulkInsert([
      mkTx({
        fund_id: 'f1', transaction_date: '2024-12-01', transaction_type: 'purchase',
        units: 100, amount: 10000,
        created_at: '2024-12-02T00:00:00Z',
      }),
      mkTx({
        fund_id: 'f1', transaction_date: '2024-06-01', transaction_type: 'purchase',
        units: 50, amount: 6000,
        // Late-arriving back-dated row — older trade date, newer insertion.
        created_at: '2025-03-15T00:00:00Z',
      }),
    ]);
    expect(await txRepo.getWatermark()).toBe('2025-03-15T00:00:00Z');
  });

  it('getLatestTransactionDate returns max(transaction_date) for the debug surface', async () => {
    expect(await txRepo.getLatestTransactionDate()).toBeNull();
    await txRepo.bulkInsert([
      mkTx({ fund_id: 'f1', transaction_date: '2024-01-01', transaction_type: 'purchase', units: 100, amount: 10000 }),
      mkTx({ fund_id: 'f1', transaction_date: '2024-06-01', transaction_type: 'purchase', units: 50, amount: 6000 }),
      mkTx({ fund_id: 'f2', transaction_date: '2024-03-01', transaction_type: 'purchase', units: 200, amount: 20000 }),
    ]);
    expect(await txRepo.getLatestTransactionDate()).toBe('2024-06-01');
  });

  it('clear empties the table', async () => {
    await txRepo.bulkInsert([
      mkTx({ fund_id: 'f1', transaction_date: '2024-01-01', transaction_type: 'purchase', units: 100, amount: 10000 }),
    ]);
    expect(await txRepo.count()).toBe(1);
    await txRepo.clear();
    expect(await txRepo.count()).toBe(0);
  });

  it('bulkInsert on empty rows is a no-op', async () => {
    await txRepo.bulkInsert([]);
    expect(await txRepo.count()).toBe(0);
  });

  it('readAll returns the new metadata columns (id, nav_at_transaction, folio_number, etc.)', async () => {
    await txRepo.bulkInsert([
      {
        fund_id: 'f1',
        transaction_date: '2024-01-01',
        transaction_type: 'purchase',
        units: 100,
        amount: 10000,
        id: 'tx-uuid-1',
        nav_at_transaction: 100,
        folio_number: 'FOL-001',
        cas_import_id: 'cas-1',
        created_at: '2024-01-01T10:00:00Z',
      },
    ]);
    const rows = await txRepo.readAll();
    expect(rows[0].id).toBe('tx-uuid-1');
    expect(rows[0].nav_at_transaction).toBe(100);
    expect(rows[0].folio_number).toBe('FOL-001');
    expect(rows[0].cas_import_id).toBe('cas-1');
    expect(rows[0].created_at).toBe('2024-01-01T10:00:00Z');
  });
});

describe('nav repo', () => {
  it('bulkInsert + readBySchemeCodes', async () => {
    await navRepo.bulkInsert([
      { scheme_code: 100, nav_date: '2024-01-01', nav: 10 },
      { scheme_code: 100, nav_date: '2024-01-02', nav: 11 },
      { scheme_code: 200, nav_date: '2024-01-01', nav: 20 },
    ]);
    const rows = await navRepo.readBySchemeCodes([100]);
    expect(rows).toHaveLength(2);
    const all = await navRepo.readBySchemeCodes([100, 200]);
    expect(all).toHaveLength(3);
  });

  it('readBySchemeCodes returns [] for empty input', async () => {
    expect(await navRepo.readBySchemeCodes([])).toEqual([]);
  });

  it('readBySchemeCodes with sinceDate filters rows', async () => {
    await navRepo.bulkInsert([
      { scheme_code: 100, nav_date: '2024-01-01', nav: 10 },
      { scheme_code: 100, nav_date: '2024-06-01', nav: 12 },
      { scheme_code: 100, nav_date: '2024-12-01', nav: 14 },
    ]);
    const rows = await navRepo.readBySchemeCodes([100], { sinceDate: '2024-06-01' });
    expect(rows).toHaveLength(2);
    expect(rows[0].nav_date).toBe('2024-06-01');
  });

  it('readBySchemeCode (singular) returns rows for one scheme', async () => {
    await navRepo.bulkInsert([
      { scheme_code: 100, nav_date: '2024-01-01', nav: 10 },
      { scheme_code: 100, nav_date: '2024-01-02', nav: 11 },
    ]);
    const rows = await navRepo.readBySchemeCode(100, { orderDesc: true, limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].nav_date).toBe('2024-01-02');
  });

  it('getWatermark is per-scheme', async () => {
    await navRepo.bulkInsert([
      { scheme_code: 100, nav_date: '2024-01-01', nav: 10 },
      { scheme_code: 200, nav_date: '2024-06-01', nav: 20 },
    ]);
    expect(await navRepo.getWatermark(100)).toBe('2024-01-01');
    expect(await navRepo.getWatermark(200)).toBe('2024-06-01');
    expect(await navRepo.getWatermark(300)).toBeNull();
  });

  it('clear empties nav', async () => {
    await navRepo.bulkInsert([{ scheme_code: 100, nav_date: '2024-01-01', nav: 10 }]);
    expect(await navRepo.count()).toBe(1);
    await navRepo.clear();
    expect(await navRepo.count()).toBe(0);
  });

  it('countBySchemeCode returns per-scheme row count for the debug surface', async () => {
    await navRepo.bulkInsert([
      { scheme_code: 100, nav_date: '2024-01-01', nav: 10 },
      { scheme_code: 100, nav_date: '2024-06-01', nav: 12 },
      { scheme_code: 200, nav_date: '2024-01-01', nav: 20 },
    ]);
    expect(await navRepo.countBySchemeCode(100)).toBe(2);
    expect(await navRepo.countBySchemeCode(200)).toBe(1);
    expect(await navRepo.countBySchemeCode(300)).toBe(0);
  });
});

describe('idx repo', () => {
  it('bulkInsert + readBySymbol', async () => {
    await idxRepo.bulkInsert([
      { index_symbol: '^NSEI', index_date: '2024-01-01', close_value: 100 },
      { index_symbol: '^NSEI', index_date: '2024-06-01', close_value: 110 },
    ]);
    const rows = await idxRepo.readBySymbol('^NSEI');
    expect(rows).toHaveLength(2);
    expect(rows[0].index_date).toBe('2024-01-01');
  });

  it('readBySymbol with sinceDate', async () => {
    await idxRepo.bulkInsert([
      { index_symbol: '^NSEI', index_date: '2024-01-01', close_value: 100 },
      { index_symbol: '^NSEI', index_date: '2024-06-01', close_value: 110 },
    ]);
    const rows = await idxRepo.readBySymbol('^NSEI', { sinceDate: '2024-06-01' });
    expect(rows).toHaveLength(1);
  });

  it('getWatermark per symbol', async () => {
    await idxRepo.bulkInsert([
      { index_symbol: '^NSEI', index_date: '2024-01-01', close_value: 100 },
      { index_symbol: '^BSESN', index_date: '2024-06-01', close_value: 60000 },
    ]);
    expect(await idxRepo.getWatermark('^NSEI')).toBe('2024-01-01');
    expect(await idxRepo.getWatermark('^BSESN')).toBe('2024-06-01');
    expect(await idxRepo.getWatermark('^UNKNOWN')).toBeNull();
  });

  it('clear empties idx', async () => {
    await idxRepo.bulkInsert([
      { index_symbol: '^NSEI', index_date: '2024-01-01', close_value: 100 },
    ]);
    expect(await idxRepo.count()).toBe(1);
    await idxRepo.clear();
    expect(await idxRepo.count()).toBe(0);
  });

  it('countBySymbol returns per-index row count for the debug surface', async () => {
    await idxRepo.bulkInsert([
      { index_symbol: '^NSEI', index_date: '2024-01-01', close_value: 100 },
      { index_symbol: '^NSEI', index_date: '2024-06-01', close_value: 110 },
      { index_symbol: '^BSESN', index_date: '2024-06-01', close_value: 60000 },
    ]);
    expect(await idxRepo.countBySymbol('^NSEI')).toBe(2);
    expect(await idxRepo.countBySymbol('^BSESN')).toBe(1);
    expect(await idxRepo.countBySymbol('^UNKNOWN')).toBe(0);
  });
});

describe('syncState repo', () => {
  it('upsert + read', async () => {
    expect(await syncStateRepo.read('tx:user-1')).toBeNull();
    await syncStateRepo.upsert('tx:user-1', '2024-06-01T00:00:00Z', '2024-05-30');
    const row = await syncStateRepo.read('tx:user-1');
    expect(row?.scope).toBe('tx:user-1');
    expect(row?.last_synced_at).toBe('2024-06-01T00:00:00Z');
    expect(row?.watermark_date).toBe('2024-05-30');
  });

  it('upsert overwrites an existing scope', async () => {
    await syncStateRepo.upsert('tx:user-1', '2024-01-01T00:00:00Z', '2024-01-01');
    await syncStateRepo.upsert('tx:user-1', '2024-06-01T00:00:00Z', '2024-05-30');
    const row = await syncStateRepo.read('tx:user-1');
    expect(row?.last_synced_at).toBe('2024-06-01T00:00:00Z');
  });

  it('clear empties sync_state', async () => {
    await syncStateRepo.upsert('tx:user-1', '2024-01-01T00:00:00Z', null);
    expect(await syncStateRepo.read('tx:user-1')).not.toBeNull();
    await syncStateRepo.clear();
    expect(await syncStateRepo.read('tx:user-1')).toBeNull();
  });

  it('readAll returns every scope sorted by last_synced_at descending', async () => {
    await syncStateRepo.upsert('tx:user-1', '2024-06-01T00:00:00Z', '2024-05-30');
    await syncStateRepo.upsert('nav:100', '2024-08-01T00:00:00Z', '2024-07-30');
    await syncStateRepo.upsert('idx:^NSEI', '2024-07-01T00:00:00Z', '2024-06-30');

    const rows = await syncStateRepo.readAll();
    expect(rows).toHaveLength(3);
    expect(rows[0].scope).toBe('nav:100');     // newest
    expect(rows[1].scope).toBe('idx:^NSEI');   // middle
    expect(rows[2].scope).toBe('tx:user-1');   // oldest
  });
});

describe('db.dropAndRecreate', () => {
  it('clears every table and restamps the schema version', async () => {
    await txRepo.bulkInsert([
      mkTx({ fund_id: 'f1', transaction_date: '2024-01-01', transaction_type: 'purchase', units: 100, amount: 10000 }),
    ]);
    await navRepo.bulkInsert([{ scheme_code: 100, nav_date: '2024-01-01', nav: 10 }]);
    await idxRepo.bulkInsert([
      { index_symbol: '^NSEI', index_date: '2024-01-01', close_value: 100 },
    ]);
    await syncStateRepo.upsert('tx:user-1', '2024-01-01T00:00:00Z', '2024-01-01');

    await dropAndRecreate();

    expect(await txRepo.count()).toBe(0);
    expect(await navRepo.count()).toBe(0);
    expect(await idxRepo.count()).toBe(0);
    expect(await syncStateRepo.read('tx:user-1')).toBeNull();
  });
});
