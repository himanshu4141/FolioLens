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

// ── CASParser response types ──────────────────────────────────────────────────

export interface CASSchemeAdditionalInfo {
  amfi?: string;       // AMFI code — same integer used by mfapi.in as scheme_code
  rta_code?: string;
  advisor?: string;
  open_units?: number;
  close_units?: number;
}

export interface CASScheme {
  name?: string;
  isin?: string;
  type?: string;       // "Equity" | "Debt" | "Hybrid" | "Other"
  units?: number;
  nav?: number;
  value?: number;
  additional_info?: CASSchemeAdditionalInfo;
  transactions?: CASTransaction[];
}

export interface CASFolio {
  folio_number?: string;
  amc?: string;
  schemes?: CASScheme[];
}

export interface CASTransaction {
  date?: string;          // ISO date YYYY-MM-DD
  type?: string;          // uppercase e.g. "PURCHASE", "REDEMPTION"
  description?: string;
  amount?: number;
  units?: number;
  nav?: number;
  balance?: number;
}

export interface CASParseResult {
  mutual_funds?: CASFolio[];
}

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

// ── Date normalisation ────────────────────────────────────────────────────────

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

export function parseDate(raw: string): string {
  if (!raw) return new Date().toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const mm = MONTHS[m[2].toLowerCase()];
    return mm ? `${m[3]}-${mm}-${m[1]}` : raw;
  }
  return raw;
}

// ── Transaction type normalisation ───────────────────────────────────────────
// CASParser sends uppercase types; we normalise to our DB enum values.

export function normaliseTxType(raw: string): string | null {
  if (!raw) return null;
  const upper = raw.toUpperCase().trim();

  if (upper === 'PURCHASE' || upper === 'PURCHASE_SIP') return 'purchase';
  if (upper === 'REDEMPTION') return 'redemption';
  if (upper === 'SWITCH_IN' || upper === 'SWITCH_IN_MERGER') return 'switch_in';
  if (upper === 'SWITCH_OUT' || upper === 'SWITCH_OUT_MERGER') return 'switch_out';
  if (upper === 'DIVIDEND_REINVEST') return 'dividend_reinvest';
  if (upper === 'DIVIDEND_PAYOUT') return 'dividend';

  // SEGREGATION, STAMP_DUTY_TAX, TDS_TAX, STT_TAX, MISC, UNKNOWN — not meaningful
  // for portfolio accounting; skip rather than default to 'purchase'.
  if (
    upper === 'REVERSAL' ||
    upper === 'SEGREGATION' ||
    upper === 'STAMP_DUTY_TAX' ||
    upper === 'TDS_TAX' ||
    upper === 'STT_TAX' ||
    upper === 'MISC' ||
    upper === 'UNKNOWN'
  ) return null;

  // Also handle legacy lowercase values (for parse-cas-pdf manual uploads)
  const lower = raw.toLowerCase().trim();
  if (lower === 'purchase' || lower === 'buy' || lower === 'sip') return 'purchase';
  if (lower.includes('switch in')) return 'switch_in';
  if (lower.includes('switch out')) return 'switch_out';
  if (lower.includes('redempt') || lower.includes('withdrawal')) return 'redemption';
  if (lower.includes('dividend reinvest')) return 'dividend_reinvest';
  if (lower.includes('dividend')) return 'dividend';

  // Anything else unrecognised — skip rather than silently import as a purchase.
  return null;
}

// ── Core import logic ─────────────────────────────────────────────────────────

export async function importCASData(
  supabase: SupabaseClient,
  userId: string,
  importId: string,
  parsed: CASParseResult,
): Promise<{ fundsUpdated: number; transactionsAdded: number; errors: string[] }> {
  let fundsUpdated = 0;
  let transactionsAdded = 0;
  const errors: string[] = [];

  const folios = parsed.mutual_funds ?? [];
  console.log('[import-cas] importCASData: %d folios for user %s', folios.length, userId);

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
    const schemes = folio.schemes ?? [];
    console.log('[import-cas] folio %s: %d schemes', folio.folio_number, schemes.length);

    for (const mf of schemes) {
      // AMFI code (e.g. "119551") is what mfapi.in uses as scheme_code
      const amfiStr = mf.additional_info?.amfi ?? '';
      const schemeCode = parseInt(amfiStr, 10);
      if (!schemeCode || isNaN(schemeCode)) {
        console.warn('[import-cas] skipping scheme "%s" — no AMFI code', mf.name);
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
        errors.push(`Scheme upsert failed for AMFI ${schemeCode}: ${schemeErr.message}`);
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
        errors.push(`Fund upsert failed for AMFI ${schemeCode}: ${fundErr?.message}`);
        continue;
      }

      fundsUpdated++;
      console.log('[import-cas] upserted fund %d "%s"', schemeCode, mf.name);

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
        console.log('[import-cas] deleted reversed purchase for fund %d on %s amount=%s', schemeCode, date, amountStr);
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
          transaction_type: normaliseTxType(tx.type ?? tx.description ?? ''),
          units: Math.abs(tx.units ?? 0),
          nav_at_transaction: tx.nav ?? 0,
          amount: Math.abs(tx.amount ?? 0),
          folio_number: folio.folio_number ?? null,
          cas_import_id: importId,
        }))
        // Drop rows where the parser couldn't surface a real cash amount.
        // casparser occasionally tags statement-level "balance forward"
        // markers as SWITCH_IN/SWITCH_OUT with non-zero units but zero rupees;
        // importing those creates phantom units and corrupts the home-screen
        // current value, cost basis, and XIRR. A genuine switch always has
        // both units and money on the line, so amount > 0 is a safe bar.
        .filter((tx) => {
          if (tx.transaction_type === null || tx.units <= 0) return false;
          if (tx.amount <= 0) {
            console.warn(
              '[import-cas] dropping phantom %s row for scheme %d on %s — units=%s, amount=0',
              tx.transaction_type, schemeCode, tx.transaction_date, tx.units,
            );
            return false;
          }
          return true;
        });

      // If the CAS closing balance is 0 and no real transactions remain after
      // filtering reversals, this fund was never actually owned (e.g. failed SIP).
      // Mark it inactive so it doesn't pollute the active portfolio.
      if ((mf.units ?? null) === 0 && txRows.length === 0) {
        await supabase
          .from('user_fund')
          .update({ is_active: false })
          .eq('id', fundRow.id as string);
        console.log('[import-cas] fund %d has 0 closing units and no real txns — marked inactive', schemeCode);
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
          errors.push(`Transaction upsert failed for AMFI ${schemeCode}: ${txErr.message}`);
        } else {
          transactionsAdded += count ?? txRows.length;
          console.log('[import-cas] inserted %d transactions for scheme %d', count ?? txRows.length, schemeCode);
        }
      }
    }
  }

  console.log(
    '[import-cas] done — funds=%d, txns=%d, errors=%d',
    fundsUpdated, transactionsAdded, errors.length,
  );
  return { fundsUpdated, transactionsAdded, errors };
}
