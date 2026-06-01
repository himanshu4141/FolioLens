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
  type SchemeUniverse,
} from '../_shared/openfolio.ts';

const PAGE_SIZE = 300; // contract max is 500; 300 keeps page payloads bounded for debt-heavy funds
const TOP = 50; // top equity holdings / sectors per scheme (mirrors existing top_holdings cap)
const MAX_PAGES = 500; // headroom far above any real scheme count (50 AMCs); count-based break stops earlier

/**
 * Load the universe of schemes we track from scheme_master: real AMFI codes
 * (primary match key) and an ISIN → code map (secondary match key).
 */
async function loadUniverse(
  supabase: ReturnType<typeof createServiceClient>,
): Promise<SchemeUniverse> {
  const knownCodes = new Set<number>();
  const isinToCode = new Map<string, number>();
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('scheme_master')
      .select('scheme_code, isin')
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('[openfolio-sync] scheme_master load failed: %s', error.message);
      break;
    }
    if (!data || data.length === 0) break;
    for (const row of data as { scheme_code: number; isin: string | null }[]) {
      knownCodes.add(row.scheme_code);
      if (row.isin) isinToCode.set(String(row.isin).trim().toUpperCase(), row.scheme_code);
    }
    if (data.length < PAGE) break;
    from += PAGE;
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

  let stats;
  try {
    stats = await runOpenFolioSync({
      client,
      universe,
      upsertRows,
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
