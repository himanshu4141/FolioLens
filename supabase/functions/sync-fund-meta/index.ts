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
  benchmark?: string | null;
  related_variants?: unknown[] | null;
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
  const cutoff = new Date(Date.now() - META_STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: masterRows } = await supabase
    .from('scheme_master')
    .select('scheme_code, fund_meta_synced_at')
    .in('scheme_code', allSchemeCodes);

  const freshCodes = new Set(
    (masterRows ?? [])
      .filter((r) => r.fund_meta_synced_at && r.fund_meta_synced_at > cutoff)
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
      const morningstar_rating =
        mfdata?.morningstar != null ? Math.round(Number(mfdata.morningstar)) : null;

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
      if (mfdata) {
        updatePayload.mfdata_family_id = mfdata.family_id ?? null;
        updatePayload.declared_benchmark_name = mfdata.benchmark ?? null;
        updatePayload.risk_label = mfdata.risk_label ?? null;
        updatePayload.morningstar_rating = morningstar_rating;
        updatePayload.related_variants = mfdata.related_variants ?? null;
        updatePayload.mfdata_meta_synced_at = now;
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
