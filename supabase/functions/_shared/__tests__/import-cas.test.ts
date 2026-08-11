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
  existingFundRows,
  existingSchemeRows = [{
    scheme_code: 119551,
    scheme_name: 'Authoritative DSP Small Cap Fund',
    scheme_category: 'Equity: Small Cap',
    benchmark_index: 'Nifty Smallcap 250 TRI',
  }],
  existingTransactionRows = [],
  fundReadError = null,
  transactionReadError = null,
  schemeMasterError = null,
  fundUpsertError = null,
  txUpsertError = null,
  txUpsertCount,
  txDeleteError = null,
  schemaCapabilityError = null,
  rpcMutationError = null,
}: {
  fundId?: string;
  existingFundRows?: Array<Record<string, unknown>>;
  existingSchemeRows?: Array<Record<string, unknown>>;
  existingTransactionRows?: Array<Record<string, unknown>>;
  fundReadError?: { message: string } | null;
  transactionReadError?: { message: string } | null;
  schemeMasterError?: { message: string } | null;
  fundUpsertError?: { message: string } | null;
  txUpsertError?: { message: string } | null;
  txUpsertCount?: number | null;
  txDeleteError?: { message: string } | null;
  schemaCapabilityError?: { message: string } | null;
  rpcMutationError?: { message: string } | null;
} = {}) {
  const deleteCalls: Array<Array<[string, unknown]>> = [];
  let upsertedRows: Record<string, unknown>[] = [];
  let upsertedSchemeRow: Record<string, unknown> | null = null;
  const fundUpdateCalls: Array<Record<string, unknown>> = [];
  const storedTransactions = [...existingTransactionRows];
  const storedFunds = existingFundRows ?? [{ id: fundId, user_id: 'user-1', scheme_code: 119551 }];
  const storedSchemes = existingSchemeRows.map((row) => ({ ...row }));

  function makeDeleteChain(): Record<string, unknown> {
    const eqLog: Array<[string, unknown]> = [];
    deleteCalls.push(eqLog);

    const chain: Record<string, unknown> = {};
    chain['error'] = txDeleteError;
    chain['eq'] = jest.fn((col: string, val: unknown) => {
      eqLog.push([col, val]);
      return chain;
    });
    return chain;
  }

  const deleteMock = jest.fn(() => makeDeleteChain());

  const txUpsertMock = jest.fn((
    rows: Record<string, unknown>[],
    _options?: Record<string, unknown>,
  ) => {
    upsertedRows = rows;
    const count = txUpsertError
      ? null
      : txUpsertCount === undefined
        ? rows.length
        : txUpsertCount;
    if (!txUpsertError && (count ?? 0) > 0) {
      const firstId = storedTransactions.length + 1;
      rows.forEach((row, index) => storedTransactions.push({
        id: `inserted-${firstId + index}`,
        ...row,
      }));
    }
    return {
      error: txUpsertError,
      count,
    };
  });

  const singleMock = jest.fn(() => ({
    data: fundUpsertError ? null : { id: fundId },
    error: fundUpsertError,
  }));
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

  const existingFundSelectMock = jest.fn(() => {
    let requestedUserId: unknown = null;
    const chain: { eq: jest.Mock; in: jest.Mock } = {
      eq: jest.fn(),
      in: jest.fn(),
    };
    chain.eq.mockImplementation((column: string, value: unknown) => {
      if (column === 'user_id') requestedUserId = value;
      return chain;
    });
    chain.in.mockImplementation((_column: string, values: unknown[]) => ({
      data: storedFunds.filter((row) =>
        (row.user_id ?? 'user-1') === requestedUserId
        && values.includes(row.scheme_code)
      ),
      error: fundReadError,
    }));
    return chain;
  });
  const existingTransactionRangeMock = jest.fn((from: number, to: number) => ({
    data: storedTransactions.slice(from, to + 1),
    error: transactionReadError,
  }));
  const existingTransactionSelectMock = jest.fn(() => {
    const chain: { in: jest.Mock; order: jest.Mock; range: jest.Mock } = {
      in: jest.fn(),
      order: jest.fn(),
      range: existingTransactionRangeMock,
    };
    chain.in.mockImplementation(() => chain);
    chain.order.mockImplementation(() => chain);
    return chain;
  });

  const fromMock = jest.fn((table: string) => {
    if (table === 'scheme_master') return { upsert: schemeMasterUpsertMock };
    if (table === 'user_fund') {
      return {
        select: existingFundSelectMock,
        upsert: userFundUpsertMock,
        update: userFundUpdateMock,
      };
    }
    if (table === 'transaction') {
      return {
        select: existingTransactionSelectMock,
        delete: deleteMock,
        upsert: txUpsertMock,
      };
    }
    return {};
  });

  const rpcMock = jest.fn(async (
    functionName: string,
    args?: Record<string, unknown>,
  ) => {
    if (functionName === 'cas_import_schema_version_v2') {
      return {
        data: schemaCapabilityError ? null : 2,
        error: schemaCapabilityError,
      };
    }
    if (functionName !== 'apply_cas_import_plans_v2') {
      return { data: null, error: { message: 'unknown rpc' } };
    }

    const plans = (args?.p_plans ?? []) as Array<{
      scheme_code: number;
      provisional_scheme_name: string;
      expected_fund_id: string | null;
      expected_transaction_ids: string[];
      closing_units: number | null;
      delete_ids: string[];
      inserts: Record<string, unknown>[];
    }>;
    for (const plan of plans) {
      const currentFund = storedFunds.find((row) =>
        row.scheme_code === plan.scheme_code
        && (row.user_id ?? 'user-1') === args?.p_user_id
      );
      const currentFundId = typeof currentFund?.id === 'string' ? currentFund.id : null;
      if (currentFundId !== plan.expected_fund_id) {
        return { data: null, error: { message: 'cas_snapshot_conflict' } };
      }
      if (currentFundId === null) continue;
      const currentIds = storedTransactions
        .filter((row) => row.fund_id === currentFundId)
        .map((row) => String(row.id))
        .sort();
      if (JSON.stringify(currentIds) !== JSON.stringify([...plan.expected_transaction_ids].sort())) {
        return { data: null, error: { message: 'cas_snapshot_conflict' } };
      }
    }

    // The real RPC is one Postgres transaction. Injected failures are checked
    // before this mock mutates its shared state so tests prove all-or-nothing.
    if (
      rpcMutationError || schemeMasterError || fundUpsertError
      || txDeleteError || txUpsertError
    ) {
      return {
        data: null,
        error: rpcMutationError ?? schemeMasterError ?? fundUpsertError
          ?? txDeleteError ?? txUpsertError,
      };
    }

    let deletedCount = 0;
    let insertedCount = 0;
    let provisionalSchemeCount = 0;
    for (const plan of plans) {
      if (!storedSchemes.some((row) => row.scheme_code === plan.scheme_code)) {
        storedSchemes.push({
          scheme_code: plan.scheme_code,
          scheme_name: plan.provisional_scheme_name,
          scheme_category: null,
          benchmark_index: null,
          benchmark_index_symbol: null,
          cas_identity_created_at: '2026-08-11T00:00:00.000Z',
          cas_identity_hydrated_at: null,
        });
        provisionalSchemeCount++;
      }
      let currentFund = storedFunds.find((row) =>
        row.scheme_code === plan.scheme_code
        && (row.user_id ?? 'user-1') === args?.p_user_id
      );
      if (!currentFund) {
        currentFund = {
          id: storedFunds.length === 0 ? fundId : `fund-id-${storedFunds.length + 1}`,
          user_id: args?.p_user_id,
          scheme_code: plan.scheme_code,
          is_active: false,
        };
        storedFunds.push(currentFund);
      }
      const currentFundId = String(currentFund.id);
      for (const id of plan.delete_ids) {
        const chain = deleteMock() as { eq: (col: string, val: unknown) => unknown };
        chain.eq('id', id);
        chain.eq('fund_id', currentFundId);
        const index = storedTransactions.findIndex((row) =>
          row.id === id && row.fund_id === currentFundId
        );
        if (index >= 0) {
          storedTransactions.splice(index, 1);
          deletedCount++;
        }
      }
      if (plan.inserts.length > 0) {
        const rows = plan.inserts.map((row) => ({
          user_id: args?.p_user_id,
          fund_id: currentFundId,
          cas_import_id: args?.p_import_id,
          ...row,
        }));
        const response = txUpsertMock(rows);
        insertedCount += response.count ?? 0;
      }
      const isActive = plan.closing_units === null
        ? storedTransactions.some((row) => row.fund_id === currentFundId)
        : plan.closing_units > 0;
      currentFund.is_active = isActive;
      fundUpdateCalls.push({ id: currentFundId, is_active: isActive });
    }
    return {
      data: {
        fund_count: plans.length,
        inserted_count: insertedCount,
        deleted_count: deletedCount,
        provisional_scheme_count: provisionalSchemeCount,
      },
      error: null,
    };
  });

  return {
    supabase: { from: fromMock, rpc: rpcMock } as unknown as SupabaseClient,
    fromMock,
    deleteMock,
    deleteCalls,
    txUpsertMock,
    existingTransactionRangeMock,
    schemeMasterUpsertMock,
    userFundUpsertMock,
    userFundUpdateMock,
    fundUpdateCalls,
    storedTransactions,
    storedFunds,
    storedSchemes,
    rpcMock,
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

function storedPurchase(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'historical-purchase',
    fund_id: 'fund-id-1',
    transaction_date: '2024-01-10',
    transaction_type: 'purchase',
    units: 100,
    amount: 10000,
    folio_number: '12345678/01',
    cas_import_id: 'old-import',
    cas_event_ordinal: 0,
    ...overrides,
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

  it('does not let CAS name, category, or benchmark claims change an existing catalog row', async () => {
    const existingCatalog = {
      scheme_code: 119551,
      scheme_name: 'Authoritative Catalog Name',
      scheme_category: 'Equity: Small Cap',
      benchmark_index: 'Nifty Smallcap 250 TRI',
      benchmark_index_symbol: '^NIFTYSC250',
      cas_identity_created_at: null,
      cas_identity_hydrated_at: null,
    };
    const { supabase, storedSchemes, schemeMasterUpsertMock } = buildMockSupabase({
      existingSchemeRows: [existingCatalog],
    });
    const beforeDigest = JSON.stringify(storedSchemes);

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(JSON.stringify(storedSchemes)).toBe(beforeDigest);
    expect(schemeMasterUpsertMock).not.toHaveBeenCalled();
  });

  it('creates only a marked minimal identity for a missing scheme and converges on retry', async () => {
    const {
      supabase,
      storedSchemes,
      storedFunds,
      storedTransactions,
    } = buildMockSupabase({ existingFundRows: [], existingSchemeRows: [] });
    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    const first = await importCASData(supabase, 'user-1', 'import-1', parsed);
    const second = await importCASData(supabase, 'user-1', 'import-2', parsed);

    expect(first).toMatchObject({
      fundsUpdated: 1,
      transactionsAdded: 1,
      catalogHydrationRequested: 1,
      errors: [],
    });
    expect(second).toMatchObject({
      fundsUpdated: 1,
      transactionsAdded: 0,
      transactionsDuplicate: 1,
      catalogHydrationRequested: 0,
      errors: [],
    });
    expect(storedSchemes).toEqual([{
      scheme_code: 119551,
      scheme_name: 'DSP Small Cap Fund - Regular Plan - Growth',
      scheme_category: null,
      benchmark_index: null,
      benchmark_index_symbol: null,
      cas_identity_created_at: '2026-08-11T00:00:00.000Z',
      cas_identity_hydrated_at: null,
    }]);
    expect(storedFunds).toHaveLength(1);
    expect(storedFunds[0]).toMatchObject({ is_active: true });
    expect(storedTransactions).toHaveLength(1);
  });

  it('keeps one user CAS from changing the provisional catalog identity created by another user', async () => {
    const { supabase, storedSchemes, storedFunds } = buildMockSupabase({
      existingFundRows: [],
      existingSchemeRows: [],
    });
    const firstPayload = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 10, amount: 1000, nav: 100 },
    ]);
    await importCASData(supabase, 'user-1', 'import-1', firstPayload);
    const digestAfterFirstUser = JSON.stringify(storedSchemes);

    const secondPayload = minimalCAS([
      { date: '2024-02-10', type: 'PURCHASE', units: 20, amount: 2000, nav: 100 },
    ]);
    secondPayload.mutual_funds![0].schemes![0].name = 'Untrusted Cross-User Rename';
    secondPayload.mutual_funds![0].schemes![0].type = 'Other';
    const second = await importCASData(supabase, 'user-2', 'import-2', secondPayload);

    expect(JSON.stringify(storedSchemes)).toBe(digestAfterFirstUser);
    expect(second.catalogHydrationRequested).toBe(0);
    expect(storedFunds.filter((row) => row.scheme_code === 119551)).toHaveLength(2);
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

  it('persists gross cash and makes a charged re-import economically idempotent', async () => {
    const { supabase, txUpsertMock } = buildMockSupabase();
    const parsed = minimalCAS([{
      date: '2026-07-01',
      type: 'PURCHASE',
      amount: 1000,
      source_amount: 1000,
      gross_amount: 1000.05,
      stamp_duty: 0.05,
      charges: { stamp_duty: 0.05 },
      units: 10,
      nav: 100,
      price: 100.05,
    }]);

    const first = await importCASData(supabase, 'user-1', 'import-1', parsed);
    const second = await importCASData(supabase, 'user-1', 'import-2', parsed);

    expect(first.transactionsAdded).toBe(1);
    expect(second.transactionsAdded).toBe(0);
    expect(second.transactionsDuplicate).toBe(1);
    expect(txUpsertMock).toHaveBeenCalledTimes(1);
    for (const [rows] of txUpsertMock.mock.calls) {
      expect(rows[0]).toMatchObject({
        amount: 1000.05,
        nav_at_transaction: 100,
        cas_event_ordinal: 0,
      });
    }
  });

  // ── REVERSAL handling ──────────────────────────────────────────────────────
  // Every reversal is planned before mutation. Units disambiguate when they
  // exist; a cash-only reversal is safe only with one candidate.

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

  it('cash-only REVERSAL excludes its unique incoming PURCHASE without a database delete', async () => {
    const { supabase, deleteMock, txUpsertMock } = buildMockSupabase();

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 155, amount: 24999, nav: 161 },
      { date: '2024-01-10', type: 'REVERSAL', units: undefined, amount: -24999, nav: 161 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(deleteMock).not.toHaveBeenCalled();
    expect(txUpsertMock).not.toHaveBeenCalled();
  });

  it('uses gross cash consistently for a charged incoming reversal pair', async () => {
    const { supabase, deleteMock, txUpsertMock } = buildMockSupabase();
    const chargeFields = {
      gross_amount: 1000.05,
      stamp_duty: 0.05,
      charges: { stamp_duty: 0.05 },
      nav: 100,
      price: 100,
    };
    const parsed = minimalCAS([
      {
        date: '2024-01-10',
        type: 'PURCHASE',
        units: 10,
        amount: 1000,
        source_amount: 1000,
        ...chargeFields,
      },
      {
        date: '2024-01-10',
        type: 'REVERSAL',
        units: undefined,
        amount: -1000,
        source_amount: -1000,
        ...chargeFields,
      },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(deleteMock).not.toHaveBeenCalled();
    expect(txUpsertMock).not.toHaveBeenCalled();
  });

  it('deletes a uniquely matched historical reversal by exact transaction ID', async () => {
    const { supabase, deleteMock, deleteCalls } = buildMockSupabase({
      existingTransactionRows: [{
        id: 'historical-purchase',
        fund_id: 'fund-id-1',
        transaction_date: '2024-01-10',
        transaction_type: 'purchase',
        units: 100,
        amount: 10000,
        folio_number: '12345678/01',
        cas_import_id: 'old-import',
        cas_event_ordinal: 0,
      }],
    });

    const parsed = minimalCAS([
      { date: '2024-02-10', type: 'PURCHASE', units: 50, amount: 5000, nav: 100 },
      { date: '2024-01-10', type: 'REVERSAL', units: -100, amount: -10000, nav: 100 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(deleteMock).toHaveBeenCalledTimes(1);
    const eqPairs = deleteCalls[0];
    expect(eqPairs).toContainEqual(['id', 'historical-purchase']);
    expect(eqPairs).toContainEqual(['fund_id', 'fund-id-1']);
    const colNames = eqPairs.map(([col]) => col);
    expect(colNames).not.toContain('transaction_date');
    expect(colNames).not.toContain('transaction_type');
    expect(colNames).not.toContain('amount');
    expect(colNames).not.toContain('units');
  });

  it('issues one exact-ID delete per uniquely matched historical REVERSAL', async () => {
    const { supabase, deleteMock } = buildMockSupabase({
      existingTransactionRows: [
        {
          id: 'historical-1', fund_id: 'fund-id-1', transaction_date: '2024-01-10',
          transaction_type: 'purchase', units: 100, amount: 10000,
          folio_number: '12345678/01', cas_import_id: 'old-1', cas_event_ordinal: 0,
        },
        {
          id: 'historical-2', fund_id: 'fund-id-1', transaction_date: '2024-02-05',
          transaction_type: 'purchase', units: 50, amount: 6000,
          folio_number: '12345678/01', cas_import_id: 'old-2', cas_event_ordinal: 0,
        },
      ],
    });

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'REVERSAL', units: -100, amount: -10000, nav: 100 },
      { date: '2024-02-05', type: 'REVERSAL', units: -50, amount: -6000, nav: 120 },
      { date: '2024-03-05', type: 'PURCHASE', units: 10, amount: 1200, nav: 120 },
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

    expect(userFundUpdateMock).not.toHaveBeenCalled();
    expect(fundUpdateCalls[0]).toMatchObject({ is_active: false });
    // No transaction upsert should happen
    expect(txUpsertMock).not.toHaveBeenCalled();
  });

  it('marks a fully redeemed fund inactive from the complete zero closing balance', async () => {
    const { supabase, userFundUpdateMock, fundUpdateCalls, getUpsertedRows } = buildMockSupabase();

    // Fully redeemed fund: real purchase + real redemption, closing = 0
    const parsed = minimalCASWithUnits(0, [
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      { date: '2024-06-01', type: 'REDEMPTION', units: 100, amount: 14000, nav: 140 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    // Historical transactions remain, but a complete zero balance is stronger
    // evidence for current holding activation.
    expect(userFundUpdateMock).not.toHaveBeenCalled();
    expect(fundUpdateCalls[0]).toMatchObject({ is_active: false });
    expect(getUpsertedRows()).toHaveLength(2);
  });

  it('derives active state from committed transactions when closing balance is absent', async () => {
    const { supabase, userFundUpdateMock, fundUpdateCalls } = buildMockSupabase();

    // No units field — should not trigger inactive marking
    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(userFundUpdateMock).not.toHaveBeenCalled();
    expect(fundUpdateCalls[0]).toMatchObject({ is_active: true });
  });

  it('sums closing units for the same scheme across folios before inactivation', async () => {
    const { supabase, userFundUpdateMock, fundUpdateCalls } = buildMockSupabase();
    const parsed: CASParseResult = {
      mutual_funds: [
        {
          ...minimalCASWithUnits(10, [
            { date: '2024-01-10', type: 'PURCHASE', units: 10, amount: 1000, nav: 100 },
            { date: '2024-01-10', type: 'REVERSAL', amount: -1000 },
          ]).mutual_funds![0],
          folio_number: 'FOLIO-01',
        },
        {
          ...minimalCASWithUnits(0, [
            { date: '2024-02-10', type: 'PURCHASE', units: 20, amount: 2000, nav: 100 },
            { date: '2024-02-10', type: 'REVERSAL', amount: -2000 },
          ]).mutual_funds![0],
          folio_number: 'FOLIO-02',
        },
      ],
    };

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result.reconciliationConflicts).toBe(0);
    expect(userFundUpdateMock).not.toHaveBeenCalled();
    expect(fundUpdateCalls[0]).toMatchObject({ is_active: true });
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
      { date: '2024-01-10', type, units, amount, nav: type === 'REVERSAL' ? 100 : 0 },
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

  it('rolls back the atomic import when holding creation fails', async () => {
    const { supabase } = buildMockSupabase({
      fundUpsertError: { message: 'DB error' },
    });

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBe('cas_import:transaction_write_failed');
    expect(result.fundsUpdated).toBe(0);
  });

  it('rolls back the atomic import when provisional catalog creation fails', async () => {
    const { supabase, userFundUpsertMock } = buildMockSupabase({
      schemeMasterError: { message: 'scheme write failed' },
    });

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBe('cas_import:transaction_write_failed');
    expect(result.fundsUpdated).toBe(0);
    expect(userFundUpsertMock).not.toHaveBeenCalled();
  });

  it('leaves no provisional catalog or holding row when transaction insertion fails', async () => {
    const { supabase, storedSchemes, storedFunds } = buildMockSupabase({
      existingFundRows: [],
      existingSchemeRows: [],
      txUpsertError: { message: 'transaction write failed' },
    });

    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBe('cas_import:transaction_write_failed');
    expect(result.fundsUpdated).toBe(0);
    expect(result.transactionsAdded).toBe(0);
    expect(result.catalogHydrationRequested).toBe(0);
    expect(storedSchemes).toEqual([]);
    expect(storedFunds).toEqual([]);
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

  it('fails closed before domain access while the ordered schema migration is not ready', async () => {
    const { supabase, fromMock } = buildMockSupabase({
      schemaCapabilityError: { message: 'function does not exist' },
    });

    const result = await importCASData(
      supabase,
      'user-1',
      'import-1',
      minimalCAS([
        { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      ]),
    );

    expect(result.errors).toEqual(['cas_import:reconciliation_read_failed']);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('fails closed when the existing fund roster cannot be read', async () => {
    const { supabase, schemeMasterUpsertMock, userFundUpsertMock } = buildMockSupabase({
      fundReadError: { message: 'fund read failed' },
    });

    const result = await importCASData(
      supabase,
      'user-1',
      'import-1',
      minimalCAS([
        { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      ]),
    );

    expect(result.errors).toEqual(['cas_import:reconciliation_read_failed']);
    expect(schemeMasterUpsertMock).not.toHaveBeenCalled();
    expect(userFundUpsertMock).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed resolved fund row before every domain write', async () => {
    const { supabase, schemeMasterUpsertMock, userFundUpsertMock } = buildMockSupabase({
      existingFundRows: [{ id: 123, scheme_code: 119551 }],
    });

    const result = await importCASData(
      supabase,
      'user-1',
      'import-1',
      minimalCAS([
        { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      ]),
    );

    expect(result.errors).toEqual(['cas_import:reconciliation_read_failed']);
    expect(schemeMasterUpsertMock).not.toHaveBeenCalled();
    expect(userFundUpsertMock).not.toHaveBeenCalled();
  });

  it('fails closed when historical reconciliation rows cannot be read', async () => {
    const {
      supabase,
      schemeMasterUpsertMock,
      userFundUpsertMock,
      deleteMock,
      txUpsertMock,
    } = buildMockSupabase({
      transactionReadError: { message: 'read failed' },
    });
    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result).toEqual({
      fundsUpdated: 0,
      transactionsAdded: 0,
      transactionsDuplicate: 0,
      reconciliationConflicts: 0,
      catalogHydrationRequested: 0,
      errors: ['cas_import:reconciliation_read_failed'],
    });
    expect(schemeMasterUpsertMock).not.toHaveBeenCalled();
    expect(userFundUpsertMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(txUpsertMock).not.toHaveBeenCalled();
  });

  it('fails closed on a structurally malformed historical transaction row', async () => {
    const {
      supabase,
      schemeMasterUpsertMock,
      userFundUpsertMock,
      txUpsertMock,
    } = buildMockSupabase({
      existingTransactionRows: [storedPurchase({ id: 123 })],
    });

    const result = await importCASData(
      supabase,
      'user-1',
      'import-1',
      minimalCAS([
        { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      ]),
    );

    expect(result.errors).toEqual(['cas_import:reconciliation_read_failed']);
    expect(schemeMasterUpsertMock).not.toHaveBeenCalled();
    expect(userFundUpsertMock).not.toHaveBeenCalled();
    expect(txUpsertMock).not.toHaveBeenCalled();
  });

  it('ignores a stored non-economic zero row without blocking the valid import', async () => {
    const {
      supabase,
    } = buildMockSupabase({
      existingTransactionRows: [storedPurchase({ units: 0 })],
    });
    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result).toMatchObject({
      fundsUpdated: 1,
      transactionsAdded: 1,
      reconciliationConflicts: 0,
      errors: [],
    });
  });

  it('normalizes a stored legacy folio sentinel to null for safe matching', async () => {
    const { supabase, txUpsertMock } = buildMockSupabase({
      existingTransactionRows: [storedPurchase({ folio_number: 'No' })],
    });
    const result = await importCASData(
      supabase,
      'user-1',
      'import-1',
      minimalCAS([
        { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      ]),
    );

    expect(result).toMatchObject({
      transactionsAdded: 0,
      transactionsDuplicate: 1,
      reconciliationConflicts: 0,
      errors: [],
    });
    expect(txUpsertMock).not.toHaveBeenCalled();
  });

  it('pages historical rows so a page-two match remains idempotent', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => storedPurchase({
      id: `older-${index}`,
      transaction_date: '2020-01-10',
      amount: 10000 + index,
    }));
    const {
      supabase,
      existingTransactionRangeMock,
      txUpsertMock,
    } = buildMockSupabase({
      existingTransactionRows: [...firstPage, storedPurchase()],
    });
    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(existingTransactionRangeMock).toHaveBeenNthCalledWith(1, 0, 999);
    expect(existingTransactionRangeMock).toHaveBeenNthCalledWith(2, 1000, 1999);
    expect(result).toMatchObject({
      transactionsAdded: 0,
      transactionsDuplicate: 1,
      reconciliationConflicts: 0,
    });
    expect(txUpsertMock).not.toHaveBeenCalled();
  });

  it('matches split incoming rows to one combined historical event', async () => {
    const { supabase, txUpsertMock } = buildMockSupabase({
      existingTransactionRows: [storedPurchase()],
    });
    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 40, amount: 4000, nav: 100 },
      { date: '2024-01-10', type: 'PURCHASE', units: 60, amount: 6000, nav: 100 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result.transactionsAdded).toBe(0);
    expect(result.transactionsDuplicate).toBe(2);
    expect(result.reconciliationConflicts).toBe(0);
    expect(txUpsertMock).not.toHaveBeenCalled();
  });

  it('matches one combined incoming row to split historical events', async () => {
    const { supabase, txUpsertMock } = buildMockSupabase({
      existingTransactionRows: [
        storedPurchase({ id: 'split-1', units: 40, amount: 4000 }),
        storedPurchase({ id: 'split-2', units: 60, amount: 6000 }),
      ],
    });
    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result.transactionsAdded).toBe(0);
    expect(result.transactionsDuplicate).toBe(1);
    expect(result.reconciliationConflicts).toBe(0);
    expect(txUpsertMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'partial row overlap',
      incoming: [
        { date: '2024-01-10', type: 'PURCHASE', units: 40, amount: 4000, nav: 100 },
        { date: '2024-01-10', type: 'PURCHASE', units: 60, amount: 6000, nav: 100 },
      ],
      existing: [
        storedPurchase({ id: 'same', units: 40, amount: 4000 }),
        storedPurchase({ id: 'different', units: 20, amount: 2500 }),
      ],
    },
    {
      name: 'cash-only aggregate equality',
      incoming: [
        { date: '2024-01-10', type: 'PURCHASE', units: 90, amount: 10000, nav: 111.1111 },
      ],
      existing: [storedPurchase()],
    },
  ])('rejects $name before every domain mutation', async ({ incoming, existing }) => {
    const {
      supabase,
      schemeMasterUpsertMock,
      userFundUpsertMock,
      deleteMock,
      txUpsertMock,
    } = buildMockSupabase({ existingTransactionRows: existing });

    const result = await importCASData(
      supabase,
      'user-1',
      'import-1',
      minimalCAS(incoming),
    );

    expect(result.transactionsAdded).toBe(0);
    expect(result.reconciliationConflicts).toBe(1);
    expect(result.errors).toEqual(['cas_import:reconciliation_conflict']);
    expect(schemeMasterUpsertMock).not.toHaveBeenCalled();
    expect(userFundUpsertMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(txUpsertMock).not.toHaveBeenCalled();
  });

  it('preserves identical within-statement multiplicity and reimports idempotently', async () => {
    const { supabase, txUpsertMock, storedTransactions } = buildMockSupabase();
    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
    ]);

    const first = await importCASData(supabase, 'user-1', 'import-1', parsed);
    const second = await importCASData(supabase, 'user-1', 'import-2', parsed);

    expect(first).toMatchObject({
      transactionsAdded: 2,
      transactionsDuplicate: 0,
      reconciliationConflicts: 0,
    });
    expect(second).toMatchObject({
      transactionsAdded: 0,
      transactionsDuplicate: 2,
      reconciliationConflicts: 0,
    });
    expect(txUpsertMock).toHaveBeenCalledTimes(1);
    expect(storedTransactions).toHaveLength(2);
    expect(storedTransactions.map((row) => row.cas_event_ordinal)).toEqual([0, 1]);
  });

  it('inserts only the exact unmatched suffix of an incoming superset', async () => {
    const { supabase, getUpsertedRows } = buildMockSupabase({
      existingTransactionRows: [storedPurchase()],
    });
    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      { date: '2024-01-10', type: 'PURCHASE', units: 50, amount: 5000, nav: 100 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result).toMatchObject({
      transactionsAdded: 1,
      transactionsDuplicate: 1,
      reconciliationConflicts: 0,
    });
    expect(getUpsertedRows()).toEqual([
      expect.objectContaining({ units: 50, amount: 5000, cas_event_ordinal: 0 }),
    ]);
  });

  it('rejects an ambiguous historical cash-only reversal without mutation', async () => {
    const {
      supabase,
      schemeMasterUpsertMock,
      userFundUpsertMock,
      deleteMock,
      txUpsertMock,
    } = buildMockSupabase({
      existingTransactionRows: [
        storedPurchase({ id: 'candidate-1', units: 100 }),
        storedPurchase({ id: 'candidate-2', units: 50, cas_event_ordinal: 1 }),
      ],
    });
    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'REVERSAL', units: undefined, amount: -10000, nav: 100 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result.reconciliationConflicts).toBe(1);
    expect(result.errors).toEqual(['cas_import:reconciliation_conflict']);
    expect(schemeMasterUpsertMock).not.toHaveBeenCalled();
    expect(userFundUpsertMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(txUpsertMock).not.toHaveBeenCalled();
  });

  it('uses reversal units to delete exactly one same-cash historical event', async () => {
    const { supabase, deleteMock, deleteCalls } = buildMockSupabase({
      existingTransactionRows: [
        storedPurchase({ id: 'candidate-1', units: 100 }),
        storedPurchase({ id: 'candidate-2', units: 50, cas_event_ordinal: 1 }),
      ],
    });
    const parsed = minimalCAS([
      { date: '2024-01-10', type: 'REVERSAL', units: -50, amount: -10000, nav: 200 },
    ]);

    const result = await importCASData(supabase, 'user-1', 'import-1', parsed);

    expect(result.reconciliationConflicts).toBe(0);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteCalls[0]).toContainEqual(['id', 'candidate-2']);
    expect(deleteCalls[0]).toContainEqual(['fund_id', 'fund-id-1']);
  });

  it('rolls back the complete multi-delete plan when the atomic RPC fails', async () => {
    const existingRows = [
      storedPurchase({ id: 'historical-1' }),
      storedPurchase({
        id: 'historical-2',
        transaction_date: '2024-02-05',
        units: 50,
        amount: 6000,
        cas_event_ordinal: 0,
      }),
    ];
    const { supabase, storedTransactions, txUpsertMock } = buildMockSupabase({
      existingTransactionRows: existingRows,
      rpcMutationError: { message: 'simulated transaction failure' },
    });

    const result = await importCASData(
      supabase,
      'user-1',
      'import-1',
      minimalCAS([
        { date: '2024-01-10', type: 'REVERSAL', units: -100, amount: -10000, nav: 100 },
        { date: '2024-02-05', type: 'REVERSAL', units: -50, amount: -6000, nav: 120 },
        { date: '2024-03-05', type: 'PURCHASE', units: 10, amount: 1200, nav: 120 },
      ]),
    );

    expect(result.errors).toContain('cas_import:transaction_write_failed');
    expect(storedTransactions).toEqual(existingRows);
    expect(txUpsertMock).not.toHaveBeenCalled();
  });

  it('maps a serialized snapshot race to a reconciliation conflict without transaction mutation', async () => {
    const { supabase, storedTransactions } = buildMockSupabase({
      rpcMutationError: { message: 'cas_snapshot_conflict' },
    });

    const result = await importCASData(
      supabase,
      'user-1',
      'import-1',
      minimalCAS([
        { date: '2024-01-10', type: 'PURCHASE', units: 100, amount: 10000, nav: 100 },
      ]),
    );

    expect(result.reconciliationConflicts).toBe(1);
    expect(result.errors).toContain('cas_import:reconciliation_conflict');
    expect(storedTransactions).toEqual([]);
  });

  it('serializes interleaved split and combined imports so only one economic group survives', async () => {
    const { supabase, storedTransactions } = buildMockSupabase({
      existingTransactionRows: [],
    });
    const combined = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 10, amount: 1000, nav: 100 },
    ]);
    const split = minimalCAS([
      { date: '2024-01-10', type: 'PURCHASE', units: 4, amount: 400, nav: 100 },
      { date: '2024-01-10', type: 'PURCHASE', units: 6, amount: 600, nav: 100 },
    ]);

    const results = await Promise.all([
      importCASData(supabase, 'user-1', 'import-combined', combined),
      importCASData(supabase, 'user-1', 'import-split', split),
    ]);

    expect(results.filter((result) => result.transactionsAdded > 0)).toHaveLength(1);
    expect(results.filter((result) =>
      result.errors.includes('cas_import:reconciliation_conflict')
    )).toHaveLength(1);
    expect(storedTransactions.reduce((sum, row) => sum + Number(row.units), 0)).toBe(10);
    expect(storedTransactions.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(1000);
  });

  it('matches twelve isolated economic groups without inserts or conflicts', async () => {
    const incoming = Array.from({ length: 12 }, (_, index) => ({
      date: `2024-01-${String(index + 1).padStart(2, '0')}`,
      type: 'PURCHASE',
      units: 100,
      amount: 10000,
      nav: 100,
    }));
    const existing = incoming.flatMap((transaction, index) => [
      storedPurchase({
        id: `split-${index}-a`,
        transaction_date: transaction.date,
        units: 40,
        amount: 4000,
      }),
      storedPurchase({
        id: `split-${index}-b`,
        transaction_date: transaction.date,
        units: 60,
        amount: 6000,
      }),
    ]);
    const { supabase, txUpsertMock } = buildMockSupabase({
      existingTransactionRows: existing,
    });

    const result = await importCASData(
      supabase,
      'user-1',
      'import-1',
      minimalCAS(incoming),
    );

    expect(result).toMatchObject({
      transactionsAdded: 0,
      transactionsDuplicate: 12,
      reconciliationConflicts: 0,
      errors: [],
    });
    expect(txUpsertMock).not.toHaveBeenCalled();
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
