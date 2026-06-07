/**
 * universe-backfill — one-time bulk sync of OpenFolio composition + metadata
 * for the **full active AMFI universe** (every scheme in scheme_master, not
 * just held funds) so tools like Compare read composition, metrics, and B1
 * fields locally with no on-demand `fetch-fund-snapshot` latency.
 *
 * Two phases (run independently via `phase` param, or together with 'both'):
 *
 *   'composition' — pages /v1/composition (backfill mode, no updated_since)
 *     against the full scheme_master universe. Skips code_source:'synthetic'
 *     items (OpenFolio placeholder codes, not real AMFI codes).
 *     Writes fund_portfolio_composition source='official' rows + scheme_master
 *     scheme_category / amc_name enrichment (same as monthly openfolio-sync).
 *
 *   'metadata' — pages /v1/metadata bulk endpoint and writes OF-sourced metrics
 *     + B1 fields to scheme_master for every matched scheme. No mfdata fallback
 *     (the daily sync-fund-meta handles held-fund B1 fallback; non-held schemes
 *     get what OF has or null). Only updates existing scheme_master rows.
 *
 * NAV history stays held-scoped — Compare doesn't need NAV history, and the
 * full 20M-row mirror is unnecessarily heavy.
 *
 * Trigger: manual POST (one-time), then kept current by monthly openfolio-sync
 * (composition) and daily sync-fund-meta (held-fund metadata).
 *
 * Deploy with --no-verify-jwt.
 */

import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';
import { trackServerEventAwait } from '../_shared/analytics.ts';
import {
  createOpenFolioClient,
  resolveOpenFolioCredentials,
  runOpenFolioSync,
  type B1FieldStatus,
  type CompositionRow,
  type FundMetadata,
  type SchemeRegistryRow,
  type SchemeUniverse,
} from '../_shared/openfolio.ts';

const PAGE_SIZE = 300;
const TOP = 50;
const MAX_PAGES = 2000; // full universe headroom (~10-14k schemes / 300 = ~47 pages)

const B1_OK_STATUSES = new Set<B1FieldStatus>(['value']);

function resolveB1<T>(
  status: B1FieldStatus | undefined,
  ofValue: T | null | undefined,
): T | null {
  if (!status || !B1_OK_STATUSES.has(status)) return null;
  return ofValue ?? null;
}

/**
 * Load the **full** scheme_master universe: every scheme code + ISIN map,
 * not filtered by the fund table. This is the expanded universe that lets
 * Compare read composition for schemes nobody holds yet.
 */
