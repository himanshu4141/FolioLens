/**
 * universe-backfill — bulk sync of OpenFolio composition + metadata
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
 * Known tradeoff — openfolio_meta_synced_at mark: the metadata phase stamps
 * every matched scheme_master row with `openfolio_meta_synced_at = syncedAt`.
 * `sync-fund-meta` uses `isSchemeMetaFresh` (7-day window) to skip schemes
 * already covered by OF. After the backfill, newly-held funds that have never
 * had a `sync-fund-meta` run will appear OF-fresh and their mfdata fallback
 * for `unresolved`/`parse_failed` B1 fields (expense_ratio, exit_load, etc.)
 * will be deferred up to 7 days. If immediate mfdata coverage is needed after
 * the backfill, trigger `sync-fund-meta` manually before the 7-day window
 * lapses (it will skip OF-only and proceed straight to mfdata for those fields).
 *
 * Chunked invocation: Each request processes at most ~5 pages (~1500 items per
 * invocation). Cursor state is stored in app_config for resumption. Returns 200
 * with progress JSON {phase, cursor, done, stats} on success or a 4xx/5xx error
 * status (never silently breaks) on page-fetch failure so the re-invoker knows
 * to retry or escalate.
 *
 * Trigger: GitHub Actions workflow (every 10 minutes until done), then kept
 * current by monthly openfolio-sync (composition) and daily sync-fund-meta
 * (held-fund metadata).
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
  type SchemeUniverse,
} from '../_shared/openfolio.ts';
import { makeRegistryUpsert } from '../_shared/registry-upsert.ts';

const PAGE_SIZE = 300;
const TOP = 50;
const MAX_PAGES = 2000; // full universe headroom (~10-14k schemes / 300 = ~47 pages)
const PAGES_PER_INVOCATION = 5; // process at most 5 pages (≈1500 items) per invocation

const B1_OK_STATUSES = new Set<B1FieldStatus>(['value']);

/**
 * Intentional divergence from `resolveB1Field` in `_shared/b1-field-resolution.ts`:
 *
 * - `resolveB1Field` returns `undefined` for non-'value' statuses to signal
 *   "leave the DB column alone" — callers use `if (v !== undefined)` to skip
 *   the write. That supports the mfdata fallback path (try OF, then mfdata).
 *
 * - This local `resolveB1` returns `null` for non-'value' statuses. Combined
 *   with `if (ter != null) patch.expense_ratio = ter`, it achieves the same
 *   "only write confirmed values" outcome without the `undefined` sentinel —
 *   cleaner for the no-fallback backfill path where we never call mfdata.
 */
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

interface CompositionBackfillState {
  phase: 'composition';
  cursor: number;
  totalCount: number;
  upserted: number;
  matchedByCode: number;
  matchedByIsin: number;
  unmatched: number;
  failed: number;
}

interface MetadataBackfillState {
  phase: 'metadata';
  cursor: number; // next page to process
  totalCount: number;
  written: number;
  skipped: number;
  failed: number;
}

/**
 * Fetch and write up to PAGES_PER_INVOCATION pages of composition.
 * Returns the new cursor and stats, or throws on page-fetch failure (fatal).
 */
async function runCompositionBackfillChunk(
  supabase: ReturnType<typeof createServiceClient>,
  client: ReturnType<typeof createOpenFolioClient>,
  universe: SchemeUniverse,
  syncedAt: string,
  startPage: number,
  log: (msg: string) => void,
): Promise<{
  endPage: number;
  totalCount: number;
  upserted: number;
  matchedByCode: number;
  matchedByIsin: number;
  unmatched: number;
  failed: number;
}> {
  const upsertRows = async (rows: CompositionRow[]) => {
    const { error } = await supabase
      .from('fund_portfolio_composition')
      .upsert(rows, { onConflict: 'scheme_code,portfolio_date,source' });
    return { error: error?.message ?? null };
  };

  const upsertSchemeRegistry = makeRegistryUpsert(supabase, '[universe-backfill]');

  const stats = await runOpenFolioSync({
    client,
    universe,
    upsertRows,
    upsertSchemeRegistry,
    syncedAt,
    log,
    pageSize: PAGE_SIZE,
    top: TOP,
    maxPages: PAGES_PER_INVOCATION, // chunk it
    updatedSince: null,
  });

  return {
    endPage: startPage + stats.pagesFetched,
    totalCount: stats.totalCount,
    upserted: stats.upserted,
    matchedByCode: stats.matchedByCode,
    matchedByIsin: stats.matchedByIsin,
    unmatched: stats.unmatched,
    failed: stats.failed,
  };
}

/**
 * Fetch and write up to PAGES_PER_INVOCATION pages of metadata.
 * Returns the new cursor and stats, or throws on page-fetch failure (fatal).
 */
