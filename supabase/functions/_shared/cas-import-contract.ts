/**
 * Provider-neutral CAS transaction contract and fail-closed preflight.
 *
 * This module is deliberately pure so both Edge Function callers and Jest can
 * exercise the exact safety boundary. Never add user identifiers, filenames,
 * folios, dates, descriptions, financial values, or upstream error strings to
 * the summaries produced here.
 */

export type CASSourceDialect =
  | 'cams'
  | 'kfintech'
  | 'mfcentral'
  | 'cdsl'
  | 'nsdl'
  | 'unknown_standard';

export type CASImportSource = 'pdf' | 'email';

export type CASPreflightReason =
  | 'empty_payload'
  | 'missing_scheme_identity'
  | 'invalid_isin'
  | 'invalid_folio'
  | 'invalid_date'
  | 'unsupported_transaction_type'
  | 'invalid_amount'
  | 'invalid_units'
  | 'invalid_nav'
  | 'invalid_price'
  | 'direction_mismatch'
  | 'nav_price_mismatch'
  | 'accounting_mismatch'
  | 'no_actionable_transactions';

export type CASWriteFailureReason =
  | 'scheme_write_failed'
  | 'fund_write_failed'
  | 'transaction_write_failed';

export type CASFailureReason =
  | CASPreflightReason
  | CASWriteFailureReason
  | 'wrong_password'
  | 'holdings_only'
  | 'parser_error'
  | 'attachment_download_failed'
  | 'no_pdf_attachments'
  | 'background_crashed';

export type CASCountBucket = '0' | '1' | '2-5' | '6-20' | '21-100' | '101+';

export interface CASSchemeAdditionalInfo {
  amfi?: string;
  rta_code?: string;
  advisor?: string;
  open_units?: number | null;
  close_units?: number | null;
}

export interface CASCharges {
  stamp_duty?: number;
  taxes?: number;
  exit_load?: number;
  other?: number;
}

export interface CASTransaction {
  date?: string;
  type?: string;
  description?: string;
  amount?: number;
  source_amount?: number;
  gross_amount?: number;
  units?: number | null;
  source_units?: number | null;
  nav?: number | null;
  price?: number | null;
  stamp_duty?: number | null;
  charges?: CASCharges;
  balance?: number | null;
}

export interface CASScheme {
  name?: string;
  isin?: string;
  type?: string;
  units?: number | null;
  nav?: number | null;
  value?: number | null;
  additional_info?: CASSchemeAdditionalInfo;
  transactions?: CASTransaction[];
}

export interface CASFolio {
  folio_number?: string | null;
  amc?: string;
  schemes?: CASScheme[];
}

export interface CASParseResult {
  contract_version?: number;
  source_dialect?: CASSourceDialect | string;
  mutual_funds?: CASFolio[];
}

export type NormalisedTransactionType =
  | 'purchase'
  | 'redemption'
  | 'switch_in'
  | 'switch_out'
  | 'dividend_reinvest'
  | 'dividend';

export type TransactionDirection = 'in' | 'out' | 'cash' | 'ignored';

export type CanonicalCASTransaction = Omit<
  CASTransaction,
  'date' | 'type' | 'description' | 'source_amount' | 'gross_amount' | 'units' | 'source_units' | 'nav' | 'price' | 'stamp_duty' | 'charges'
> & {
  date: string;
  type: string;
  normalised_type: NormalisedTransactionType | null;
  direction: TransactionDirection;
  source_amount: number;
  gross_amount: number;
  units: number | null;
  source_units: number | null;
  nav: number | null;
  price: number | null;
  stamp_duty: number;
  charges: Required<CASCharges>;
};

export type CanonicalCASScheme = Omit<CASScheme, 'isin' | 'additional_info' | 'transactions'> & {
  isin: string;
  additional_info: CASSchemeAdditionalInfo & { amfi: string };
  transactions: CanonicalCASTransaction[];
};

export type CanonicalCASFolio = Omit<CASFolio, 'folio_number' | 'schemes'> & {
  folio_number: string | null;
  schemes: CanonicalCASScheme[];
};

export type CanonicalCASParseResult = Omit<
  CASParseResult,
  'contract_version' | 'source_dialect' | 'mutual_funds'
> & {
  contract_version: 1;
  source_dialect: CASSourceDialect;
  mutual_funds: CanonicalCASFolio[];
};

export interface CASPreflightSummary {
  dialect: CASSourceDialect;
  folios_bucket: CASCountBucket;
  schemes_bucket: CASCountBucket;
  rows_bucket: CASCountBucket;
  valid_rows_bucket: CASCountBucket;
  rejected_rows_bucket: CASCountBucket;
}

