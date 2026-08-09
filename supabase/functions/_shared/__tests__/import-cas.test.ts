import {
  countParsedTransactions,
  normaliseTxType,
  parseDate,
  importCASData,
  type CASParseResult,
  type CASTransaction,
  type SupabaseClient,
} from '../import-cas';

// ---------------------------------------------------------------------------
// Mock Supabase client builder
// ---------------------------------------------------------------------------

/**
 * Builds a chainable mock SupabaseClient.
 *
 * Tracks:
 *  - `deleteCalls`  — each array is the ordered [col, val] pairs passed to
 *                     .eq() on a single delete chain (one entry per reversal).
 *  - `upsertedRows` — the rows array passed to the transaction .upsert() call.
 *  - `fundUpdateCalls` — args passed to user_fund .update() (inactive marking)
 */
function buildMockSupabase({
  fundId = 'fund-id-1',
  benchmarkRows = [],
  schemeMasterError = null,
  txUpsertError = null,
  txUpsertCount,
}: {
  fundId?: string;
  benchmarkRows?: Array<{
    scheme_category: string;
    benchmark_index: string;
    benchmark_index_symbol: string;
  }>;
  schemeMasterError?: { message: string } | null;
  txUpsertError?: { message: string } | null;
  txUpsertCount?: number | null;
} = {}) {
  const deleteCalls: Array<Array<[string, unknown]>> = [];
  let upsertedRows: Record<string, unknown>[] = [];
  let upsertedSchemeRow: Record<string, unknown> | null = null;
  const fundUpdateCalls: Array<Record<string, unknown>> = [];

  function makeDeleteChain(): Record<string, unknown> {
    const eqLog: Array<[string, unknown]> = [];
    deleteCalls.push(eqLog);

    const chain: Record<string, unknown> = {};
    chain['eq'] = jest.fn((col: string, val: unknown) => {
      eqLog.push([col, val]);
      return chain;
    });
    return chain;
  }

  const deleteMock = jest.fn(() => makeDeleteChain());

  const txUpsertMock = jest.fn((rows: Record<string, unknown>[]) => {
    upsertedRows = rows;
    return {
      error: txUpsertError,
      count: txUpsertError
        ? null
        : txUpsertCount === undefined
          ? rows.length
          : txUpsertCount,
    };
  });

  const singleMock = jest.fn(() => ({ data: { id: fundId }, error: null }));
  const userFundSelectMock = jest.fn(() => ({ single: singleMock }));
  const userFundUpsertMock = jest.fn(() => ({ select: userFundSelectMock }));
  const userFundUpdateMock = jest.fn((data: Record<string, unknown>) => {
    fundUpdateCalls.push(data);
    return { eq: jest.fn(() => ({ error: null })) };
  });
  const schemeMasterUpsertMock = jest.fn((row: Record<string, unknown>) => {
    upsertedSchemeRow = row;
    return { error: schemeMasterError };
  });

  const benchmarkSelectMock = jest.fn(() => ({ data: benchmarkRows }));

  const fromMock = jest.fn((table: string) => {
    if (table === 'benchmark_mapping') return { select: benchmarkSelectMock };
    if (table === 'scheme_master') return { upsert: schemeMasterUpsertMock };
    if (table === 'user_fund') return { upsert: userFundUpsertMock, update: userFundUpdateMock };
    if (table === 'transaction') return { delete: deleteMock, upsert: txUpsertMock };
    return {};
  });

  return {
    supabase: { from: fromMock } as unknown as SupabaseClient,
    fromMock,
    deleteMock,
    deleteCalls,
    txUpsertMock,
    userFundUpdateMock,
    fundUpdateCalls,
    getUpsertedRows: () => upsertedRows,
    getUpsertedSchemeRow: () => upsertedSchemeRow,
  };
}

// ---------------------------------------------------------------------------
// Minimal CAS payload helpers
// ---------------------------------------------------------------------------

function minimalCAS(transactions: CASTransaction[]): CASParseResult {
  return {
    mutual_funds: [{
      folio_number: '12345678/01',
      amc: 'DSP Mutual Fund',
      schemes: [{
        name: 'DSP Small Cap Fund - Regular Plan - Growth',
        isin: 'INF740K01601',
        type: 'Equity',
        additional_info: { amfi: '119551' },
        transactions,
      }],
    }],
  };
}

