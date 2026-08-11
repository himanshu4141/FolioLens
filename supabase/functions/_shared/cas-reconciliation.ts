export const CASH_SCALE = 100;
export const UNITS_SCALE = 10_000;

export type PersistedTransactionType =
  | 'purchase'
  | 'redemption'
  | 'switch_in'
  | 'switch_out'
  | 'dividend_reinvest';

export interface IncomingEconomicRow {
  sourceIndex: number;
  transactionDate: string;
  transactionType: PersistedTransactionType;
  units: number;
  grossAmount: number;
  navAtTransaction: number;
  folioNumber: string | null;
}

export interface PlannedIncomingRow extends IncomingEconomicRow {
  units: number;
  grossAmount: number;
  eventOrdinal: number;
}

export interface ExistingEconomicRow {
  id: string;
  fundId: string;
  transactionDate: string;
  transactionType: PersistedTransactionType;
  units: number;
  amount: number;
  folioNumber: string | null;
  eventOrdinal: number;
  casImportId: string | null;
}

export interface ReversalRequest {
  sourceIndex: number;
  transactionDate: string;
  grossAmount: number;
  units: number | null;
  folioNumber: string | null;
}

export type ReconciliationConflictReason =
  | 'ambiguous_folio'
  | 'partial_overlap'
  | 'cash_units_mismatch'
  | 'ambiguous_independent_event'
  | 'ambiguous_reversal'
  | 'unmatched_reversal';

export type ReconciliationCountBucket =
  | '0'
  | '1'
  | '2-5'
  | '6-20'
  | '21-100'
  | '101+';

export interface ReconciliationConflict {
  reason: ReconciliationConflictReason;
  incomingRowsBucket: ReconciliationCountBucket;
  existingRowsBucket: ReconciliationCountBucket;
}

export interface EconomicReconciliationPlan {
  inserts: PlannedIncomingRow[];
  reversalDeleteIds: string[];
  duplicateRows: number;
  matchedGroups: number;
  conflicts: ReconciliationConflict[];
}

function roundToScale(value: number, scale: number): number {
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function roundCash(value: number): number {
  return roundToScale(Math.abs(value), CASH_SCALE);
}

export function roundUnits(value: number): number {
  return roundToScale(Math.abs(value), UNITS_SCALE);
}

export function cashTolerance(left: number, right: number): number {
  return Math.max(1, Math.max(Math.abs(left), Math.abs(right)) * 0.002);
}

export function unitsTolerance(left: number, right: number): number {
  return Math.max(0.0001, Math.max(Math.abs(left), Math.abs(right)) * 0.000001);
}

export function cashMatches(left: number, right: number): boolean {
  return Math.abs(left - right) <= cashTolerance(left, right);
}

export function unitsMatch(left: number, right: number): boolean {
  return Math.abs(left - right) <= unitsTolerance(left, right);
}

function normalizedFolio(value: string | null): string | null {
  const normalized = value?.trim().toUpperCase() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function baseKey(row: {
  transactionDate: string;
  transactionType: PersistedTransactionType;
}): string {
  return `${row.transactionDate}\u001f${row.transactionType}`;
}

function rowIdentity(row: PlannedIncomingRow): string {
  return [
    baseKey(row),
    row.units.toFixed(4),
    row.grossAmount.toFixed(2),
    normalizedFolio(row.folioNumber) ?? '',
  ].join('\u001f');
}

function existingRowIdentity(row: ExistingEconomicRow): string {
  return [
    baseKey(row),
    roundUnits(row.units).toFixed(4),
    roundCash(row.amount).toFixed(2),
    normalizedFolio(row.folioNumber) ?? '',
  ].join('\u001f');
}

export function assignEventOrdinals(
  rows: IncomingEconomicRow[],
): PlannedIncomingRow[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const normalized: PlannedIncomingRow = {
      ...row,
      units: roundUnits(row.units),
      grossAmount: roundCash(row.grossAmount),
      eventOrdinal: 0,
    };
    const identity = rowIdentity(normalized);
    const ordinal = seen.get(identity) ?? 0;
    seen.set(identity, ordinal + 1);
    normalized.eventOrdinal = ordinal;
    return normalized;
  });
}

