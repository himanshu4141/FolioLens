/**
 * Shared CAS import logic — used by both cas-webhook-resend (inbound email
 * via Resend Inbound + Vercel router) and parse-cas-pdf (direct upload)
 * edge functions.
 *
 * CASParser /v4/smart/parse response shape (relevant fields):
 *
 *   mutual_funds: [
 *     {
 *       folio_number: string,
 *       amc: string,
 *       schemes: [
 *         {
 *           name: string,
 *           isin: string,
 *           type: "Equity" | "Debt" | "Hybrid" | "Other",
 *           additional_info: { amfi: string },   ← AMFI code = mfapi scheme_code
 *           transactions: [
 *             { date, type, description, amount, units, nav, balance }
 *           ]
 *         }
 *       ]
 *     }
 *   ]
 *
 * Transaction type values from CASParser (uppercase):
 *   PURCHASE, PURCHASE_SIP, REDEMPTION, SWITCH_IN, SWITCH_IN_MERGER,
 *   SWITCH_OUT, SWITCH_OUT_MERGER, DIVIDEND_PAYOUT, DIVIDEND_REINVEST,
 *   SEGREGATION, STAMP_DUTY_TAX, TDS_TAX, STT_TAX, MISC, REVERSAL, UNKNOWN
 */

// Minimal structural type for the Supabase client — the real client satisfies
// this via duck typing in Deno; tests pass a plain mock object that matches.
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
} from './cas-import-contract.ts';

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

// ── Core import logic ─────────────────────────────────────────────────────────