function minimalCASWithUnits(units: number, transactions: CASTransaction[]): CASParseResult {
  return {
    mutual_funds: [{
      folio_number: '12345678/01',
      amc: 'DSP Mutual Fund',
      schemes: [{
        name: 'DSP Small Cap Fund - Regular Plan - Growth',
        isin: 'INF740K01601',
        type: 'Equity',
        units,
        additional_info: { amfi: '119551' },
        transactions,
      }],
    }],
  };
}

// ===========================================================================
// normaliseTxType()
// ===========================================================================

describe('normaliseTxType()', () => {
  // ── Purchase types ─────────────────────────────────────────────────────────
  describe('purchase types', () => {
    it.each([
      ['PURCHASE', 'purchase'],
      ['PURCHASE_SIP', 'purchase'],
      ['purchase', 'purchase'],
      ['buy', 'purchase'],
      ['sip', 'purchase'],
      ['Buy', 'purchase'],
    ])('maps %s → %s', (input, expected) => {
      expect(normaliseTxType(input)).toBe(expected);
    });
  });

  // ── Redemption types ───────────────────────────────────────────────────────
  describe('redemption types', () => {
    it.each([
      ['REDEMPTION', 'redemption'],
      ['redemption', 'redemption'],
      ['withdrawal', 'redemption'],
      ['partial redemption', 'redemption'],
    ])('maps %s → %s', (input, expected) => {
      expect(normaliseTxType(input)).toBe(expected);
    });
  });

  // ── Switch types ───────────────────────────────────────────────────────────
  describe('switch types', () => {
    it.each([
      ['SWITCH_IN', 'switch_in'],
      ['SWITCH_IN_MERGER', 'switch_in'],
      ['switch in to growth', 'switch_in'],
      ['SWITCH_OUT', 'switch_out'],
      ['SWITCH_OUT_MERGER', 'switch_out'],
      ['switch out to direct', 'switch_out'],
    ])('maps %s → %s', (input, expected) => {
      expect(normaliseTxType(input)).toBe(expected);
    });
  });

  // ── Dividend types ─────────────────────────────────────────────────────────
  describe('dividend types', () => {
    it.each([
      ['DIVIDEND_REINVEST', 'dividend_reinvest'],
      ['dividend reinvest', 'dividend_reinvest'],
      ['DIVIDEND_PAYOUT', 'dividend'],
      ['dividend payout', 'dividend'],
      ['dividend', 'dividend'],
    ])('maps %s → %s', (input, expected) => {
      expect(normaliseTxType(input)).toBe(expected);
    });
  });

  // ── Types that must return null (skipped, not imported) ───────────────────
  describe('non-actionable types → null', () => {
    it.each([
      'REVERSAL',
      'SEGREGATION',
      'STAMP_DUTY_TAX',
      'TDS_TAX',
      'STT_TAX',
      'MISC',
      'UNKNOWN',
    ])('maps %s → null', (input) => {
      expect(normaliseTxType(input)).toBeNull();
    });

    it('maps REVERSAL case-insensitively to null', () => {
      expect(normaliseTxType('reversal')).toBeNull();
      expect(normaliseTxType('Reversal')).toBeNull();
    });

    it('maps an empty string → null (not purchase)', () => {
      expect(normaliseTxType('')).toBeNull();
    });

    it('maps a completely unrecognised string → null (not purchase)', () => {
      expect(normaliseTxType('SOME_FUTURE_TYPE')).toBeNull();
      expect(normaliseTxType('bonus_units')).toBeNull();
    });
  });
});

// ===========================================================================
// countParsedTransactions()
// ===========================================================================

