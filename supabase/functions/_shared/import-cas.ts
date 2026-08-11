/**
 * Shared CAS import logic used by direct PDF upload and inbound email.
 *
 * Q1 owns complete-payload financial preflight. Q3 adds an I/O-free economic
 * reconciliation plan before transaction mutation: source row shape and cash
 * alone are never transaction identity.
 */

// Minimal structural type for the Supabase client. Deno supplies the real
// client; Jest supplies a chainable mock.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SupabaseClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc(functionName: string, args?: Record<string, unknown>): any;
}

import {
  assertCASPreflight,
  auditErrorCode,
  bucketCount,
  canonicalFolioNumber,
  normaliseTxType,
  parseDate,
  type CASParseResult,
  type CASWriteFailureReason,
  type CanonicalCASParseResult,
  type CanonicalCASTransaction,
} from './cas-import-contract.ts';
import {
  reconcileEconomicRows,
  roundCash,
  type EconomicReconciliationPlan,
  type ExistingEconomicRow,
  type IncomingEconomicRow,
  type PersistedTransactionType,
  type ReversalRequest,
} from './cas-reconciliation.ts';

export {
  normaliseTxType,
  parseDate,
  type CASParseResult,
  type CASTransaction,
  type CASScheme,
  type CASFolio,
} from './cas-import-contract.ts';

export function countParsedTransactions(parsed: CASParseResult): number {
  return (parsed.mutual_funds ?? []).reduce(
    (folioTotal, folio) =>
      folioTotal +
      (folio.schemes ?? []).reduce(
        (schemeTotal, scheme) => schemeTotal + (scheme.transactions ?? []).length,
        0,
      ),
    0,
  );
}

export interface CASImportResult {
  fundsUpdated: number;
  transactionsAdded: number;
  transactionsDuplicate: number;
  reconciliationConflicts: number;
  catalogHydrationRequested: number;
  errors: string[];
}

interface PreparedScheme {
  schemeCode: number;
  schemeName: string;
  closingUnits: number | null;
  incomingRows: IncomingEconomicRow[];
  reversals: ReversalRequest[];
}

interface PlannedScheme extends PreparedScheme {
  existingFundId: string | null;
  expectedTransactionIds: string[];
  plan: EconomicReconciliationPlan;
}

const PERSISTED_TRANSACTION_TYPES = new Set<PersistedTransactionType>([
  'purchase',
  'redemption',
  'switch_in',
  'switch_out',
  'dividend_reinvest',
]);
const RECONCILIATION_PAGE_SIZE = 1000;

export function economicGrossAmount(transaction: CanonicalCASTransaction): number {
  return roundCash(transaction.gross_amount);
}

function prepareSchemes(canonical: CanonicalCASParseResult): PreparedScheme[] {
  const bySchemeCode = new Map<number, PreparedScheme>();
  let sourceIndex = 0;

  for (const folio of canonical.mutual_funds) {
    for (const scheme of folio.schemes) {
      const schemeCode = parseInt(scheme.additional_info.amfi, 10);
      const prepared = bySchemeCode.get(schemeCode) ?? {
        schemeCode,
        schemeName: scheme.name ?? 'Unknown Fund',
        closingUnits: 0,
        incomingRows: [],
        reversals: [],
      };
      // user_fund is scheme-scoped while a CAS can carry the same plan under
      // more than one folio. Only a complete numeric closing balance may drive
      // inactivation, and it must be the sum across every occurrence.
      if (prepared.closingUnits !== null) {
        if (typeof scheme.units === 'number' && Number.isFinite(scheme.units)) {
          prepared.closingUnits += scheme.units;
        } else {
          prepared.closingUnits = null;
        }
      }

      for (const transaction of scheme.transactions) {
        const currentSourceIndex = sourceIndex++;
        if (transaction.type.toUpperCase().trim() === 'REVERSAL') {
          prepared.reversals.push({
            sourceIndex: currentSourceIndex,
            transactionDate: transaction.date,
            grossAmount: economicGrossAmount(transaction),
            units: transaction.units,
            folioNumber: folio.folio_number,
          });
          continue;
        }

        const transactionType = transaction.normalised_type;
        if (
          transactionType === null ||
          !PERSISTED_TRANSACTION_TYPES.has(transactionType as PersistedTransactionType) ||
          transaction.units === null ||
          transaction.units <= 0 ||
          transaction.gross_amount <= 0
        ) continue;

        prepared.incomingRows.push({
          sourceIndex: currentSourceIndex,
          transactionDate: transaction.date,
          transactionType: transactionType as PersistedTransactionType,
          units: transaction.units,
          grossAmount: economicGrossAmount(transaction),
          navAtTransaction: transaction.nav ?? transaction.price ?? 0,
          folioNumber: folio.folio_number,
        });
      }

      bySchemeCode.set(schemeCode, prepared);
    }
  }

  return [...bySchemeCode.values()];
}

interface ExistingSnapshotRow {
  id: string;
  fundId: string;
  economicRow: ExistingEconomicRow | null;
}

