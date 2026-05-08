/**
 * sync-index — fetches daily benchmark index values into index_history.
 *
 * Three sources, used in fixed priority for each symbol:
 *
 *   1. NSE Indices direct (`niftyindices.com/Backpage.aspx/getTotalReturnIndexString`)
 *      — used for the TRI variants of Nifty equity indices. Returns gross TRI
 *        and NTR in one POST. Tagged source='nse'.
 *
 *   2. EODHD (paid backup)
 *      — used for any symbol whose primary source failed AND that has an
 *        EODHD code mapped, OR for legacy non-TRI symbols where YF is sparse.
 *        Tagged source='eodhd'.
 *
 *   3. Yahoo Finance (legacy primary for price-return symbols)
 *      — used for the existing PR symbols (^NSEI, ^BSESN, etc.). Tagged
 *        source='yahoo'.
 *
 * Source priority enforces convergence: when a higher-priority source
 * succeeds for a (symbol, date) it overwrites any lower-priority row;
 * lower-priority rows are skipped if a higher-priority row already exists
 * at that date.
 *
 *   nse > eodhd > yahoo > unknown
 *
 * Schedule: "30 13 * * 1-5"  (1:30 PM UTC = 7 PM IST, weekdays)
 */

import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';
import { trackServerEventAwait } from '../_shared/analytics.ts';

const BATCH_SIZE = 500;
const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const EODHD_BASE = 'https://eodhd.com/api/eod';
const NSE_TRI_URL = 'https://www.niftyindices.com/Backpage.aspx/getTotalReturnIndexString';

// ---------------------------------------------------------------------------
// Source priority
// ---------------------------------------------------------------------------

type Source = 'nse' | 'eodhd' | 'yahoo' | 'unknown';

const SOURCE_PRIORITY: Record<Source, number> = {
  nse: 30,
  eodhd: 20,
  yahoo: 10,
  unknown: 0,
};

// ---------------------------------------------------------------------------
// Symbol maps
// ---------------------------------------------------------------------------

// NSE TRI primary — Phase 8. Maps our internal TRI symbol → NSE's display name.
const NSE_TRI_NAME_MAP: Record<string, string> = {
  '^NSEITRI':             'NIFTY 50',
  '^NIFTY100TRI':         'NIFTY 100',
  '^NIFTY200TRI':         'NIFTY 200',
  '^NIFTY500TRI':         'NIFTY 500',
  '^NIFTYNEXT50TRI':      'NIFTY NEXT 50',
  '^NIFTYMIDCAP150TRI':   'NIFTY MIDCAP 150',
  '^NIFTYSMALLCAP250TRI': 'NIFTY SMALLCAP 250',
  '^NIFTYLMI250TRI':      'NIFTY LARGEMIDCAP 250',
  '^NSEBANKTRI':          'NIFTY BANK',
  '^CNXITTRI':            'NIFTY IT',
};

// Yahoo Finance primary for price-return symbols.
// null = symbol not available on Yahoo Finance → try EODHD
const YF_SYMBOL_MAP: Record<string, string | null> = {
  '^NSEI':             '^NSEI',        // Nifty 50
  '^NSEBANK':          '^NSEBANK',     // Nifty Bank
  '^BSESN':            '^BSESN',       // BSE Sensex
  '^CNXIT':            '^CNXIT',       // Nifty IT
  '^CNX100':           '^CNX100',      // Nifty 100 (direct)
  '^NIFTY100':         '^CNX100',      // Nifty 100 (via fund category mapping)
  '^NIFTYMIDCAP150':   '^NSEMDCP150',  // Nifty Midcap 150 — fallback to EODHD if < 50 rows
  '^NIFTYSMALLCAP250': '^NSEMDCP250',  // Nifty Smallcap 250 — fallback to EODHD if < 50 rows
  '^BSE100':           '^BSE100',      // BSE 100 — fallback to EODHD if < 50 rows
  '^BSE500':           '^BSE500',      // BSE 500 — fallback to EODHD if < 50 rows
  '^NIFTY500':         null,           // Not on Yahoo Finance → EODHD
  '^NIFTYLMI250':      null,           // Not on Yahoo Finance → EODHD
  '^BSENEXT50':        null,           // Not on Yahoo Finance → EODHD
  '^NIFTYHYBRID6535':  null,           // Not on Yahoo Finance or EODHD → skip
  '^NIFTYARB':         null,           // Not on Yahoo Finance or EODHD → skip
  '^NIFTY1D':          null,           // Rate index, no public source
  '^NIFTYLIQUID':      null,           // Rate index, no public source
  'CRISILUST':         null,           // Proprietary CRISIL data
  'CRISILLD':          null,
  'CRISILSD':          null,
  'CRISILMD':          null,
  'CRISILLONG':        null,
  'CRISILDG':          null,
  'CRISILHYBRID2575':  null,
};