describe('countParsedTransactions()', () => {
  it('counts transactions across folios and schemes', () => {
    const parsed = {
      mutual_funds: [
        {
          schemes: [
            { transactions: [{ type: 'PURCHASE' }, { type: 'REDEMPTION' }] },
            { transactions: [{ type: 'PURCHASE_SIP' }] },
          ],
        },
        {
          schemes: [{ transactions: [] }],
        },
      ],
    };

    expect(countParsedTransactions(parsed as CASParseResult)).toBe(3);
  });

  it('returns zero when folios, schemes, or transaction arrays are missing', () => {
    expect(countParsedTransactions({})).toBe(0);
    expect(countParsedTransactions({ mutual_funds: [{}] })).toBe(0);
    expect(countParsedTransactions({ mutual_funds: [{ schemes: [{}] }] })).toBe(0);
  });
});

// ===========================================================================
// parseDate()
// ===========================================================================

describe('parseDate()', () => {
  it('passes through an ISO date unchanged', () => {
    expect(parseDate('2024-01-15')).toBe('2024-01-15');
    expect(parseDate('2023-12-31')).toBe('2023-12-31');
  });

  it.each([
    ['15-Jan-2024', '2024-01-15'],
    ['01-Feb-2023', '2023-02-01'],
    ['28-Mar-2022', '2022-03-28'],
    ['05-Apr-2021', '2021-04-05'],
    ['31-May-2020', '2020-05-31'],
    ['30-Jun-2019', '2019-06-30'],
    ['04-Jul-2018', '2018-07-04'],
    ['15-Aug-2017', '2017-08-15'],
    ['01-Sep-2016', '2016-09-01'],
    ['10-Oct-2015', '2015-10-10'],
    ['11-Nov-2014', '2014-11-11'],
    ['25-Dec-2013', '2013-12-25'],
  ])('converts DD-MMM-YYYY %s → %s', (input, expected) => {
    expect(parseDate(input)).toBe(expected);
  });

  it('handles DD-MMM-YYYY case-insensitively', () => {
    expect(parseDate('15-JAN-2024')).toBe('2024-01-15');
    expect(parseDate('15-jan-2024')).toBe('2024-01-15');
  });

  it('keeps an empty date empty so preflight can reject it', () => {
    expect(parseDate('')).toBe('');
  });

  it('passes through an unrecognised raw date unchanged', () => {
    expect(parseDate('15/01/2024')).toBe('15/01/2024');
  });
});

// ===========================================================================
// importCASData() — integration with mocked SupabaseClient
// ===========================================================================

