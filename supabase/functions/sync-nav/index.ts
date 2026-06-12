/**
 * sync-nav — fetches latest NAV data for all active held funds and upserts
 * into nav_history.
 *
 * Source precedence (highest wins):
 *   OpenFolio /v1/nav/{scheme_code}?since=<last_known> — AMFI-sourced, plan-keyed.
 *   Passing `since` makes incremental runs return 1–2 points instead of 3000+,
 *   eliminating the parallel-fetch timeout that caused mfapi fallback for most
 *   schemes on full-history requests.
 *   mfapi.in  /mf/{scheme_code}     — fallback when OpenFolio returns 404 or errors.
 *
 * Schedule: hourly cron (existing pg_cron job, unchanged cadence).
 * Deploy with --no-verify-jwt.
 */

import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';
import { trackServerEventAwait } from '../_shared/analytics.ts';
import {
  createOpenFolioClient,
  resolveOpenFolioCredentials,
} from '../_shared/openfolio.ts';
import { buildSchemeLatestMap, SINCE_MAP_PAGE_SIZE } from '../_shared/nav-since-map.ts';

const BATCH_SIZE = 500;
const MFAPI_BASE = 'https://api.mfapi.in/mf';
const FETCH_TIMEOUT_MS = 20_000;
// Keep OpenFolio request concurrency low — 35 parallel hits cause server-side
// saturation even for small incremental (since=) fetches.
const OPENFOLIO_CONCURRENCY = 5;

// Look back 45 days to find per-scheme latest nav_date — covers month-end gaps
// and ensures we catch any missed windows even with holidays.
const SINCE_LOOKBACK_DAYS = 45;

