/**
 * sync-stock-market-cap — pulls AMFI's half-yearly stock categorization list
 * and upserts it into the `stock_market_cap` reference table.
 *
 * Why: every Flexi Cap fund used to display 38/33/29 for Large/Mid/Small cap
 * because the portfolio-builder functions stamped the SEBI category default
 * instead of summing real holdings. With this table populated, the classifier
 * helpers in _shared/portfolio-utils.ts derive per-fund cap percentages from
 * each fund's disclosed equity holdings keyed by ISIN.
 *
 * The AMFI list is updated twice a year (typically Jan and Jul) at:
 *   https://www.amfiindia.com/research-information/other-data/categorization-of-stocks
 *
 * The exact .xlsx URL changes every cycle, so we scrape the listing page for
 * the latest link rather than hardcoding one. The seeder is idempotent —
 * re-running against the same `classification_period` is a no-op.
 *
 * Schedule: monthly on the 1st at 00:30 UTC (06:00 IST). AMFI publishes
 * twice a year, so ~10 of 12 monthly runs are no-ops. Monthly cadence keeps
 * us resilient if AMFI shifts their release window, and the no-op path is
 * cheap (one HTTP GET + one xlsx parse to detect "same period as before").
 *
 * Deploy with --verify-jwt so only authenticated admins / cron can invoke.
 *
 * Phase 9 M6 — see docs/plans/phase-9-pre-launch-readiness/M6-honest-portfolio-composition.md.
 */

import * as XLSX from 'https://esm.sh/xlsx@0.18.5';

import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';
import { trackServerEventAwait } from '../_shared/analytics.ts';

const AMFI_LISTING_URL = 'https://www.amfiindia.com/research-information/other-data/categorization-of-stocks';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_XLSX_BYTES = 5 * 1024 * 1024; // 5 MB ceiling — the list is ~150 KB today.
const USER_AGENT = 'Mozilla/5.0 (compatible; FolioLens/1.0; +https://foliolens.app)';

// AMFI lists are remarkably consistent: ~100 Large, ~150 Mid, ~500 Small.
// We refuse to upsert if the parsed total is way outside these bounds —
// almost always indicates a header-mismatch parse error.
const MIN_EXPECTED_ROWS = 500;
const MAX_EXPECTED_ROWS = 1500;

type FailureReason =
  | 'fetch_listing_failed'
  | 'xlsx_link_not_found'
  | 'fetch_xlsx_failed'
  | 'parse_failed'
  | 'sanity_check_failed'
  | 'upsert_failed';