export type CASPreflightResult =
  | {
      ok: true;
      parsed: CanonicalCASParseResult;
      summary: CASPreflightSummary;
    }
  | {
      ok: false;
      reason: CASPreflightReason;
      summary: CASPreflightSummary;
    };

export class CASPreflightError extends Error {
  readonly reason: CASPreflightReason;
  readonly summary: CASPreflightSummary;

  constructor(reason: CASPreflightReason, summary: CASPreflightSummary) {
    super(`cas_preflight:${reason}`);
    this.name = 'CASPreflightError';
    this.reason = reason;
    this.summary = summary;
  }
}

const DIALECTS = new Set<CASSourceDialect>([
  'cams',
  'kfintech',
  'mfcentral',
  'cdsl',
  'nsdl',
  'unknown_standard',
]);

const FAILURE_REASONS = new Set<CASFailureReason>([
  'empty_payload',
  'missing_scheme_identity',
  'invalid_isin',
  'invalid_folio',
  'invalid_date',
  'unsupported_transaction_type',
  'invalid_amount',
  'invalid_units',
  'invalid_nav',
  'invalid_price',
  'direction_mismatch',
  'nav_price_mismatch',
  'accounting_mismatch',
  'no_actionable_transactions',
  'scheme_write_failed',
  'fund_write_failed',
  'transaction_write_failed',
  'wrong_password',
  'holdings_only',
  'parser_error',
  'attachment_download_failed',
  'no_pdf_attachments',
  'background_crashed',
]);

const PLACEHOLDER_FOLIOS = new Set([
  'NO',
  'CDSL',
  'NSDL',
  'N/A',
  'NA',
  'NONE',
  'UNKNOWN',
  '-',
]);

const IGNORED_TRANSACTION_TYPES = new Set([
  'REVERSAL',
  'SEGREGATION',
  'STAMP_DUTY_TAX',
  'TDS_TAX',
  'STT_TAX',
  'MISC',
]);

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function absoluteNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null ? null : Math.abs(number);
}

function dialectOf(value: unknown): CASSourceDialect {
  return typeof value === 'string' && DIALECTS.has(value as CASSourceDialect)
    ? value as CASSourceDialect
    : 'unknown_standard';
}

export function bucketCount(count: number): CASCountBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2-5';
  if (count <= 20) return '6-20';
  if (count <= 100) return '21-100';
  return '101+';
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function parseDate(raw: string): string {
  const value = raw.trim();
  if (validIsoDate(value)) return value;
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(value);
  if (!match) return value;
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return value;
  const normalized = `${match[3]}-${month}-${match[1]}`;
  return validIsoDate(normalized) ? normalized : value;
}

export function normaliseTxType(raw: string): NormalisedTransactionType | null {
  if (!raw) return null;
  const upper = raw.toUpperCase().trim();

  if (upper === 'PURCHASE' || upper === 'PURCHASE_SIP') return 'purchase';
  if (upper === 'REDEMPTION') return 'redemption';
  if (upper === 'SWITCH_IN' || upper === 'SWITCH_IN_MERGER') return 'switch_in';
  if (upper === 'SWITCH_OUT' || upper === 'SWITCH_OUT_MERGER') return 'switch_out';
  if (upper === 'DIVIDEND_REINVEST') return 'dividend_reinvest';
  if (upper === 'DIVIDEND_PAYOUT' || upper === 'DIVIDEND') return 'dividend';

  if (IGNORED_TRANSACTION_TYPES.has(upper)) return null;

  const lower = raw.toLowerCase().trim();
  if (lower === 'purchase' || lower === 'buy' || lower === 'sip') return 'purchase';
  if (lower.includes('switch in')) return 'switch_in';
  if (lower.includes('switch out')) return 'switch_out';
  if (lower.includes('redempt') || lower.includes('withdrawal')) return 'redemption';
  if (lower.includes('dividend reinvest')) return 'dividend_reinvest';
  if (lower.includes('dividend')) return 'dividend';
  return null;
}

function directionFor(type: NormalisedTransactionType | null): TransactionDirection {
  if (type === 'purchase' || type === 'switch_in' || type === 'dividend_reinvest') return 'in';
  if (type === 'redemption' || type === 'switch_out') return 'out';
  if (type === 'dividend') return 'cash';
  return 'ignored';
}

