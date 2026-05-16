/**
 * sync-fund-meta — fetches shared scheme metadata for each active scheme and
 * stores it once in scheme_master.
 *
 * Primary source: mfdata.in
 * Fallback source for ISIN only: mfapi.in
 *
 * mfdata also exposes useful future-facing fields that we are not showing in
 * the UI yet, but want to persist now:
 * - family_id
 * - declared benchmark label
 * - risk label
 * - Morningstar rating
 * - related variants for the same scheme family
 *
 * Staleness window: schemes synced within META_STALE_DAYS are skipped so the
 * daily cron is cheap even as the scheme catalog grows.
 * Deploy with --no-verify-jwt.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { trackServerEventAwait } from '../_shared/analytics.ts';
import { isSchemeMetaFresh } from '../_shared/scheme-meta-cache.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MFDATA_USER_AGENT = 'Mozilla/5.0 (compatible; FundLens/1.0; +https://fundlens.app)';

const META_STALE_DAYS = 7;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/** Delay helper — avoids hammering public APIs */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  // MFData also returns `returns` and `ratios` blocks. We persist them as
  // raw JSONB on scheme_master.period_returns / scheme_master.risk_ratios.
  // The screen does NOT trust these verbatim — see src/utils/mfdataGuards.ts
  // for the category-aware gating + composition guards we apply at read time.
  returns?: Record<string, unknown> | null;
  ratios?: Record<string, unknown> | null;
}

interface MFDataSchemeResponse {
  status?: string;
  data?: MFDataSchemePayload | null;
}

function toCrores(amount: number | null | undefined): number | null {
  if (amount == null || Number.isNaN(amount)) return null;
  return Math.round((amount / 10_000_000) * 100) / 100;
}

