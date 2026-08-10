import {
  CASPreflightError,
  assertCASPreflight,
  auditErrorCode,
  bucketCount,
  buildImportCrashOutcome,
  buildImportOutcome,
  buildImportSuccessTelemetry,
  buildPreflightFailureOutcome,
  importFailureHttpStatus,
  preflightCASPayload,
  userMessageForCASFailure,
  type CASParseResult,
  type CASSourceDialect,
  type CASTransaction,
} from '../cas-import-contract';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROVIDERS: CASSourceDialect[] = [
  'cams',
  'kfintech',
  'mfcentral',
  'cdsl',
  'nsdl',
];

function validTransaction(overrides: Partial<CASTransaction> = {}): CASTransaction {
  return {
    date: '2026-07-01',
    type: 'PURCHASE',
    amount: 1005.05,
    source_amount: 1005.05,
    gross_amount: 1005.05,
    stamp_duty: 0.05,
    charges: { stamp_duty: 0.05 },
    nav: 100,
    price: 100.5,
    units: 10,
    ...overrides,
  };
}

function payload(
  dialect: CASSourceDialect = 'cams',
  transactions: CASTransaction[] = [validTransaction()],
): CASParseResult {
  return {
    source_dialect: dialect,
    mutual_funds: [{
      folio_number: 'SYNTHETIC-01',
      schemes: [{
        name: 'Synthetic Mutual Fund - Growth',
        isin: 'INF000A00001',
        additional_info: { amfi: '100001' },
        transactions,
      }],
    }],
  };
}