interface StockRow {
  isin: string;
  company_name: string;
  market_cap_category: 'Large Cap' | 'Mid Cap' | 'Small Cap';
  rank: number | null;
  avg_market_cap_cr: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, ...(init?.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scrapes the listing page for the latest .xlsx href. AMFI links the
 * spreadsheet from the page body (a list of "Categorization of Stocks for
 * H2-YYYY" cards, each linking to its own .xlsx). The latest is typically
 * the first match on the page; we return all matches sorted descending and
 * pick the head so we always end up with the freshest period.
 */
function extractLatestXlsxUrl(html: string): string | null {
  // hrefs we want look like /modules/categorisation-stocks?file=...xlsx or
  // /research-information/.../categorisation-of-stocks-h2-2025.xlsx. Be
  // lenient — match any href ending in .xlsx near the categorization page.
  const hrefRe = /href\s*=\s*["']([^"']+\.xlsx[^"']*)["']/gi;
  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    candidates.push(m[1]);
  }
  if (candidates.length === 0) return null;

  // Sort by year/half embedded in the filename, descending; ties broken by
  // string descending (alphabetically later == more recent for AMFI's URLs).
  const ranked = candidates
    .map((href) => {
      const periodMatch = href.toLowerCase().match(/h([12])[-_ ]?(\d{4})/);
      const half = periodMatch ? Number(periodMatch[1]) : 0;
      const year = periodMatch ? Number(periodMatch[2]) : 0;
      return { href, rank: year * 10 + half };
    })
    .sort((a, b) => (b.rank - a.rank) || b.href.localeCompare(a.href));

  const winner = ranked[0].href;
  if (winner.startsWith('http')) return winner;
  if (winner.startsWith('//')) return `https:${winner}`;
  if (winner.startsWith('/')) return `https://www.amfiindia.com${winner}`;
  return `https://www.amfiindia.com/${winner}`;
}

/**
 * Best-effort period extractor. AMFI filenames embed `H1-2025`, `h2_2024`,
 * etc. — we read the first occurrence we recognise. Used only for the
 * `classification_period` column (idempotency key) and for the no-op
 * detection log.
 */
function extractClassificationPeriod(sourceUrl: string, fallback: Date = new Date()): string {
  const m = sourceUrl.toLowerCase().match(/h([12])[-_ ]?(\d{4})/);
  if (m) return `H${m[1]}-${m[2]}`;
  // Fallback: synthesize from today's date.
  const month = fallback.getUTCMonth() + 1;
  const year = fallback.getUTCFullYear();
  return `H${month <= 6 ? 1 : 2}-${year}`;
}

/**
 * Parses the AMFI xlsx into typed rows. AMFI's sheet shape is stable across
 * cycles: column headers include "ISIN", "Name of the Company", "Average
 * Market Capitalization", and a category column. The leftmost sheet has the
 * full list. We use SheetJS's header-aware row reader so column order shifts
 * don't break us — we look up columns by fuzzy header match.
 */
function parseAmfiWorkbook(buffer: ArrayBuffer): StockRow[] {
  const wb = XLSX.read(buffer, { type: 'array' });
  if (!wb.SheetNames.length) {
    throw new Error('workbook has no sheets');
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('first sheet missing');

  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: true,
  });
  if (rawRows.length === 0) throw new Error('sheet produced zero rows');

  // Heuristic header detection — pick the first row whose keys look like data.
  const headerMap = buildHeaderMap(rawRows[0]);
  if (!headerMap.isin || !headerMap.company || !headerMap.category) {
    throw new Error(
      `headers missing — found ${JSON.stringify(Object.keys(rawRows[0]))} but need isin/company/category`,
    );
  }

  const rows: StockRow[] = [];
  for (const raw of rawRows) {
    const isin = stringCell(raw[headerMap.isin]).toUpperCase();
    if (!/^IN[A-Z0-9]{10}$/.test(isin)) continue; // skip header carry-overs / footnotes
    const company = stringCell(raw[headerMap.company]);
    const categoryRaw = stringCell(raw[headerMap.category]).toLowerCase();
    let category: StockRow['market_cap_category'];
    if (categoryRaw.includes('large')) category = 'Large Cap';
    else if (categoryRaw.includes('mid')) category = 'Mid Cap';
    else if (categoryRaw.includes('small')) category = 'Small Cap';
    else continue; // skip "Sl. No.", blank rows, etc.

    const rank = headerMap.rank ? numCell(raw[headerMap.rank]) : null;
    const avgCap = headerMap.avgCap ? numCell(raw[headerMap.avgCap]) : null;
    rows.push({
      isin,
      company_name: company || isin,
      market_cap_category: category,
      rank,
      avg_market_cap_cr: avgCap,
    });
  }
  return rows;
}

function buildHeaderMap(firstRow: Record<string, unknown>): {
  isin?: string;
  company?: string;
  category?: string;
  rank?: string;
  avgCap?: string;
} {
  const map: ReturnType<typeof buildHeaderMap> = {};
  for (const key of Object.keys(firstRow)) {
    const k = key.toLowerCase();
    if (!map.isin && k.includes('isin')) map.isin = key;
    else if (!map.company && (k.includes('name of the company') || k === 'company' || k.includes('company name'))) map.company = key;
    else if (!map.category && (k.includes('category') || k.includes('classification'))) map.category = key;
    else if (!map.rank && (k.includes('sl') || k.includes('sr') || k === 'rank' || k.includes('no.'))) map.rank = key;
    else if (!map.avgCap && (k.includes('market capital') || k.includes('avg') || k.includes('average market'))) map.avgCap = key;
  }
  return map;
}

function stringCell(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function numCell(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405 });

  const startedAt = Date.now();
  const supabase = createServiceClient();

  let failureReason: FailureReason | null = null;
  let firstError = '';
  let xlsxUrl = '';
  let classificationPeriod = '';
  let rowsSeen = 0;
  let rowsUpserted = 0;
  let wasNoop = false;
  let largeCount = 0;
  let midCount = 0;
  let smallCount = 0;