// EODHD codes:
//   * Backup for TRI symbols when NSE direct fails. Codes are populated only
//     after we've verified the symbol exists on EODHD via a live probe — an
//     unverified guess wastes our 20-call/day free-tier quota on every sync
//     and starves the PR-fallback path that actually depends on EODHD.
//   * Primary fallback for PR symbols not on Yahoo Finance.
//
// TRI coverage is a follow-up: probe the candidate codes once the daily
// quota resets, then add the verified ones below. Until then NSE is the
// sole TRI source — acceptable because NSE has been stable and the daily
// downside of a transient NSE outage is at most a 1-day stale benchmark.
const EODHD_SYMBOL_MAP: Record<string, string> = {
  // PR symbols (legacy — already verified working)
  '^NIFTY500':          'NIFTY500.INDX',
  '^NIFTYLMI250':       'NIFTYLARGEMID250.INDX',
  '^NIFTYMIDCAP150':    'NIFTYMIDCAP150.INDX',
  '^NIFTYSMALLCAP250':  'NISM250.INDX',
  '^BSE100':            'BSE100.INDX',
  '^BSE500':            'BSE500.INDX',
  // TRI symbols: empty until verified. Re-probe candidates:
  //   NIFTY50TR.INDX, NIFTY50TRI.INDX, N50TR.INDX,
  //   NIFTY100TR.INDX, NIFTY500TR.INDX, NIFTYBANKTR.INDX, NIFTYITTR.INDX, etc.
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FetchedRow {
  index_symbol: string;
  index_name: string;
  index_date: string;     // ISO 'YYYY-MM-DD'
  close_value: number;
  ntr_value: number | null;
  source: Source;
}

// ---------------------------------------------------------------------------
// NSE TRI fetcher (primary for TRI symbols)
// ---------------------------------------------------------------------------

function ddmmmyyyy(d: Date): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = months[d.getUTCMonth()];
  const yr = d.getUTCFullYear();
  return `${day}-${mon}-${yr}`;
}

function parseNseDate(s: string): string {
  // "05 Jan 2024" → "2024-01-05"
  const months: Record<string, string> = {
    Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
    Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12',
  };
  const [day, mon, yr] = s.trim().split(/\s+/);
  return `${yr}-${months[mon]}-${day.padStart(2, '0')}`;
}

async function fetchFromNSE(
  symbol: string,
  indexName: string,
  nseName: string,
  fromDate: Date,
  toDate: Date,
): Promise<FetchedRow[]> {
  const body = JSON.stringify({
    cinfo: JSON.stringify({
      name: nseName,
      indexName: nseName,
      startDate: ddmmmyyyy(fromDate),
      endDate: ddmmmyyyy(toDate),
    }),
  });

  const res = await fetch(NSE_TRI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; FolioLens/1.0)',
      'Referer': 'https://www.niftyindices.com/',
    },
    body,
  });

  if (!res.ok) throw new Error(`NSE HTTP ${res.status}`);
  const wrapper = await res.json() as { d: string };
  const inner = JSON.parse(wrapper.d) as Array<{
    Date: string;
    TotalReturnsIndex: string;
    NTR_Value: string;
  }>;

  return inner
    .map((r) => {
      const tri = parseFloat(r.TotalReturnsIndex);
      if (!Number.isFinite(tri)) return null;
      const ntrRaw = r.NTR_Value;
      const ntr = ntrRaw === '-' || !ntrRaw ? null : parseFloat(ntrRaw);
      return {
        index_symbol: symbol,
        index_name: indexName,
        index_date: parseNseDate(r.Date),
        close_value: tri,
        ntr_value: Number.isFinite(ntr ?? NaN) ? (ntr as number) : null,
        source: 'nse' as const,
      };
    })
    .filter((r): r is FetchedRow => r !== null);
}