async function loadFullUniverse(
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
      console.error('[universe-backfill] scheme_master load failed: %s', error.message);
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

/**
 * Metadata phase: page /v1/metadata and write OF-sourced fields to
 * scheme_master for every matched scheme. Returns { written, skipped, failed }.
 */
async function runMetadataBackfill(
  supabase: ReturnType<typeof createServiceClient>,
  client: ReturnType<typeof createOpenFolioClient>,
  knownCodes: Set<number>,
  syncedAt: string,
  log: (msg: string) => void,
): Promise<{ written: number; skipped: number; failed: number }> {
  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    let result;
    try {
      result = await client.listMetadata({ page, pageSize: PAGE_SIZE });
    } catch (err) {
      log(`[universe-backfill] metadata page=${page} fetch failed: ${String(err)}`);
      failed += PAGE_SIZE; // conservative; we don't know how many were on the page
      break;
    }
    const items = Array.isArray(result?.items) ? (result.items as FundMetadata[]) : [];
    log(
      `[universe-backfill] metadata page=${page} fetched=${items.length} ` +
        `(count=${result?.count ?? '?'})`,
    );

    for (const item of items) {
      if (!item?.scheme_code || !knownCodes.has(item.scheme_code)) {
        skipped += 1;
        continue;
      }
      try {
        const b1 = item.b1_field_meta;
        const patch: Record<string, unknown> = {
          openfolio_meta_synced_at: syncedAt,
        };

        // Metrics — always write if present (no status gate; these are computed)
        if (item.metrics?.aum_cr != null) patch.aum_cr = item.metrics.aum_cr;
        if (item.metrics?.returns) {
          const ret = item.metrics.returns;
          const pr: Record<string, number> = {};
          if (ret.ret_1y != null) pr.ret_1y = ret.ret_1y;
          if (ret.ret_3y != null) pr.ret_3y = ret.ret_3y;
          if (ret.ret_5y != null) pr.ret_5y = ret.ret_5y;
          if (Object.keys(pr).length > 0) patch.period_returns = pr;
        }

        // B1 fields — write only when status = 'value'
        const ter = resolveB1(b1?.ter?.status, item.ter);
        if (ter != null) patch.expense_ratio = ter;
        const terDate = resolveB1(b1?.ter_date?.status, item.ter_date);
        if (terDate != null) patch.ter_date = terDate;
        const mgr = resolveB1(b1?.fund_manager?.status, item.fund_manager);
        if (mgr != null) patch.fund_manager = mgr;
        const bench = resolveB1(b1?.benchmark?.status, item.benchmark);
        if (bench != null) patch.declared_benchmark_name = bench;
        const risko = resolveB1(b1?.riskometer?.status, item.riskometer);
        if (risko != null) patch.risk_label = risko;
        const pt = resolveB1(b1?.portfolio_turnover?.status, item.portfolio_turnover);
        if (pt != null) patch.portfolio_turnover = pt;
        const xl = resolveB1(b1?.exit_load?.status, item.exit_load);
        if (xl != null) patch.exit_load = xl;
        const minSip = resolveB1(b1?.min_sip?.status, item.min_sip);
        if (minSip != null) patch.min_sip_amount = minSip;
        const minInv = resolveB1(b1?.min_investment?.status, item.min_investment);
        if (minInv != null) patch.min_lumpsum = minInv;
        const incep = resolveB1(b1?.inception_date?.status, item.inception_date);
        if (incep != null) patch.launch_date = incep;

        const { error } = await supabase
          .from('scheme_master')
          .update(patch)
          .eq('scheme_code', item.scheme_code);
        if (error) {
          failed += 1;
          log(
            `[universe-backfill] metadata update failed scheme=${item.scheme_code}: ${error.message}`,
          );
        } else {
          written += 1;
        }
      } catch (err) {
        failed += 1;
        log(
          `[universe-backfill] metadata item error scheme=${item?.scheme_code}: ${String(err)}`,
        );
      }
    }

    if (items.length < PAGE_SIZE) break;
    if (result?.count && page * PAGE_SIZE >= result.count) break;
  }

  return { written, skipped, failed };
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  let phase: 'composition' | 'metadata' | 'both' = 'both';
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.phase === 'composition') phase = 'composition';
    else if (body?.phase === 'metadata') phase = 'metadata';
  } catch {
    // default 'both'
  }

  console.log('[universe-backfill] invoked method=%s phase=%s', req.method, phase);

  let client: ReturnType<typeof createOpenFolioClient>;
  try {
    const creds = resolveOpenFolioCredentials(Deno.env);
    client = createOpenFolioClient(creds);
    console.log('[universe-backfill] using OpenFolio base=%s', creds.baseUrl);
  } catch (err) {
    console.error('[universe-backfill] credentials: %s', String(err));
    return json({ success: false, error: String(err) }, { status: 500 });
  }

  const supabase = createServiceClient();
  const universe = await loadFullUniverse(supabase);
  console.log(
    '[universe-backfill] universe loaded — %d scheme codes, %d ISIN keys',
    universe.knownCodes.size,
    universe.isinToCode.size,
  );

  const syncedAt = new Date().toISOString();
  const result: Record<string, unknown> = { success: true, phase };

  // ── Composition phase ────────────────────────────────────────────────────
  if (phase === 'composition' || phase === 'both') {
    const upsertRows = async (rows: CompositionRow[]) => {
      const { error } = await supabase
        .from('fund_portfolio_composition')
        .upsert(rows, { onConflict: 'scheme_code,portfolio_date,source' });
      return { error: error?.message ?? null };
    };

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
            '[universe-backfill] registry update failed scheme=%d: %s',
            row.scheme_code,
            error.message,
          );
        }
      }
      return { error: null };
    };

    let compStats;
    try {
      compStats = await runOpenFolioSync({
        client,
        universe,
        upsertRows,
        upsertSchemeRegistry,
        syncedAt,
        log: (msg) => console.log(msg),
        pageSize: PAGE_SIZE,
        top: TOP,
        maxPages: MAX_PAGES,
        updatedSince: null, // full backfill — no date filter
      });
    } catch (err) {
      console.error('[universe-backfill] composition fatal: %s', String(err));
      return json({ success: false, error: String(err) }, { status: 500 });
    }

    console.log(
      '[universe-backfill] composition done — upserted=%d matched_code=%d matched_isin=%d unmatched=%d failed=%d',
      compStats.upserted,
      compStats.matchedByCode,
      compStats.matchedByIsin,
      compStats.unmatched,
      compStats.failed,
    );
    result.composition = compStats;
  }

  // ── Metadata phase ───────────────────────────────────────────────────────
  if (phase === 'metadata' || phase === 'both') {
    let metaResult;
    try {
      metaResult = await runMetadataBackfill(
        supabase,
        client,
        universe.knownCodes,
        syncedAt,
        (msg) => console.log(msg),
      );
    } catch (err) {
      console.error('[universe-backfill] metadata fatal: %s', String(err));
      return json({ success: false, error: String(err) }, { status: 500 });
    }

    console.log(
      '[universe-backfill] metadata done — written=%d skipped=%d failed=%d',
      metaResult.written,
      metaResult.skipped,
      metaResult.failed,
    );
    result.metadata = metaResult;
  }

  const elapsedMs = Date.now() - startedAt;
  result.elapsedMs = elapsedMs;
  console.log('[universe-backfill] completed phase=%s elapsed_ms=%d', phase, elapsedMs);

  await trackServerEventAwait(
    'sync_completed',
    {
      job: 'universe-backfill',
      phase,
      elapsed_ms: elapsedMs,
    },
    'system:universe-backfill',
  );

  return json(result);
});
