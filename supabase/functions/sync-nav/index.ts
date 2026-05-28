/**
 * sync-nav — fetches latest NAV data from mfapi.in for all active funds
 * and upserts into nav_history.
 *
 * Schedule lives in pg_cron (see `supabase/migrations/20260528000000_*.sql`):
 * hourly between 6 PM IST and 6 AM IST (EOD publish window for Indian
 * AMCs and international FoFs), every 2 hours between 8 AM and 5 PM IST
 * (idle daytime). Runs every day so a Friday-EOD NAV landing on Saturday
 * morning IST gets picked up instead of waiting until Monday.
 *
 * Also reachable via HTTP POST with the service role key for ad-hoc runs.
 *
 * mfapi.in format: { data: [{ date: "DD-MM-YYYY", nav: "123.45" }, ...] }
 * Returns full NAV history per scheme — any missed days are backfilled on next run.
 */

import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';
import { trackServerEventAwait } from '../_shared/analytics.ts';

const BATCH_SIZE = 500;
const MFAPI_BASE = 'https://api.mfapi.in/mf';
const FETCH_TIMEOUT_MS = 10_000; // abort per-scheme fetch if mfapi.in hangs

Deno.serve(async (req) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  console.log('[sync-nav] invoked, method=%s', req.method);

  const supabase = createServiceClient();

  // Get all distinct active scheme_codes across all users
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

  // Fetch and upsert each scheme in parallel — total wall time ≈ one timeout (10s)
  // regardless of how many schemes there are, preventing serial timeouts from
  // exceeding Supabase's 150s hard limit.
  async function syncScheme(schemeCode: number): Promise<{ newRows: number; error?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let res: Response;
    try {
      try {
        res = await fetch(`${MFAPI_BASE}/${schemeCode}`, {
          headers: { 'User-Agent': 'FundLens/1.0' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const msg = (err as Error).message;
      const isTimeout = msg.includes('abort') || msg.includes('timed out');
      console.error('[sync-nav] scheme %d %s: %s',
        schemeCode, isTimeout ? '(timeout)' : '(error)', msg);
      return { newRows: 0, error: `scheme ${schemeCode}: ${isTimeout ? 'fetch timeout' : msg}` };
    }

    if (!res.ok) {
      console.warn('[sync-nav] scheme %d: HTTP %d', schemeCode, res.status);
      return { newRows: 0, error: `scheme ${schemeCode}: HTTP ${res.status}` };
    }

    const body = await res.json();
    const rawData = body.data as Array<{ date: string; nav: string }> | undefined;

    if (!rawData?.length) {
      console.warn('[sync-nav] scheme %d: empty response from mfapi', schemeCode);
      return { newRows: 0, error: `scheme ${schemeCode}: empty response` };
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
    console.log('[sync-nav] scheme %d: mfapi returned %d rows, latest date = %s',
      schemeCode, rawData.length, latestFromSource);

    let newRows = 0;
    try {
      // Batch upsert — ignoreDuplicates avoids overwriting existing clean data
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const { data: inserted, error } = await supabase
          .from('nav_history')
          .upsert(batch, { onConflict: 'scheme_code,nav_date', ignoreDuplicates: true })
          .select('nav_date');

        if (error) throw new Error(error.message);
        newRows += inserted?.length ?? 0;
      }
    } catch (err) {
      const msg = (err as Error).message;
      console.error('[sync-nav] scheme %d upsert error: %s', schemeCode, msg);
      return { newRows, error: `scheme ${schemeCode}: ${msg}` };
    }

    console.log('[sync-nav] scheme %d: %d new rows inserted (source had %d total)',
      schemeCode, newRows, rows.length);
    return { newRows };
  }

  const results = await Promise.allSettled(schemeCodes.map((code) => syncScheme(code as number)));

  let totalUpserted = 0;
  const errors: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      totalUpserted += result.value.newRows;
      if (result.value.error) errors.push(result.value.error);
    } else {
      errors.push(String(result.reason));
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    '[sync-nav] done — schemes=%d, rows=%d, errors=%d, elapsed_ms=%d',
    schemeCodes.length, totalUpserted, errors.length, elapsedMs,
  );

  await trackServerEventAwait(
    errors.length > 0 && totalUpserted === 0 ? 'sync_failed' : 'sync_completed',
    {
      job: 'sync-nav',
      schemes_processed: schemeCodes.length,
      rows_upserted: totalUpserted,
      errors_count: errors.length,
      elapsed_ms: elapsedMs,
    },
    'system:sync-nav',
  );

  return json({
    success: true,
    schemesProcessed: schemeCodes.length,
    navRowsUpserted: totalUpserted,
    errors,
  });
});