function canonicalTransaction(transaction: CASTransaction): CanonicalCASTransaction {
  const { description: _description, ...safeTransaction } = transaction;
  const type = (transaction.type ?? transaction.description ?? '').trim();
  const normalisedType = normaliseTxType(type);
  const sourceAmount = finiteNumber(transaction.source_amount ?? transaction.amount) ?? 0;
  const explicitGrossAmount = finiteNumber(transaction.gross_amount);
  const grossAmount = explicitGrossAmount ?? Math.abs(sourceAmount);
  const stampDuty = absoluteNumber(transaction.stamp_duty ?? transaction.charges?.stamp_duty) ?? 0;
  const nav = finiteNumber(transaction.nav);
  const price = finiteNumber(transaction.price) ?? nav;
  const sourceUnits = finiteNumber(transaction.source_units ?? transaction.units);
  const units = absoluteNumber(sourceUnits);

  return {
    ...safeTransaction,
    date: parseDate(transaction.date ?? ''),
    type,
    normalised_type: normalisedType,
    direction: directionFor(normalisedType),
    amount: Math.abs(sourceAmount),
    source_amount: sourceAmount,
    gross_amount: grossAmount,
    units,
    source_units: sourceUnits,
    nav,
    price,
    stamp_duty: stampDuty,
    charges: {
      stamp_duty: stampDuty,
      taxes: absoluteNumber(transaction.charges?.taxes) ?? 0,
      exit_load: absoluteNumber(transaction.charges?.exit_load) ?? 0,
      other: absoluteNumber(transaction.charges?.other) ?? 0,
    },
  };
}

function canonicalPayload(parsed: CASParseResult): CanonicalCASParseResult {
  return {
    ...parsed,
    contract_version: 1,
    source_dialect: dialectOf(parsed.source_dialect),
    mutual_funds: (parsed.mutual_funds ?? []).map((folio) => ({
      ...folio,
      folio_number: folio.folio_number?.trim() || null,
      schemes: (folio.schemes ?? []).map((scheme) => ({
        ...scheme,
        isin: scheme.isin?.trim().toUpperCase() ?? '',
        additional_info: {
          ...(scheme.additional_info ?? {}),
          amfi: scheme.additional_info?.amfi?.trim() ?? '',
        },
        transactions: (scheme.transactions ?? []).map(canonicalTransaction),
      })),
    })),
  };
}

function counts(parsed: CanonicalCASParseResult) {
  const schemes = parsed.mutual_funds.flatMap((folio) => folio.schemes);
  const rows = schemes.flatMap((scheme) => scheme.transactions);
  return { schemes, rows };
}

function summaryFor(
  parsed: CanonicalCASParseResult,
  validRows: number,
  rejectedRows: number,
): CASPreflightSummary {
  const { schemes, rows } = counts(parsed);
  return {
    dialect: parsed.source_dialect,
    folios_bucket: bucketCount(parsed.mutual_funds.length),
    schemes_bucket: bucketCount(schemes.length),
    rows_bucket: bucketCount(rows.length),
    valid_rows_bucket: bucketCount(validRows),
    rejected_rows_bucket: bucketCount(rejectedRows),
  };
}

function invalidResult(
  parsed: CanonicalCASParseResult,
  reason: CASPreflightReason,
  validRows: number,
): CASPreflightResult {
  const { rows } = counts(parsed);
  return {
    ok: false,
    reason,
    summary: summaryFor(parsed, validRows, Math.max(1, rows.length - validRows)),
  };
}

function accountingMatches(transaction: CanonicalCASTransaction): boolean {
  const price = transaction.price ?? transaction.nav ?? 0;
  const units = transaction.units ?? 0;
  const base = price * units;
  const charges = transaction.charges.stamp_duty
    + transaction.charges.taxes
    + transaction.charges.exit_load
    + transaction.charges.other;
  const cashCandidates = [Math.abs(transaction.source_amount), transaction.gross_amount];
  const expectedCandidates = transaction.direction === 'in'
    ? [base, base + charges]
    : [base, Math.max(0, base - charges)];
  // Charges are represented explicitly in the expected candidates; treating
  // their full value as rounding tolerance would make +charge and -charge
  // equations indistinguishable.
  const tolerance = Math.max(1, transaction.gross_amount * 0.002);

  return cashCandidates.some((cash) =>
    expectedCandidates.some((expected) => Math.abs(cash - expected) <= tolerance));
}

