/**
 * openfolio-sync — monthly bulk sync of OpenFolio-Data holdings into
 * `fund_portfolio_composition` as the primary `source='official'` rows.
 *
 * OpenFolio-Data (our own service) parses AMCs' SEBI-mandated monthly
 * portfolio disclosures into a REST API. This function pages its bulk
 * `/v1/composition` endpoint, matches each scheme to the funds we track
 * (AMFI scheme_code primary, ISIN secondary), and upserts an `official` row
 * per match. Official outranks mfdata ('amfi') and category rules at read time
 * (see src/utils/compositionSource.ts), so the app reads its own Postgres and
 * never depends on the external API at request time.
 *
 * Modes (POST body { mode, updated_since?, amc? }):
 *   - 'monthly' (default): only schemes whose latest disclosure is on/after
 *     the start of the previous month (the freshly-published batch). Fired by
 *     the `openfolio-composition-monthly` cron on the 15th.
 *   - 'backfill': full sweep (no updated_since) — one-time seed of every
 *     tracked scheme OpenFolio has.
 *
 * Resilience: per-record failures are caught and counted; one bad record never
 * aborts the sweep. The app keeps last month's rows if the API is down.
 *
 * Structured [openfolio-sync] logs at invocation / fetched / per-page /
 * upserted / completion. Deploy with --no-verify-jwt (cron-invoked, no JWT).
 */

import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';
import { trackServerEventAwait } from '../_shared/analytics.ts';
import {
  createOpenFolioClient,
  resolveOpenFolioCredentials,
  runOpenFolioSync,
  type CompositionRow,
  type SchemeRegistryRow,
  type SchemeUniverse,
} from '../_shared/openfolio.ts';

const PAGE_SIZE = 300; // contract max is 500; 300 keeps page payloads bounded for debt-heavy funds
const TOP = 50; // top equity holdings / sectors per scheme (mirrors existing top_holdings cap)
const MAX_PAGES = 500; // headroom far above any real scheme count (50 AMCs); count-based break stops earlier

/**
 * Load the universe of schemes we pre-seed composition for: the **active held
 * funds** (the `fund` table — same scope as `sync-fund-portfolios`), keyed by
 * AMFI plan code (primary) with an ISIN → code map (secondary). We deliberately
 * do NOT use `scheme_master` here: that's the full ~37.6k AMFI catalog, and
 * under the v2 contract every family exposes all its plans, so matching the
 * catalog would write an `official` row for every plan of every OpenFolio
 * family (~8–10k rows) — bloating the table and blowing the sync wall-clock.
 * Funds nobody holds are hydrated on-demand by `fetch-fund-snapshot` (Compare).
 */