describe('CAS import preflight contract', () => {
  it.each(PROVIDERS)('accepts a canonical %s fixture', (dialect) => {
    const result = preflightCASPayload(payload(dialect));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.source_dialect).toBe(dialect);
    expect(result.parsed.contract_version).toBe(1);
    expect(result.parsed.mutual_funds[0].schemes[0].transactions[0]).toMatchObject({
      source_amount: 1005.05,
      gross_amount: 1005.05,
      stamp_duty: 0.05,
      nav: 100,
      price: 100.5,
      units: 10,
      normalised_type: 'purchase',
      direction: 'in',
      cash_basis: 'source',
    });
  });

  it('uses transaction Price rather than NAV for the accounting equation', () => {
    const result = preflightCASPayload(payload('cams', [validTransaction({
      amount: 1010,
      source_amount: 1010,
      gross_amount: 1010,
      stamp_duty: 0,
      charges: {},
      nav: 100,
      price: 101,
      units: 10,
    })]));

    expect(result.ok).toBe(true);
  });

  it.each([
    ['missing date', { date: '' }, 'invalid_date'],
    ['impossible calendar date', { date: '2026-02-30' }, 'invalid_date'],
    ['unknown type', { type: 'FUTURE_UNMAPPED_EVENT' }, 'unsupported_transaction_type'],
    ['zero amount', { amount: 0, source_amount: 0, gross_amount: 0 }, 'invalid_amount'],
    ['opposite source signs', { units: -10 }, 'direction_mismatch'],
    ['zero units', { units: 0 }, 'invalid_units'],
    ['zero NAV', { nav: 0 }, 'invalid_nav'],
    ['zero Price', { price: 0 }, 'invalid_price'],
    ['shifted NAV/Price', { nav: 0.05, price: 100 }, 'nav_price_mismatch'],
    ['impossible cash equation', { amount: 5000, source_amount: 5000, gross_amount: 5000 }, 'accounting_mismatch'],
  ] as const)('handles %s garbage input', (_label, overrides, reason) => {
    const result = preflightCASPayload(payload('nsdl', [validTransaction(overrides)]));

    if (reason === null) {
      expect(result.ok).toBe(true);
    } else {
      expect(result).toMatchObject({ ok: false, reason });
    }
  });

  it('retains signed redemption inputs while canonicalizing magnitudes and direction', () => {
    const result = preflightCASPayload(payload('cams', [{
      date: '2026-07-01',
      type: 'REDEMPTION',
      amount: -1200,
      units: -10,
      nav: 120,
    }]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.mutual_funds[0].schemes[0].transactions[0]).toMatchObject({
      source_amount: -1200,
      gross_amount: 1200,
      source_units: -10,
      units: 10,
      direction: 'out',
    });
  });

  it('rejects a negative signed purchase pair despite matching signs', () => {
    const result = preflightCASPayload(payload('cams', [validTransaction({
      amount: -1000,
      source_amount: -1000,
      gross_amount: 1000,
      units: 10,
      source_units: 10,
    })]));

    expect(result).toMatchObject({ ok: false, reason: 'direction_mismatch' });
  });

  it.each([
    ['nav', 'invalid_nav'],
    ['price', 'invalid_price'],
  ] as const)('rejects a negative %s instead of taking its magnitude', (field, reason) => {
    const result = preflightCASPayload(payload('cams', [validTransaction({ [field]: -100 })]));
    expect(result).toMatchObject({ ok: false, reason });
  });

  it('uses direction-specific charge equations', () => {
    const purchase = preflightCASPayload(payload('cams', [validTransaction({
      amount: 990,
      source_amount: 990,
      gross_amount: 990,
      stamp_duty: 10,
      charges: { stamp_duty: 10 },
    })]));
    expect(purchase).toMatchObject({ ok: false, reason: 'accounting_mismatch' });

    const redemption = preflightCASPayload(payload('cams', [validTransaction({
      type: 'REDEMPTION',
      amount: 1015,
      source_amount: 1015,
      gross_amount: 1015,
      stamp_duty: 10,
      charges: { stamp_duty: 10 },
    })]));
    expect(redemption).toMatchObject({ ok: false, reason: 'accounting_mismatch' });
  });

  it.each([
    ['inflated gross', { source_amount: 1005.05, gross_amount: 1_000_000_000 }],
    ['inflated source', { amount: 500_000, source_amount: 500_000, gross_amount: 500_000_000 }],
    ['unreconciled source/gross', { source_amount: 1005.05, gross_amount: 1015.05 }],
  ])('rejects %s without allowing cash to widen its own tolerance', (_label, overrides) => {
    expect(preflightCASPayload(payload('cams', [validTransaction(overrides)]))).toMatchObject({
      ok: false,
      reason: 'accounting_mismatch',
    });
  });

  it('rejects finite scalars whose derived accounting values overflow', () => {
    expect(preflightCASPayload(payload('cams', [validTransaction({
      amount: 1e308,
      source_amount: 1e308,
      gross_amount: 1e308,
      nav: null,
      price: 1e308,
      units: 1e308,
    })]))).toMatchObject({ ok: false, reason: 'accounting_mismatch' });
  });

  it.each(['No', 'CDSL', 'NSDL', 'N/A'])('rejects placeholder folio %s', (folio) => {
    const candidate = payload();
    candidate.mutual_funds![0].folio_number = folio;

    expect(preflightCASPayload(candidate)).toMatchObject({
      ok: false,
      reason: 'invalid_folio',
    });
  });

  it('allows a genuinely missing folio as canonical null', () => {
    const candidate = payload();
    candidate.mutual_funds![0].folio_number = null;

    const result = preflightCASPayload(candidate);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parsed.mutual_funds[0].folio_number).toBeNull();
  });

  it.each([
    ['missing AMFI', { amfi: '' }, 'missing_scheme_identity'],
    ['non-numeric AMFI', { amfi: 'ABC' }, 'missing_scheme_identity'],
    ['zero AMFI', { amfi: '0' }, 'missing_scheme_identity'],
    ['overlong AMFI', { amfi: '9'.repeat(5000) }, 'missing_scheme_identity'],
  ])('rejects %s', (_label, additionalInfo, reason) => {
    const candidate = payload();
    candidate.mutual_funds![0].schemes![0].additional_info = additionalInfo;
    expect(preflightCASPayload(candidate)).toMatchObject({ ok: false, reason });
  });

  it('rejects a malformed ISIN', () => {
    const candidate = payload();
    candidate.mutual_funds![0].schemes![0].isin = 'NOT-AN-ISIN';
    expect(preflightCASPayload(candidate)).toMatchObject({ ok: false, reason: 'invalid_isin' });
  });

  it('rejects a mixed valid/corrupt payload as one unit', () => {
    const candidate = payload('kfintech');
    candidate.mutual_funds![0].schemes!.push({
      name: 'Synthetic Corrupt Fund',
      isin: 'INF000A00002',
      additional_info: { amfi: '100002' },
      transactions: [validTransaction({
        amount: 9000,
        source_amount: 9000,
        gross_amount: 9000,
      })],
    });

    expect(preflightCASPayload(candidate)).toMatchObject({
      ok: false,
      reason: 'accounting_mismatch',
    });
  });

  it.each([
    [{ mutual_funds: [] }, 'empty_payload'],
    [{ mutual_funds: [{ schemes: [] }] }, 'empty_payload'],
    [payload('cams', []), 'empty_payload'],
  ])('rejects empty or truncated payload %#', (candidate, reason) => {
    expect(preflightCASPayload(candidate as CASParseResult)).toMatchObject({ ok: false, reason });
  });

  it.each([
    null,
    [],
    {},
    { mutual_funds: {} },
    { mutual_funds: [null] },
    { mutual_funds: [{ schemes: {} }] },
    { mutual_funds: [{ schemes: [null] }] },
    { mutual_funds: [{ schemes: [{ additional_info: [], transactions: [] }] }] },
    { mutual_funds: [{ schemes: [{ additional_info: {}, transactions: {} }] }] },
    { mutual_funds: [{ schemes: [{ additional_info: {}, transactions: [null] }] }] },
    {
      mutual_funds: [{
        schemes: [{
          additional_info: {},
          transactions: [{ date: '2026-07-01', type: 'PURCHASE', charges: [] }],
        }],
      }],
    },
  ])('turns malformed runtime shape %# into an allowlisted rejection', (candidate) => {
    expect(preflightCASPayload(candidate)).toMatchObject({
      ok: false,
      reason: 'malformed_payload',
    });
  });

  it('throws the typed error expected by direct and inbound callers for malformed JSON', () => {
    expect(() => assertCASPreflight({ mutual_funds: {} })).toThrow(CASPreflightError);
    try {
      assertCASPreflight({ mutual_funds: {} });
    } catch (error) {
      expect(error).toMatchObject({ reason: 'malformed_payload' });
    }
  });

  it('rejects a mixed payload with a transactionless scheme', () => {
    const candidate = payload();
    candidate.mutual_funds![0].schemes!.push({
      name: 'Synthetic Truncated Fund',
      isin: 'INF000A00002',
      additional_info: { amfi: '100002' },
      transactions: [],
    });
    expect(preflightCASPayload(candidate)).toMatchObject({ ok: false, reason: 'empty_payload' });
  });

  it('accepts known ignored charge and reversal rows beside an actionable row', () => {
    const result = preflightCASPayload(payload('mfcentral', [
      validTransaction(),
      { date: '2026-07-01', type: 'STAMP_DUTY_TAX', amount: 0.05 },
      { date: '2026-07-01', type: 'REVERSAL', amount: -1005.05 },
    ]));

    expect(result.ok).toBe(true);
  });

  it('rejects an unpaired reversal before it can become a delete key', () => {
    expect(preflightCASPayload(payload('cams', [
      validTransaction(),
      { date: '2026-07-02', type: 'REVERSAL', amount: -999_999_999, nav: -5, price: 0 },
    ]))).toMatchObject({ ok: false, reason: 'invalid_nav' });
  });

  it('lets a valid cross-period reversal reach Q3 reconciliation', () => {
    expect(preflightCASPayload(payload('cams', [
      { date: '2026-07-02', type: 'REVERSAL', amount: -1005.05 },
    ]))).toMatchObject({ ok: true });
  });

  it('accepts explicit bounded net withholding with independent gross evidence', () => {
    expect(preflightCASPayload(payload('nsdl', [validTransaction({
      type: 'SWITCH_OUT',
      amount: 90,
      source_amount: 90,
      gross_amount: 100,
      units: 10,
      source_units: 10,
      nav: 10,
      price: 10,
      stamp_duty: 0,
      charges: {},
      cash_basis: 'net_of_withholding',
    })]))).toMatchObject({ ok: true });
  });

  it.each(['unknown', 1, [], {}])(
    'rejects malformed cash basis %p with an allowlisted reason',
    (cashBasis) => {
      expect(preflightCASPayload(payload('nsdl', [validTransaction({
        cash_basis: cashBasis as never,
      })]))).toMatchObject({ ok: false, reason: 'malformed_payload' });
    },
  );

  it.each([
    ['unmarked residual', { cash_basis: 'source' as const }],
    ['gross not independently supported', { cash_basis: 'net_of_withholding' as const, gross_amount: 90 }],
    ['excessive withholding', { cash_basis: 'net_of_withholding' as const, amount: 80, source_amount: 80 }],
    ['inflow basis misuse', { cash_basis: 'net_of_withholding' as const, type: 'PURCHASE' }],
  ])('rejects %s', (_label, overrides) => {
    expect(preflightCASPayload(payload('nsdl', [validTransaction({
      type: 'SWITCH_OUT',
      amount: 90,
      source_amount: 90,
      gross_amount: 100,
      units: -10,
      source_units: -10,
      nav: 10,
      price: 10,
      stamp_duty: 0,
      charges: {},
      ...overrides,
    })]))).toMatchObject({ ok: false });
  });

  it('rejects derived overflow in a paired cash-only reversal', () => {
    expect(preflightCASPayload(payload('cams', [
      validTransaction(),
      {
        date: '2026-07-01',
        type: 'REVERSAL',
        amount: -1005.05,
        charges: {
          stamp_duty: 1e308,
          taxes: 1e308,
          exit_load: 1e308,
          other: 1e308,
        },
      },
    ]))).toMatchObject({ ok: false, reason: 'accounting_mismatch' });
  });

  it('rejects a payload containing no actionable transaction', () => {
    expect(preflightCASPayload(payload('cams', [
      { date: '2026-07-01', type: 'STAMP_DUTY_TAX', amount: 0.05 },
    ]))).toMatchObject({ ok: false, reason: 'no_actionable_transactions' });
  });
});

