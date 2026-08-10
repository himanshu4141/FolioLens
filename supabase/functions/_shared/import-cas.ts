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
}

import {
  assertCASPreflight,
  auditErrorCode,
  bucketCount,
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
  errors: string[];
}

interface PreparedScheme {
  schemeCode: number;
  schemeName: string;
  schemeCategory: string;
  closingUnits: number | null;
  incomingRows: IncomingEconomicRow[];
  reversals: ReversalRequest[];
}

interface PlannedScheme extends PreparedScheme {
  existingFundId: string | null;
  plan: EconomicReconciliationPlan;
}

interface WritableScheme extends PlannedScheme {
  fundId: string;
}

const PERSISTED_TRANSACTION_TYPES = new Set<PersistedTransactionType>([
  'purchase',
  'redemption',
  'switch_in',
  'switch_out',
  'dividend_reinvest',
]);
const INVALID_EXISTING_FOLIOS = new Set([
  'NO',
  'CDSL',
  'NSDL',
  'N/A',
  'NA',
  'NONE',
  'UNKNOWN',
  '-',
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
        schemeCategory: scheme.type ?? 'Flexi Cap Fund',
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

function existingEconomicRow(value: Record<string, unknown>): ExistingEconomicRow | null {
  const transactionType = value.transaction_type;
  const units = Number(value.units);
  const amount = Number(value.amount);
  const eventOrdinal = Number(value.cas_event_ordinal ?? 0);
  const folioNumber = typeof value.folio_number === 'string'
    ? value.folio_number.trim() || null
    : null;
  if (
    typeof value.id !== 'string' ||
    typeof value.fund_id !== 'string' ||
    typeof value.transaction_date !== 'string' ||
    typeof transactionType !== 'string' ||
    !PERSISTED_TRANSACTION_TYPES.has(transactionType as PersistedTransactionType) ||
    !Number.isFinite(units) ||
    units <= 0 ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isInteger(eventOrdinal) ||
    eventOrdinal < 0 ||
    (folioNumber !== null && INVALID_EXISTING_FOLIOS.has(folioNumber.toUpperCase()))
  ) return null;

  return {
    id: value.id,
    fundId: value.fund_id,
    transactionDate: value.transaction_date,
    transactionType: transactionType as PersistedTransactionType,
    units,
    amount,
    folioNumber,
    eventOrdinal,
    casImportId: typeof value.cas_import_id === 'string' ? value.cas_import_id : null,
  };
}

function reconciliationFailure(reason: CASWriteFailureReason): CASImportResult {
  return {
    fundsUpdated: 0,
    transactionsAdded: 0,
    transactionsDuplicate: 0,
    reconciliationConflicts: 0,
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
  const errors: string[] = [];

  console.log(
    '[import-cas] preflight_passed dialect=%s folios=%s schemes=%s rows=%s',
    summary.dialect,
    summary.folios_bucket,
    summary.schemes_bucket,
    summary.rows_bucket,
  );

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
      const row = existingEconomicRow(value as Record<string, unknown>);
      if (!row) return reconciliationFailure('reconciliation_read_failed');
      existingTransactions.push(row);
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
      errors: [auditErrorCode('reconciliation_conflict')],
    };
  }

  // Q4 will make the remaining catalog/fund/transaction writes atomic. Q3
  // guarantees the transaction plan itself is complete before they begin.
  const { data: benchmarks } = await supabase
    .from('benchmark_mapping')
    .select('scheme_category, benchmark_index, benchmark_index_symbol');

  const benchmarkMap = new Map<string, { index: string; symbol: string }>();
  for (const value of benchmarks ?? []) {
    const benchmark = value as {
      scheme_category: string;
      benchmark_index: string;
      benchmark_index_symbol: string;
    };
    benchmarkMap.set(benchmark.scheme_category, {
      index: benchmark.benchmark_index,
      symbol: benchmark.benchmark_index_symbol,
    });
  }

  const writableSchemes: WritableScheme[] = [];
  for (const scheme of plannedSchemes) {
    const benchmark = benchmarkMap.get(scheme.schemeCategory)
      ?? benchmarkMap.get('Flexi Cap Fund');
    const { error: schemeError } = await supabase
      .from('scheme_master')
      .upsert(
        {
          scheme_code: scheme.schemeCode,
          scheme_name: scheme.schemeName,
          scheme_category: scheme.schemeCategory,
          benchmark_index: benchmark?.index ?? null,
          benchmark_index_symbol: benchmark?.symbol ?? null,
        },
        { onConflict: 'scheme_code' },
      );
    if (schemeError) {
      errors.push(auditErrorCode('scheme_write_failed'));
      continue;
    }

    const { data: fundRow, error: fundError } = await supabase
      .from('user_fund')
      .upsert(
        {
          user_id: userId,
          scheme_code: scheme.schemeCode,
          is_active: true,
        },
        { onConflict: 'user_id,scheme_code' },
      )
      .select('id')
      .single();
    if (fundError || !fundRow) {
      errors.push(auditErrorCode('fund_write_failed'));
      continue;
    }

    fundsUpdated++;
    writableSchemes.push({ ...scheme, fundId: fundRow.id as string });
  }

  for (const scheme of writableSchemes) {
    let deleteFailed = false;
    for (const transactionId of scheme.plan.reversalDeleteIds) {
      const { error: deleteError } = await supabase
        .from('transaction')
        .delete()
        .eq('id', transactionId)
        .eq('fund_id', scheme.fundId);
      if (deleteError) {
        errors.push(auditErrorCode('transaction_write_failed'));
        deleteFailed = true;
        break;
      }
      console.log('[import-cas] reversal_delete_exact');
    }
    if (deleteFailed) continue;

    const transactionRows = scheme.plan.inserts.map((transaction) => ({
      user_id: userId,
      fund_id: scheme.fundId,
      transaction_date: transaction.transactionDate,
      transaction_type: transaction.transactionType,
      units: transaction.units,
      nav_at_transaction: transaction.navAtTransaction,
      amount: transaction.grossAmount,
      folio_number: transaction.folioNumber,
      cas_import_id: importId,
      cas_event_ordinal: transaction.eventOrdinal,
    }));

    if (
      scheme.closingUnits === 0 &&
      transactionRows.length === 0 &&
      scheme.plan.duplicateRows === 0 &&
      scheme.plan.matchedGroups === 0
    ) {
      await supabase
        .from('user_fund')
        .update({ is_active: false })
        .eq('id', scheme.fundId);
      console.log('[import-cas] inactive_holding_update_attempted');
      continue;
    }

    if (transactionRows.length > 0) {
      const { error: transactionError, count } = await supabase
        .from('transaction')
        .upsert(transactionRows, {
          onConflict:
            'fund_id,transaction_date,transaction_type,units,amount,folio_number,cas_event_ordinal',
          ignoreDuplicates: true,
          count: 'exact',
        });
      if (transactionError) {
        errors.push(auditErrorCode('transaction_write_failed'));
      } else {
        const inserted = count ?? 0;
        transactionsAdded += inserted;
        console.log('[import-cas] transaction_insert_count=%s', bucketCount(inserted));
      }
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
    errors,
  };
}
