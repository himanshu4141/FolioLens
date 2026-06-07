/**
 * sync-fund-meta — fetches scheme metadata for each active scheme and stores
 * it in scheme_master.
 *
 * Source precedence:
 *   OpenFolio /v1/schemes/{scheme_code}/metadata — primary for metrics
 *   (AUM, returns, volatility) and all B1 fields (TER, manager, etc.).
 *   Per-field `b1_field_meta.status` drives the mfdata backup decision:
 *     'value'              → use OpenFolio value (primary wins)
 *     'officially_absent'  → honest null, skip mfdata for this field
 *     'not_applicable'     → honest null, skip mfdata for this field
 *     'unresolved'         → fall back to mfdata
 *     'parse_failed'       → fall back to mfdata
 *     'source_failed'      → fall back to mfdata
 *   mfdata.in — backup for fields where OpenFolio status != 'value' /
 *               'officially_absent' / 'not_applicable'; also provides
 *               mfdata_family_id, morningstar_rating, related_variants.
 *   mfapi.in  — fallback for ISIN only.
 *
 * Staleness: schemes synced within META_STALE_DAYS days are skipped.
 * Schedule: daily cron (existing pg_cron job, unchanged cadence).
 * Deploy with --no-verify-jwt.
 */

import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';
import { trackServerEventAwait } from '../_shared/analytics.ts';
import {
  createOpenFolioClient,
  resolveOpenFolioCredentials,
  type B1FieldStatus,
  type FundMetadata,
} from '../_shared/openfolio.ts';
import { isSchemeMetaFresh } from '../_shared/scheme-meta-cache.ts';

const META_STALE_DAYS = 7;
const MFDATA_USER_AGENT = 'Mozilla/5.0 (compatible; FolioLens/1.0; +https://foliolens.app)';
const FETCH_TIMEOUT_MS = 20_000;

// Delay between per-scheme fetches to avoid hammering external APIs.
const INTER_SCHEME_DELAY_MS = 300;

