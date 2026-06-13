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
 * Chunked invocation: Each request processes at most ~2 pages (~600 items per
 * invocation). Cursor state is stored in app_config for resumption. Done markers
 * (universe_backfill_{phase}_done_at) track completion to avoid re-running.
 * Returns 200 with progress JSON {phase, cursor, done, stats} on success or a
 * 4xx/5xx error status (never silently breaks) on page-fetch failure so the
 * re-invoker knows to retry or escalate.
 *
 * Trigger: GitHub Actions workflow (every 15 minutes, ~8 invocations per run),
 * then kept current by monthly openfolio-sync (composition) and daily
 * sync-fund-meta (held-fund metadata).
 *
 * Universe loading strategy: per-page incremental lookup. Instead of loading
 * all 37,595 schemes upfront (38 round trips → ~150s timeout), each page of OF
 * data triggers a single targeted IN query for the ~300 codes/ISINs on that
 * page. This reduces per-invocation overhead from ~150s to ~2s.
 *
 * Deploy with --no-verify-jwt.
 */

import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';
import { trackServerEventAwait } from '../_shared/analytics.ts';
import {
  createOpenFolioClient,
  resolveOpenFolioCredentials,
  isPlausibleDisclosureDate,
  mapCompositionToRow,
  mapCompositionToRegistryRows,
  resolveSchemeCodes,
  type B1FieldStatus,
  type CompositionRow,
  type FundMetadata,
  type OpenFolioComposition,
  type SchemeRegistryRow,
  type SchemeUniverse,
} from '../_shared/openfolio.ts';
import { makeRegistryUpsert } from '../_shared/registry-upsert.ts';
import {
  resolveSebiCategory,
  broadCategoryFromSebi,
  selectCategoryFromSiblings,
  type SiblingCandidateRow,
} from '../_shared/portfolio-utils.ts';

// Metadata: small payload per item (no holdings), large pages are fine
const META_PAGE_SIZE = 300;
const META_MAX_PAGES = 2000; // ~14k schemes / 300 = ~47 pages

// Composition: each item includes top_holdings — large payload. Use small pages
// to keep each API response under ~500KB and avoid the 150s edge-fn idle timeout.
const COMP_PAGE_SIZE = 50;
const COMP_TOP = 10; // top holdings per family (down from 50: 50×10 vs 300×50 = 30× smaller responses)
const COMP_MAX_PAGES = 2000; // ~14k families / 50 = ~280 pages

const PAGES_PER_INVOCATION = 1; // 1 OF API call per phase per invocation; 2 calls for phase='both'

const B1_OK_STATUSES = new Set<B1FieldStatus>(['value']);

/**
 * Resolve B1 fields with NULL-write semantics.
 *
 * Divergence from `resolveB1Field` in `_shared/b1-field-resolution.ts`:
 * - `resolveB1Field` returns `undefined` for non-'value' statuses to signal
 *   "leave the DB column alone" — supports mfdata fallback (try OF, then mfdata).
 * - This local `resolveB1` handles three cases:
 *   1. status='value' → return the OF value (or null if OF has no value)
 *   2. status='officially_absent' or other non-value → return null (write NULL)
 *   3. status=undefined (field missing from API) → return undefined (no-touch)
 *
 * This enables the P4 upstream correction propagation path: when OpenFolio
 * explicitly reports a field as 'not_applicable', 'parse_failed', etc.,
 * we write NULL to retract junk values FolioLens previously cached.
 */
function resolveB1<T>(
  status: B1FieldStatus | undefined,
  ofValue: T | null | undefined,
): T | null | undefined {
  // Missing status = field not in API response = don't touch DB
  if (status === undefined) return undefined;
  // status='value' = use OF value (or null if empty)
  if (B1_OK_STATUSES.has(status)) return ofValue ?? null;
  // status is non-value (officially_absent, not_applicable, unresolved, parse_failed, source_failed)
  // → write NULL to retract any previous value (propagates P4 upstream corrections)
  return null;
}