function existingSnapshotRow(value: Record<string, unknown>): ExistingSnapshotRow | null {
  const transactionType = value.transaction_type;
  const units = Number(value.units);
  const amount = Number(value.amount);
  const eventOrdinal = Number(value.cas_event_ordinal ?? 0);
  if (
    typeof value.id !== 'string' ||
    typeof value.fund_id !== 'string' ||
    typeof value.transaction_date !== 'string' ||
    typeof transactionType !== 'string' ||
    !PERSISTED_TRANSACTION_TYPES.has(transactionType as PersistedTransactionType) ||
    !Number.isInteger(eventOrdinal) ||
    eventOrdinal < 0
  ) return null;

  // Pre-Q2 rows can contain folio sentinels or non-economic zero values. They
  // remain part of the immutable-ID snapshot (so concurrency checks see them)
  // but they are not evidence against a new valid statement. Placeholder
  // folios bridge as canonical null; non-positive/non-finite economic rows are
  // ignored by reconciliation instead of bricking every future import.
  const economicRow = !Number.isFinite(units) || units <= 0
    || !Number.isFinite(amount) || amount <= 0
    ? null
    : {
      id: value.id,
      fundId: value.fund_id,
      transactionDate: value.transaction_date,
      transactionType: transactionType as PersistedTransactionType,
      units,
      amount,
      folioNumber: canonicalFolioNumber(value.folio_number),
      eventOrdinal,
      casImportId: typeof value.cas_import_id === 'string' ? value.cas_import_id : null,
    };
  return { id: value.id, fundId: value.fund_id, economicRow };
}

function reconciliationFailure(reason: CASWriteFailureReason): CASImportResult {
  return {
    fundsUpdated: 0,
    transactionsAdded: 0,
    transactionsDuplicate: 0,
    reconciliationConflicts: 0,
    catalogHydrationRequested: 0,
    errors: [auditErrorCode(reason)],
  };
}