describe('importCASData()', () => {
  beforeEach(() => jest.clearAllMocks());

  // ── Happy-path: normal purchase ────────────────────────────────────────────

  it('imports a normal purchase with correct type, units and amount', async () => {
    const { supabase, getUpsertedRows } = buildMockSupabase();

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    const rows = getUpsertedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].transaction_type).toBe('purchase');
    expect(rows[0].units).toBe(100);
    expect(rows[0].amount).toBe(10000);
    expect(rows[0].transaction_date).toBe('2024-01-10');
  });

  it('uses benchmark mapping when the scheme category is present', async () => {
    const { supabase, getUpsertedSchemeRow } = buildMockSupabase({
      benchmarkRows: [
        {
          scheme_category: 'Equity',
          benchmark_index: 'Nifty 100',
          benchmark_index_symbol: '^NIFTY100',
        },
      ],
    });

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(getUpsertedSchemeRow()).toMatchObject({
      scheme_code: 119551,
      scheme_name: 'DSP Small Cap Fund - Regular Plan - Growth',
      scheme_category: 'Equity',
      benchmark_index: 'Nifty 100',
      benchmark_index_symbol: '^NIFTY100',
    });
  });

  it('applies Math.abs to negative units and amounts from the CAS', async () => {
    const { supabase, getUpsertedRows } = buildMockSupabase();

    const parsed = minimalCAS([
      { date: '2024-03-01', type: 'REDEMPTION', units: -50, amount: -6000, nav: 120 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    const rows = getUpsertedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].units).toBe(50);
    expect(rows[0].amount).toBe(6000);
    expect(rows[0].transaction_type).toBe('redemption');
  });

  // ── REVERSAL handling ──────────────────────────────────────────────────────
  // casparser often returns REVERSAL rows with null units (the original bug).
  // The fix: match on amount (always present) instead of units; exclude both
  // the REVERSAL row AND its paired PURCHASE from the transaction upsert.

  it('excludes both REVERSAL and its paired PURCHASE from the upserted rows', async () => {
    const { supabase, txUpsertMock } = buildMockSupabase();

    // Realistic case: purchase + reversal on the same date, same amount magnitude
    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 155, amount: 24999, nav: 161 },
      { date: '2024-01-10', type: 'REVERSAL', units: -155, amount: -24999, nav: 161 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    // No transaction rows should be upserted — both sides of the reversal are excluded
    expect(txUpsertMock).not.toHaveBeenCalled();
  });

  it('key fix: REVERSAL with null units still excludes its paired PURCHASE via amount-based match', async () => {
    // This was the original phantom-units bug: casparser returns null units for
    // REVERSAL rows, so the old code's `if (revUnits > 0)` guard skipped both the
    // deletion and the redemption-import — leaving the PURCHASE as a phantom holding.
    const { supabase, deleteMock, deleteCalls, txUpsertMock } = buildMockSupabase();

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 155, amount: 24999, nav: 161 },
      { date: '2024-01-10', type: 'REVERSAL', units: undefined, amount: -24999, nav: 161 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    // Deletion must still fire (amount-based, not unit-based)
    expect(deleteMock).toHaveBeenCalledTimes(1);
    const eqPairs = deleteCalls[0];
    expect(eqPairs).toContainEqual(['transaction_type', 'purchase']);
    expect(eqPairs).toContainEqual(['amount', 24999]);

    // No transaction rows upserted — paired purchase is excluded
    expect(txUpsertMock).not.toHaveBeenCalled();
  });

  it('delete chain matches on date and amount (not units) to handle null-unit reversals', async () => {
    const { supabase, deleteMock, deleteCalls } = buildMockSupabase();

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      { date: '2024-01-10', type: 'REVERSAL', units: -100, amount: -10000, nav: 100 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(deleteMock).toHaveBeenCalledTimes(1);
    const eqPairs = deleteCalls[0];
    expect(eqPairs).toContainEqual(['fund_id', 'fund-id-1']);
    expect(eqPairs).toContainEqual(['transaction_date', '2024-01-10']);
    expect(eqPairs).toContainEqual(['transaction_type', 'purchase']);
    expect(eqPairs).toContainEqual(['amount', 10000]);
    // Units NOT part of the delete key — amount alone is sufficient
    const colNames = eqPairs.map(([col]) => col);
    expect(colNames).not.toContain('units');
  });

  it('issues one delete per REVERSAL when multiple reversals are present', async () => {
    const { supabase, deleteMock } = buildMockSupabase();

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      { date: '2024-01-10', type: 'REVERSAL', units: -100, amount: -10000, nav: 100 },
      { date: '2024-02-05', type: 'PURCHASE', units: 50, amount: 6000, nav: 120 },
      { date: '2024-02-05', type: 'REVERSAL', units: undefined, amount: -6000, nav: 120 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(deleteMock).toHaveBeenCalledTimes(2);
  });

  it('does not exclude a purchase that is not paired with any reversal', async () => {
    const { supabase, getUpsertedRows } = buildMockSupabase();

    // Real purchase on 01-Jan; reversal on 05-Mar of a different purchase
    const parsed = minimalCAS([
      { date: '2024-01-01', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 }, // ← kept
      { date: '2024-03-05', type: 'PURCHASE', units: 50, amount: 6000, nav: 120 },   // ← excluded
      { date: '2024-03-05', type: 'REVERSAL', units: undefined, amount: -6000, nav: 120 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    const rows = getUpsertedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].transaction_date).toBe('2024-01-01');
    expect(rows[0].transaction_type).toBe('purchase');
  });

  it('does not issue a delete when there are no REVERSALs', async () => {
    const { supabase, deleteMock } = buildMockSupabase();

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      { date: '2024-06-01', type: 'REDEMPTION', units: 50, amount: 7000, nav: 140 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(deleteMock).not.toHaveBeenCalled();
  });

  // ── Inactive-fund marking when closing units = 0 ──────────────────────────

  it('marks fund inactive when closing units are 0 and all transactions are reversed', async () => {
    const { supabase, userFundUpdateMock, txUpsertMock, fundUpdateCalls } = buildMockSupabase();

    // Closing balance 0 + all transactions are a reversal pair → never actually owned
    const parsed = minimalCASWithUnits(0, [
      { date: '2024-01-10', type: 'PURCHASE', units: 155, amount: 24999, nav: 161 },
      { date: '2024-01-10', type: 'REVERSAL', units: undefined, amount: -24999, nav: 161 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(userFundUpdateMock).toHaveBeenCalledTimes(1);
    expect(fundUpdateCalls[0]).toMatchObject({ is_active: false });
    // No transaction upsert should happen
    expect(txUpsertMock).not.toHaveBeenCalled();
  });

  it('does NOT mark inactive when closing units are 0 but real transactions exist (full redemption)', async () => {
    const { supabase, userFundUpdateMock, getUpsertedRows } = buildMockSupabase();

    // Fully redeemed fund: real purchase + real redemption, closing = 0
    const parsed = minimalCASWithUnits(0, [
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      { date: '2024-06-01', type: 'REDEMPTION', units: 100, amount: 14000, nav: 140 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    // Real transactions remain → is_active NOT set to false
    expect(userFundUpdateMock).not.toHaveBeenCalled();
    expect(getUpsertedRows()).toHaveLength(2);
  });

  it('does NOT mark inactive when mf.units is undefined (no closing balance in CAS)', async () => {
    const { supabase, userFundUpdateMock } = buildMockSupabase();

    // No units field — should not trigger inactive marking
    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(userFundUpdateMock).not.toHaveBeenCalled();
  });

  // ── Null-type filtering ────────────────────────────────────────────────────

  it.each([
    ['STAMP_DUTY_TAX', 0, 5],
    ['TDS_TAX', 0, 120],
    ['STT_TAX', 0, 8],
    ['MISC', 0, 0],
    ['SEGREGATION', 10, 0],   // non-zero units — must still be skipped
    ['REVERSAL', 100, 10000], // REVERSAL with no paired purchase — excluded by type filter
  ])('filters out %s transactions (null type, never imported)', async (type, units, amount) => {
    const { supabase, getUpsertedRows } = buildMockSupabase();

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      { date: '2024-01-10', type, units, amount, nav: 0 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    const rows = getUpsertedRows();
    expect(rows.every((r) => r.transaction_type !== null)).toBe(true);
  });

  it('rejects an unknown transaction type before any domain operation', async () => {
    const { supabase, fromMock } = buildMockSupabase();

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      { date: '2024-01-10', type: 'UNKNOWN', units: 0, amount: 0, nav: 0 },
    ]);

    await expect(importCASData(supabase, 'user-1', 'import-1', parsed))
      .rejects.toMatchObject({ reason: 'unsupported_transaction_type' });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('rejects zero-unit transactions before any domain operation', async () => {
    const { supabase, fromMock } = buildMockSupabase();

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      { date: '2024-01-10', type: 'PURCHASE', units: 0, amount: 0, nav: 100 },
    ]);

    await expect(importCASData(supabase, 'user-1', 'import-1', parsed))
      .rejects.toMatchObject({ reason: 'invalid_amount' });
    expect(fromMock).not.toHaveBeenCalled();
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  it('rejects a scheme with no AMFI code before any domain operation', async () => {
    const { supabase, fromMock } = buildMockSupabase();

    const parsed: CASParseResult = {
      mutual_funds: [{
        folio_number: '12345678/01',
        amc: 'Unknown AMC',
        schemes: [{
          name: 'Unknown Fund',
          additional_info: {},   // no amfi key
          transactions: [
            { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
          ],
        }],
      }],
    };

    await expect(importCASData(supabase, 'user-1', 'import-1', parsed))
      .rejects.toMatchObject({ reason: 'missing_scheme_identity' });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('records an error when the fund upsert fails and continues to next scheme', async () => {
    const { supabase } = buildMockSupabase();

    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'benchmark_mapping') return { select: jest.fn(() => ({ data: [] })) };
      if (table === 'scheme_master') {
        return { upsert: jest.fn(() => ({ error: null })) };
      }
      if (table === 'user_fund') {
        return {
          upsert: jest.fn(() => ({
            select: jest.fn(() => ({
              single: jest.fn(() => ({ data: null, error: { message: 'DB error' } })),
            })),
          })),
          update: jest.fn(() => ({ eq: jest.fn(() => ({ error: null })) })),
        };
      }
      return {};
    });

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBe('cas_import:fund_write_failed');
    expect(result.fundsUpdated).toBe(0);
  });

  it('records an error when the shared scheme upsert fails and skips fund creation', async () => {
    const { supabase, fromMock } = buildMockSupabase({
      schemeMasterError: { message: 'scheme write failed' },
    });

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBe('cas_import:scheme_write_failed');
    expect(result.fundsUpdated).toBe(0);
    expect(fromMock).not.toHaveBeenCalledWith('user_fund');
  });

  it('records an error when transaction upsert fails after fund creation', async () => {
    const { supabase } = buildMockSupabase({
      txUpsertError: { message: 'transaction write failed' },
    });

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBe('cas_import:transaction_write_failed');
    expect(result.fundsUpdated).toBe(1);
    expect(result.transactionsAdded).toBe(0);
  });

  it('returns correct counts for funds and transactions', async () => {
    const { supabase } = buildMockSupabase();

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      { date: '2024-06-01', type: 'PURCHASE_SIP', units: 50, amount: 6000, nav: 120 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result.fundsUpdated).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it.each([null, 0])('reports zero inserted when exact upsert count is %s', async (txUpsertCount) => {
    const { supabase } = buildMockSupabase({ txUpsertCount });
    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result.transactionsAdded).toBe(0);
  });

  // ── Phantom rows: SWITCH_IN/SWITCH_OUT with units > 0 but amount = 0 ──────
  // casparser sometimes surfaces statement-level "balance forward" markers
  // as switch_in/switch_out with non-zero units but zero rupees. Importing
  // those creates phantom holdings — the user's home screen suddenly shows
  // funds they fully redeemed years ago, with absurd current values
  // (units * NAV with no offsetting cost basis → +159k% gain).

  it.each(['SWITCH_IN', 'SWITCH_OUT'])('rejects a phantom %s before any domain operation', async (type) => {
    const { supabase, fromMock } = buildMockSupabase();

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      // The phantom row — non-zero units, zero amount
      { date: '2026-07-02', type, units: 20, amount: 0, nav: 0 },
    ]);

    await expect(importCASData(supabase, 'user-1', 'import-1', parsed))
      .rejects.toMatchObject({ reason: 'invalid_amount' });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('rejects a phantom row with null amount before any domain operation', async () => {
    const { supabase, fromMock } = buildMockSupabase();

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      // amount: null → Math.abs(null ?? 0) = 0, must be dropped just like an explicit 0
      { date: '2024-06-01', type: 'SWITCH_IN', units: 200, amount: null as unknown as number, nav: 0 },
    ]);

    await expect(importCASData(supabase, 'user-1', 'import-1', parsed))
      .rejects.toMatchObject({ reason: 'invalid_amount' });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('preserves a real SWITCH_IN that has both units AND amount', async () => {
    const { supabase, getUpsertedRows } = buildMockSupabase();

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'SWITCH_IN', units: 100, amount: 12000, nav: 120 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    const rows = getUpsertedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].transaction_type).toBe('switch_in');
    expect(rows[0].amount).toBe(12000);
  });

  it('rejects a valid-plus-phantom mixed payload without partial writes', async () => {
    const { supabase, fromMock } = buildMockSupabase();

    // Fully synthetic same-day mixed input: one malformed row rejects the
    // complete payload even when the surrounding rows are coherent.
    const parsed = minimalCAS([
      { date: '2026-07-01', type: 'PURCHASE', units: 10, amount: 1000, nav: 100 },
      { date: '2026-07-02', type: 'SWITCH_IN', units: 20, amount: 0, nav: 0 },
      { date: '2026-07-02', type: 'SWITCH_OUT', units: 5, amount: 500, nav: 100 },
    ]);

    await expect(importCASData(supabase, 'user-1', 'import-1', parsed))
      .rejects.toMatchObject({ reason: 'invalid_amount' });
    expect(fromMock).not.toHaveBeenCalled();
  });
});
