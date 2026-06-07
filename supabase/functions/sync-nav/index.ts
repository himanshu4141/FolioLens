/**
 * sync-nav — fetches latest NAV data for all active held funds and upserts
 * into nav_history.
 *
 * Source precedence (highest wins):
 *   OpenFolio /v1/nav/{scheme_code} — AMFI-sourced, authoritative, plan-keyed
 *   mfapi.in  /mf/{scheme_code}     — fallback when OpenFolio returns nothing
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

const BATCH_SIZE = 500;
const MFAPI_BASE = 'https://api.mfapi.in/mf';
const FETCH_TIMEOUT_MS = 20_000;

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

  // Build the OpenFolio client once — re-used across all parallel scheme fetches.
  let openfolioCreds: ReturnType<typeof resolveOpenFolioCredentials> | null = null;
  try {
    openfolioCreds = resolveOpenFolioCredentials(Deno.env);
  } catch {
    console.warn('[sync-nav] OpenFolio not configured — will use mfapi for all schemes');
  }

  const openfolio = openfolioCreds
    ? createOpenFolioClient({ ...openfolioCreds, timeoutMs: FETCH_TIMEOUT_MS })
    : null;

  // -------------------------------------------------------------------------
  // Per-scheme sync: OpenFolio primary, mfapi fallback
  // -------------------------------------------------------------------------

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
      try {
        const series = await openfolio.getNavSeries(schemeCode);
        const points = series?.points ?? [];
        if (points.length > 0) {
          const rows = points.map((p) => ({
            scheme_code: schemeCode,
            nav_date: p.date, // already ISO YYYY-MM-DD
            nav: p.nav,
          }));
          const newRows = await upsertRows(rows);
          console.log(
            '[sync-nav] scheme %d: OpenFolio %d points → %d new rows',
            schemeCode,
            points.length,
            newRows,
          );
          return { newRows, source: 'openfolio' };
        }
        // 404 (null series) or empty points — fall through to mfapi
        console.log('[sync-nav] scheme %d: OpenFolio returned nothing, trying mfapi', schemeCode);
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
      return { newRows: 0, source: 'mfapi', error: `scheme ${schemeCode}: ${isTimeout ? 'fetch timeout' : msg}` };
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

  const results = await Promise.allSettled(schemeCodes.map((code) => syncScheme(code)));

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