function folioCompatible(
  left: string | null,
  right: string | null,
  knownFolios: Set<string>,
): boolean {
  const normalizedLeft = normalizedFolio(left);
  const normalizedRight = normalizedFolio(right);
  if (normalizedLeft !== null && normalizedRight !== null) {
    return normalizedLeft === normalizedRight;
  }
  if (normalizedLeft === null && normalizedRight === null) return true;
  return knownFolios.size <= 1;
}

function aggregateIncoming(rows: PlannedIncomingRow[]): { cash: number; units: number } {
  return {
    cash: roundCash(rows.reduce((total, row) => total + row.grossAmount, 0)),
    units: roundUnits(rows.reduce((total, row) => total + row.units, 0)),
  };
}

function aggregateExisting(rows: ExistingEconomicRow[]): { cash: number; units: number } {
  return {
    cash: roundCash(rows.reduce((total, row) => total + row.amount, 0)),
    units: roundUnits(rows.reduce((total, row) => total + row.units, 0)),
  };
}

function reconciliationCountBucket(count: number): ReconciliationCountBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2-5';
  if (count <= 20) return '6-20';
  if (count <= 100) return '21-100';
  return '101+';
}

function conflict(
  reason: ReconciliationConflictReason,
  incomingRows: number,
  existingRows: number,
): ReconciliationConflict {
  return {
    reason,
    incomingRowsBucket: reconciliationCountBucket(incomingRows),
    existingRowsBucket: reconciliationCountBucket(existingRows),
  };
}

function knownFoliosForRows(
  incoming: Array<{ folioNumber: string | null }>,
  existing: Array<{ folioNumber: string | null }>,
): Set<string> {
  const known = new Set<string>();
  for (const row of [...incoming, ...existing]) {
    const folio = normalizedFolio(row.folioNumber);
    if (folio !== null) known.add(folio);
  }
  return known;
}

function resolvedGroupKey(
  row: { folioNumber: string | null },
  knownFolios: Set<string>,
): string {
  const folio = normalizedFolio(row.folioNumber);
  if (folio !== null) return folio;
  if (knownFolios.size === 1) return [...knownFolios][0];
  return '';
}

type AggregateSubsetMatch =
  | { kind: 'none' }
  | { kind: 'unique'; rows: ExistingEconomicRow[] }
  | { kind: 'ambiguous' };

const MAX_SUBSET_SEARCH_STATES = 100_000;

function findUniqueAggregateSubset(
  rows: ExistingEconomicRow[],
  targetCash: number,
  targetUnits: number,
): AggregateSubsetMatch {
  const eligible = rows
    .filter((row) => {
      const cash = roundCash(row.amount);
      const units = roundUnits(row.units);
      return (cash <= targetCash || cashMatches(cash, targetCash))
        && (units <= targetUnits || unitsMatch(units, targetUnits));
    })
    .sort((left, right) =>
      right.amount - left.amount
      || right.units - left.units
      || left.id.localeCompare(right.id)
    );
  type SubsetState = { count: 1 | 2; rows: ExistingEconomicRow[] };
  const states = new Map<string, SubsetState>([
    ['0\u001f0', { count: 1, rows: [] }],
  ]);

  for (const row of eligible) {
    const rowCash = Math.round(roundCash(row.amount) * CASH_SCALE);
    const rowUnits = Math.round(roundUnits(row.units) * UNITS_SCALE);
    const additions: Array<[string, SubsetState]> = [];
    for (const [key, state] of [...states.entries()]) {
      const [cashValue, unitsValue] = key.split('\u001f').map(Number);
      const cash = cashValue + rowCash;
      const units = unitsValue + rowUnits;
      const roundedCash = cash / CASH_SCALE;
      const roundedUnits = units / UNITS_SCALE;
      // All economic components are positive. Once either aggregate is above
      // the target and outside tolerance, adding another row cannot restore a
      // match.
      if (
        (roundedCash > targetCash && !cashMatches(roundedCash, targetCash))
        || (roundedUnits > targetUnits && !unitsMatch(roundedUnits, targetUnits))
      ) continue;
      additions.push([
        `${cash}\u001f${units}`,
        { count: state.count, rows: [...state.rows, row] },
      ]);
    }

    for (const [key, addition] of additions) {
      const current = states.get(key);
      if (current === undefined) {
        states.set(key, addition);
      } else {
        states.set(key, {
          count: 2,
          rows: current.rows,
        });
      }
    }
    if (states.size > MAX_SUBSET_SEARCH_STATES) return { kind: 'ambiguous' };
  }

  let match: ExistingEconomicRow[] | null = null;
  for (const [key, state] of states) {
    if (state.rows.length === 0) continue;
    const [cash, units] = key.split('\u001f').map(Number);
    if (
      !cashMatches(cash / CASH_SCALE, targetCash)
      || !unitsMatch(units / UNITS_SCALE, targetUnits)
    ) continue;
    if (state.count > 1 || match !== null) return { kind: 'ambiguous' };
    match = state.rows;
  }

  if (match === null) return { kind: 'none' };
  return { kind: 'unique', rows: match };
}

