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
 * Deploy with --no-verify-jwt to match the other pg_cron-triggered functions
 * (sync-fund-portfolios, sync-fund-meta, regenerate-index-snapshots). The
 * scheduled SQL call in 20260514100001_sync_stock_market_cap_cron.sql sends
 * no Authorization header. The .github/workflows/sync-stock-market-cap.yml
 * dispatch wrapper is the audited path for on-demand triggers; ad-hoc
 * invocation from the internet is rate-limited by AMFI's page-fetch cost
 * + the seeder's idempotent no-op on repeated periods.
 *
 * Phase 9 M6 — see docs/plans/phase-9-pre-launch-readiness/M6-honest-portfolio-composition.md.
 */

import * as XLSX from 'https://esm.sh/xlsx@0.18.5';

import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';
import { trackServerEventAwait } from '../_shared/analytics.ts';
import {
  extractLatestXlsxUrl,
  extractClassificationPeriod,
} from '../_shared/amfi-listing-parser.ts';
import {
  type AmfiStockRow,
  AMFI_SANITY_BOUNDS,
  countBuckets,
  parseAmfiRows,
  validateBucketShape,
} from '../_shared/amfi-xlsx-parser.ts';

const AMFI_LISTING_URL = 'https://www.amfiindia.com/otherdata/categorisation-of-stocks';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_XLSX_BYTES = 5 * 1024 * 1024; // 5 MB ceiling — the list is ~150 KB today.
const USER_AGENT = 'Mozilla/5.0 (compatible; FolioLens/1.0; +https://foliolens.app)';

// Sanity bounds live in _shared/amfi-xlsx-parser.ts so they can be tested
// alongside `parseAmfiRows` against the same fixtures the parser uses.

type FailureReason =
  | 'fetch_listing_failed'
  | 'xlsx_link_not_found'
  | 'fetch_xlsx_failed'
  | 'parse_failed'
  | 'sanity_check_failed'
  | 'upsert_failed';

type StockRow = AmfiStockRow;

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
 * Reads the first sheet of the AMFI xlsx as a 2D array and hands it to
 * `parseAmfiRows` (in `_shared/amfi-xlsx-parser.ts`) for the actual
 * structural work. The previous version of this function used SheetJS's
 * default object-mode `sheet_to_json`, which assumes row 0 is the header
 * — AMFI's sheet has a title in row 0 instead, so the headers came back
 * as `["…six months ended 31 December 2025", "__EMPTY", "__EMPTY_1", …]`
 * and the column detector found none of the columns it needed. Moving to
 * `header: 1` + a header-row scanner makes the parser robust to title /
 * subtitle rows of any count up to MAX_HEADER_SCAN_ROWS.
 */
function parseAmfiWorkbook(buffer: ArrayBuffer): StockRow[] {
  const wb = XLSX.read(buffer, { type: 'array' });
  if (!wb.SheetNames.length) {
    throw new Error('workbook has no sheets');
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('first sheet missing');

  // `header: 1` returns rows as positional arrays instead of objects keyed
  // by row-0 cells. Combined with `defval: null` this gives us a stable
  // 2D shape regardless of empty cells or merged title rows.
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: true,
    blankrows: false,
  });

  return parseAmfiRows(rows);
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
    const { url: found, candidates } = extractLatestXlsxUrl(listingHtml);
    if (!found) {
      failureReason = 'xlsx_link_not_found';
      // Surface a short sample of what we *did* see so the next
      // diagnoser doesn't need to re-run with extra logging. AMFI
      // occasionally ships a cycle as PDF-only, which lands here.
      const sample = candidates.slice(0, 5).join(' | ') || '(no hrefs at all)';
      firstError = `no .xlsx href; candidates=${sample}`.slice(0, 240);
      throw new Error(firstError);
    }
    xlsxUrl = found;
    classificationPeriod = extractClassificationPeriod(xlsxUrl);
    console.log('[sync-stock-market-cap] picked period=%s url=%s (from %d candidates)',
      classificationPeriod, xlsxUrl, candidates.length);

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
      const buckets = countBuckets(parsed);
      largeCount = buckets.large;
      midCount = buckets.mid;
      smallCount = buckets.small;

      // Step 4 — sanity check before any DB write. The bucket shape is the
      // load-bearing assertion: SEBI pins Large at 100 and Mid at 150;
      // Small is unbounded but must exist. If buckets are off by more than
      // AMFI_SANITY_BOUNDS.bucketSlack, something likely broke parsing or
      // AMFI changed schema — refuse the write so the downstream
      // classifier doesn't poison every fund's cap split.
      const sanityError = validateBucketShape(buckets, AMFI_SANITY_BOUNDS);
      if (sanityError) {
        failureReason = 'sanity_check_failed';
        firstError = sanityError;
        throw new Error(firstError);
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
      classification_period: classificationPeriod,
      xlsx_url: xlsxUrl,
      rows_seen: rowsSeen,
      large_count: largeCount,
      mid_count: midCount,
      small_count: smallCount,
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