export async function importCASData(
  supabase: SupabaseClient,
  userId: string,
  importId: string,
  parsed: CASParseResult,
): Promise<{ fundsUpdated: number; transactionsAdded: number; errors: string[] }> {
  // This pure, complete-payload pass is intentionally the first operation. A
  // rejection must happen before benchmark lookup, scheme/user_fund writes,
  // reversal deletes, or transaction upserts.
  const { parsed: canonical, summary } = assertCASPreflight(parsed);
  let fundsUpdated = 0;
  let transactionsAdded = 0;
  const errors: string[] = [];

  const folios = canonical.mutual_funds;
  console.log(
    '[import-cas] preflight_passed dialect=%s folios=%s schemes=%s rows=%s',
    summary.dialect,
    summary.folios_bucket,
    summary.schemes_bucket,
    summary.rows_bucket,
  );

  // Prefetch benchmark mappings for category → index lookup
  const { data: benchmarks } = await supabase
    .from('benchmark_mapping')
    .select('scheme_category, benchmark_index, benchmark_index_symbol');

  const benchmarkMap = new Map<string, { index: string; symbol: string }>();
  for (const b of benchmarks ?? []) {
    const bm = b as { scheme_category: string; benchmark_index: string; benchmark_index_symbol: string };
    benchmarkMap.set(bm.scheme_category, { index: bm.benchmark_index, symbol: bm.benchmark_index_symbol });
  }

  for (const folio of folios) {
    const schemes = folio.schemes;

    for (const mf of schemes) {
      // AMFI code (e.g. "119551") is what mfapi.in uses as scheme_code
      const amfiStr = mf.additional_info?.amfi ?? '';
      const schemeCode = parseInt(amfiStr, 10);
      if (!schemeCode || isNaN(schemeCode)) {
        console.warn('[import-cas] scheme_skipped reason=missing_scheme_identity');
        continue;
      }

      // Use CASParser type as scheme_category (broad: Equity/Debt/Hybrid/Other)
      const schemeCategory = mf.type ?? 'Flexi Cap Fund';
      const bm = benchmarkMap.get(schemeCategory) ?? benchmarkMap.get('Flexi Cap Fund');

      const { error: schemeErr } = await supabase
        .from('scheme_master')
        .upsert(
          {
            scheme_code: schemeCode,
            scheme_name: mf.name ?? 'Unknown Fund',
            scheme_category: schemeCategory,
            benchmark_index: bm?.index ?? null,
            benchmark_index_symbol: bm?.symbol ?? null,
          },
          { onConflict: 'scheme_code' },
        );

      if (schemeErr) {
        const reason: CASWriteFailureReason = 'scheme_write_failed';
        errors.push(auditErrorCode(reason));
        continue;
      }

      const { data: fundRow, error: fundErr } = await supabase
        .from('user_fund')
        .upsert(
          {
            user_id: userId,
            scheme_code: schemeCode,
            is_active: true,
          },
          { onConflict: 'user_id,scheme_code' },
        )
        .select('id')
        .single();

      if (fundErr || !fundRow) {
        const reason: CASWriteFailureReason = 'fund_write_failed';
        errors.push(auditErrorCode(reason));
        continue;
      }

      fundsUpdated++;

      // Build a set of reversed-purchase keys keyed by "date:amount".
      // casparser often returns REVERSAL rows with null units, so we match on
      // amount (always present) rather than units to find the paired purchase.
      const reversedKeys = new Set<string>();
      for (const tx of mf.transactions ?? []) {
        if ((tx.type ?? '').toUpperCase().trim() === 'REVERSAL') {
          const date = parseDate(tx.date ?? '');
          const amount = Math.abs(tx.amount ?? 0);
          if (amount > 0) reversedKeys.add(`${date}:${amount}`);
        }
      }

      // Delete previously-imported purchase rows that have since been reversed
      // (handles re-imports where the purchase exists from a prior import run).
      for (const key of reversedKeys) {
        const [date, amountStr] = key.split(':');
        await supabase
          .from('transaction')
          .delete()
          .eq('fund_id', fundRow.id as string)
          .eq('transaction_date', date)
          .eq('transaction_type', 'purchase')
          .eq('amount', parseFloat(amountStr));
        console.log('[import-cas] reversal_delete_attempted');
      }

      // Exclude REVERSAL rows and their paired PURCHASE rows from import.
      // Both represent a transaction that never settled — importing either
      // would create phantom units in the portfolio.
      const txRows = (mf.transactions ?? [])
        .filter((tx) => {
          const type = (tx.type ?? '').toUpperCase().trim();
          if (type === 'REVERSAL') return false;
          if (type === 'PURCHASE' || type === 'PURCHASE_SIP') {
            const key = `${parseDate(tx.date ?? '')}:${Math.abs(tx.amount ?? 0)}`;
            if (reversedKeys.has(key)) return false;
          }
          return true;
        })
        .map((tx) => ({
          user_id: userId,
          fund_id: fundRow.id as string,
          transaction_date: parseDate(tx.date ?? ''),
          transaction_type: tx.normalised_type ?? normaliseTxType(tx.type),
          units: Math.abs(tx.units ?? 0),
          nav_at_transaction: tx.price ?? tx.nav ?? 0,
          amount: tx.gross_amount,
          folio_number: folio.folio_number ?? null,
          cas_import_id: importId,
        }))
        // Non-persisted rows (reversals, taxes, dividend payouts, etc.) have
        // already been structurally validated. The DB enum stores only the
        // portfolio-unit-changing types below.
        .filter((tx) => {
          return tx.transaction_type !== null
            && tx.transaction_type !== 'dividend'
            && tx.units > 0
            && tx.amount > 0;
        });

      // If the CAS closing balance is 0 and no real transactions remain after
      // filtering reversals, this fund was never actually owned (e.g. failed SIP).
      // Mark it inactive so it doesn't pollute the active portfolio.
      if ((mf.units ?? null) === 0 && txRows.length === 0) {
        await supabase
          .from('user_fund')
          .update({ is_active: false })
          .eq('id', fundRow.id as string);
        console.log('[import-cas] inactive_holding_update_attempted');
        continue;
      }

      if (txRows.length > 0) {
        // ignoreDuplicates on (fund_id, date, type, units, amount) makes a
        // second CAS upload additive: rows already imported from a previous
        // run get skipped, and only transactions the previous CAS missed
        // are inserted. This is the merge guarantee we promise users on the
        // "Get a fresh CAS" callout — don't replace this with a delete-and-
        // re-insert pattern without updating that copy.
        const { error: txErr, count } = await supabase
          .from('transaction')
          .upsert(txRows, {
            onConflict: 'fund_id,transaction_date,transaction_type,units,amount',
            ignoreDuplicates: true,
            count: 'exact',
          });

        if (txErr) {
          const reason: CASWriteFailureReason = 'transaction_write_failed';
          errors.push(auditErrorCode(reason));
        } else {
          const inserted = count ?? 0;
          transactionsAdded += inserted;
          console.log('[import-cas] transaction_insert_count=%s', bucketCount(inserted));
        }
      }
    }
  }

  console.log(
    '[import-cas] completed funds=%s transactions=%s write_failures=%s',
    bucketCount(fundsUpdated),
    bucketCount(transactionsAdded),
    bucketCount(errors.length),
  );
  return { fundsUpdated, transactionsAdded, errors };
}