  try {
    // Step 1 — fetch the listing page.
    let listingHtml: string;
    try {
      const res = await fetchWithTimeout(AMFI_LISTING_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      listingHtml = await res.text();
    } catch (err) {
      failureReason = 'fetch_listing_failed';
      firstError = String(err).slice(0, 240);
      throw err;
    }

    // Step 2 — extract the latest .xlsx link.
    const found = extractLatestXlsxUrl(listingHtml);
    if (!found) {
      failureReason = 'xlsx_link_not_found';
      firstError = 'no .xlsx href on listing page';
      throw new Error(firstError);
    }
    xlsxUrl = found;
    classificationPeriod = extractClassificationPeriod(xlsxUrl);
    console.log('[sync-stock-market-cap] picked period=%s url=%s', classificationPeriod, xlsxUrl);

    // Idempotency check — if every row in `stock_market_cap` already
    // carries this period, skip the download entirely. Saves ~150 KB
    // and ~1 s on monthly no-op runs.
    const { data: existing, error: existingErr } = await supabase
      .from('stock_market_cap')
      .select('classification_period', { count: 'exact', head: false })
      .eq('classification_period', classificationPeriod)
      .limit(1);
    if (existingErr) {
      console.warn('[sync-stock-market-cap] noop precheck failed: %s', existingErr.message);
    } else if (existing && existing.length > 0) {
      wasNoop = true;
      const { count: total } = await supabase
        .from('stock_market_cap')
        .select('isin', { count: 'exact', head: true })
        .eq('classification_period', classificationPeriod);
      rowsSeen = total ?? 0;
      console.log('[sync-stock-market-cap] no-op — period %s already loaded (%d rows)', classificationPeriod, rowsSeen);
    }

    if (!wasNoop) {
      // Step 3 — fetch + parse the xlsx.
      let buffer: ArrayBuffer;
      try {
        const res = await fetchWithTimeout(xlsxUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const len = Number(res.headers.get('content-length') ?? '0');
        if (len > MAX_XLSX_BYTES) throw new Error(`oversized: ${len} bytes`);
        buffer = await res.arrayBuffer();
        if (buffer.byteLength > MAX_XLSX_BYTES) {
          throw new Error(`body too large: ${buffer.byteLength} bytes`);
        }
      } catch (err) {
        failureReason = 'fetch_xlsx_failed';
        firstError = String(err).slice(0, 240);
        throw err;
      }

      let parsed: StockRow[];
      try {
        parsed = parseAmfiWorkbook(buffer);
      } catch (err) {
        failureReason = 'parse_failed';
        firstError = String(err).slice(0, 240);
        throw err;
      }
      rowsSeen = parsed.length;
      largeCount = parsed.filter((r) => r.market_cap_category === 'Large Cap').length;
      midCount = parsed.filter((r) => r.market_cap_category === 'Mid Cap').length;
      smallCount = parsed.filter((r) => r.market_cap_category === 'Small Cap').length;

      // Step 4 — sanity check before any DB write.
      if (parsed.length < MIN_EXPECTED_ROWS || parsed.length > MAX_EXPECTED_ROWS) {
        failureReason = 'sanity_check_failed';
        firstError = `row count ${parsed.length} outside [${MIN_EXPECTED_ROWS}, ${MAX_EXPECTED_ROWS}]`;
        throw new Error(firstError);
      }
      // AMFI's Large bucket is always exactly 100 except across the 2-3 day
      // gap when they're rotating the list. Tolerate +/-10 to absorb that.
      if (largeCount < 90 || largeCount > 110) {
        console.warn('[sync-stock-market-cap] large_count outside [90,110]: %d', largeCount);
      }

      // Step 5 — upsert.
      const synced_at = new Date().toISOString();
      const payload = parsed.map((r) => ({
        ...r,
        classification_period: classificationPeriod,
        source: 'amfi',
        synced_at,
      }));

      // Chunk to keep PostgREST happy.
      const CHUNK = 500;
      for (let i = 0; i < payload.length; i += CHUNK) {
        const slice = payload.slice(i, i + CHUNK);
        const { error } = await supabase
          .from('stock_market_cap')
          .upsert(slice, { onConflict: 'isin' });
        if (error) {
          failureReason = 'upsert_failed';
          firstError = error.message.slice(0, 240);
          throw new Error(error.message);
        }
        rowsUpserted += slice.length;
      }
      console.log('[sync-stock-market-cap] upserted %d rows for period %s (L=%d M=%d S=%d)',
        rowsUpserted, classificationPeriod, largeCount, midCount, smallCount);
    } else {
      // Surface the bucket counts even on a no-op so the PostHog alert on
      // `large_count NOT BETWEEN 90 AND 110` keeps working month over month.
      const { count: lc } = await supabase.from('stock_market_cap').select('isin', { count: 'exact', head: true }).eq('market_cap_category', 'Large Cap');
      const { count: mc } = await supabase.from('stock_market_cap').select('isin', { count: 'exact', head: true }).eq('market_cap_category', 'Mid Cap');
      const { count: sc } = await supabase.from('stock_market_cap').select('isin', { count: 'exact', head: true }).eq('market_cap_category', 'Small Cap');
      largeCount = lc ?? 0;
      midCount = mc ?? 0;
      smallCount = sc ?? 0;
    }
  } catch (err) {
    console.error('[sync-stock-market-cap] failed: %s (reason=%s)', err, failureReason);
  }

  const elapsedMs = Date.now() - startedAt;
  const succeeded = failureReason === null;

  await trackServerEventAwait(
    succeeded ? 'sync_completed' : 'sync_failed',
    succeeded
      ? {
          job: 'sync-stock-market-cap',
          classification_period: classificationPeriod,
          rows_seen: rowsSeen,
          rows_upserted: rowsUpserted,
          was_noop: wasNoop,
          large_count: largeCount,
          mid_count: midCount,
          small_count: smallCount,
          elapsed_ms: elapsedMs,
        }
      : {
          job: 'sync-stock-market-cap',
          failure_reason: failureReason,
          first_error: firstError,
          classification_period: classificationPeriod,
          xlsx_url: xlsxUrl,
          elapsed_ms: elapsedMs,
        },
    'system:sync-stock-market-cap',
  );

  if (!succeeded) {
    return json({
      success: false,
      failure_reason: failureReason,
      first_error: firstError,
      elapsed_ms: elapsedMs,
    }, { status: 500 });
  }

  return json({
    success: true,
    classification_period: classificationPeriod,
    rows_seen: rowsSeen,
    rows_upserted: rowsUpserted,
    was_noop: wasNoop,
    large_count: largeCount,
    mid_count: midCount,
    small_count: smallCount,
    elapsed_ms: elapsedMs,
  });
});