export async function importCASData(
  supabase: SupabaseClient,
  userId: string,
  importId: string,
  parsed: CASParseResult,
): Promise<CASImportResult> {
  // A malformed provider payload must stop before the first domain read/write.
  const { parsed: canonical, summary } = assertCASPreflight(parsed);
  const preparedSchemes = prepareSchemes(canonical);
  let fundsUpdated = 0;
  let transactionsAdded = 0;
  let transactionsDuplicate = 0;
  let reconciliationConflicts = 0;
  let catalogHydrationRequested = 0;
  const errors: string[] = [];

  console.log(
    '[import-cas] preflight_passed dialect=%s folios=%s schemes=%s rows=%s',
    summary.dialect,
    summary.folios_bucket,
    summary.schemes_bucket,
    summary.rows_bucket,
  );

  // Deployment is function-first, then migration. During that short window the
  // capability RPC is absent and the new function must reject before the first
  // domain read/write rather than running against the legacy uniqueness shape.
  const schemaCapability = await supabase.rpc('cas_import_schema_version_v2');
  if (schemaCapability.error || schemaCapability.data !== 2) {
    return reconciliationFailure('reconciliation_read_failed');
  }

  // Resolve existing IDs and rows before any domain write so an ambiguity can
  // reject without inserting/deleting/updating a transaction.
  const schemeCodes = preparedSchemes.map((scheme) => scheme.schemeCode);
  const currentFundsResult = schemeCodes.length > 0
    ? await supabase
      .from('user_fund')
      .select('id, scheme_code')
      .eq('user_id', userId)
      .in('scheme_code', schemeCodes)
    : { data: [], error: null };
  if (currentFundsResult.error) {
    return reconciliationFailure('reconciliation_read_failed');
  }

  const existingFundByScheme = new Map<number, string>();
  for (const value of currentFundsResult.data ?? []) {
    const row = value as Record<string, unknown>;
    const schemeCode = Number(row.scheme_code);
    if (typeof row.id !== 'string' || !Number.isInteger(schemeCode)) {
      return reconciliationFailure('reconciliation_read_failed');
    }
    existingFundByScheme.set(schemeCode, row.id);
  }

  const existingTransactions: ExistingEconomicRow[] = [];
  const snapshotIdsByFund = new Map<string, string[]>();
  const existingFundIds = [...existingFundByScheme.values()];
  for (
    let from = 0;
    existingFundIds.length > 0;
    from += RECONCILIATION_PAGE_SIZE
  ) {
    const currentTransactionsResult = await supabase
      .from('transaction')
      .select(
        'id, fund_id, transaction_date, transaction_type, units, amount, folio_number, cas_import_id, cas_event_ordinal',
      )
      .in('fund_id', existingFundIds)
      .order('id', { ascending: true })
      .range(from, from + RECONCILIATION_PAGE_SIZE - 1);
    if (currentTransactionsResult.error) {
      return reconciliationFailure('reconciliation_read_failed');
    }

    const page = currentTransactionsResult.data ?? [];
    for (const value of page) {
      const snapshotRow = existingSnapshotRow(value as Record<string, unknown>);
      if (!snapshotRow) return reconciliationFailure('reconciliation_read_failed');
      const ids = snapshotIdsByFund.get(snapshotRow.fundId) ?? [];
      ids.push(snapshotRow.id);
      snapshotIdsByFund.set(snapshotRow.fundId, ids);
      if (snapshotRow.economicRow) existingTransactions.push(snapshotRow.economicRow);
    }
    if (page.length < RECONCILIATION_PAGE_SIZE) break;
  }

  const plannedSchemes: PlannedScheme[] = preparedSchemes.map((scheme) => {
    const existingFundId = existingFundByScheme.get(scheme.schemeCode) ?? null;
    const existing = existingFundId === null
      ? []
      : existingTransactions.filter((row) => row.fundId === existingFundId);
    return {
      ...scheme,
      existingFundId,
      expectedTransactionIds: existingFundId === null
        ? []
        : [...(snapshotIdsByFund.get(existingFundId) ?? [])].sort(),
      plan: reconcileEconomicRows(scheme.incomingRows, existing, scheme.reversals),
    };
  });

  transactionsDuplicate = plannedSchemes.reduce(
    (total, scheme) => total + scheme.plan.duplicateRows,
    0,
  );
  reconciliationConflicts = plannedSchemes.reduce(
    (total, scheme) => total + scheme.plan.conflicts.length,
    0,
  );
  if (reconciliationConflicts > 0) {
    console.warn(
      '[import-cas] reconciliation_rejected conflicts=%s duplicates=%s',
      bucketCount(reconciliationConflicts),
      bucketCount(transactionsDuplicate),
    );
    return {
      fundsUpdated: 0,
      transactionsAdded: 0,
      transactionsDuplicate,
      reconciliationConflicts,
      catalogHydrationRequested: 0,
      errors: [auditErrorCode('reconciliation_conflict')],
    };
  }

  // Q4 moves the previously separate catalog, holding, transaction, and
  // activation writes behind one service-role-only PostgreSQL transaction.
  // Existing shared catalog rows are never part of an update payload: the RPC
  // may insert a marked minimal identity only when the code is absent.
  const importPlans = plannedSchemes.map((scheme) => ({
    scheme_code: scheme.schemeCode,
    provisional_scheme_name: scheme.schemeName,
    expected_fund_id: scheme.existingFundId,
    expected_transaction_ids: scheme.expectedTransactionIds,
    closing_units: scheme.closingUnits,
    delete_ids: scheme.plan.reversalDeleteIds,
    inserts: scheme.plan.inserts.map((transaction) => ({
      transaction_date: transaction.transactionDate,
      transaction_type: transaction.transactionType,
      units: transaction.units,
      nav_at_transaction: transaction.navAtTransaction,
      amount: transaction.grossAmount,
      folio_number: transaction.folioNumber,
      cas_event_ordinal: transaction.eventOrdinal,
    })),
  }));

  if (importPlans.length > 0) {
    const mutationResult = await supabase.rpc('apply_cas_import_plans_v2', {
      p_user_id: userId,
      p_import_id: importId,
      p_plans: importPlans,
    });
    if (mutationResult.error) {
      const message = typeof mutationResult.error.message === 'string'
        ? mutationResult.error.message
        : '';
      if (message.includes('cas_snapshot_conflict')) {
        reconciliationConflicts += 1;
        errors.push(auditErrorCode('reconciliation_conflict'));
      } else {
        errors.push(auditErrorCode('transaction_write_failed'));
      }
    } else {
      const payload = Array.isArray(mutationResult.data)
        ? mutationResult.data[0]
        : mutationResult.data;
      const inserted = Number(payload?.inserted_count ?? 0);
      const deleted = Number(payload?.deleted_count ?? 0);
      const funds = Number(payload?.fund_count ?? 0);
      const provisionalSchemes = Number(payload?.provisional_scheme_count ?? 0);
      transactionsAdded += Number.isInteger(inserted) && inserted >= 0 ? inserted : 0;
      fundsUpdated += Number.isInteger(funds) && funds >= 0 ? funds : 0;
      catalogHydrationRequested += Number.isInteger(provisionalSchemes)
        && provisionalSchemes >= 0
        ? provisionalSchemes
        : 0;
      if (deleted > 0) console.log('[import-cas] reversal_delete_count=%s', bucketCount(deleted));
      console.log('[import-cas] transaction_insert_count=%s', bucketCount(transactionsAdded));
    }
  }

  console.log(
    '[import-cas] completed funds=%s transactions=%s duplicates=%s conflicts=%s write_failures=%s',
    bucketCount(fundsUpdated),
    bucketCount(transactionsAdded),
    bucketCount(transactionsDuplicate),
    bucketCount(reconciliationConflicts),
    bucketCount(errors.length),
  );
  return {
    fundsUpdated,
    transactionsAdded,
    transactionsDuplicate,
    reconciliationConflicts,
    catalogHydrationRequested,
    errors,
  };
}