async function runMetadataBackfillChunk(
  supabase: ReturnType<typeof createServiceClient>,
  client: ReturnType<typeof createOpenFolioClient>,
  knownCodes: Set<number>,
  syncedAt: string,
  startPage: number,
  log: (msg: string) => void,
): Promise<{ endPage: number; totalCount: number; written: number; skipped: number; failed: number }> {
  let written = 0;
  let skipped = 0;
  let failed = 0;
  let totalCount = 0;

  for (let page = startPage; page < startPage + PAGES_PER_INVOCATION && page <= MAX_PAGES; page++) {
    let result;
    try {
      result = await client.listMetadata({ page, pageSize: PAGE_SIZE });
    } catch (err) {
      const msg = `[universe-backfill] metadata page=${page} fetch failed: ${String(err)}`;
      log(msg);
      throw new Error(msg);
    }
    const items = Array.isArray(result?.items) ? (result.items as FundMetadata[]) : [];
    totalCount = typeof result?.count === 'number' ? result.count : totalCount;
    log(
      `[universe-backfill] metadata page=${page} fetched=${items.length} ` +
        `(count=${totalCount})`,
    );

    const pageWork: Array<{ schemeCode: number; patch: Record<string, unknown> }> = [];
    for (const item of items) {
      if (!item?.scheme_code || !knownCodes.has(item.scheme_code)) {
        skipped += 1;
        continue;
      }
      const b1 = item.b1_field_meta;
      const patch: Record<string, unknown> = { openfolio_meta_synced_at: syncedAt };

      if (item.metrics?.aum_cr != null) patch.aum_cr = item.metrics.aum_cr;
      if (item.metrics?.returns) {
        const ret = item.metrics.returns;
        const pr: Record<string, number> = {};
        if (ret.ret_1y != null) pr.ret_1y = ret.ret_1y;
        if (ret.ret_3y != null) pr.ret_3y = ret.ret_3y;
        if (ret.ret_5y != null) pr.ret_5y = ret.ret_5y;
        if (Object.keys(pr).length > 0) patch.period_returns = pr;
      }

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

      pageWork.push({ schemeCode: item.scheme_code, patch });
    }

    const BATCH = 50;
    for (let i = 0; i < pageWork.length; i += BATCH) {
      const batch = pageWork.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async ({ schemeCode, patch }) => {
          try {
            const { error } = await supabase.from('scheme_master').update(patch).eq('scheme_code', schemeCode);
            return { schemeCode, error };
          } catch (err) {
            return { schemeCode, error: { message: String(err) } };
          }
        }),
      );
      for (const { schemeCode, error } of results) {
        if (error) {
          failed += 1;
          log(`[universe-backfill] metadata update failed scheme=${schemeCode}: ${error.message}`);
        } else {
          written += 1;
        }
      }
    }

    if (items.length < PAGE_SIZE) return { endPage: page + 1, totalCount, written, skipped, failed };
    if (totalCount > 0 && page * PAGE_SIZE >= totalCount) return { endPage: page + 1, totalCount, written, skipped, failed };
  }

  return { endPage: startPage + PAGES_PER_INVOCATION, totalCount, written, skipped, failed };
}

async function readCursor(
  supabase: ReturnType<typeof createServiceClient>,
  phase: string,
): Promise<CompositionBackfillState | MetadataBackfillState | null> {
  const key = `universe_backfill_${phase}_cursor`;
  const { data, error } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', key)
    .single();
  if (error || !data) return null;
  try {
    return JSON.parse(data.value);
  } catch {
    return null;
  }
}