export function preflightCASPayload(input: CASParseResult): CASPreflightResult {
  const parsed = canonicalPayload(input);
  const { schemes, rows } = counts(parsed);
  if (parsed.mutual_funds.length === 0 || schemes.length === 0 || rows.length === 0) {
    return invalidResult(parsed, 'empty_payload', 0);
  }

  let validRows = 0;
  let actionableRows = 0;

  for (const folio of parsed.mutual_funds) {
    if (folio.schemes.length === 0) {
      return invalidResult(parsed, 'empty_payload', validRows);
    }
    if (folio.folio_number && PLACEHOLDER_FOLIOS.has(folio.folio_number.toUpperCase())) {
      return invalidResult(parsed, 'invalid_folio', validRows);
    }

    for (const scheme of folio.schemes) {
      if (scheme.transactions.length === 0) {
        return invalidResult(parsed, 'empty_payload', validRows);
      }
      if (!scheme.additional_info.amfi || !/^\d+$/.test(scheme.additional_info.amfi)) {
        return invalidResult(parsed, 'missing_scheme_identity', validRows);
      }
      if (!/^INF[A-Z0-9]{9}$/.test(scheme.isin)) {
        return invalidResult(parsed, 'invalid_isin', validRows);
      }

      for (const transaction of scheme.transactions) {
        if (!validIsoDate(transaction.date)) {
          return invalidResult(parsed, 'invalid_date', validRows);
        }

        const upperType = transaction.type.toUpperCase().trim();
        const ignored = IGNORED_TRANSACTION_TYPES.has(upperType);
        if (transaction.normalised_type === null && !ignored) {
          return invalidResult(parsed, 'unsupported_transaction_type', validRows);
        }

        if (ignored) {
          validRows++;
          continue;
        }

        actionableRows++;
        if (Math.abs(transaction.source_amount) <= 0 || transaction.gross_amount <= 0) {
          return invalidResult(parsed, 'invalid_amount', validRows);
        }

        if (transaction.normalised_type === 'dividend') {
          validRows++;
          continue;
        }

        if (transaction.units === null || transaction.units <= 0) {
          return invalidResult(parsed, 'invalid_units', validRows);
        }
        if (
          transaction.source_units !== null
          && transaction.source_amount !== 0
          && Math.sign(transaction.source_units) !== Math.sign(transaction.source_amount)
        ) {
          return invalidResult(parsed, 'direction_mismatch', validRows);
        }
        // Outflows may arrive as unsigned magnitudes or as a negative signed
        // pair. An inflow may never carry a negative signed pair.
        if (
          transaction.direction === 'in'
          && (transaction.source_amount < 0 || (transaction.source_units ?? 0) < 0)
        ) {
          return invalidResult(parsed, 'direction_mismatch', validRows);
        }
        if (transaction.nav !== null && transaction.nav <= 0) {
          return invalidResult(parsed, 'invalid_nav', validRows);
        }
        if (transaction.price === null || transaction.price <= 0) {
          return invalidResult(parsed, 'invalid_price', validRows);
        }
        if (transaction.nav !== null) {
          const navPriceDelta = Math.abs(transaction.nav - transaction.price);
          const navPriceTolerance = Math.max(transaction.nav, transaction.price) * 0.05;
          if (navPriceDelta > navPriceTolerance) {
            return invalidResult(parsed, 'nav_price_mismatch', validRows);
          }
        }
        if (!accountingMatches(transaction)) {
          return invalidResult(parsed, 'accounting_mismatch', validRows);
        }
        validRows++;
      }
    }
  }

  if (actionableRows === 0) {
    return invalidResult(parsed, 'no_actionable_transactions', validRows);
  }

  return {
    ok: true,
    parsed,
    summary: summaryFor(parsed, validRows, 0),
  };
}

export function assertCASPreflight(input: CASParseResult): {
  parsed: CanonicalCASParseResult;
  summary: CASPreflightSummary;
} {
  const result = preflightCASPayload(input);
  if (!result.ok) throw new CASPreflightError(result.reason, result.summary);
  return result;
}

