/**
 * fetch-fund-nav — on-demand NAV-history backfill for an arbitrary AMFI
 * scheme. Used by Compare Funds and Past SIP Check when a user picks a fund
 * they don't hold.
 *
 * The daily `sync-nav` cron only processes user-held funds. This function is
 * the escape hatch for the universal picker: when a non-held scheme is
 * selected, the client invokes this to materialise NAV history into the
 * `nav_history` table once, after which subsequent reads hit the cache.
 *
 * POST body: { scheme_code: number }
 * Response:  { scheme_code, rows_upserted, last_nav_date, status }
 *
 * Source ladder (mirrors sync-nav):
 *   1. 3-day freshness short-circuit — skip all upstream fetches.
 *   2. OpenFolio /v1/nav/{code}?since=<latest_local_date_or_null>
 *      — incremental on warm re-hydrations; full history on first sync.
 *   3. mfapi.in full history — fallback on OF 404 / error / empty-first-sync.
 */

import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';
import {
  createOpenFolioClient,
  resolveOpenFolioCredentials,
} from '../_shared/openfolio.ts';

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

async function upsertNavRows(
  supabase: ReturnType<typeof createServiceClient>,
  rows: { scheme_code: number; nav_date: string; nav: number }[],
  schemeCode: number,
  source: string,
): Promise<number> {
  let upserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
    const { data, error } = await supabase
      .from('nav_history')
      .upsert(chunk, { onConflict: 'scheme_code,nav_date', ignoreDuplicates: true })
      .select('nav_date');
    if (error) {
      console.error(
        '[fetch-fund-nav] scheme=%d source=%s chunk=%d upsert error: %s',
        schemeCode, source, Math.floor(i / UPSERT_CHUNK_SIZE), error.message,
      );
      throw error;
    }
    upserted += data?.length ?? 0;
  }
  return upserted;
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

  // ── 1. Invocation log ──────────────────────────────────────────────────────
  console.log('[fetch-fund-nav] invocation scheme=%d ts=%s', schemeCode, new Date().toISOString());

  // ── 2. Cache check — if the latest row is recent, skip all upstream fetches ─
  const { data: latest, error: latestErr } = await supabase
    .from('nav_history')
    .select('nav_date')
    .eq('scheme_code', schemeCode)
    .order('nav_date', { ascending: false })
    .limit(1);

  if (latestErr) {
    console.error('[fetch-fund-nav] scheme=%d cache check error: %s', schemeCode, latestErr.message);
  }

  const latestDate: string | null = latest?.[0]?.nav_date ?? null;
  if (latestDate) {
    const ageDays = (Date.now() - new Date(latestDate).getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays <= FRESH_NAV_DAYS) {
      console.log(
        '[fetch-fund-nav] scheme=%d cache hit last=%s age=%.1fd — skipping fetch',
        schemeCode, latestDate, ageDays,
      );
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

  // `since` for OpenFolio: if we have history use it for an incremental fetch;
  // null means no local history → request full series (one-time cold-start cost).
  const since: string | null = latestDate ?? null;

  // ── 3. OpenFolio (primary) ─────────────────────────────────────────────────
  let openfolioCreds: ReturnType<typeof resolveOpenFolioCredentials> | null = null;
  try {
    openfolioCreds = resolveOpenFolioCredentials(Deno.env);
  } catch {
    console.warn('[fetch-fund-nav] scheme=%d OpenFolio not configured — using mfapi', schemeCode);
  }

  if (openfolioCreds) {
    const openfolio = createOpenFolioClient({ ...openfolioCreds, timeoutMs: FETCH_TIMEOUT_MS });
    try {
      const series = await openfolio.getNavSeries(schemeCode, { since });

      if (series === null) {
        // 404 — scheme not indexed by OpenFolio → fall through to mfapi
        console.log(
          '[fetch-fund-nav] scheme=%d source=openfolio status=404 since=%s — falling back to mfapi',
          schemeCode, since ?? 'null',
        );
      } else {
        const points = series.points ?? [];
        console.log(
          '[fetch-fund-nav] scheme=%d source=openfolio data_loaded points=%d since=%s',
          schemeCode, points.length, since ?? 'null',
        );

        if (points.length > 0) {
          const dbRows = points.map((p) => ({ scheme_code: schemeCode, nav_date: p.date, nav: p.nav }));
          let upserted: number;
          try {
            upserted = await upsertNavRows(supabase, dbRows, schemeCode, 'openfolio');
          } catch (err) {
            return json({ error: `upsert failed: ${(err as Error).message}` }, { status: 500 });
          }

          const lastNavDate = dbRows.reduce((max, r) => (r.nav_date > max ? r.nav_date : max), dbRows[0].nav_date);
          await stampBackfilledAt(supabase, schemeCode);

          const elapsedMs = Date.now() - startedAt;
          console.log(
            '[fetch-fund-nav] scheme=%d completion source=openfolio rows_upserted=%d last=%s elapsed_ms=%d',
            schemeCode, upserted, lastNavDate, elapsedMs,
          );
          return json({
            scheme_code: schemeCode,
            rows_upserted: upserted,
            last_nav_date: lastNavDate,
            status: 'fetched',
            elapsed_ms: elapsedMs,
          });
        }

        if (since !== null) {
          // Incremental: no new points since the latest local date → already up to date.
          // (The 3-day check above would have caught a truly fresh cache; reaching here
          // means the local series is >3 days old but OpenFolio confirms no newer data.)
          await stampBackfilledAt(supabase, schemeCode);
          const elapsedMs = Date.now() - startedAt;
          console.log(
            '[fetch-fund-nav] scheme=%d completion source=openfolio up_to_date since=%s elapsed_ms=%d',
            schemeCode, since, elapsedMs,
          );
          return json({
            scheme_code: schemeCode,
            rows_upserted: 0,
            last_nav_date: latestDate,
            status: 'cache_hit',
          });
        }

        // since=null (first-ever sync) + empty points → OpenFolio has no history
        // for this scheme. Fall through to mfapi for the full series.
        console.log(
          '[fetch-fund-nav] scheme=%d source=openfolio no_history since=null — falling back to mfapi',
          schemeCode,
        );
      }
    } catch (err) {
      console.warn(
        '[fetch-fund-nav] scheme=%d source=openfolio error="%s" — falling back to mfapi',
        schemeCode, (err as Error).message,
      );
    }
  }

  // ── 4. mfapi.in (fallback) ─────────────────────────────────────────────────
  console.log('[fetch-fund-nav] scheme=%d source=mfapi fetch_start since=%s', schemeCode, since ?? 'null');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let payload: { data?: MfapiNavRow[]; meta?: { scheme_name?: string } };
  try {
    const res = await fetch(`${MFAPI_BASE}/${schemeCode}`, { signal: controller.signal });
    if (!res.ok) {
      console.warn('[fetch-fund-nav] scheme=%d source=mfapi status=%d', schemeCode, res.status);
      return json({ error: `mfapi ${res.status}` }, { status: 502 });
    }
    payload = await res.json();
  } catch (err) {
    console.error('[fetch-fund-nav] scheme=%d source=mfapi error="%s"', schemeCode, String(err));
    return json({ error: String(err) }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  const navRows = payload.data ?? [];
  console.log(
    '[fetch-fund-nav] scheme=%d source=mfapi data_loaded rows=%d',
    schemeCode, navRows.length,
  );

  if (navRows.length === 0) {
    return json({
      scheme_code: schemeCode,
      rows_upserted: 0,
      last_nav_date: latestDate,
      status: 'empty',
    });
  }

  // Convert DD-MM-YYYY → ISO and filter invalid rows.
  const dbRows = navRows
    .map((row) => {
      const isoDate = ddmmyyyyToIso(row.date);
      const nav = Number(row.nav);
      if (!isoDate || !Number.isFinite(nav) || nav <= 0) return null;
      return { scheme_code: schemeCode, nav_date: isoDate, nav };
    })
    .filter((r): r is { scheme_code: number; nav_date: string; nav: number } => r !== null);

  let upserted: number;
  try {
    upserted = await upsertNavRows(supabase, dbRows, schemeCode, 'mfapi');
  } catch (err) {
    return json({ error: `upsert failed: ${(err as Error).message}` }, { status: 500 });
  }

  const lastNavDate = dbRows.length > 0
    ? dbRows.reduce((max, r) => (r.nav_date > max ? r.nav_date : max), dbRows[0].nav_date)
    : latestDate;

  // Stamp nav_backfilled_at now that we have confirmed (or freshly written)
  // NAV data. Best-effort: a failure here must not roll back the upserted rows.
  await stampBackfilledAt(supabase, schemeCode);

  const elapsedMs = Date.now() - startedAt;
  console.log(
    '[fetch-fund-nav] scheme=%d completion source=mfapi rows_upserted=%d last=%s elapsed_ms=%d',
    schemeCode, upserted, lastNavDate, elapsedMs,
  );

  return json({
    scheme_code: schemeCode,
    rows_upserted: upserted,
    last_nav_date: lastNavDate,
    status: 'fetched',
    elapsed_ms: elapsedMs,
  });
});
