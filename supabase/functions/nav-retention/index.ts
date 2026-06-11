/**
 * nav-retention — weekly NAV history pruning for non-held schemes.
 *
 * Deletes nav_history rows for schemes that satisfy both:
 *   1. NOT in any active user_fund (no user currently holds or tracks them).
 *   2. scheme_master.nav_backfilled_at IS NULL (never demand-fetched) OR
 *      nav_backfilled_at < now() - 90 days (demand-fetch is stale).
 *
 * Deletes are batched (SCHEME_DELETE_BATCH_SIZE schemes per statement) and
 * capped at MAX_ROWS_PER_RUN rows per invocation.  A pruned fund re-hydrates
 * automatically via fetch-fund-nav when a user next picks it (1–2 s spinner).
 *
 * Deploy with --no-verify-jwt (invoked by pg_cron, which has no JWT).
 * Cron schedule: Sundays 03:00 UTC / 08:30 IST
 *   (see migration 20260610000002_nav_retention_cron.sql)
 */

import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';
import { trackServerEventAwait } from '../_shared/analytics.ts';
import {
  MAX_ROWS_PER_RUN,
  NAV_RETENTION_DAYS,
  SCHEME_DELETE_BATCH_SIZE,
  retentionCutoffDate,
} from '../_shared/nav-retention.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  const startedAt = Date.now();
  console.log('[nav-retention] invoked method=%s', req.method);

  let dryRun = false;
  try {
    const body = await req.json().catch(() => ({}));
    dryRun = body?.dryRun === true;
  } catch {
    // default dryRun = false
  }
  console.log('[nav-retention] dryRun=%s', dryRun);

  const supabase = createServiceClient();

  // ── Step 1: load all scheme codes held by at least one active user_fund ──
  // We query through the `fund` view (which joins user_fund + scheme_master
  // and exposes is_active) — the same source sync-nav uses, for consistency.
  const { data: heldFunds, error: heldErr } = await supabase
    .from('fund')
    .select('scheme_code')
    .eq('is_active', true);

  if (heldErr) {
    console.error('[nav-retention] failed to load held funds: %s', heldErr.message);
    return json({ success: false, error: heldErr.message }, { status: 500 });
  }

  const heldCodes = new Set((heldFunds ?? []).map((f) => f.scheme_code as number));
  console.log('[nav-retention] held_scheme_codes=%d', heldCodes.size);

  // ── Step 2: paginate through nav_history to find all schemes with rows ────
  // Invert the walk: candidates = schemes with nav_history rows that are NOT
  // held AND are either never demand-fetched or stale (older than 90 days).
  // This avoids the PostgREST 1,000-row cap that was silently truncating
  // candidates when scheme_master had >1,000 pruneable rows.
  const cutoff = retentionCutoffDate(new Date(), NAV_RETENTION_DAYS);
  const candidateCodes = new Set<number>();
  const PAGE_SIZE = 1000;
  let from = 0;

  while (true) {
    const { data: schemeRows, error: navErr } = await supabase
      .from('nav_history')
      .select('scheme_code', { count: 'exact' })
      .order('scheme_code')
      .range(from, from + PAGE_SIZE - 1);

    if (navErr) {
      console.error('[nav-retention] failed to query nav_history: %s', navErr.message);
      return json({ success: false, error: navErr.message }, { status: 500 });
    }

    if (!schemeRows || schemeRows.length === 0) break;

    for (const row of schemeRows as { scheme_code: number }[]) {
      candidateCodes.add(row.scheme_code);
    }

    if (schemeRows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  console.log('[nav-retention] nav_history contains %d distinct schemes', candidateCodes.size);

  // ── Step 3: look up nav_backfilled_at for candidate schemes ───────────────
  // Now find which of these schemes are eligible for pruning (not held,
  // and either never backfilled or stale). Batch the lookups to avoid
  // hitting PostgREST limits.
  const candidateArray = Array.from(candidateCodes);
  const pruneable: { scheme_code: number; nav_backfilled_at: string | null }[] = [];
  const BATCH_SIZE = 200;

  for (let i = 0; i < candidateArray.length; i += BATCH_SIZE) {
    const batch = candidateArray.slice(i, i + BATCH_SIZE);
    const { data: schemes, error: schemeErr } = await supabase
      .from('scheme_master')
      .select('scheme_code, nav_backfilled_at')
      .in('scheme_code', batch);

    if (schemeErr) {
      console.error('[nav-retention] failed to query scheme_master: %s', schemeErr.message);
      return json({ success: false, error: schemeErr.message }, { status: 500 });
    }

    for (const scheme of schemes as { scheme_code: number; nav_backfilled_at: string | null }[]) {
      pruneable.push(scheme);
    }
  }

  // Filter to only schemes that are not held and are eligible
  const pruneableCodes = pruneable
    .filter((s) => !heldCodes.has(s.scheme_code))
    .filter((s) => s.nav_backfilled_at === null || s.nav_backfilled_at < cutoff)
    .map((s) => s.scheme_code);

  console.log(
    '[nav-retention] pruneable_schemes=%d cutoff=%s',
    pruneableCodes.length,
    cutoff,
  );

  if (pruneableCodes.length === 0) {
    console.log('[nav-retention] nothing to prune — exiting');
    await trackServerEventAwait(
      'nav_retention_completed',
      {
        job: 'nav-retention',
        held_scheme_codes: heldCodes.size,
        pruneable_schemes: 0,
        pruneable_rows: 0,
        rows_deleted: 0,
        capped: false,
        errors_count: 0,
        elapsed_ms: Date.now() - startedAt,
      },
      'system:nav-retention',
    );
    return json({
      success: true,
      pruneableSchemes: 0,
      pruneableRows: 0,
      rowsDeleted: 0,
      capped: false,
      errors: [],
      dryRun,
    });
  }

  // ── Step 4: dry-run row count (logged) ───────────────────────────────────
  const { count: pruneableRows, error: countErr } = await supabase
    .from('nav_history')
    .select('*', { count: 'exact', head: true })
    .in('scheme_code', pruneableCodes);

  if (countErr) {
    console.warn('[nav-retention] row count query failed (non-fatal): %s', countErr.message);
  }

  console.log('[nav-retention] pruneable_nav_history_rows=%d dryRun=%s', pruneableRows ?? -1, dryRun);

  // ── Step 5: if dryRun, return the candidate list without deleting ────────
  if (dryRun) {
    const elapsedMs = Date.now() - startedAt;
    console.log(
      '[nav-retention] dryRun — returning candidate list (no deletes performed) elapsed_ms=%d',
      elapsedMs,
    );
    return json({
      success: true,
      pruneableSchemes: pruneableCodes.length,
      pruneableRows: pruneableRows ?? null,
      rowsDeleted: 0,
      capped: false,
      errors: [],
      dryRun: true,
      candidateSchemes: pruneableCodes,
      elapsed_ms: elapsedMs,
    });
  }

  // ── Step 6: batched deletes ───────────────────────────────────────────────
  let totalDeleted = 0;
  let schemasProcessed = 0;
  const errors: string[] = [];

  outer: for (let i = 0; i < pruneableCodes.length; i += SCHEME_DELETE_BATCH_SIZE) {
    if (totalDeleted >= MAX_ROWS_PER_RUN) break;

    const batch = pruneableCodes.slice(i, i + SCHEME_DELETE_BATCH_SIZE);

    const { data: deleted, error: delErr } = await supabase
      .from('nav_history')
      .delete()
      .in('scheme_code', batch)
      .select('id');

    if (delErr) {
      console.error(
        '[nav-retention] delete error schemes=%o: %s',
        batch,
        delErr.message,
      );
      errors.push(delErr.message);
      continue;
    }

    const batchCount = deleted?.length ?? 0;
    totalDeleted += batchCount;
    schemasProcessed += batch.length;

    console.log(
      '[nav-retention] batch i=%d schemes=%d rows_deleted=%d cumulative=%d',
      i,
      batch.length,
      batchCount,
      totalDeleted,
    );

    if (totalDeleted >= MAX_ROWS_PER_RUN) break outer;
  }

  const capped = totalDeleted >= MAX_ROWS_PER_RUN;
  const elapsedMs = Date.now() - startedAt;

  console.log(
    '[nav-retention] done — held=%d pruneable_schemes=%d pruneable_rows=%d schemes_processed=%d rows_deleted=%d capped=%s errors=%d elapsed_ms=%d',
    heldCodes.size,
    pruneableCodes.length,
    pruneableRows ?? -1,
    schemasProcessed,
    totalDeleted,
    capped,
    errors.length,
    elapsedMs,
  );

  await trackServerEventAwait(
    'nav_retention_completed',
    {
      job: 'nav-retention',
      held_scheme_codes: heldCodes.size,
      pruneable_schemes: pruneableCodes.length,
      pruneable_rows: pruneableRows ?? null,
      rows_deleted: totalDeleted,
      capped,
      errors_count: errors.length,
      elapsed_ms: elapsedMs,
    },
    'system:nav-retention',
  );

  return json({
    success: true,
    pruneableSchemes: pruneableCodes.length,
    pruneableRows: pruneableRows ?? null,
    rowsDeleted: totalDeleted,
    capped,
    errors,
    dryRun: false,
  });
});