const USER_FAILURE_MESSAGES: Record<CASFailureReason, string> = {
  empty_payload: 'This PDF does not contain a complete transaction history.',
  missing_scheme_identity: 'A fund in this statement could not be identified safely.',
  invalid_isin: 'A fund in this statement could not be identified safely.',
  invalid_folio: 'This statement contains an unsupported folio layout.',
  invalid_date: 'This statement contains an invalid transaction date.',
  unsupported_transaction_type: 'This statement contains an unsupported transaction type.',
  invalid_amount: 'This statement contains an invalid transaction amount.',
  invalid_units: 'This statement contains invalid transaction units.',
  invalid_nav: 'This statement contains an invalid NAV.',
  invalid_price: 'This statement contains an invalid transaction price.',
  direction_mismatch: 'This statement contains inconsistent transaction directions.',
  nav_price_mismatch: 'This statement has inconsistent NAV and transaction-price values.',
  accounting_mismatch: 'This statement has transactions whose cash and units do not reconcile.',
  no_actionable_transactions: 'This PDF has no importable mutual-fund transactions.',
  scheme_write_failed: 'A fund could not be saved. No further rows for that fund were imported.',
  fund_write_failed: 'A portfolio holding could not be saved.',
  transaction_write_failed: 'One or more transactions could not be saved.',
  wrong_password: 'The PDF password was not accepted. Check the password saved in FolioLens.',
  holdings_only: 'This PDF has holdings but no transaction history. Please upload a Detailed CAS.',
  parser_error: 'This PDF could not be parsed safely.',
  attachment_download_failed: 'An attached PDF could not be downloaded. Please forward the CAS again.',
  no_pdf_attachments: 'No PDF attachment was found in this email.',
  background_crashed: 'The import stopped unexpectedly before it could complete. Please try again.',
};

export function userMessageForCASFailure(reason: CASFailureReason): string {
  return USER_FAILURE_MESSAGES[reason];
}

export function auditErrorCode(reason: CASFailureReason): string {
  return `cas_import:${reason}`;
}

export function safeCASFailureReason(value: unknown): CASFailureReason {
  return typeof value === 'string' && FAILURE_REASONS.has(value as CASFailureReason)
    ? value as CASFailureReason
    : 'parser_error';
}

export function reasonFromAuditError(code: string): CASFailureReason {
  return safeCASFailureReason(code.startsWith('cas_import:') ? code.slice('cas_import:'.length) : code);
}

export function buildPreflightFailureOutcome(
  source: CASImportSource,
  error: CASPreflightError,
) {
  return {
    audit: {
      import_status: 'failed' as const,
      funds_updated: 0,
      transactions_added: 0,
      error_message: auditErrorCode(error.reason),
    },
    response: {
      status: 422,
      body: {
        error: userMessageForCASFailure(error.reason),
        reason: error.reason,
      },
    },
    notification: {
      status: 'failed' as const,
      funds: 0,
      transactions: 0,
      errors: [userMessageForCASFailure(error.reason)],
    },
    telemetry: {
      source,
      dialect: error.summary.dialect,
      status: 'rejected',
      failure_reason: error.reason,
      rows_bucket: error.summary.rows_bucket,
      valid_rows_bucket: error.summary.valid_rows_bucket,
      rejected_rows_bucket: error.summary.rejected_rows_bucket,
    },
  };
}

export function buildImportSuccessTelemetry({
  source,
  dialect,
  fundsUpdated,
  transactionsAdded,
  writeFailures,
}: {
  source: CASImportSource;
  dialect: CASSourceDialect;
  fundsUpdated: number;
  transactionsAdded: number;
  writeFailures: number;
}) {
  return {
    source,
    dialect,
    status: writeFailures > 0 ? 'partial' : 'accepted',
    funds_bucket: bucketCount(fundsUpdated),
    transactions_bucket: bucketCount(transactionsAdded),
    write_failures_bucket: bucketCount(writeFailures),
    validation_reason: 'validated',
  };
}

export function buildImportOutcome({
  source,
  dialect,
  fundsUpdated,
  transactionsAdded,
  errors,
}: {
  source: CASImportSource;
  dialect: CASSourceDialect;
  fundsUpdated: number;
  transactionsAdded: number;
  errors: string[];
}) {
  const status: 'success' | 'failed' = errors.length > 0 && fundsUpdated === 0
    ? 'failed'
    : 'success';
  const safeReasons = errors.map(reasonFromAuditError);
  return {
    status,
    audit: {
      import_status: status,
      funds_updated: fundsUpdated,
      transactions_added: transactionsAdded,
      error_message: errors.length > 0
        ? safeReasons.map(auditErrorCode).join('; ')
        : null,
    },
    response: {
      ok: status === 'success',
      funds: fundsUpdated,
      transactions: transactionsAdded,
    },
    notification: {
      status,
      funds: fundsUpdated,
      transactions: transactionsAdded,
      errors: safeReasons.map(userMessageForCASFailure),
    },
    telemetry: buildImportSuccessTelemetry({
      source,
      dialect,
      fundsUpdated,
      transactionsAdded,
      writeFailures: errors.length,
    }),
  };
}