async function fetchMFDataScheme(schemeCode: number): Promise<MFDataSchemePayload | null> {
  const res = await fetch(`https://mfdata.in/api/v1/schemes/${schemeCode}`, {
    headers: { 'User-Agent': MFDATA_USER_AGENT, Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`mfdata ${res.status}`);
  }

  const body = await res.json() as MFDataSchemeResponse | MFDataSchemePayload;
  if ('data' in body) return body.data ?? null;
  return body ?? null;
}

async function fetchMfapiIsin(schemeCode: number): Promise<string | null> {
  const res = await fetch(`https://api.mfapi.in/mf/${schemeCode}`);
  if (!res.ok) {
    throw new Error(`mfapi ${res.status}`);
  }
  const body = await res.json();
  return body?.meta?.isin_growth ?? null;
}

Deno.serve(async (_req) => {
  const startedAt = Date.now();
  console.log('[sync-fund-meta] invocation started');

  const { data: funds, error: fundsError } = await supabase
    .from('user_fund')
    .select('scheme_code')
    .eq('is_active', true);

  if (fundsError) {
    console.error('[sync-fund-meta] failed to load funds:', fundsError.message);
    return new Response(JSON.stringify({ error: fundsError.message }), { status: 500 });
  }

  if (!funds?.length) {
    console.log('[sync-fund-meta] no active funds found');
    return new Response(JSON.stringify({ updated: 0 }), { status: 200 });
  }

  const allSchemeCodes = [...new Set((funds ?? []).map((fund) => fund.scheme_code as number))];

  // Filter out recently-synced schemes so the daily cron stays cheap.
  // `isSchemeMetaFresh` requires both a recent timestamp AND a non-null
  // `mfdata_family_id`. The null-family_id guard handles the partial-
  // success bug (audit #6): if the previous sync got mfapi-only because
  // mfdata was down, the scheme would otherwise be considered fresh and
  // skipped for 7 days, locking the fund into category_fallback
  // composition. Retrying is cheap; a still-down mfdata gives the same
  // partial result, but a recovered mfdata gives real data.
  const { data: masterRows } = await supabase
    .from('scheme_master')
    .select('scheme_code, fund_meta_synced_at, mfdata_family_id')
    .in('scheme_code', allSchemeCodes);

  const now = Date.now();
  const freshCodes = new Set(
    (masterRows ?? [])
      .filter((r) => isSchemeMetaFresh(r, META_STALE_DAYS, now))
      .map((r) => r.scheme_code as number),
  );
  const schemeCodes = allSchemeCodes.filter((c) => !freshCodes.has(c));

  console.log(
    `[sync-fund-meta] ${allSchemeCodes.length} active schemes — ${freshCodes.size} fresh (skipped), ${schemeCodes.length} stale/new (processing)`,
  );

  if (!schemeCodes.length) {
    return new Response(JSON.stringify({ updated: 0, skipped: freshCodes.size }), { status: 200 });
  }

  let updated = 0;
  let failed = 0;

  for (const schemeCode of schemeCodes) {
    await delay(200); // rate-limit between funds

    try {
      let mfdata: MFDataSchemePayload | null = null;
      let mfdataError: string | null = null;

      try {
        mfdata = await fetchMFDataScheme(schemeCode);
      } catch (err) {
        mfdataError = String(err);
        console.warn(`[sync-fund-meta] scheme ${schemeCode}: ${mfdataError}`);
      }

      let isin = mfdata?.isin ?? null;
      if (!isin) {
        try {
          isin = await fetchMfapiIsin(schemeCode);
        } catch (err) {
          console.warn(`[sync-fund-meta] scheme ${schemeCode}: ${String(err)}`);
        }
      }

      const expense_ratio =
        mfdata?.expense_ratio != null ? Number(mfdata.expense_ratio) : null;
      const aum_cr = toCrores(mfdata?.aum ?? null);
      const min_sip_amount =
        mfdata?.min_sip != null ? Math.round(Number(mfdata.min_sip)) : null;
      const min_lumpsum =
        mfdata?.min_lumpsum != null ? Math.round(Number(mfdata.min_lumpsum)) : null;
      const min_additional =
        mfdata?.min_additional != null ? Math.round(Number(mfdata.min_additional)) : null;
      const morningstar_rating =
        mfdata?.morningstar != null ? Math.round(Number(mfdata.morningstar)) : null;

      // launch_date arrives as 'YYYY-MM-DD' or full ISO. Postgres will accept
      // either via the date column; we just trim whitespace.
      const launch_date =
        typeof mfdata?.launch_date === 'string' && mfdata.launch_date.trim().length > 0
          ? mfdata.launch_date.trim()
          : null;

      if (
        !isin &&
        expense_ratio == null &&
        aum_cr == null &&
        min_sip_amount == null &&
        !mfdata?.benchmark &&
        !mfdata?.risk_label &&
        morningstar_rating == null
      ) {
        failed++;
        continue;
      }

      const now = new Date().toISOString();

      const updatePayload: Record<string, unknown> = {
        fund_meta_synced_at: now,
      };

      if (isin) updatePayload.isin = isin;
      if (expense_ratio != null) updatePayload.expense_ratio = expense_ratio;
      if (aum_cr != null) updatePayload.aum_cr = aum_cr;
      if (min_sip_amount != null) updatePayload.min_sip_amount = min_sip_amount;
      if (min_lumpsum != null) updatePayload.min_lumpsum = min_lumpsum;
      if (min_additional != null) updatePayload.min_additional = min_additional;
      if (launch_date) updatePayload.launch_date = launch_date;
      if (mfdata) {
        updatePayload.mfdata_family_id = mfdata.family_id ?? null;
        updatePayload.declared_benchmark_name = mfdata.benchmark ?? null;
        updatePayload.risk_label = mfdata.risk_label ?? null;
        updatePayload.morningstar_rating = morningstar_rating;
        updatePayload.related_variants = mfdata.related_variants ?? null;
        updatePayload.mfdata_meta_synced_at = now;
        // M3v2 (2026-05-09) — extended metadata. Stored as-received; the read
        // path applies category gating + composition guards before surfacing.
        updatePayload.exit_load = mfdata.exit_load ?? null;
        updatePayload.plan_type = mfdata.plan_type ?? null;
        updatePayload.option_type = mfdata.option_type ?? null;
        updatePayload.family_name = mfdata.family_name ?? null;
        updatePayload.amc_name = mfdata.amc_name ?? null;
        updatePayload.amc_slug = mfdata.amc_slug ?? null;
        updatePayload.period_returns = mfdata.returns ?? null;
        updatePayload.risk_ratios = mfdata.ratios ?? null;
      }

      const { error: updateError } = await supabase
        .from('scheme_master')
        .update(updatePayload)
        .eq('scheme_code', schemeCode);

      if (updateError) {
        console.error(`[sync-fund-meta] scheme ${schemeCode}: update error:`, updateError.message);
        failed++;
      } else {
        console.log(
          `[sync-fund-meta] scheme ${schemeCode}: updated (isin=${isin}, er=${expense_ratio}, aum=${aum_cr}cr, minsip=${min_sip_amount}, family=${mfdata?.family_id ?? 'n/a'})`,
        );
        updated++;
      }
    } catch (err) {
      console.error(`[sync-fund-meta] scheme ${schemeCode}: unexpected error:`, String(err));
      failed++;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`[sync-fund-meta] done — updated=${updated} failed=${failed} skipped=${freshCodes.size} elapsed_ms=${elapsedMs}`);

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

  return new Response(JSON.stringify({ updated, failed, skipped: freshCodes.size }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
