import {
  assignEventOrdinals,
  cashMatches,
  reconcileEconomicRows,
  unitsMatch,
  type ExistingEconomicRow,
  type IncomingEconomicRow,
  type ReversalRequest,
} from '../cas-reconciliation';

function incoming(
  overrides: Partial<IncomingEconomicRow> = {},
): IncomingEconomicRow {
  return {
    sourceIndex: 0,
    transactionDate: '2026-07-01',
    transactionType: 'purchase',
    units: 10,
    grossAmount: 1000,
    navAtTransaction: 100,
    folioNumber: 'FOLIO-01',
    ...overrides,
  };
}

function existing(
  overrides: Partial<ExistingEconomicRow> = {},
): ExistingEconomicRow {
  return {
    id: 'tx-1',
    fundId: 'fund-1',
    transactionDate: '2026-07-01',
    transactionType: 'purchase',
    units: 10,
    amount: 1000,
    folioNumber: 'FOLIO-01',
    eventOrdinal: 0,
    casImportId: 'import-old',
    ...overrides,
  };
}

function reversal(overrides: Partial<ReversalRequest> = {}): ReversalRequest {
  return {
    sourceIndex: 100,
    transactionDate: '2026-07-01',
    grossAmount: 1000,
    units: 10,
    folioNumber: 'FOLIO-01',
    ...overrides,
  };
}