Deno.serve(async (req) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  console.log('[sync-nav] invoked, method=%s', req.method);

  const supabase = createServiceClient();

  const { data: funds, error: fundsError } = await supabase
    .from('fund')
    .select('scheme_code')
    .eq('is_active', true);

  if (fundsError) {
    console.error('[sync-nav] failed to fetch active funds:', fundsError.message);
    return json({ success: false, error: fundsError.message }, { status: 500 });
  }

  const schemeCodes = [...new Set((funds ?? []).map((f) => f.scheme_code as number))];
  console.log('[sync-nav] %d distinct active scheme codes to sync', schemeCodes.length);

  if (schemeCodes.length === 0) {
    console.log('[sync-nav] no active funds — nothing to do');
    return json({ success: true, message: 'No active funds to sync', navRowsUpserted: 0 });
  }

  // ── Per-scheme latest nav_date (incremental `since` for OpenFolio) ─────────
  // Fetching only the recent window keeps the result set small (≤ N × 45 rows).
  // Schemes outside the window (or with no history) get since=null → full fetch.
  const lookbackDate = new Date(Date.now() - SINCE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  // Paginate with .range() to avoid the 1,000-row PostgREST default cap.
  // Without pagination, schemes whose first row falls beyond row 1,000 silently
  // degrade to since=null (full-history re-fetch).
  const allNavRows: { scheme_code: number; nav_date: string }[] = [];
  let navFetchFrom = 0;
  while (true) {
    const { data: page, error: pageErr } = await supabase
      .from('nav_history')
      .select('scheme_code, nav_date')
      .in('scheme_code', schemeCodes)
      .gte('nav_date', lookbackDate)
      .order('nav_date', { ascending: false })
      .range(navFetchFrom, navFetchFrom + SINCE_MAP_PAGE_SIZE - 1);

    if (pageErr) {
      console.error('[sync-nav] since-map page fetch error (from=%d): %s', navFetchFrom, pageErr.message);
      break;
    }

    const rows = page ?? [];
    allNavRows.push(...rows);

    if (rows.length < SINCE_MAP_PAGE_SIZE) break;
    navFetchFrom += SINCE_MAP_PAGE_SIZE;
  }

  // First occurrence per scheme_code = max nav_date (rows are desc-ordered).
  const schemeLatest = buildSchemeLatestMap(allNavRows);
  console.log(
    '[sync-nav] since-map: %d schemes have recent history (lookback=%s, total_rows=%d)',
    schemeLatest.size,
    lookbackDate,
    allNavRows.length,
  );

  // ── OpenFolio client ───────────────────────────────────────────────────────
  let openfolioCreds: ReturnType<typeof resolveOpenFolioCredentials> | null = null;
  try {
    openfolioCreds = resolveOpenFolioCredentials(Deno.env);
  } catch {
    console.warn('[sync-nav] OpenFolio not configured — will use mfapi for all schemes');
  }

  const openfolio = openfolioCreds
    ? createOpenFolioClient({ ...openfolioCreds, timeoutMs: FETCH_TIMEOUT_MS })
    : null;

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function upsertRows(
    rows: { scheme_code: number; nav_date: string; nav: number }[],
  ): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase
        .from('nav_history')
        .upsert(batch, { onConflict: 'scheme_code,nav_date', ignoreDuplicates: true })
        .select('nav_date');
      if (error) throw new Error(error.message);
      inserted += data?.length ?? 0;
    }
    return inserted;
  }

  async function syncScheme(
    schemeCode: number,
  ): Promise<{ newRows: number; source: 'openfolio' | 'mfapi'; error?: string }> {
    // ── OpenFolio (primary) ──────────────────────────────────────────────────
    if (openfolio) {
      // Pass per-scheme `since` so incremental runs fetch 1–2 points, not 3000+.
      // since=null for first-ever sync → full history (one-time cost).
      const since = schemeLatest.get(schemeCode) ?? null;
      try {
        const series = await openfolio.getNavSeries(schemeCode, { since });

        if (series === null) {
          // 404 → scheme genuinely absent from OpenFolio → fall through to mfapi
          console.log(
            '[sync-nav] scheme %d: OpenFolio 404 (not indexed), trying mfapi',
            schemeCode,
          );
        } else {
          const points = series.points ?? [];
          if (points.length > 0) {
            const rows = points.map((p) => ({
              scheme_code: schemeCode,
              nav_date: p.date,
              nav: p.nav,
            }));
            const newRows = await upsertRows(rows);
            console.log(
              '[sync-nav] scheme %d: OpenFolio %d points (since=%s) → %d new rows',
              schemeCode,
              points.length,
              since ?? 'full',
              newRows,
            );
            return { newRows, source: 'openfolio' };
          }
          if (since !== null) {
            // Incremental sync: no new points since our last known date → already up to date.
            console.log(
              '[sync-nav] scheme %d: OpenFolio up to date (since=%s)',
              schemeCode,
              since,
            );
            return { newRows: 0, source: 'openfolio' };
          }
          // since=null (first-ever sync) + empty points → OF has no history for this
          // scheme. Fall through to mfapi rather than silently leaving nav_history empty.
          console.log(
            '[sync-nav] scheme %d: OpenFolio no history (since=null), trying mfapi',
            schemeCode,
          );
        }
      } catch (err) {
        console.warn(
          '[sync-nav] scheme %d: OpenFolio error (%s), trying mfapi',
          schemeCode,
          (err as Error).message,
        );
      }
    }

    // ── mfapi.in (fallback) ──────────────────────────────────────────────────
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      try {
        res = await fetch(`${MFAPI_BASE}/${schemeCode}`, {
          headers: { 'User-Agent': 'FolioLens/1.0' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const msg = (err as Error).message;
      const isTimeout = msg.includes('abort') || msg.includes('timed out');
      console.error(
        '[sync-nav] scheme %d %s: %s',
        schemeCode,
        isTimeout ? '(timeout)' : '(error)',
        msg,
      );
      return {
        newRows: 0,
        source: 'mfapi',
        error: `scheme ${schemeCode}: ${isTimeout ? 'fetch timeout' : msg}`,
      };
    }

    if (!res.ok) {
      console.warn('[sync-nav] scheme %d: mfapi HTTP %d', schemeCode, res.status);
      return { newRows: 0, source: 'mfapi', error: `scheme ${schemeCode}: mfapi HTTP ${res.status}` };
    }

    const body = await res.json();
    const rawData = body.data as Array<{ date: string; nav: string }> | undefined;

    if (!rawData?.length) {
      console.warn('[sync-nav] scheme %d: empty response from mfapi', schemeCode);
      return { newRows: 0, source: 'mfapi', error: `scheme ${schemeCode}: mfapi empty response` };
    }

    // mfapi returns date as "DD-MM-YYYY" — convert to ISO "YYYY-MM-DD"
    const rows = rawData
      .map((d) => {
        const parts = d.date.split('-');
        if (parts.length !== 3) return null;
        const [day, month, year] = parts;
        const nav = parseFloat(d.nav);
        if (isNaN(nav)) return null;
        return { scheme_code: schemeCode, nav_date: `${year}-${month}-${day}`, nav };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const latestFromSource = rows[0]?.nav_date ?? 'none';
    console.log(
      '[sync-nav] scheme %d: mfapi %d rows, latest=%s',
      schemeCode,
      rawData.length,
      latestFromSource,
    );

    try {
      const newRows = await upsertRows(rows);
      console.log('[sync-nav] scheme %d: mfapi %d new rows inserted', schemeCode, newRows);
      return { newRows, source: 'mfapi' };
    } catch (err) {
      const msg = (err as Error).message;
      console.error('[sync-nav] scheme %d: upsert error: %s', schemeCode, msg);
      return { newRows: 0, source: 'mfapi', error: `scheme ${schemeCode}: ${msg}` };
    }
  }

  // Rate-limit OpenFolio fetches — 35 parallel saturates the upstream server.
  const results: PromiseSettledResult<Awaited<ReturnType<typeof syncScheme>>>[] = [];
  for (let i = 0; i < schemeCodes.length; i += OPENFOLIO_CONCURRENCY) {
    const batch = schemeCodes.slice(i, i + OPENFOLIO_CONCURRENCY);
    const batchResults = await Promise.allSettled(batch.map((code) => syncScheme(code)));
    results.push(...batchResults);
  }

  let totalUpserted = 0;
  let openfolioSchemes = 0;
  let mfapiSchemes = 0;
  const errors: string[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      totalUpserted += result.value.newRows;
      if (result.value.source === 'openfolio') openfolioSchemes++;
      else mfapiSchemes++;
      if (result.value.error) errors.push(result.value.error);
    } else {
      errors.push(String(result.reason));
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    '[sync-nav] done — schemes=%d (openfolio=%d mfapi=%d) rows=%d errors=%d elapsed_ms=%d',
    schemeCodes.length,
    openfolioSchemes,
    mfapiSchemes,
    totalUpserted,
    errors.length,
    elapsedMs,
  );

  await trackServerEventAwait(
    errors.length > 0 && totalUpserted === 0 ? 'sync_failed' : 'sync_completed',
    {
      job: 'sync-nav',
      schemes_processed: schemeCodes.length,
      openfolio_schemes: openfolioSchemes,
      mfapi_schemes: mfapiSchemes,
      rows_upserted: totalUpserted,
      errors_count: errors.length,
      elapsed_ms: elapsedMs,
    },
    'system:sync-nav',
  );

  return json({
    success: true,
    schemesProcessed: schemeCodes.length,
    openfolioSchemes,
    mfapiSchemes,
    navRowsUpserted: totalUpserted,
    errors,
  });
});