async function writeCursor(
  supabase: ReturnType<typeof createServiceClient>,
  state: CompositionBackfillState | MetadataBackfillState,
): Promise<void> {
  const key = `universe_backfill_${state.phase}_cursor`;
  await supabase
    .from('app_config')
    .upsert({ key, value: JSON.stringify(state), description: `Cursor for ${state.phase} phase of universe-backfill` })
    .eq('key', key);
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

  // Load universe once — reused across both composition and metadata phases
  let universe: SchemeUniverse;
  try {
    universe = await loadFullUniverse(supabase);
    console.log(
      '[universe-backfill] universe loaded — %d scheme codes, %d ISIN keys',
      universe.knownCodes.size,
      universe.isinToCode.size,
    );
  } catch (err) {
    console.error('[universe-backfill] universe load: %s', String(err));
    return json({ success: false, error: String(err) }, { status: 500 });
  }

  const syncedAt = new Date().toISOString();

  // ── Composition phase (chunked with cursor resumption) ────────────────────
  if (phase === 'composition' || phase === 'both') {
    let stateRaw = await readCursor(supabase, 'composition');
    let state: CompositionBackfillState;
    if (!stateRaw || stateRaw.phase !== 'composition') {
      state = {
        phase: 'composition',
        cursor: 1,
        totalCount: 0,
        upserted: 0,
        matchedByCode: 0,
        matchedByIsin: 0,
        unmatched: 0,
        failed: 0,
      };
      console.log('[universe-backfill] composition starting fresh cursor');
    } else {
      state = stateRaw as CompositionBackfillState;
      console.log('[universe-backfill] composition resuming cursor=%d', state.cursor);
    }

    try {
      const chunk = await runCompositionBackfillChunk(
        supabase,
        client,
        universe,
        syncedAt,
        state.cursor,
        (msg) => console.log(msg),
      );

      state.cursor = chunk.endPage;
      state.totalCount = chunk.totalCount;
      state.upserted += chunk.upserted;
      state.matchedByCode += chunk.matchedByCode;
      state.matchedByIsin += chunk.matchedByIsin;
      state.unmatched += chunk.unmatched;
      state.failed += chunk.failed;

      const done = state.totalCount === 0 || state.cursor * PAGE_SIZE > state.totalCount;
      if (!done) {
        await writeCursor(supabase, state);
      } else {
        const key = `universe_backfill_composition_cursor`;
        await supabase.from('app_config').delete().eq('key', key);
      }

      console.log(
        '[universe-backfill] composition chunk done — cursor=%d done=%s upserted=%d matched_code=%d matched_isin=%d unmatched=%d failed=%d',
        state.cursor,
        done,
        state.upserted,
        state.matchedByCode,
        state.matchedByIsin,
        state.unmatched,
        state.failed,
      );

      if (phase === 'composition') {
        const elapsedMs = Date.now() - startedAt;
        return json({
          success: true,
          phase: 'composition',
          cursor: state.cursor,
          done,
          stats: {
            upserted: state.upserted,
            matchedByCode: state.matchedByCode,
            matchedByIsin: state.matchedByIsin,
            unmatched: state.unmatched,
            failed: state.failed,
            totalCount: state.totalCount,
          },
          elapsed_ms: elapsedMs,
        });
      }
    } catch (err) {
      const msg = String(err);
      console.error('[universe-backfill] composition page-fetch fatal: %s', msg);
      return json(
        { success: false, error: msg, phase: 'composition', cursor: state.cursor },
        { status: 500 },
      );
    }
  }

  // ── Metadata phase (chunked with cursor resumption) ────────────────────────
  if (phase === 'metadata' || phase === 'both') {
    let stateRaw = await readCursor(supabase, 'metadata');
    let state: MetadataBackfillState;
    if (!stateRaw || stateRaw.phase !== 'metadata') {
      state = {
        phase: 'metadata',
        cursor: 1,
        totalCount: 0,
        written: 0,
        skipped: 0,
        failed: 0,
      };
      console.log('[universe-backfill] metadata starting fresh cursor');
    } else {
      state = stateRaw as MetadataBackfillState;
      console.log('[universe-backfill] metadata resuming cursor=%d', state.cursor);
    }

    try {
      const chunk = await runMetadataBackfillChunk(
        supabase,
        client,
        universe.knownCodes,
        syncedAt,
        state.cursor,
        (msg) => console.log(msg),
      );

      state.cursor = chunk.endPage;
      state.totalCount = chunk.totalCount;
      state.written += chunk.written;
      state.skipped += chunk.skipped;
      state.failed += chunk.failed;

      const done = state.totalCount === 0 || state.cursor * PAGE_SIZE >= state.totalCount;
      if (!done) {
        await writeCursor(supabase, state);
      } else {
        const key = `universe_backfill_metadata_cursor`;
        await supabase.from('app_config').delete().eq('key', key);
      }

      console.log(
        '[universe-backfill] metadata chunk done — cursor=%d done=%s written=%d skipped=%d failed=%d',
        state.cursor,
        done,
        state.written,
        state.skipped,
        state.failed,
      );

      const elapsedMs = Date.now() - startedAt;
      return json({
        success: true,
        phase: 'metadata',
        cursor: state.cursor,
        done,
        stats: {
          written: state.written,
          skipped: state.skipped,
          failed: state.failed,
          totalCount: state.totalCount,
        },
        elapsed_ms: elapsedMs,
      });
    } catch (err) {
      const msg = String(err);
      console.error('[universe-backfill] metadata page-fetch fatal: %s', msg);
      return json(
        { success: false, error: msg, phase: 'metadata', cursor: state.cursor },
        { status: 500 },
      );
    }
  }

  return json({ success: false, error: 'no phase selected' }, { status: 400 });
});