/** B1 field statuses where mfdata backup should be attempted. */
const NEEDS_MFDATA_BACKUP = new Set<B1FieldStatus>([
  'unresolved',
  'parse_failed',
  'source_failed',
]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── mfdata types ──────────────────────────────────────────────────────────

interface MFDataSchemePayload {
  family_id?: number | null;
  isin?: string | null;
  expense_ratio?: number | null;
  morningstar?: number | null;
  risk_label?: string | null;
  aum?: number | null;
  min_sip?: number | null;
  min_lumpsum?: number | null;
  min_additional?: number | null;
  exit_load?: string | null;
  launch_date?: string | null;
  plan_type?: string | null;
  option_type?: string | null;
  family_name?: string | null;
  amc_name?: string | null;
  amc_slug?: string | null;
  benchmark?: string | null;
  related_variants?: unknown[] | null;
  returns?: Record<string, unknown> | null;
  ratios?: Record<string, unknown> | null;
}

interface MFDataSchemeResponse {
  status?: string;
  data?: MFDataSchemePayload | null;
}

// ── External fetch helpers ─────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMFDataScheme(schemeCode: number): Promise<MFDataSchemePayload | null> {
  const res = await fetchWithTimeout(`https://mfdata.in/api/v1/schemes/${schemeCode}`, {
    headers: { 'User-Agent': MFDATA_USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`mfdata HTTP ${res.status}`);
  const body = (await res.json()) as MFDataSchemeResponse | MFDataSchemePayload;
  if ('data' in body) return body.data ?? null;
  return body ?? null;
}

async function fetchMfapiIsin(schemeCode: number): Promise<string | null> {
  const res = await fetchWithTimeout(`https://api.mfapi.in/mf/${schemeCode}`, {
    headers: { 'User-Agent': MFDATA_USER_AGENT },
  });
  if (!res.ok) throw new Error(`mfapi HTTP ${res.status}`);
  const body = await res.json();
  return body?.meta?.isin_growth ?? null;
}

// ── Per-field status helper ────────────────────────────────────────────────

/**
 * Returns true if the OpenFolio B1 field status means we should fall back to
 * mfdata. The field may be absent from b1_field_meta entirely (not yet
 * diagnosed by OpenFolio) — treat absence as 'unresolved' and fall back.
 */
function needsMfdataBackup(status: B1FieldStatus | undefined): boolean {
  if (status == null) return true;
  return NEEDS_MFDATA_BACKUP.has(status);
}

/**
 * Returns true when OpenFolio has a definitive answer (value present, or
 * officially absent/not_applicable). In these cases we do NOT overwrite with
 * mfdata — we respect OpenFolio's authoritative answer.
 */
function isDefinitive(status: B1FieldStatus | undefined): boolean {
  return status === 'value' || status === 'officially_absent' || status === 'not_applicable';
}

// ── Main handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  console.log('[sync-fund-meta] invoked, method=%s', req.method);

  const supabase = createServiceClient();

  // ── OpenFolio client (optional — degrades to mfdata if not configured) ──
  let openfolio: ReturnType<typeof createOpenFolioClient> | null = null;
  try {
    const creds = resolveOpenFolioCredentials(Deno.env);
    openfolio = createOpenFolioClient({ ...creds, timeoutMs: FETCH_TIMEOUT_MS });
  } catch {
    console.warn('[sync-fund-meta] OpenFolio not configured — using mfdata for all schemes');
  }

  // ── Active scheme codes ──────────────────────────────────────────────────
  const { data: funds, error: fundsError } = await supabase
    .from('fund')
    .select('scheme_code')
    .eq('is_active', true);

  if (fundsError) {
    console.error('[sync-fund-meta] failed to load funds:', fundsError.message);
    return json({ success: false, error: fundsError.message }, { status: 500 });
  }

  if (!funds?.length) {
    console.log('[sync-fund-meta] no active funds found');
    return json({ success: true, updated: 0 });
  }

  const allSchemeCodes = [...new Set((funds ?? []).map((f) => f.scheme_code as number))];

  // ── Freshness filter ─────────────────────────────────────────────────────
  const { data: masterRows } = await supabase
    .from('scheme_master')
    .select('scheme_code, fund_meta_synced_at, mfdata_family_id, openfolio_meta_synced_at')
    .in('scheme_code', allSchemeCodes);

  const now = Date.now();
  const freshCodes = new Set(
    (masterRows ?? [])
      .filter((r) => isSchemeMetaFresh(r, META_STALE_DAYS, now))
      .map((r) => r.scheme_code as number),
  );
  const schemeCodes = allSchemeCodes.filter((c) => !freshCodes.has(c));

  console.log(
    '[sync-fund-meta] %d active — %d fresh (skipped), %d stale/new (processing)',
    allSchemeCodes.length,
    freshCodes.size,
    schemeCodes.length,
  );

  if (!schemeCodes.length) {
    return json({ success: true, updated: 0, skipped: freshCodes.size });
  }

  let updated = 0;
  let failed = 0;

  for (const schemeCode of schemeCodes) {
    await delay(INTER_SCHEME_DELAY_MS);

    try {
      // ── 1. OpenFolio primary ──────────────────────────────────────────────
      let ofMeta: FundMetadata | null = null;
      let ofError: string | null = null;

      if (openfolio) {
        try {
          ofMeta = await openfolio.getMetadata(schemeCode);
          if (ofMeta === null) {
            ofError = 'OpenFolio 404 (not indexed)';
            console.log('[sync-fund-meta] scheme %d: OpenFolio 404', schemeCode);
          } else {
            console.log(
              '[sync-fund-meta] scheme %d: OpenFolio ok (aum=%s ret_1y=%s)',
              schemeCode,
              ofMeta.metrics?.aum_cr ?? 'null',
              ofMeta.metrics?.returns?.ret_1y ?? 'null',
            );
          }
        } catch (err) {
          ofError = (err as Error).message;
          console.warn('[sync-fund-meta] scheme %d: OpenFolio error (%s)', schemeCode, ofError);
        }
      }

      // ── 2. Determine which B1 fields need mfdata backup ──────────────────
      const fm = ofMeta?.b1_field_meta ?? {};
      const needsMfdata =
        !ofMeta || // OpenFolio failed entirely
        needsMfdataBackup(fm.ter?.status) ||
        needsMfdataBackup(fm.ter_date?.status) ||
        needsMfdataBackup(fm.fund_manager?.status) ||
        needsMfdataBackup(fm.inception_date?.status) ||
        needsMfdataBackup(fm.exit_load?.status) ||
        needsMfdataBackup(fm.min_investment?.status) ||
        needsMfdataBackup(fm.min_sip?.status) ||
        needsMfdataBackup(fm.benchmark?.status) ||
        needsMfdataBackup(fm.riskometer?.status) ||
        needsMfdataBackup(fm.portfolio_turnover?.status);

      // ── 3. mfdata (backup + always for family_id / morningstar / variants) ─
      let mfdata: MFDataSchemePayload | null = null;
      if (needsMfdata) {
        try {
          mfdata = await fetchMFDataScheme(schemeCode);
        } catch (err) {
          console.warn('[sync-fund-meta] scheme %d: mfdata error (%s)', schemeCode, (err as Error).message);
        }
      }

      // ── 4. ISIN from mfapi if not in mfdata ──────────────────────────────
      let isin = mfdata?.isin ?? null;
      if (!isin) {
        try {
          isin = await fetchMfapiIsin(schemeCode);
        } catch (err) {
          console.warn('[sync-fund-meta] scheme %d: mfapi isin error (%s)', schemeCode, (err as Error).message);
        }
      }

      // ── 5. Build update payload ───────────────────────────────────────────
      // Skip entirely if we have nothing useful to write.
      const hasOfMetrics = ofMeta?.metrics != null;
      const hasMfdata = mfdata != null;
      if (!hasOfMetrics && !hasMfdata && !isin) {
        console.warn('[sync-fund-meta] scheme %d: no data from any source — skipping', schemeCode);
        failed++;
        continue;
      }

      const syncedAt = new Date().toISOString();
      const payload: Record<string, unknown> = {
        fund_meta_synced_at: syncedAt,
      };

      if (isin) payload.isin = isin;

      // ── Metrics from OpenFolio (when available) ───────────────────────────
      if (ofMeta) {
        payload.openfolio_meta_synced_at = syncedAt;

        const metrics = ofMeta.metrics;
        if (metrics) {
          // aum_cr is already in crores — no conversion needed.
          if (metrics.aum_cr != null) payload.aum_cr = metrics.aum_cr;

          // Build period_returns JSONB from decimal CAGRs.
          const ret = metrics.returns;
          if (ret && Object.values(ret).some((v) => v != null)) {
            const periodReturns: Record<string, number> = {};
            if (ret.ret_1y != null) periodReturns.ret_1y = ret.ret_1y;
            if (ret.ret_3y != null) periodReturns.ret_3y = ret.ret_3y;
            if (ret.ret_5y != null) periodReturns.ret_5y = ret.ret_5y;
            if (ret.ret_incep != null) periodReturns.ret_incep = ret.ret_incep;
            if (Object.keys(periodReturns).length > 0) payload.period_returns = periodReturns;
          }

          if (metrics.volatility != null) {
            payload.risk_ratios = {
              volatility: metrics.volatility,
              ...(metrics.computed_from_nav_date
                ? { computed_from_nav_date: metrics.computed_from_nav_date }
                : {}),
            };
          }
        }

        // ── B1 fields: OpenFolio primary, mfdata backup per status ────────
        // For each field: 'value' → use OF; 'officially_absent'/'not_applicable'
        // → honest null; 'unresolved'/'parse_failed'/'source_failed'/absent → mfdata.

        // expense_ratio (ter):
        if (isDefinitive(fm.ter?.status)) {
          payload.expense_ratio = ofMeta.ter ?? null;
        } else if (mfdata?.expense_ratio != null) {
          payload.expense_ratio = Number(mfdata.expense_ratio);
        }

        // ter_date:
        if (isDefinitive(fm.ter_date?.status)) {
          payload.ter_date = ofMeta.ter_date ?? null;
        }
        // No mfdata backup for ter_date (mfdata doesn't have it).

        // fund_manager:
        if (isDefinitive(fm.fund_manager?.status)) {
          payload.fund_manager = ofMeta.fund_manager ?? null;
        }
        // No mfdata backup for fund_manager (mfdata doesn't have it).

        // launch_date (inception_date):
        if (isDefinitive(fm.inception_date?.status)) {
          const d = ofMeta.inception_date;
          payload.launch_date = d && d.trim().length > 0 ? d.trim() : null;
        } else if (typeof mfdata?.launch_date === 'string' && mfdata.launch_date.trim().length > 0) {
          payload.launch_date = mfdata.launch_date.trim();
        }

        // exit_load:
        if (isDefinitive(fm.exit_load?.status)) {
          payload.exit_load = ofMeta.exit_load ?? null;
        } else if (mfdata?.exit_load != null) {
          payload.exit_load = mfdata.exit_load;
        }

        // min_lumpsum (min_investment):
        if (isDefinitive(fm.min_investment?.status)) {
          payload.min_lumpsum = ofMeta.min_investment != null ? Math.round(ofMeta.min_investment) : null;
        } else if (mfdata?.min_lumpsum != null) {
          payload.min_lumpsum = Math.round(Number(mfdata.min_lumpsum));
        }

        // min_sip_amount (min_sip):
        if (isDefinitive(fm.min_sip?.status)) {
          payload.min_sip_amount = ofMeta.min_sip != null ? Math.round(ofMeta.min_sip) : null;
        } else if (mfdata?.min_sip != null) {
          payload.min_sip_amount = Math.round(Number(mfdata.min_sip));
        }

        // declared_benchmark_name (benchmark):
        if (isDefinitive(fm.benchmark?.status)) {
          payload.declared_benchmark_name = ofMeta.benchmark ?? null;
        } else if (mfdata?.benchmark) {
          payload.declared_benchmark_name = mfdata.benchmark;
        }

        // risk_label (riskometer):
        if (isDefinitive(fm.riskometer?.status)) {
          payload.risk_label = ofMeta.riskometer ?? null;
        } else if (mfdata?.risk_label) {
          payload.risk_label = mfdata.risk_label;
        }

        // portfolio_turnover:
        if (isDefinitive(fm.portfolio_turnover?.status)) {
          payload.portfolio_turnover = ofMeta.portfolio_turnover ?? null;
        }
        // No mfdata backup for portfolio_turnover (mfdata doesn't have it).
      } else {
        // OpenFolio unavailable — fall back to mfdata for all B1 fields.
        if (mfdata) {
          const expense_ratio = mfdata.expense_ratio != null ? Number(mfdata.expense_ratio) : null;
          if (expense_ratio != null) payload.expense_ratio = expense_ratio;
          if (mfdata.min_sip != null) payload.min_sip_amount = Math.round(Number(mfdata.min_sip));
          if (mfdata.min_lumpsum != null) payload.min_lumpsum = Math.round(Number(mfdata.min_lumpsum));
          if (mfdata.min_additional != null) payload.min_additional = Math.round(Number(mfdata.min_additional));
          if (typeof mfdata.launch_date === 'string' && mfdata.launch_date.trim().length > 0) {
            payload.launch_date = mfdata.launch_date.trim();
          }
          if (mfdata.exit_load != null) payload.exit_load = mfdata.exit_load;
          if (mfdata.benchmark) payload.declared_benchmark_name = mfdata.benchmark;
          if (mfdata.risk_label) payload.risk_label = mfdata.risk_label;
          if (mfdata.aum != null) {
            const aumCr = Math.round((mfdata.aum / 10_000_000) * 100) / 100;
            payload.aum_cr = aumCr;
          }
          if (mfdata.returns) payload.period_returns = mfdata.returns;
          if (mfdata.ratios) payload.risk_ratios = mfdata.ratios;
        }
      }

      // ── mfdata-exclusive fields (always from mfdata, OpenFolio has none) ─
      if (mfdata) {
        payload.mfdata_family_id = mfdata.family_id ?? null;
        payload.morningstar_rating = mfdata.morningstar != null ? Math.round(Number(mfdata.morningstar)) : null;
        payload.related_variants = mfdata.related_variants ?? null;
        if (mfdata.plan_type != null) payload.plan_type = mfdata.plan_type;
        if (mfdata.option_type != null) payload.option_type = mfdata.option_type;
        if (mfdata.family_name != null) payload.family_name = mfdata.family_name;
        if (mfdata.amc_name != null) payload.amc_name = mfdata.amc_name;
        if (mfdata.amc_slug != null) payload.amc_slug = mfdata.amc_slug;
        payload.mfdata_meta_synced_at = syncedAt;
      }

      // ── 6. Upsert ─────────────────────────────────────────────────────────
      const { error: updateError } = await supabase
        .from('scheme_master')
        .update(payload)
        .eq('scheme_code', schemeCode);

      if (updateError) {
        console.error('[sync-fund-meta] scheme %d: update error: %s', schemeCode, updateError.message);
        failed++;
      } else {
        const source = ofError ? 'mfdata' : 'openfolio';
        console.log(
          '[sync-fund-meta] scheme %d: updated (source=%s er=%s aum=%s ret_1y=%s)',
          schemeCode,
          source,
          payload.expense_ratio ?? 'null',
          payload.aum_cr ?? 'null',
          (ofMeta?.metrics?.returns?.ret_1y ?? 'null'),
        );
        updated++;
      }
    } catch (err) {
      console.error('[sync-fund-meta] scheme %d: unexpected error: %s', schemeCode, String(err));
      failed++;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    '[sync-fund-meta] done — updated=%d failed=%d skipped=%d elapsed_ms=%d',
    updated,
    failed,
    freshCodes.size,
    elapsedMs,
  );

  await trackServerEventAwait(
    failed > 0 && updated === 0 ? 'sync_failed' : 'sync_completed',
    {
      job: 'sync-fund-meta',
      updated,
      failed,
      skipped: freshCodes.size,
      elapsed_ms: elapsedMs,
    },
    'system:sync-fund-meta',
  );

  return json({ success: true, updated, failed, skipped: freshCodes.size });
});