function matchReversals(
  incoming: PlannedIncomingRow[],
  existing: ExistingEconomicRow[],
  reversals: ReversalRequest[],
): {
  remainingIncoming: PlannedIncomingRow[];
  remainingExisting: ExistingEconomicRow[];
  deleteIds: string[];
  conflicts: ReconciliationConflict[];
} {
  const consumedIncoming = new Set<number>();
  const consumedExisting = new Set<string>();
  const deleteIds: string[] = [];
  const conflicts: ReconciliationConflict[] = [];
  const statementReversedRows: PlannedIncomingRow[] = [];

  for (const reversal of reversals) {
    const availableIncoming = incoming.filter((row) =>
      row.transactionType === 'purchase'
      && row.transactionDate === reversal.transactionDate
      && !consumedIncoming.has(row.sourceIndex)
    );
    const availableExisting = existing.filter((row) =>
      row.transactionType === 'purchase'
      && row.transactionDate === reversal.transactionDate
      && !consumedExisting.has(row.id)
    );
    // A null candidate may bridge only when the complete candidate set plus
    // the reversal itself names at most one known folio. Including the
    // reversal closes the unsafe FOLIO-01 -> null bridge when contradictory
    // FOLIO-02 evidence is present in the same date/type group.
    const candidateFolios = knownFoliosForRows(
      [reversal, ...availableIncoming],
      availableExisting,
    );
    const hasNullCandidate = [...availableIncoming, ...availableExisting]
      .some((row) => normalizedFolio(row.folioNumber) === null);
    if (
      candidateFolios.size > 1
      && (hasNullCandidate || normalizedFolio(reversal.folioNumber) === null)
    ) {
      conflicts.push(conflict(
        'ambiguous_folio',
        availableIncoming.length + 1,
        availableExisting.length,
      ));
      continue;
    }
    const incomingCandidates = availableIncoming.filter((row) =>
      folioCompatible(reversal.folioNumber, row.folioNumber, candidateFolios)
      && cashMatches(roundCash(reversal.grossAmount), row.grossAmount)
      && (reversal.units === null || unitsMatch(roundUnits(reversal.units), row.units))
    );
    if (incomingCandidates.length === 1) {
      consumedIncoming.add(incomingCandidates[0].sourceIndex);
      statementReversedRows.push(incomingCandidates[0]);
      continue;
    }
    if (incomingCandidates.length > 1) {
      conflicts.push(conflict('ambiguous_reversal', 1, incomingCandidates.length));
      continue;
    }

    const existingCandidates = availableExisting.filter((row) =>
      folioCompatible(reversal.folioNumber, row.folioNumber, candidateFolios)
      && cashMatches(roundCash(reversal.grossAmount), roundCash(row.amount))
      && (reversal.units === null || unitsMatch(roundUnits(reversal.units), roundUnits(row.units)))
    );
    if (existingCandidates.length === 0) {
      conflicts.push(conflict('unmatched_reversal', 1, 0));
      continue;
    }
    if (existingCandidates.length > 1) {
      conflicts.push(conflict('ambiguous_reversal', 1, existingCandidates.length));
      continue;
    }
    consumedExisting.add(existingCandidates[0].id);
    deleteIds.push(existingCandidates[0].id);
  }

  // When the statement repeats a purchase and then reverses it, that incoming
  // row is the statement representation of any identical stored row. Keep
  // exactly the multiplicity that remains live in the statement after its
  // reversals. This makes E=n/P=1/R=1 converge to zero instead of consuming
  // only the incoming copy and leaving every historical copy behind.
  const reversedIdentities = new Set(statementReversedRows.map(rowIdentity));
  for (const identity of reversedIdentities) {
    const reversedRow = statementReversedRows.find((row) => rowIdentity(row) === identity)!;
    const remainingCount = incoming.filter((row) =>
      row.transactionType === 'purchase'
      && rowIdentity(row) === identity
      && !consumedIncoming.has(row.sourceIndex)
    ).length;
    const storedMatches = existing.filter((row) =>
      !consumedExisting.has(row.id)
      && existingRowIdentity(row) === identity
    ).sort((left, right) =>
      right.eventOrdinal - left.eventOrdinal || right.id.localeCompare(left.id)
    );
    if (remainingCount === 0) {
      const compatibleGroup = existing.filter((row) => {
        if (consumedExisting.has(row.id) || baseKey(row) !== baseKey(reversedRow)) return false;
        const folios = knownFoliosForRows([reversedRow], [row]);
        return folioCompatible(reversedRow.folioNumber, row.folioNumber, folios);
      });
      const storedMatchIds = new Set(storedMatches.map((row) => row.id));
      const splitMatch = findUniqueAggregateSubset(
        compatibleGroup.filter((row) => !storedMatchIds.has(row.id)),
        reversedRow.grossAmount,
        reversedRow.units,
      );

      // Exact stored copies are one representation of the reversed event. A
      // matching non-exact subset is another. If both exist, or more than one
      // non-exact subset exists, choosing either would delete legitimate
      // history in at least one valid interpretation, so reject the plan.
      if (
        splitMatch.kind === 'ambiguous'
        || (storedMatches.length > 0 && splitMatch.kind === 'unique')
      ) {
        conflicts.push(conflict('ambiguous_reversal', 1, compatibleGroup.length));
        continue;
      }

      const reversedStoredRows = storedMatches.length > 0
        ? storedMatches
        : splitMatch.kind === 'unique' ? splitMatch.rows : [];
      for (const row of reversedStoredRows) {
        consumedExisting.add(row.id);
        deleteIds.push(row.id);
      }
      continue;
    }

    const deleteCount = Math.max(0, storedMatches.length - remainingCount);
    for (const row of storedMatches.slice(0, deleteCount)) {
      consumedExisting.add(row.id);
      deleteIds.push(row.id);
    }
  }

  return {
    remainingIncoming: incoming.filter((row) => !consumedIncoming.has(row.sourceIndex)),
    remainingExisting: existing.filter((row) => !consumedExisting.has(row.id)),
    deleteIds,
    conflicts,
  };
}