describe('CAS economic reconciliation', () => {
  it('uses explicit cash and unit tolerances together', () => {
    expect(cashMatches(1000, 1001)).toBe(true);
    expect(cashMatches(1000, 1002.01)).toBe(false);
    expect(unitsMatch(10, 10.0001)).toBe(true);
    expect(unitsMatch(10, 10.0002)).toBe(false);
  });

  it('assigns stable ordinals to identical rows while preserving both events', () => {
    const rows = assignEventOrdinals([
      incoming({ sourceIndex: 0 }),
      incoming({ sourceIndex: 1 }),
      incoming({ sourceIndex: 2, grossAmount: 2000, units: 20 }),
    ]);

    expect(rows.map((row) => row.eventOrdinal)).toEqual([0, 1, 0]);
  });

  it('inserts two independent same-day rows when no stored group exists', () => {
    const plan = reconcileEconomicRows([
      incoming({ sourceIndex: 0, units: 10, grossAmount: 1000 }),
      incoming({ sourceIndex: 1, units: 20, grossAmount: 2000 }),
    ], []);

    expect(plan.conflicts).toEqual([]);
    expect(plan.inserts).toHaveLength(2);
  });

  it('treats an exact repeated row as a duplicate', () => {
    const plan = reconcileEconomicRows([incoming()], [existing()]);

    expect(plan).toMatchObject({
      inserts: [],
      duplicateRows: 1,
      matchedGroups: 1,
      conflicts: [],
    });
  });

  it('matches split incoming rows to one combined stored event', () => {
    const plan = reconcileEconomicRows([
      incoming({ sourceIndex: 0, units: 4, grossAmount: 400 }),
      incoming({ sourceIndex: 1, units: 6, grossAmount: 600 }),
    ], [existing()]);

    expect(plan).toMatchObject({
      inserts: [],
      duplicateRows: 2,
      matchedGroups: 1,
      conflicts: [],
    });
  });

  it('matches one combined incoming row to split stored events', () => {
    const plan = reconcileEconomicRows([incoming()], [
      existing({ id: 'tx-1', units: 4, amount: 400 }),
      existing({ id: 'tx-2', units: 6, amount: 600 }),
    ]);

    expect(plan).toMatchObject({
      inserts: [],
      duplicateRows: 1,
      matchedGroups: 1,
      conflicts: [],
    });
  });

  it('counts twelve isolated split/combined matches with no planned inserts', () => {
    const incomingRows = Array.from({ length: 12 }, (_, index) => incoming({
      sourceIndex: index,
      transactionDate: `2026-07-${String(index + 1).padStart(2, '0')}`,
    }));
    const existingRows = incomingRows.flatMap((row, index) => [
      existing({
        id: `existing-${index}-a`,
        transactionDate: row.transactionDate,
        units: 4,
        amount: 400,
      }),
      existing({
        id: `existing-${index}-b`,
        transactionDate: row.transactionDate,
        units: 6,
        amount: 600,
      }),
    ]);

    const plan = reconcileEconomicRows(incomingRows, existingRows);

    expect(plan).toMatchObject({
      inserts: [],
      duplicateRows: 12,
      matchedGroups: 12,
      conflicts: [],
    });
  });

  it('matches stamp-duty gross cash within the explicit cash tolerance', () => {
    const plan = reconcileEconomicRows([
      incoming({ grossAmount: 1000.05 }),
    ], [existing({ amount: 1000 })]);

    expect(plan.conflicts).toEqual([]);
    expect(plan.inserts).toEqual([]);
  });

  it('inserts only the exact unmatched suffix of a true incoming superset', () => {
    const extra = incoming({ sourceIndex: 1, units: 20, grossAmount: 2000 });
    const plan = reconcileEconomicRows([incoming(), extra], [existing()]);

    expect(plan.conflicts).toEqual([]);
    expect(plan.duplicateRows).toBe(1);
    expect(plan.inserts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceIndex: 1, units: 20, grossAmount: 2000 }),
    ]));
  });

  it('keeps an incoming subset idempotent when stored history is a superset', () => {
    const plan = reconcileEconomicRows([incoming()], [
      existing(),
      existing({ id: 'tx-2', units: 20, amount: 2000 }),
    ]);

    expect(plan.conflicts).toEqual([]);
    expect(plan.inserts).toEqual([]);
    expect(plan.duplicateRows).toBe(1);
  });

  it('fails closed for partial overlap with unmatched rows on both sides', () => {
    const plan = reconcileEconomicRows([
      incoming(),
      incoming({ sourceIndex: 1, units: 20, grossAmount: 2000 }),
    ], [
      existing(),
      existing({ id: 'tx-2', units: 30, amount: 3000 }),
    ]);

    expect(plan.conflicts).toEqual([{
      reason: 'partial_overlap',
      incomingRowsBucket: '2-5',
      existingRowsBucket: '2-5',
    }]);
    expect(plan.inserts).toEqual([]);
  });

  it('fails closed when aggregate cash matches but aggregate units do not', () => {
    const plan = reconcileEconomicRows([
      incoming({ units: 11, grossAmount: 1000 }),
    ], [existing({ units: 10, amount: 1000 })]);

    expect(plan.conflicts[0].reason).toBe('cash_units_mismatch');
    expect(plan.inserts).toEqual([]);
  });

  it('fails closed when aggregate units match but aggregate cash does not', () => {
    const plan = reconcileEconomicRows([
      incoming({ units: 10, grossAmount: 1300 }),
    ], [existing({ units: 10, amount: 1000 })]);

    expect(plan.conflicts[0].reason).toBe('cash_units_mismatch');
    expect(plan.inserts).toEqual([]);
  });

  it('fails closed when an unmatched stored group makes independence ambiguous', () => {
    const plan = reconcileEconomicRows([
      incoming({ units: 20, grossAmount: 2500 }),
    ], [existing()]);

    expect(plan.conflicts[0].reason).toBe('ambiguous_independent_event');
    expect(plan.inserts).toEqual([]);
  });

  it('keeps different known folios as independent groups', () => {
    const plan = reconcileEconomicRows([
      incoming({ folioNumber: 'FOLIO-02' }),
    ], [existing({ folioNumber: 'FOLIO-01' })]);

    expect(plan.conflicts).toEqual([]);
    expect(plan.inserts).toHaveLength(1);
  });

  it('uses null folio only as a unique-known-folio bridge', () => {
    const unique = reconcileEconomicRows([
      incoming({ folioNumber: null }),
    ], [existing({ folioNumber: 'FOLIO-01' })]);
    expect(unique.conflicts).toEqual([]);
    expect(unique.inserts).toEqual([]);

    const ambiguous = reconcileEconomicRows([
      incoming({ folioNumber: null }),
    ], [
      existing({ id: 'tx-1', folioNumber: 'FOLIO-01' }),
      existing({ id: 'tx-2', folioNumber: 'FOLIO-02' }),
    ]);
    expect(ambiguous.conflicts[0].reason).toBe('ambiguous_folio');
  });

  it.each(['redemption', 'switch_in', 'switch_out', 'dividend_reinvest'] as const)(
    'reconciles %s using both cash and units',
    (transactionType) => {
      const plan = reconcileEconomicRows([
        incoming({ transactionType }),
      ], [existing({ transactionType })]);
      expect(plan.conflicts).toEqual([]);
      expect(plan.inserts).toEqual([]);
    },
  );

  it('removes a uniquely reversed purchase from the incoming insert plan', () => {
    const plan = reconcileEconomicRows([incoming()], [], [reversal()]);

    expect(plan.conflicts).toEqual([]);
    expect(plan.inserts).toEqual([]);
    expect(plan.reversalDeleteIds).toEqual([]);
  });

  it('deletes the historical twin when the statement repeats and reverses the purchase', () => {
    const plan = reconcileEconomicRows([incoming()], [existing()], [reversal()]);

    expect(plan.conflicts).toEqual([]);
    expect(plan.inserts).toEqual([]);
    expect(plan.reversalDeleteIds).toEqual(['tx-1']);
  });

  it.each([1, 2, 3])(
    'removes all %i historical copies when a complete statement repeats one purchase and reverses it',
    (existingCount) => {
      const stored = Array.from({ length: existingCount }, (_, index) => existing({
        id: `tx-${index}`,
        eventOrdinal: index,
      }));
      const plan = reconcileEconomicRows([incoming()], stored, [reversal()]);

      expect(plan.conflicts).toEqual([]);
      expect(plan.inserts).toEqual([]);
      expect(plan.reversalDeleteIds).toHaveLength(existingCount);
      expect(new Set(plan.reversalDeleteIds)).toEqual(
        new Set(stored.map((row) => row.id)),
      );
    },
  );

  it('deletes every exact ID in a stored split representation of a repeated combined reversal', () => {
    const plan = reconcileEconomicRows([incoming()], [
      existing({ id: 'split-a', amount: 400, units: 4 }),
      existing({ id: 'split-b', amount: 600, units: 6 }),
    ], [reversal()]);

    expect(plan.conflicts).toEqual([]);
    expect(plan.inserts).toEqual([]);
    expect(new Set(plan.reversalDeleteIds)).toEqual(new Set(['split-a', 'split-b']));
  });

  it('deletes only the unique split subset when an independent purchase shares the group', () => {
    const plan = reconcileEconomicRows([incoming()], [
      existing({ id: 'split-a', amount: 400, units: 4 }),
      existing({ id: 'split-b', amount: 600, units: 6 }),
      existing({ id: 'independent', amount: 500, units: 5 }),
    ], [reversal()]);

    expect(plan.conflicts).toEqual([]);
    expect(plan.inserts).toEqual([]);
    expect(new Set(plan.reversalDeleteIds)).toEqual(new Set(['split-a', 'split-b']));
    expect(plan.reversalDeleteIds).not.toContain('independent');
  });

  it('rejects exact-versus-split reversal ambiguity without deleting either representation', () => {
    const plan = reconcileEconomicRows([incoming()], [
      existing({ id: 'exact', amount: 1000, units: 10 }),
      existing({ id: 'split-a', amount: 400, units: 4 }),
      existing({ id: 'split-b', amount: 600, units: 6 }),
    ], [reversal()]);

    expect(plan.conflicts[0].reason).toBe('ambiguous_reversal');
    expect(plan.inserts).toEqual([]);
    expect(plan.reversalDeleteIds).toEqual([]);
  });

  it('rejects multiple matching split subsets without deleting any candidate', () => {
    const plan = reconcileEconomicRows([incoming()], [
      existing({ id: 'split-a', amount: 400, units: 4 }),
      existing({ id: 'split-b', amount: 600, units: 6 }),
      existing({ id: 'split-c', amount: 200, units: 2 }),
      existing({ id: 'split-d', amount: 800, units: 8 }),
    ], [reversal()]);

    expect(plan.conflicts[0].reason).toBe('ambiguous_reversal');
    expect(plan.inserts).toEqual([]);
    expect(plan.reversalDeleteIds).toEqual([]);
  });

  it('preserves unique-subset-or-conflict reversal safety across mixed groups', () => {
    const values = [10, 8, 6, 5, 4, 3, 2, 1];
    for (let mask = 1; mask < 2 ** values.length; mask += 1) {
      const selected = values.filter((_, index) => (mask & (1 << index)) !== 0);
      const stored = selected.map((value) => existing({
        id: `units-${value}`,
        amount: value * 100,
        units: value,
      }));
      const nonExact = selected.filter((value) => value !== 10);
      const matchingSubsets: number[][] = [];
      for (let subsetMask = 1; subsetMask < 2 ** nonExact.length; subsetMask += 1) {
        const subset = nonExact.filter((_, index) =>
          (subsetMask & (1 << index)) !== 0
        );
        if (subset.reduce((sum, value) => sum + value, 0) === 10) {
          matchingSubsets.push(subset);
        }
      }

      const plan = reconcileEconomicRows([incoming()], stored, [reversal()]);
      const hasExact = selected.includes(10);
      const ambiguous = matchingSubsets.length > 1
        || (hasExact && matchingSubsets.length === 1);
      if (ambiguous) {
        expect(plan.conflicts[0].reason).toBe('ambiguous_reversal');
        expect(plan.reversalDeleteIds).toEqual([]);
      } else {
        expect(plan.conflicts).toEqual([]);
        const expectedValues = hasExact
          ? [10]
          : matchingSubsets[0] ?? [];
        expect(new Set(plan.reversalDeleteIds)).toEqual(
          new Set(expectedValues.map((value) => `units-${value}`)),
        );
      }
    }
  });

  it('clears a resolved delete when another reversal conflicts', () => {
    const plan = reconcileEconomicRows([], [existing()], [
      reversal(),
      reversal({ sourceIndex: 101, transactionDate: '2026-07-02' }),
    ]);

    expect(plan.conflicts[0].reason).toBe('unmatched_reversal');
    expect(plan.inserts).toEqual([]);
    expect(plan.reversalDeleteIds).toEqual([]);
  });

  it('does not bridge a known reversal folio to null when another known folio contradicts it', () => {
    const plan = reconcileEconomicRows([], [
      existing({ id: 'unknown-folio', folioNumber: null }),
      existing({
        id: 'other-folio',
        folioNumber: 'FOLIO-02',
        amount: 2000,
        units: 20,
      }),
    ], [reversal({ folioNumber: 'FOLIO-01' })]);

    expect(plan.conflicts[0].reason).toBe('ambiguous_folio');
    expect(plan.reversalDeleteIds).toEqual([]);
  });

  it('does not consume a null-folio incoming purchase amid contradictory known-folio evidence', () => {
    const plan = reconcileEconomicRows([
      incoming({ sourceIndex: 0, folioNumber: null }),
      incoming({ sourceIndex: 1, folioNumber: 'FOLIO-02', grossAmount: 2000, units: 20 }),
    ], [], [reversal({ folioNumber: 'FOLIO-01' })]);

    expect(plan.conflicts[0].reason).toBe('ambiguous_folio');
    expect(plan.inserts).toEqual([]);
    expect(plan.reversalDeleteIds).toEqual([]);
  });

  it('deletes only the exact ID of a uniquely matched historical reversal', () => {
    const plan = reconcileEconomicRows([], [existing()], [reversal()]);

    expect(plan.conflicts).toEqual([]);
    expect(plan.reversalDeleteIds).toEqual(['tx-1']);
  });

  it('uses reversal units to select one of two same-cash purchases', () => {
    const plan = reconcileEconomicRows([], [
      existing({ id: 'tx-1', units: 10, amount: 1000 }),
      existing({ id: 'tx-2', units: 20, amount: 1000 }),
    ], [reversal({ units: 20 })]);

    expect(plan.conflicts).toEqual([]);
    expect(plan.reversalDeleteIds).toEqual(['tx-2']);
  });

  it('allocates an unmatched identical row into a gap in historical ordinals', () => {
    const plan = reconcileEconomicRows([
      incoming({ sourceIndex: 0 }),
      incoming({ sourceIndex: 1 }),
    ], [existing({ eventOrdinal: 1 })]);

    expect(plan.conflicts).toEqual([]);
    expect(plan.duplicateRows).toBe(1);
    expect(plan.inserts).toEqual([
      expect.objectContaining({ eventOrdinal: 0 }),
    ]);
  });

  it('rejects an ambiguous cash-only reversal without planning any delete', () => {
    const plan = reconcileEconomicRows([], [
      existing({ id: 'tx-1', units: 10, amount: 1000 }),
      existing({ id: 'tx-2', units: 20, amount: 1000 }),
    ], [reversal({ units: null })]);

    expect(plan.conflicts[0].reason).toBe('ambiguous_reversal');
    expect(plan.reversalDeleteIds).toEqual([]);
  });

  it('rejects an unmatched reversal without planning any delete', () => {
    const plan = reconcileEconomicRows([], [existing()], [
      reversal({ grossAmount: 2000 }),
    ]);

    expect(plan.conflicts[0].reason).toBe('unmatched_reversal');
    expect(plan.reversalDeleteIds).toEqual([]);
  });
});