function resolveB1Integer(
  status: B1FieldStatus | undefined,
  ofValue: number | null | undefined,
): number | null | undefined {
  const value = resolveB1(status, ofValue);
  if (value === undefined) return undefined; // no-touch
  if (value == null) return null; // write NULL (retract)
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null; // invalid → null
  return value;
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
 * Build a mini SchemeUniverse for the plan codes and ISINs present on one
 * composition page by querying scheme_master with targeted IN clauses.
 * Runs two parallel queries (one per key type) and merges results.
 */
async function resolvePageUniverse(
  supabase: ReturnType<typeof createServiceClient>,
  items: OpenFolioComposition[],
): Promise<SchemeUniverse> {
  const pageCodes: number[] = [];
  const pageIsins: string[] = [];
  for (const item of items) {
    for (const plan of Array.isArray(item?.plans) ? item.plans : []) {
      if (typeof plan?.plan_code === 'number') pageCodes.push(plan.plan_code);
      for (const isin of Array.isArray(plan?.isins) ? plan.isins : []) {
        const norm = (isin ?? '').trim().toUpperCase();
        if (norm) pageIsins.push(norm);
      }
    }
  }

  const knownCodes = new Set<number>();
  const isinToCode = new Map<string, number>();

  if (pageCodes.length === 0 && pageIsins.length === 0) return { knownCodes, isinToCode };

  const [codeRes, isinRes] = await Promise.all([
    pageCodes.length > 0
      ? supabase.from('scheme_master').select('scheme_code, isin').in('scheme_code', pageCodes)
      : Promise.resolve({ data: [] as Array<{ scheme_code: number; isin: string | null }> }),
    pageIsins.length > 0
      ? supabase.from('scheme_master').select('scheme_code, isin').in('isin', pageIsins)
      : Promise.resolve({ data: [] as Array<{ scheme_code: number; isin: string | null }> }),
  ]);

  for (const row of [...(codeRes.data ?? []), ...(isinRes.data ?? [])]) {
    knownCodes.add(row.scheme_code);
    if (row.isin) isinToCode.set(String(row.isin).trim().toUpperCase(), row.scheme_code);
  }

  return { knownCodes, isinToCode };
}

/**
 * Fetch and write up to PAGES_PER_INVOCATION pages of composition starting
 * from startPage. Builds a per-page mini-universe via targeted IN queries
 * instead of pre-loading all 37k schemes — reduces invocation overhead from
 * ~150s to ~2s.
 */
async function runCompositionBackfillChunk(
  supabase: ReturnType<typeof createServiceClient>,
  client: ReturnType<typeof createOpenFolioClient>,
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
  const today = syncedAt.slice(0, 10);
  const upsertSchemeRegistry = makeRegistryUpsert(supabase, '[universe-backfill]');
  let totalCount = 0;
  let upserted = 0;
  let matchedByCode = 0;
  let matchedByIsin = 0;
  let unmatched = 0;
  let failed = 0;

  for (
    let page = startPage;
    page < startPage + PAGES_PER_INVOCATION && page <= COMP_MAX_PAGES;
    page++
  ) {
    let result;
    try {
      result = await client.listComposition({
        page,
        pageSize: COMP_PAGE_SIZE,
        top: COMP_TOP,
        updatedSince: null,
        amc: null,
      });
    } catch (err) {
      const msg = `[universe-backfill] composition page=${page} fetch failed: ${String(err)}`;
      log(msg);
      throw new Error(msg);
    }

    const items = Array.isArray(result?.items) ? (result.items as OpenFolioComposition[]) : [];
    totalCount = typeof result?.count === 'number' ? result.count : totalCount;
    log(
      `[universe-backfill] composition page=${page} fetched=${items.length} (count=${totalCount})`,
    );

    // Per-page mini-universe: one targeted IN query instead of 38 full-scan queries
    const miniUniverse = await resolvePageUniverse(supabase, items);
    log(
      `[universe-backfill] composition page=${page} universe resolved: codes=${miniUniverse.knownCodes.size} isins=${miniUniverse.isinToCode.size}`,
    );

    const pageRows: CompositionRow[] = [];
    const pageRegistryRows: SchemeRegistryRow[] = [];

    for (const item of items) {
      if (!item) {
        unmatched++;
        continue;
      }
      const matches = resolveSchemeCodes(item, miniUniverse);
      if (matches.length === 0) {
        unmatched++;
        log(`[universe-backfill] composition skip family=${item.family_id ?? 'none'} (no matches)`);
        continue;
      }
      if (!isPlausibleDisclosureDate(item.disclosure_date, today)) {
        log(
          `[universe-backfill] composition skip family=${item.family_id ?? 'none'} bad date=${item.disclosure_date ?? 'none'}`,
        );
        continue;
      }
      for (const match of matches) {
        if (match.matchedBy === 'plan_code') matchedByCode++;
        else matchedByIsin++;
        try {
          pageRows.push(mapCompositionToRow(item, match.schemeCode, syncedAt));
        } catch (err) {
          failed++;
          log(
            `[universe-backfill] composition mapRow failed scheme=${match.schemeCode}: ${String(err)}`,
          );
        }
      }
      for (const regRow of mapCompositionToRegistryRows(item, matches)) {
        pageRegistryRows.push(regRow);
      }
    }

    // Batch upsert with per-row fallback on error
    if (pageRows.length > 0) {
      const { error } = await supabase
        .from('fund_portfolio_composition')
        .upsert(pageRows, { onConflict: 'scheme_code,portfolio_date,source' });
      if (error) {
        for (const row of pageRows) {
          const { error: rowErr } = await supabase
            .from('fund_portfolio_composition')
            .upsert([row], { onConflict: 'scheme_code,portfolio_date,source' });
          if (rowErr) {
            failed++;
            log(
              `[universe-backfill] composition upsert failed scheme=${row.scheme_code}: ${rowErr.message}`,
            );
          } else {
            upserted++;
          }
        }
      } else {
        upserted += pageRows.length;
      }
    }

    if (pageRegistryRows.length > 0) {
      try {
        await upsertSchemeRegistry(pageRegistryRows);
      } catch (err) {
        log(`[universe-backfill] composition registry upsert failed: ${String(err)}`);
      }
    }

    if (items.length < COMP_PAGE_SIZE)
      return {
        endPage: page + 1,
        totalCount,
        upserted,
        matchedByCode,
        matchedByIsin,
        unmatched,
        failed,
      };
    if (totalCount > 0 && page * COMP_PAGE_SIZE >= totalCount)
      return {
        endPage: page + 1,
        totalCount,
        upserted,
        matchedByCode,
        matchedByIsin,
        unmatched,
        failed,
      };
  }

  return {
    endPage: startPage + PAGES_PER_INVOCATION,
    totalCount,
    upserted,
    matchedByCode,
    matchedByIsin,
    unmatched,
    failed,
  };
}

/**
 * Fetch and write up to PAGES_PER_INVOCATION pages of metadata starting
 * from startPage. Resolves known scheme codes per-page via an IN query
 * instead of holding a 37k-entry Set in memory.
 */
async function runMetadataBackfillChunk(
  supabase: ReturnType<typeof createServiceClient>,
  client: ReturnType<typeof createOpenFolioClient>,
  syncedAt: string,
  startPage: number,
  log: (msg: string) => void,
): Promise<{
  endPage: number;
  totalCount: number;
  written: number;
  skipped: number;
  failed: number;
}> {
  let written = 0;
  let skipped = 0;
  let failed = 0;
  let totalCount = 0;

  for (
    let page = startPage;
    page < startPage + PAGES_PER_INVOCATION && page <= META_MAX_PAGES;
    page++
  ) {
    let result;
    try {
      result = await client.listMetadata({ page, pageSize: META_PAGE_SIZE });
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

    // Per-page scheme_code lookup — single IN query for the ~300 codes on this page
    const pageCodes = items
      .map((item) => item?.scheme_code)
      .filter((c): c is number => typeof c === 'number');
    const knownCodes = new Set<number>();
    if (pageCodes.length > 0) {
      const { data: knownRows } = await supabase
        .from('scheme_master')
        .select('scheme_code')
        .in('scheme_code', pageCodes);
      for (const row of knownRows ?? []) knownCodes.add(row.scheme_code);
    }

    const pageWork: Array<{ schemeCode: number; patch: Record<string, unknown> }> = [];
    for (const item of items) {
      if (!item?.scheme_code || !knownCodes.has(item.scheme_code)) {
        skipped += 1;
        continue;
      }
      const b1 = item.b1_field_meta;
      const patch: Record<string, unknown> = { openfolio_meta_synced_at: syncedAt };

      if (item.active != null) patch.scheme_active = item.active;
      if (item.metrics?.aum_cr != null) patch.aum_cr = item.metrics.aum_cr;
      if (item.metrics?.returns) {
        const ret = item.metrics.returns;
        const pr: Record<string, number> = {};
        if (ret.ret_1y != null) pr.ret_1y = ret.ret_1y;
        if (ret.ret_3y != null) pr.ret_3y = ret.ret_3y;
        if (ret.ret_5y != null) pr.ret_5y = ret.ret_5y;
        if (Object.keys(pr).length > 0) patch.period_returns = pr;
      }

      // Build risk_ratios with volatility and max_drawdown_5y from OF metrics.
      // Note: universe-backfill doesn't load existing risk_ratios to preserve
      // mfdata beta; that's sync-fund-meta's responsibility. This backfill
      // simply populates the OF metrics.
      if (item.metrics?.volatility != null || item.metrics?.max_drawdown_5y != null) {
        const rr: Record<string, unknown> = {};
        if (item.metrics.volatility != null) rr.volatility = item.metrics.volatility;
        if (item.metrics.max_drawdown_5y != null) rr.max_drawdown_5y = item.metrics.max_drawdown_5y;
        if (item.metrics.computed_from_nav_date)
          rr.computed_from_nav_date = item.metrics.computed_from_nav_date;
        patch.risk_ratios = rr;
      }

      const ter = resolveB1(b1?.ter?.status, item.ter);
      if (ter !== undefined) patch.expense_ratio = ter;
      const terDate = resolveB1(b1?.ter_date?.status, item.ter_date);
      if (terDate !== undefined) patch.ter_date = terDate;
      const mgr = resolveB1(b1?.fund_manager?.status, item.fund_manager);
      if (mgr !== undefined) patch.fund_manager = mgr;
      const bench = resolveB1(b1?.benchmark?.status, item.benchmark);
      if (bench !== undefined) patch.declared_benchmark_name = bench;
      const risko = resolveB1(b1?.riskometer?.status, item.riskometer);
      if (risko !== undefined) patch.risk_label = risko;
      const pt = resolveB1(b1?.portfolio_turnover?.status, item.portfolio_turnover);
      if (pt !== undefined) patch.portfolio_turnover = pt;
      const xl = resolveB1(b1?.exit_load?.status, item.exit_load);
      if (xl !== undefined) patch.exit_load = xl;
      const minSip = resolveB1Integer(b1?.min_sip?.status, item.min_sip);
      if (minSip !== undefined) patch.min_sip_amount = minSip;
      const minInv = resolveB1Integer(b1?.min_investment?.status, item.min_investment);
      if (minInv !== undefined) patch.min_lumpsum = minInv;
      const incep = resolveB1(b1?.inception_date?.status, item.inception_date);
      if (incep !== undefined) patch.launch_date = incep;

      pageWork.push({ schemeCode: item.scheme_code, patch });
    }

    const BATCH = 50;
    for (let i = 0; i < pageWork.length; i += BATCH) {
      const batch = pageWork.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async ({ schemeCode, patch }) => {
          try {
            const { error } = await supabase
              .from('scheme_master')
              .update(patch)
              .eq('scheme_code', schemeCode);
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

    // Category inheritance for schemes processed on this page (Layer 1 + Layer 2).
    // Uses all codes that were queued for update (errors are fine — the DB guards
    // against overwrite and the inheritance queries simply find nothing to do).
    const pageProcessedCodes = pageWork.map((w) => w.schemeCode);
    if (pageProcessedCodes.length > 0) {
      const inherited = await applyMetadataSiblingInheritance(supabase, pageProcessedCodes, log);
      const nameResolved = await applyMetadataNameHeuristics(supabase, pageProcessedCodes, log);
      if (inherited > 0 || nameResolved > 0) {
        log(
          `[universe-backfill] category fill — sibling_inherited=${inherited} name_resolved=${nameResolved}`,
        );
      }
    }

    if (items.length < META_PAGE_SIZE)
      return { endPage: page + 1, totalCount, written, skipped, failed };
    if (totalCount > 0 && page * META_PAGE_SIZE >= totalCount)
      return { endPage: page + 1, totalCount, written, skipped, failed };
  }

  return { endPage: startPage + PAGES_PER_INVOCATION, totalCount, written, skipped, failed };
}

/**
 * Layer 1 sibling inheritance — copy sebi_category + scheme_category from a
 * categorised plan-sibling when the current page introduced new null-category
 * scheme_master rows.  Runs once per metadata chunk invocation after the main
 * OF metadata write, so future plan aliases pick up their family category
 * immediately rather than waiting for the next mfdata / backfill pass.
 *
 * Assumption: category is a family-level fact — all plan/option variants of
 * the same fund belong to the same SEBI sub-bucket and broad asset class.
 * See selectCategoryFromSiblings for safety guards (never-overwrite, skip-
 * ambiguous).
 *
 * Returns the count of schemes updated.
 */
async function applyMetadataSiblingInheritance(
  supabase: ReturnType<typeof createServiceClient>,
  updatedCodes: number[],
  log: (msg: string) => void,
): Promise<number> {
  if (updatedCodes.length === 0) return 0;

  // Load the schemes we just wrote that are still missing a category.
  const { data: nullRows } = await supabase
    .from('scheme_master')
    .select('scheme_code, scheme_name, amc_name, scheme_category, sebi_category')
    .in('scheme_code', updatedCodes)
    .is('sebi_category', null)
    .is('scheme_category', null)
    .eq('scheme_active', true);

  if (!nullRows?.length) return 0;

  // Collect AMC names to limit the sibling pool query.
  const amcNames = [...new Set(nullRows.map((r) => r.amc_name).filter(Boolean))] as string[];

  // Load all categorised active schemes for the same AMCs.
  const { data: siblingPool } = await supabase
    .from('scheme_master')
    .select('scheme_code, scheme_name, amc_name, scheme_category, sebi_category')
    .in('amc_name', amcNames)
    .not('sebi_category', 'is', null)
    .not('scheme_category', 'is', null)
    .eq('scheme_active', true);

  if (!siblingPool?.length) return 0;

  const candidates = siblingPool as SiblingCandidateRow[];
  let inherited = 0;

  for (const row of nullRows as SiblingCandidateRow[]) {
    const pair = selectCategoryFromSiblings(row, candidates);
    if (!pair) continue;

    const { error } = await supabase
      .from('scheme_master')
      .update({ sebi_category: pair.sebi_category, scheme_category: pair.scheme_category })
      .eq('scheme_code', row.scheme_code)
      .is('sebi_category', null) // idempotency guard: skip if filled in the interim
      .is('scheme_category', null);

    if (error) {
      log(
        `[universe-backfill] sibling-inherit scheme=${row.scheme_code} update error: ${error.message}`,
      );
    } else {
      log(
        `[universe-backfill] sibling-inherit scheme=${row.scheme_code} ` +
          `"${row.scheme_name.slice(0, 50)}" → sebi=${pair.sebi_category}`,
      );
      inherited++;
    }
  }

  return inherited;
}

/**
 * Layer 2 name-heuristic pass — applies resolveSebiCategory + broadCategoryFromSebi
 * to newly written null-category rows using only the scheme_name already in the DB.
 * No network calls.  Run after sibling inheritance so we only touch the residue.
 */
async function applyMetadataNameHeuristics(
  supabase: ReturnType<typeof createServiceClient>,
  updatedCodes: number[],
  log: (msg: string) => void,
): Promise<number> {
  if (updatedCodes.length === 0) return 0;

  const { data: nullRows } = await supabase
    .from('scheme_master')
    .select('scheme_code, scheme_name, scheme_category, sebi_category')
    .in('scheme_code', updatedCodes)
    .is('sebi_category', null)
    .is('scheme_category', null)
    .eq('scheme_active', true);

  if (!nullRows?.length) return 0;

  let resolved = 0;
  for (const row of nullRows) {
    const sebi = resolveSebiCategory(
      row.scheme_category as string | null,
      row.scheme_name as string | null,
    );
    if (!sebi) continue;

    const broad = broadCategoryFromSebi(sebi);
    const patch: Record<string, string> = { sebi_category: sebi };
    if (broad) patch.scheme_category = broad;

    const { error } = await supabase
      .from('scheme_master')
      .update(patch)
      .eq('scheme_code', row.scheme_code as number)
      .is('sebi_category', null);

    if (error) {
      log(
        `[universe-backfill] name-heuristic scheme=${row.scheme_code} update error: ${error.message}`,
      );
    } else {
      resolved++;
    }
  }

  return resolved;
}

async function readCursor(
  supabase: ReturnType<typeof createServiceClient>,
  phase: string,
): Promise<CompositionBackfillState | MetadataBackfillState | null> {
  const key = `universe_backfill_${phase}_cursor`;
  const { data, error } = await supabase.from('app_config').select('value').eq('key', key).single();
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
    .upsert({
      key,
      value: JSON.stringify(state),
      description: `Cursor for ${state.phase} phase of universe-backfill`,
    })
    .eq('key', key);
}

async function readDoneMarker(
  supabase: ReturnType<typeof createServiceClient>,
  phase: string,
): Promise<string | null> {
  const key = `universe_backfill_${phase}_done_at`;
  const { data, error } = await supabase.from('app_config').select('value').eq('key', key).single();
  if (error || !data) return null;
  try {
    const parsed = JSON.parse(data.value);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

async function readRefreshDueMarker(
  supabase: ReturnType<typeof createServiceClient>,
): Promise<string | null> {
  const key = `universe_backfill_refresh_due`;
  const { data, error } = await supabase.from('app_config').select('value').eq('key', key).single();
  if (error || !data) return null;
  try {
    const parsed = JSON.parse(data.value);
    return typeof parsed === 'object' && parsed?.timestamp ? parsed.timestamp : null;
  } catch {
    return null;
  }
}

async function clearRefreshDueMarker(
  supabase: ReturnType<typeof createServiceClient>,
): Promise<void> {
  const key = `universe_backfill_refresh_due`;
  await supabase.from('app_config').delete().eq('key', key);
}

async function writeDoneMarker(
  supabase: ReturnType<typeof createServiceClient>,
  phase: string,
  timestamp: string,
): Promise<void> {
  const key = `universe_backfill_${phase}_done_at`;
  await supabase
    .from('app_config')
    .upsert({
      key,
      value: JSON.stringify(timestamp),
      description: `Completion marker for ${phase} phase of universe-backfill`,
    })
    .eq('key', key);
}

async function clearDoneMarker(
  supabase: ReturnType<typeof createServiceClient>,
  phase: string,
): Promise<void> {
  const key = `universe_backfill_${phase}_done_at`;
  await supabase.from('app_config').delete().eq('key', key);
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  let phase: 'composition' | 'metadata' | 'both' = 'both';
  let force = false;
  let autoDetected = false;
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.phase === 'composition') phase = 'composition';
    else if (body?.phase === 'metadata') phase = 'metadata';
    if (body?.force === true) force = true;
  } catch {
    // default 'both', force=false
  }

  // Initialize Supabase early to check refresh_due marker
  let client: ReturnType<typeof createOpenFolioClient>;
  try {
    const creds = resolveOpenFolioCredentials(Deno.env);
    client = createOpenFolioClient(creds);
  } catch (err) {
    console.error('[universe-backfill] credentials: %s', String(err));
    return json({ success: false, error: String(err) }, { status: 500 });
  }

  const supabase = createServiceClient();

  // Check for monthly refresh marker. If present and phase not explicitly set, auto-detect.
  // The monthly cron (16th @ 01:00 UTC) invokes with force=true to start a fresh cycle.
  // The frequent cron (every 15 min) relies on this marker to decide if a backfill is due.
  if (!force && phase === 'both') {
    const refreshDueAt = await readRefreshDueMarker(supabase);
    if (refreshDueAt) {
      console.log('[universe-backfill] refresh_due marker found (timestamp=%s), clearing done markers for fresh cycle', refreshDueAt);
      force = true;
      autoDetected = true;
      // Clear done markers so the backfill restarts
      await clearDoneMarker(supabase, 'composition');
      await clearDoneMarker(supabase, 'metadata');
      const compositionKey = `universe_backfill_composition_cursor`;
      const metadataKey = `universe_backfill_metadata_cursor`;
      await supabase.from('app_config').delete().eq('key', compositionKey);
      await supabase.from('app_config').delete().eq('key', metadataKey);
    }
  }

  console.log('[universe-backfill] invoked method=%s phase=%s force=%s auto_detected=%s', req.method, phase, force, autoDetected);

  const creds = resolveOpenFolioCredentials(Deno.env);
  console.log('[universe-backfill] using OpenFolio base=%s', creds.baseUrl);

  const syncedAt = new Date().toISOString();

  // ── Composition phase (chunked with cursor resumption) ────────────────────
  if (phase === 'composition' || phase === 'both') {
    // Check for done marker and short-circuit
    const compositionDoneAt = await readDoneMarker(supabase, 'composition');
    if (compositionDoneAt && !force) {
      console.log(
        '[universe-backfill] composition already done at %s, skipping',
        compositionDoneAt,
      );
      if (phase === 'composition') {
        const elapsedMs = Date.now() - startedAt;
        return json({
          success: true,
          phase: 'composition',
          cursor: null,
          done: true,
          stats: {
            upserted: 0,
            matchedByCode: 0,
            matchedByIsin: 0,
            unmatched: 0,
            failed: 0,
            totalCount: 0,
          },
          elapsed_ms: elapsedMs,
        });
      }
    } else {
      if (compositionDoneAt && force) {
        console.log('[universe-backfill] force=true, clearing composition done marker');
        await clearDoneMarker(supabase, 'composition');
        const key = `universe_backfill_composition_cursor`;
        await supabase.from('app_config').delete().eq('key', key);
      }

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

        if (chunk.failed > 50) {
          console.error(
            '[universe-backfill] composition failed count grew by %d (total=%d)',
            chunk.failed,
            state.failed,
          );
        }

        const done = state.totalCount === 0 || state.cursor * COMP_PAGE_SIZE > state.totalCount;
        if (!done) {
          await writeCursor(supabase, state);
        } else {
          const key = `universe_backfill_composition_cursor`;
          await supabase.from('app_config').delete().eq('key', key);
          await writeDoneMarker(supabase, 'composition', syncedAt);
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
  }

  // ── Metadata phase (chunked with cursor resumption) ────────────────────────
  if (phase === 'metadata' || phase === 'both') {
    // Check for done marker and short-circuit
    const metadataDoneAt = await readDoneMarker(supabase, 'metadata');
    if (metadataDoneAt && !force) {
      console.log('[universe-backfill] metadata already done at %s, skipping', metadataDoneAt);
      if (phase === 'metadata') {
        const elapsedMs = Date.now() - startedAt;
        return json({
          success: true,
          phase: 'metadata',
          cursor: null,
          done: true,
          stats: { written: 0, skipped: 0, failed: 0, totalCount: 0 },
          elapsed_ms: elapsedMs,
        });
      }
      const elapsedMs = Date.now() - startedAt;
      const compState = await readCursor(supabase, 'composition');
      const compDoneAt = await readDoneMarker(supabase, 'composition');
      return json({
        success: true,
        phase: 'both',
        composition: {
          cursor: compDoneAt
            ? null
            : compState
              ? (compState as CompositionBackfillState).cursor
              : null,
          done: compDoneAt !== null,
          stats:
            compDoneAt || !compState
              ? {
                  upserted: 0,
                  matchedByCode: 0,
                  matchedByIsin: 0,
                  unmatched: 0,
                  failed: 0,
                  totalCount: 0,
                }
              : {
                  upserted: (compState as CompositionBackfillState).upserted,
                  matchedByCode: (compState as CompositionBackfillState).matchedByCode,
                  matchedByIsin: (compState as CompositionBackfillState).matchedByIsin,
                  unmatched: (compState as CompositionBackfillState).unmatched,
                  failed: (compState as CompositionBackfillState).failed,
                  totalCount: (compState as CompositionBackfillState).totalCount,
                },
        },
        metadata: {
          cursor: null,
          done: true,
          stats: { written: 0, skipped: 0, failed: 0, totalCount: 0 },
        },
        done: compDoneAt !== null,
        elapsed_ms: elapsedMs,
      });
    } else {
      if (metadataDoneAt && force) {
        console.log('[universe-backfill] force=true, clearing metadata done marker');
        await clearDoneMarker(supabase, 'metadata');
        const key = `universe_backfill_metadata_cursor`;
        await supabase.from('app_config').delete().eq('key', key);
      }

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
          syncedAt,
          state.cursor,
          (msg) => console.log(msg),
        );

        state.cursor = chunk.endPage;
        state.totalCount = chunk.totalCount;
        state.written += chunk.written;
        state.skipped += chunk.skipped;
        state.failed += chunk.failed;

        if (chunk.failed > 50) {
          console.error(
            '[universe-backfill] metadata failed count grew by %d (total=%d)',
            chunk.failed,
            state.failed,
          );
        }

        const done = state.totalCount === 0 || state.cursor * META_PAGE_SIZE >= state.totalCount;
        if (!done) {
          await writeCursor(supabase, state);
        } else {
          const key = `universe_backfill_metadata_cursor`;
          await supabase.from('app_config').delete().eq('key', key);
          await writeDoneMarker(supabase, 'metadata', syncedAt);
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

        if (phase === 'both') {
          // Get actual composition state for the combined response
          const compState = await readCursor(supabase, 'composition');
          const compDoneAt = await readDoneMarker(supabase, 'composition');
          const compDone =
            compDoneAt !== null ||
            (compState != null &&
              compState.totalCount > 0 &&
              compState.cursor * COMP_PAGE_SIZE > compState.totalCount);

          const bothDone = done && !!compDone;

          // When both phases complete, clear the monthly refresh marker so the frequent cron
          // (every 15 min) knows the cycle is done and can short-circuit.
          if (bothDone) {
            await clearRefreshDueMarker(supabase);
            console.log('[universe-backfill] both phases complete, clearing refresh_due marker');
          }

          return json({
            success: true,
            phase: 'both',
            composition: {
              cursor: compDoneAt
                ? null
                : compState
                  ? (compState as CompositionBackfillState).cursor
                  : null,
              done: compDone,
              stats:
                compDoneAt || !compState
                  ? {
                      upserted: 0,
                      matchedByCode: 0,
                      matchedByIsin: 0,
                      unmatched: 0,
                      failed: 0,
                      totalCount: 0,
                    }
                  : {
                      upserted: (compState as CompositionBackfillState).upserted,
                      matchedByCode: (compState as CompositionBackfillState).matchedByCode,
                      matchedByIsin: (compState as CompositionBackfillState).matchedByIsin,
                      unmatched: (compState as CompositionBackfillState).unmatched,
                      failed: (compState as CompositionBackfillState).failed,
                      totalCount: (compState as CompositionBackfillState).totalCount,
                    },
            },
            metadata: {
              cursor: state.cursor,
              done,
              stats: {
                written: state.written,
                skipped: state.skipped,
                failed: state.failed,
                totalCount: state.totalCount,
              },
            },
            done: bothDone,
            elapsed_ms: elapsedMs,
            refresh_due_cleared: bothDone,
          });
        } else {
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
        }
      } catch (err) {
        const msg = String(err);
        console.error('[universe-backfill] metadata page-fetch fatal: %s', msg);
        return json(
          { success: false, error: msg, phase: 'metadata', cursor: null },
          { status: 500 },
        );
      }
    }
  }

  return json({ success: false, error: 'no phase selected' }, { status: 400 });
});