async function loadUniverse(
  supabase: ReturnType<typeof createServiceClient>,
): Promise<SchemeUniverse> {
  const knownCodes = new Set<number>();
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('fund')
      .select('scheme_code')
      .eq('is_active', true)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('[openfolio-sync] held-funds load failed: %s', error.message);
      break;
    }
    if (!data || data.length === 0) break;
    for (const row of data as { scheme_code: number }[]) knownCodes.add(row.scheme_code);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  // ISIN secondary key, restricted to held codes (so an ISIN match still
  // resolves to a scheme we serve). Looked up from scheme_master in chunks.
  const isinToCode = new Map<string, number>();
  const codes = [...knownCodes];
  const CHUNK = 500;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('scheme_master')
      .select('scheme_code, isin')
      .in('scheme_code', codes.slice(i, i + CHUNK));
    if (error) {
      console.error('[openfolio-sync] scheme_master isin load failed: %s', error.message);
      break;
    }
    for (const row of (data ?? []) as { scheme_code: number; isin: string | null }[]) {
      if (row.isin) isinToCode.set(String(row.isin).trim().toUpperCase(), row.scheme_code);
    }
  }
  return { knownCodes, isinToCode };
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  let mode: 'monthly' | 'backfill' = 'monthly';
  let updatedSinceOverride: string | null = null;
  let amc: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.mode === 'backfill') mode = 'backfill';
    if (typeof body?.updated_since === 'string') updatedSinceOverride = body.updated_since;
    if (typeof body?.amc === 'string') amc = body.amc;
  } catch {
    // Empty / non-JSON body → defaults (monthly).
  }

  console.log('[openfolio-sync] invoked method=%s mode=%s amc=%s', req.method, mode, amc ?? 'all');

  // Credentials (Deno function secrets). Fail loudly if unset.
  let client: ReturnType<typeof createOpenFolioClient>;
  try {
    const creds = resolveOpenFolioCredentials(Deno.env);
    client = createOpenFolioClient(creds);
    console.log('[openfolio-sync] using OpenFolio base=%s', creds.baseUrl);
  } catch (err) {
    console.error('[openfolio-sync] %s', String(err));
    return json({ success: false, error: String(err) }, { status: 500 });
  }

  const supabase = createServiceClient();

  const universe = await loadUniverse(supabase);
  console.log(
    '[openfolio-sync] universe loaded — %d scheme codes, %d ISIN keys',
    universe.knownCodes.size,
    universe.isinToCode.size,
  );

  // monthly → only the freshly-published batch (latest disclosure on/after the
  // start of the previous month). backfill → full sweep.
  let updatedSince: string | null = null;
  if (mode === 'monthly') {
    if (updatedSinceOverride) {
      updatedSince = updatedSinceOverride;
    } else {
      const now = new Date();
      const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      updatedSince = prevMonthStart.toISOString().split('T')[0];
    }
  }
  console.log('[openfolio-sync] updated_since=%s', updatedSince ?? 'none (full sweep)');

  const syncedAt = new Date().toISOString();

  const upsertRows = async (rows: CompositionRow[]) => {
    const { error } = await supabase
      .from('fund_portfolio_composition')
      .upsert(rows, { onConflict: 'scheme_code,portfolio_date,source' });
    return { error: error?.message ?? null };
  };

  // Registry write-back: update scheme_master.scheme_category + amc_name for
  // matched schemes. Uses individual UPDATE (not upsert) so we only touch rows
  // that already exist in scheme_master — we never insert phantom scheme_master
  // rows. Nulls from OpenFolio are skipped (mapCompositionToRegistryRows
  // excludes rows where both fields are null, so we still write when one is set).
  const upsertSchemeRegistry = async (rows: SchemeRegistryRow[]) => {
    for (const row of rows) {
      const patch: Record<string, string | null> = {};
      if (row.scheme_category !== null) patch.scheme_category = row.scheme_category;
      if (row.amc_name !== null) patch.amc_name = row.amc_name;
      if (Object.keys(patch).length === 0) continue;
      const { error } = await supabase
        .from('scheme_master')
        .update(patch)
        .eq('scheme_code', row.scheme_code);
      if (error) {
        console.error(
          '[openfolio-sync] registry update failed scheme=%d: %s',
          row.scheme_code,
          error.message,
        );
      }
    }
    return { error: null };
  };

  let stats;
  try {
    stats = await runOpenFolioSync({
      client,
      universe,
      upsertRows,
      upsertSchemeRegistry,
      syncedAt,
      log: (msg) => console.log(msg),
      pageSize: PAGE_SIZE,
      top: TOP,
      maxPages: MAX_PAGES,
      updatedSince,
      amc,
    });
  } catch (err) {
    console.error('[openfolio-sync] fatal: %s', String(err));
    return json({ success: false, error: String(err) }, { status: 500 });
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    '[openfolio-sync] completed — upserted=%d matched_code=%d matched_isin=%d unmatched=%d skipped_bad_date=%d failed=%d truncated=%s elapsed_ms=%d',
    stats.upserted,
    stats.matchedByCode,
    stats.matchedByIsin,
    stats.unmatched,
    stats.skippedBadDate,
    stats.failed,
    stats.truncated,
    elapsedMs,
  );

  const eventName = stats.failed > 0 && stats.upserted === 0 ? 'sync_failed' : 'sync_completed';
  await trackServerEventAwait(
    eventName,
    {
      job: 'openfolio-sync',
      mode,
      updated_since: updatedSince,
      pages_fetched: stats.pagesFetched,
      items_fetched: stats.itemsFetched,
      total_count: stats.totalCount,
      matched_by_code: stats.matchedByCode,
      matched_by_isin: stats.matchedByIsin,
      unmatched: stats.unmatched,
      skipped_bad_date: stats.skippedBadDate,
      upserted: stats.upserted,
      failed: stats.failed,
      truncated: stats.truncated,
      elapsed_ms: elapsedMs,
    },
    'system:openfolio-sync',
  );

  return json({
    success: true,
    mode,
    updatedSince,
    ...stats,
    errors: stats.errors.slice(0, 20),
    elapsedMs,
  });
});
