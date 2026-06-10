/**
 * fetch-fund-nav — on-demand NAV-history backfill for an arbitrary AMFI
 * scheme. Used by Compare Funds (PR A) and Past SIP Check (PR B) when a user
 * picks a fund they don't hold.
 *
 * The daily `sync-nav` cron only processes user-held funds. This function is
 * the escape hatch for the universal picker: when a non-held scheme is
 * selected, the client invokes this to materialise NAV history into the
 * `nav_history` table once, after which subsequent reads hit the cache.
 *
 * POST body: { scheme_code: number }
 * Response:  { scheme_code, rows_upserted, last_nav_date, status }
 *
 * Idempotent: if the latest nav_history row for the scheme is from today or
 * yesterday, we skip the upstream fetch entirely. Otherwise we fetch the
 * full history from mfapi.in and upsert. mfapi.in returns the entire NAV
 * series in one shot (~3000–6000 rows for an old fund), so this is a single
 * round-trip.
 */

import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';

const MFAPI_BASE = 'https://api.mfapi.in/mf';
const FETCH_TIMEOUT_MS = 15_000;
const UPSERT_CHUNK_SIZE = 500;

// Skip the upstream fetch if the latest nav_history row is at most this many
// days old. Past SIP Check / Compare Funds work off month-end NAVs, so a one-
// or two-day gap is harmless.
const FRESH_NAV_DAYS = 3;

interface MfapiNavRow {
  date: string; // 'DD-MM-YYYY' from mfapi.in
  nav: string;
}

function ddmmyyyyToIso(d: string): string | null {
  const m = d.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stampBackfilledAt(supabase: ReturnType<typeof createServiceClient>, schemeCode: number): Promise<void> {
  const { error } = await supabase
    .from('scheme_master')
    .update({ nav_backfilled_at: new Date().toISOString() })
    .eq('scheme_code', schemeCode);
  if (error) {
    // Non-fatal: log and continue. A missed stamp means the row may be pruned
    // earlier than intended on the next retention run — acceptable.
    console.warn('[fetch-fund-nav] scheme=%d nav_backfilled_at stamp failed: %s', schemeCode, error.message);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  let schemeCode: number;
  try {
    const body = await req.json();
    const code = Number(body?.scheme_code);
    if (!Number.isFinite(code) || code <= 0) throw new Error('invalid scheme_code');
    schemeCode = code;
  } catch (err) {
    return json({ error: `bad request: ${String(err)}` }, { status: 400 });
  }

  const supabase = createServiceClient();
  const startedAt = Date.now();
  console.log('[fetch-fund-nav] scheme=%d invocation started', schemeCode);

  // 1. Cache check — if the latest row is recent, skip mfapi entirely.
  const { data: latest, error: latestErr } = await supabase
    .from('nav_history')
    .select('nav_date')
    .eq('scheme_code', schemeCode)
    .order('nav_date', { ascending: false })
    .limit(1);

  if (latestErr) {
    console.error('[fetch-fund-nav] scheme=%d cache check error:', schemeCode, latestErr.message);
  }

  const latestDate = latest?.[0]?.nav_date ?? null;
  if (latestDate) {
    const ageDays = (Date.now() - new Date(latestDate).getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays <= FRESH_NAV_DAYS) {
      console.log('[fetch-fund-nav] scheme=%d cache hit (last=%s, age=%.1fd) — skipping fetch',
        schemeCode, latestDate, ageDays);
      // Stamp nav_backfilled_at even on cache-hit: the series is current, so
      // the retention clock should reset regardless of whether we fetched rows.
      await stampBackfilledAt(supabase, schemeCode);
      return json({
        scheme_code: schemeCode,
        rows_upserted: 0,
        last_nav_date: latestDate,
        status: 'cache_hit',
      });
    }
  }

  // 2. Fetch full NAV history from mfapi.in.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let payload: { data?: MfapiNavRow[]; meta?: { scheme_name?: string } };
  try {
    const res = await fetch(`${MFAPI_BASE}/${schemeCode}`, { signal: controller.signal });
    if (!res.ok) {
      console.warn('[fetch-fund-nav] scheme=%d mfapi returned %d', schemeCode, res.status);
      return json({ error: `mfapi ${res.status}` }, { status: 502 });
    }
    payload = await res.json();
  } catch (err) {
    console.error('[fetch-fund-nav] scheme=%d fetch failed:', schemeCode, String(err));
    return json({ error: String(err) }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  const navRows = payload.data ?? [];
  console.log('[fetch-fund-nav] scheme=%d received %d NAV rows from mfapi', schemeCode, navRows.length);

  if (navRows.length === 0) {
    return json({
      scheme_code: schemeCode,
      rows_upserted: 0,
      last_nav_date: latestDate,
      status: 'empty',
    });
  }

  // 3. Convert + upsert in chunks. nav_history has UNIQUE(scheme_code, nav_date)
  // so we use upsert with onConflict to make this idempotent.
  const dbRows = navRows
    .map((row) => {
      const isoDate = ddmmyyyyToIso(row.date);
      const nav = Number(row.nav);
      if (!isoDate || !Number.isFinite(nav) || nav <= 0) return null;
      return { scheme_code: schemeCode, nav_date: isoDate, nav };
    })
    .filter((r): r is { scheme_code: number; nav_date: string; nav: number } => r !== null);

  let upserted = 0;
  for (let i = 0; i < dbRows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = dbRows.slice(i, i + UPSERT_CHUNK_SIZE);
    const { error } = await supabase
      .from('nav_history')
      .upsert(chunk, { onConflict: 'scheme_code,nav_date' });
    if (error) {
      console.error('[fetch-fund-nav] scheme=%d chunk %d upsert error: %s', schemeCode, i / UPSERT_CHUNK_SIZE, error.message);
      return json({ error: `upsert failed: ${error.message}` }, { status: 500 });
    }
    upserted += chunk.length;
  }

  const lastNavDate = dbRows.length > 0
    ? dbRows.reduce((max, r) => (r.nav_date > max ? r.nav_date : max), dbRows[0].nav_date)
    : latestDate;

  // Stamp nav_backfilled_at now that we have confirmed (or freshly written)
  // NAV data.  Best-effort: a failure here must not roll back the upserted rows.
  await stampBackfilledAt(supabase, schemeCode);

  const elapsedMs = Date.now() - startedAt;
  console.log('[fetch-fund-nav] scheme=%d done — upserted=%d last=%s elapsed_ms=%d',
    schemeCode, upserted, lastNavDate, elapsedMs);

  return json({
    scheme_code: schemeCode,
    rows_upserted: upserted,
    last_nav_date: lastNavDate,
    status: 'fetched',
    elapsed_ms: elapsedMs,
  });
});