// ---------------------------------------------------------------------------
// EODHD fetcher (backup; existing legacy primary for some PR symbols)
// ---------------------------------------------------------------------------

async function fetchFromEODHD(
  eodhdSymbol: string,
  apiKey: string,
): Promise<{ date: string; close: number }[]> {
  const url = `${EODHD_BASE}/${encodeURIComponent(eodhdSymbol)}` +
    `?api_token=${apiKey}&fmt=json&from=2000-01-01&order=a`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`EODHD HTTP ${res.status} for ${eodhdSymbol}`);
  const data = await res.json() as Array<{ date: string; close: number | null }>;
  return data.filter((r) => r.close !== null && !isNaN(r.close as number)) as { date: string; close: number }[];
}

// ---------------------------------------------------------------------------
// Yahoo Finance fetcher (legacy primary for PR symbols)
// ---------------------------------------------------------------------------

async function fetchFromYahoo(yfSymbol: string): Promise<{ date: string; close: number }[]> {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = 631152000; // 1990-01-01 UTC
  const url = `${YF_BASE}/${encodeURIComponent(yfSymbol)}?interval=1d&period1=${period1}&period2=${period2}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) return [];
  const timestamps: number[] = result.timestamp ?? [];
  const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
  return timestamps
    .map((ts, i) => {
      const close = closes[i];
      if (close === null || close === undefined || isNaN(close)) return null;
      return { date: new Date(ts * 1000).toISOString().split('T')[0], close };
    })
    .filter((r): r is { date: string; close: number } => r !== null);
}

// ---------------------------------------------------------------------------
// Priority-aware upsert
// ---------------------------------------------------------------------------

/**
 * Upsert rows in batches, respecting source priority.
 *
 * For each (symbol, date) we look up the existing row and only write when the
 * incoming source has equal or higher priority. Equal priority overwrites
 * (so today's NSE re-sync overwrites yesterday's NSE row with fresh data).
 */
async function upsertWithPriority(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  rows: FetchedRow[],
): Promise<{ inserted: number; updated: number; skipped: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0, skipped: 0 };

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    // 1. Read existing source for every (symbol, date) in this batch
    const symbols = [...new Set(batch.map((r) => r.index_symbol))];
    const dates = [...new Set(batch.map((r) => r.index_date))];
    const { data: existing, error: readError } = await supabase
      .from('index_history')
      .select('index_symbol, index_date, source')
      .in('index_symbol', symbols)
      .in('index_date', dates);
    if (readError) throw new Error(`read existing: ${readError.message}`);

    const existingMap = new Map<string, Source>();
    for (const e of (existing ?? []) as { index_symbol: string; index_date: string; source: Source }[]) {
      existingMap.set(`${e.index_symbol}|${e.index_date}`, e.source);
    }

    // 2. Partition: rows we should write (insert or update) vs skip
    const toWrite: FetchedRow[] = [];
    for (const row of batch) {
      const key = `${row.index_symbol}|${row.index_date}`;
      const existingSource = existingMap.get(key);
      if (!existingSource) {
        toWrite.push(row);
        inserted += 1;
      } else if (SOURCE_PRIORITY[row.source] >= SOURCE_PRIORITY[existingSource]) {
        toWrite.push(row);
        updated += 1;
      } else {
        skipped += 1;
      }
    }

    if (toWrite.length === 0) continue;

    // 3. Upsert the partition. We've already enforced priority in step 2, so a
    //    plain upsert (with onConflict update behaviour) is correct here.
    const { error: writeError } = await supabase
      .from('index_history')
      .upsert(toWrite, { onConflict: 'index_symbol,index_date' });
    if (writeError) throw new Error(`upsert: ${writeError.message}`);
  }

  return { inserted, updated, skipped };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  console.log('[sync-index] invoked, method=%s', req.method);

  const supabase = createServiceClient();
  const eodhdKey = Deno.env.get('EODHD_API_KEY') ?? '';
  if (!eodhdKey) {
    console.warn('[sync-index] EODHD_API_KEY not set — EODHD fallback disabled');
  }

  // ── Phase 8: Sync TRI symbols from NSE direct ─────────────────────────────
  // We loop the TRI symbols separately from benchmark_mapping because the
  // benchmark_mapping table tracks PR symbols. TRI symbols are app-driven.

  const triErrors: string[] = [];
  const triSummary: Record<string, { inserted: number; updated: number; skipped: number; backup?: string }> = {};

  for (const [symbol, nseName] of Object.entries(NSE_TRI_NAME_MAP)) {
    const indexName = `${nseName} TRI`;
    let primarySucceeded = false;

    // Step 1: NSE primary
    try {
      const fromDate = new Date(Date.UTC(1990, 0, 1));
      const toDate = new Date();
      const nseRows = await fetchFromNSE(symbol, indexName, nseName, fromDate, toDate);
      if (nseRows.length > 0) {
        const { inserted, updated, skipped } = await upsertWithPriority(supabase, nseRows);
        triSummary[symbol] = { inserted, updated, skipped };
        console.log('[sync-index] %s NSE → %d rows (ins=%d upd=%d skip=%d)',
          symbol, nseRows.length, inserted, updated, skipped);
        primarySucceeded = true;
      } else {
        console.warn('[sync-index] %s NSE returned 0 rows', symbol);
      }
    } catch (err) {
      console.error('[sync-index] %s NSE error: %s', symbol, (err as Error).message);
      triErrors.push(`${symbol} (nse): ${(err as Error).message}`);
    }

    // Step 2: EODHD backup. Always attempt — priority logic ensures NSE rows
    // are not overwritten when both succeed; backup only fills gaps.
    if (eodhdKey && symbol in EODHD_SYMBOL_MAP) {
      const eodhdSymbol = EODHD_SYMBOL_MAP[symbol];
      try {
        const eodhdRows = await fetchFromEODHD(eodhdSymbol, eodhdKey);
        if (eodhdRows.length > 0) {
          const mapped: FetchedRow[] = eodhdRows.map((r) => ({
            index_symbol: symbol,
            index_name: indexName,
            index_date: r.date,
            close_value: r.close,
            ntr_value: null,
            source: 'eodhd' as const,
          }));
          const { inserted, updated, skipped } = await upsertWithPriority(supabase, mapped);
          if (!triSummary[symbol]) triSummary[symbol] = { inserted: 0, updated: 0, skipped: 0 };
          triSummary[symbol].backup = `eodhd ins=${inserted} upd=${updated} skip=${skipped}`;
          console.log('[sync-index] %s EODHD backup (%s) → %d rows (ins=%d upd=%d skip=%d)',
            symbol, eodhdSymbol, eodhdRows.length, inserted, updated, skipped);
        } else {
          console.warn('[sync-index] %s EODHD backup (%s): 0 rows', symbol, eodhdSymbol);
          if (!primarySucceeded) {
            triErrors.push(`${symbol}: both NSE and EODHD failed`);
          }
        }
      } catch (err) {
        console.warn('[sync-index] %s EODHD backup (%s) error: %s',
          symbol, eodhdSymbol, (err as Error).message);
        if (!primarySucceeded) {
          triErrors.push(`${symbol} (eodhd backup): ${(err as Error).message}`);
        }
      }
    } else if (!primarySucceeded) {
      triErrors.push(`${symbol}: NSE failed and no backup configured`);
    }
  }

  // ── Legacy: sync PR symbols from benchmark_mapping via Yahoo + EODHD ──────
  const { data: mappings, error: mappingsError } = await supabase
    .from('benchmark_mapping')
    .select('benchmark_index_symbol, benchmark_index')
    .order('benchmark_index_symbol');

  if (mappingsError) {
    console.error('[sync-index] failed to fetch benchmark_mapping:', mappingsError.message);
    return json({ success: false, error: mappingsError.message }, { status: 500 });
  }

  const symbolMap = new Map<string, string>();
  for (const m of mappings ?? []) {
    symbolMap.set(m.benchmark_index_symbol, m.benchmark_index);
  }
  console.log('[sync-index] %d distinct PR benchmark symbols to sync', symbolMap.size);

  let prTotalUpserted = 0;
  const prErrors: string[] = [];
  const prSkipped: string[] = [];

  for (const [symbol, indexName] of symbolMap) {
    const yfSymbol = symbol in YF_SYMBOL_MAP ? YF_SYMBOL_MAP[symbol] : symbol;
    let rows: FetchedRow[] = [];

    // Yahoo Finance
    if (yfSymbol !== null && yfSymbol !== undefined) {
      try {
        const yhRows = await fetchFromYahoo(yfSymbol);
        if (yhRows.length >= 50) {
          rows = yhRows.map((r) => ({
            index_symbol: symbol,
            index_name: indexName,
            index_date: r.date,
            close_value: r.close,
            ntr_value: null,
            source: 'yahoo' as const,
          }));
          console.log('[sync-index] %s Yahoo Finance → %d rows', symbol, rows.length);
        } else if (yhRows.length > 0) {
          console.warn('[sync-index] %s Yahoo Finance returned only %d rows — trying EODHD',
            symbol, yhRows.length);
        }
      } catch (err) {
        console.warn('[sync-index] %s Yahoo Finance error: %s', symbol, (err as Error).message);
      }
    }

    // EODHD fallback
    if (rows.length === 0 && symbol in EODHD_SYMBOL_MAP) {
      if (!eodhdKey) {
        console.warn('[sync-index] %s: would use EODHD but EODHD_API_KEY not set', symbol);
        prErrors.push(`${symbol}: EODHD_API_KEY not configured`);
        continue;
      }
      const eodhdSymbol = EODHD_SYMBOL_MAP[symbol];
      try {
        const eRows = await fetchFromEODHD(eodhdSymbol, eodhdKey);
        rows = eRows.map((r) => ({
          index_symbol: symbol,
          index_name: indexName,
          index_date: r.date,
          close_value: r.close,
          ntr_value: null,
          source: 'eodhd' as const,
        }));
        console.log('[sync-index] %s EODHD (%s) → %d rows', symbol, eodhdSymbol, rows.length);
      } catch (err) {
        console.error('[sync-index] %s EODHD error: %s', symbol, (err as Error).message);
        prErrors.push(`${symbol}: ${(err as Error).message}`);
        continue;
      }
    }

    if (rows.length === 0) {
      if (yfSymbol === null && !(symbol in EODHD_SYMBOL_MAP)) {
        console.log('[sync-index] %s: no data source available, skipping', symbol);
        prSkipped.push(symbol);
      } else {
        console.warn('[sync-index] %s: no data returned from any source', symbol);
        prErrors.push(`${symbol}: no data from Yahoo Finance or EODHD`);
      }
      continue;
    }

    try {
      const { inserted, updated, skipped } = await upsertWithPriority(supabase, rows);
      prTotalUpserted += inserted + updated;
      console.log('[sync-index] %s upserted (ins=%d upd=%d skip=%d)',
        symbol, inserted, updated, skipped);
    } catch (err) {
      console.error('[sync-index] %s upsert error: %s', symbol, (err as Error).message);
      prErrors.push(`${symbol}: ${(err as Error).message}`);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    '[sync-index] done — TRI symbols=%d errors=%d, PR symbols=%d skipped=%d errors=%d, elapsed_ms=%d',
    Object.keys(NSE_TRI_NAME_MAP).length,
    triErrors.length,
    symbolMap.size - prSkipped.length,
    prSkipped.length,
    prErrors.length,
    elapsedMs,
  );

  const totalErrors = triErrors.length + prErrors.length;
  const totalRows = prTotalUpserted;
  await trackServerEventAwait(
    totalErrors > 0 && totalRows === 0 ? 'sync_failed' : 'sync_completed',
    {
      job: 'sync-index',
      tri_symbols: Object.keys(NSE_TRI_NAME_MAP).length,
      tri_errors: triErrors.length,
      pr_symbols: symbolMap.size - prSkipped.length,
      pr_skipped: prSkipped.length,
      pr_errors: prErrors.length,
      pr_rows_upserted: prTotalUpserted,
      elapsed_ms: elapsedMs,
    },
    'system:sync-index',
  );

  return json({
    success: true,
    tri: {
      summary: triSummary,
      errors: triErrors,
    },
    pr: {
      symbolsProcessed: symbolMap.size - prSkipped.length,
      symbolsSkipped: prSkipped,
      indexRowsUpserted: prTotalUpserted,
      errors: prErrors,
    },
  });
});