describe('privacy-safe caller outcomes', () => {
  it.each(['pdf', 'email'] as const)('builds a safe %s rejection contract', (source) => {
    let caught: CASPreflightError | null = null;
    try {
      assertCASPreflight(payload('nsdl', [validTransaction({ nav: 0.05, price: 100 })]));
    } catch (error) {
      caught = error as CASPreflightError;
    }
    expect(caught).not.toBeNull();

    const outcome = buildPreflightFailureOutcome(source, caught!);
    expect(outcome.audit).toEqual({
      import_status: 'failed',
      funds_updated: 0,
      transactions_added: 0,
      error_message: 'cas_import:nav_price_mismatch',
    });
    expect(outcome.response.status).toBe(422);
    expect(outcome.notification).toMatchObject({ status: 'failed', funds: 0, transactions: 0 });
    expect(outcome.telemetry).toMatchObject({
      source,
      dialect: 'nsdl',
      status: 'rejected',
      failure_reason: 'nav_price_mismatch',
    });

    const serialized = JSON.stringify(outcome);
    for (const prohibited of [
      'private-file.pdf',
      'ABCDE1234F',
      'holder@example.test',
      'SYNTHETIC-01',
      '2026-07-01',
      '1005.05',
      'INF000A00001',
      'user-id',
      'import-id',
      'upstream stack trace',
    ]) {
      expect(serialized).not.toContain(prohibited);
    }
  });

  it('builds success telemetry from buckets rather than exact counts', () => {
    const telemetry = buildImportSuccessTelemetry({
      source: 'pdf',
      dialect: 'cams',
      fundsUpdated: 13,
      transactionsAdded: 57,
      writeFailures: 0,
    });
    expect(telemetry).toEqual({
      source: 'pdf',
      dialect: 'cams',
      status: 'accepted',
      funds_bucket: '6-20',
      transactions_bucket: '21-100',
      write_failures_bucket: '0',
      validation_reason: 'validated',
    });
    expect(JSON.stringify(telemetry)).not.toContain('57');
  });

  it.each(['pdf', 'email'] as const)('keeps zero exact inserts coherent for %s', (source) => {
    const outcome = buildImportOutcome({
      source,
      dialect: 'cams',
      fundsUpdated: 1,
      transactionsAdded: 0,
      errors: [],
    });

    expect(outcome.status).toBe('success');
    expect(outcome.audit.transactions_added).toBe(0);
    expect(outcome.response.transactions).toBe(0);
    expect(outcome.notification.transactions).toBe(0);
    expect(outcome.telemetry.transactions_bucket).toBe('0');
  });

  it('preserves committed counts across an inbound crash outcome', () => {
    const outcome = buildImportCrashOutcome({
      source: 'email',
      fundsUpdated: 2,
      transactionsAdded: 7,
    });

    expect(outcome.audit).toEqual({
      import_status: 'failed',
      funds_updated: 2,
      transactions_added: 7,
      error_message: 'cas_import:background_crashed',
    });
    expect(outcome.notification).toMatchObject({ funds: 2, transactions: 7 });
    expect(outcome.telemetry).toMatchObject({
      status: 'crashed',
      funds_bucket: '2-5',
      transactions_bucket: '6-20',
    });
  });

  it.each([
    [0, '0'],
    [1, '1'],
    [5, '2-5'],
    [20, '6-20'],
    [100, '21-100'],
    [101, '101+'],
  ])('buckets count %d as %s', (count, expected) => {
    expect(bucketCount(count)).toBe(expected);
  });

  it('persists only allowlisted write reason codes', () => {
    expect(auditErrorCode('transaction_write_failed')).toBe('cas_import:transaction_write_failed');
  });

  it.each([
    'reconciliation_read_failed',
    'reconciliation_conflict',
  ] as const)('keeps %s allowlisted across audit, notification, and telemetry', (reason) => {
    const outcome = buildImportOutcome({
      source: 'email',
      dialect: 'nsdl',
      fundsUpdated: 0,
      transactionsAdded: 0,
      errors: [auditErrorCode(reason)],
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.audit.error_message).toBe(`cas_import:${reason}`);
    expect(outcome.notification.errors[0]).toContain('this statement');
    expect(outcome.telemetry).toMatchObject({
      status: 'rejected',
      failure_reason: reason,
      funds_bucket: '0',
      transactions_bucket: '0',
      write_failures_bucket: '1',
    });
  });

  it('returns a client-safe status for conflicts while keeping I/O failures retryable', () => {
    expect(importFailureHttpStatus('reconciliation_conflict')).toBe(422);
    expect(importFailureHttpStatus('reconciliation_read_failed')).toBe(500);
    expect(importFailureHttpStatus('transaction_write_failed')).toBe(500);
  });

  it('gives malformed and unpaired payloads precise safe user messages', () => {
    expect(userMessageForCASFailure('malformed_payload')).toContain('data structure');
    expect(userMessageForCASFailure('unpaired_reversal')).toContain('matching purchase');
    expect(userMessageForCASFailure('unsupported_layout')).toContain('layout');
  });

  it('keeps raw CAS identifiers and upstream bodies out of caller diagnostics', () => {
    const sources = [
      resolve(__dirname, '../import-cas.ts'),
      resolve(__dirname, '../../parse-cas-pdf/index.ts'),
      resolve(__dirname, '../../cas-webhook-resend/index.ts'),
    ].map((path) => readFileSync(path, 'utf8')).join('\n');

    for (const prohibitedSource of [
      'body_prefix=',
      'file=%s',
      'user=%s',
      'import_id=%s',
      'token=%s',
      'recipient=%s',
      'first_error:',
      'raw_payload:',
    ]) {
      expect(sources).not.toContain(prohibitedSource);
    }
  });

  it('attributes direct and resolved inbound events to the authenticated user denominator', () => {
    const directSource = readFileSync(
      resolve(__dirname, '../../parse-cas-pdf/index.ts'),
      'utf8',
    );
    const inboundSource = readFileSync(
      resolve(__dirname, '../../cas-webhook-resend/index.ts'),
      'utf8',
    );

    expect(directSource).not.toContain('system:cas-upload');
    expect(inboundSource).not.toContain('system:cas-inbound');
    expect(directSource).toContain("outcome.telemetry, user.id");
    expect(inboundSource).toContain("outcome.telemetry,\n      userId");
  });
});
