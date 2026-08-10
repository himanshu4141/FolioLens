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

  for (const reversal of reversals) {
    // A reversal in the same statement belongs to that statement's purchase
    // before it can target historical storage. This ordering prevents a
    // re-imported historical twin from turning a proven in-payload pair into an
    // ambiguous delete candidate.
    const availableIncoming = incoming.filter((row) =>
      row.transactionType === 'purchase'
      && row.transactionDate === reversal.transactionDate
      && !consumedIncoming.has(row.sourceIndex)
    );
    const incomingFolios = knownFoliosForRows(availableIncoming, []);
    if (normalizedFolio(reversal.folioNumber) === null && incomingFolios.size > 1) {
      conflicts.push(conflict('ambiguous_folio', 1, availableIncoming.length));
      continue;
    }
    const incomingCandidates = availableIncoming.filter((row) =>
      folioCompatible(reversal.folioNumber, row.folioNumber, incomingFolios)
      && cashMatches(roundCash(reversal.grossAmount), row.grossAmount)
      && (reversal.units === null || unitsMatch(roundUnits(reversal.units), row.units))
    );
    if (incomingCandidates.length === 1) {
      consumedIncoming.add(incomingCandidates[0].sourceIndex);
      continue;
    }
    if (incomingCandidates.length > 1) {
      conflicts.push(conflict('ambiguous_reversal', 1, incomingCandidates.length));
      continue;
    }

    const availableExisting = existing.filter((row) =>
      row.transactionType === 'purchase'
      && row.transactionDate === reversal.transactionDate
      && !consumedExisting.has(row.id)
    );
    const existingFolios = knownFoliosForRows([], availableExisting);
    if (normalizedFolio(reversal.folioNumber) === null && existingFolios.size > 1) {
      conflicts.push(conflict('ambiguous_folio', 1, availableExisting.length));
      continue;
    }
    const existingCandidates = availableExisting.filter((row) =>
      folioCompatible(reversal.folioNumber, row.folioNumber, existingFolios)
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

  return {
    remainingIncoming: incoming.filter((row) => !consumedIncoming.has(row.sourceIndex)),
    remainingExisting: existing.filter((row) => !consumedExisting.has(row.id)),
    deleteIds,
    conflicts,
  };
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
  if (plan.conflicts.length > 0) return plan;

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
  }
  return plan;
}