function allocateInsertOrdinals(
  inserts: PlannedIncomingRow[],
  existingRows: ExistingEconomicRow[],
  reversalDeleteIds: string[],
): PlannedIncomingRow[] {
  const deleted = new Set(reversalDeleteIds);
  const usedByIdentity = new Map<string, Set<number>>();
  for (const row of existingRows) {
    if (deleted.has(row.id)) continue;
    const identity = existingRowIdentity(row);
    const used = usedByIdentity.get(identity) ?? new Set<number>();
    used.add(row.eventOrdinal);
    usedByIdentity.set(identity, used);
  }

  return inserts.map((row) => {
    const identity = rowIdentity(row);
    const used = usedByIdentity.get(identity) ?? new Set<number>();
    let ordinal = 0;
    while (used.has(ordinal)) ordinal++;
    used.add(ordinal);
    usedByIdentity.set(identity, used);
    return { ...row, eventOrdinal: ordinal };
  });
}

export function reconcileEconomicRows(
  rawIncoming: IncomingEconomicRow[],
  existingRows: ExistingEconomicRow[],
  reversals: ReversalRequest[] = [],
): EconomicReconciliationPlan {
  const incoming = assignEventOrdinals(rawIncoming);
  const reversalPlan = matchReversals(incoming, existingRows, reversals);
  const plan: EconomicReconciliationPlan = {
    inserts: [],
    reversalDeleteIds: reversalPlan.deleteIds,
    duplicateRows: 0,
    matchedGroups: 0,
    conflicts: [...reversalPlan.conflicts],
  };
  if (plan.conflicts.length > 0) {
    plan.inserts = [];
    plan.reversalDeleteIds = [];
    return plan;
  }

  const allBaseKeys = new Set([
    ...reversalPlan.remainingIncoming.map(baseKey),
    ...reversalPlan.remainingExisting.map(baseKey),
  ]);

  for (const key of allBaseKeys) {
    const incomingAtBase = reversalPlan.remainingIncoming.filter((row) => baseKey(row) === key);
    if (incomingAtBase.length === 0) continue;
    const existingAtBase = reversalPlan.remainingExisting.filter((row) => baseKey(row) === key);
    const knownFolios = knownFoliosForRows(incomingAtBase, existingAtBase);
    const hasNull = [...incomingAtBase, ...existingAtBase]
      .some((row) => normalizedFolio(row.folioNumber) === null);
    if (knownFolios.size > 1 && hasNull) {
      plan.conflicts.push(conflict(
        'ambiguous_folio', incomingAtBase.length, existingAtBase.length,
      ));
      continue;
    }

    const groupKeys = new Set(incomingAtBase.map((row) => resolvedGroupKey(row, knownFolios)));
    for (const groupKey of groupKeys) {
      const incomingGroup = incomingAtBase.filter(
        (row) => resolvedGroupKey(row, knownFolios) === groupKey,
      );
      const existingGroup = existingAtBase.filter(
        (row) => resolvedGroupKey(row, knownFolios) === groupKey,
      );
      if (existingGroup.length === 0) {
        plan.inserts.push(...incomingGroup);
        continue;
      }

      const unmatchedExisting = new Set(existingGroup.map((row) => row.id));
      const unmatchedIncoming: PlannedIncomingRow[] = [];
      let rowMatches = 0;
      for (const incomingRow of incomingGroup) {
        const match = existingGroup.find((existingRow) =>
          unmatchedExisting.has(existingRow.id)
          && cashMatches(incomingRow.grossAmount, roundCash(existingRow.amount))
          && unitsMatch(incomingRow.units, roundUnits(existingRow.units))
        );
        if (match) {
          unmatchedExisting.delete(match.id);
          rowMatches++;
        } else {
          unmatchedIncoming.push(incomingRow);
        }
      }

      if (unmatchedIncoming.length === 0) {
        plan.duplicateRows += incomingGroup.length;
        plan.matchedGroups++;
        continue;
      }
      if (rowMatches > 0) {
        if (unmatchedExisting.size === 0) {
          plan.inserts.push(...unmatchedIncoming);
          plan.duplicateRows += rowMatches;
          continue;
        }
        plan.conflicts.push(conflict(
          'partial_overlap', incomingGroup.length, existingGroup.length,
        ));
        continue;
      }

      const incomingTotals = aggregateIncoming(incomingGroup);
      const existingTotals = aggregateExisting(existingGroup);
      const cashEqual = cashMatches(incomingTotals.cash, existingTotals.cash);
      const unitsEqual = unitsMatch(incomingTotals.units, existingTotals.units);
      if (cashEqual && unitsEqual) {
        plan.duplicateRows += incomingGroup.length;
        plan.matchedGroups++;
      } else if (cashEqual || unitsEqual) {
        plan.conflicts.push(conflict(
          'cash_units_mismatch', incomingGroup.length, existingGroup.length,
        ));
      } else {
        plan.conflicts.push(conflict(
          'ambiguous_independent_event', incomingGroup.length, existingGroup.length,
        ));
      }
    }
  }

  if (plan.conflicts.length > 0) {
    plan.inserts = [];
    plan.reversalDeleteIds = [];
  } else {
    plan.inserts = allocateInsertOrdinals(
      plan.inserts,
      existingRows,
      plan.reversalDeleteIds,
    );
  }
  return plan;
}
