/**
 * seed-scheme-master — one-shot seed of scheme_master from mfapi.in's full
 * scheme list. Run once after the M3v2 migration.
 *
 * Pulls ~12k schemes, parses scheme_code + scheme_name + plan_type + amc_name
 * from the AMFI naming convention, and bulk-upserts into scheme_master with
 * `ignoreDuplicates=true` so existing rows keep their richer metadata.
 *
 * The Compare Funds redesign needs scheme_master populated broadly so the
 * universal fund picker has results beyond the ~40 rows seeded from held
 * user_fund. sync-fund-meta then progressively backfills category + the rest
 * of the metadata as users hold those funds.
 *
 * Idempotent — safe to re-invoke. Deploy with --no-verify-jwt so it can be
 * triggered without a user JWT.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BATCH_SIZE = 1000;

interface MfapiScheme {
  schemeCode: number;
  schemeName: string;
}

function detectPlanType(name: string): 'direct' | 'regular' | null {
  const n = name.toLowerCase();
  if (/\bdirect\s+plan\b/.test(n) || /\bdirect\s*-\s*growth/.test(n)) return 'direct';
  if (/\bregular\s+plan\b/.test(n) || /\bregular\s*-\s*growth/.test(n)) return 'regular';
  return null;
}

function inferAmcName(name: string): string | null {
  const m = name.match(/^(.+?)\s+(Mutual\s+Fund|Fund|Asset Management)/i);
  if (m) return m[1].trim();
  const words = name.split(/\s+/).slice(0, 3).join(' ');
  return words || null;
}

Deno.serve(async (_req) => {
  const startedAt = Date.now();
  console.log('[seed-scheme-master] invocation started');

  // 1. Fetch the full AMFI scheme list from mfapi.in.
  let allSchemes: MfapiScheme[];
  try {
    const res = await fetch('https://api.mfapi.in/mf');
    if (!res.ok) throw new Error(`mfapi ${res.status}`);
    allSchemes = await res.json();
  } catch (err) {
    console.error('[seed-scheme-master] mfapi.in fetch failed:', String(err));
    return new Response(JSON.stringify({ error: String(err) }), { status: 502 });
  }

  console.log(`[seed-scheme-master] received ${allSchemes.length} schemes from mfapi.in`);

  // 2. Build the upsert rows. scheme_category stays null; sync-fund-meta
  // backfills via mfdata.in for any held fund.
  const rows = allSchemes
    .filter((s) => Number.isFinite(s.schemeCode) && typeof s.schemeName === 'string' && s.schemeName.trim().length > 0)
    .map((s) => ({
      scheme_code: Number(s.schemeCode),
      scheme_name: String(s.schemeName).trim(),
      scheme_category: null,
      plan_type: detectPlanType(s.schemeName),
      amc_name: inferAmcName(s.schemeName),
    }));

  console.log(`[seed-scheme-master] upserting ${rows.length} rows in batches of ${BATCH_SIZE}`);

  // 3. Bulk upsert with ignoreDuplicates so we never overwrite richer data.
  let processedBatches = 0;
  let failedBatches = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('scheme_master')
      .upsert(batch, { onConflict: 'scheme_code', ignoreDuplicates: true });
    if (error) {
      console.error(`[seed-scheme-master] batch ${i / BATCH_SIZE} failed:`, error.message);
      failedBatches++;
    } else {
      processedBatches++;
    }
  }

  // 4. Final row count for confirmation.
  const { count: totalCount } = await supabase
    .from('scheme_master')
    .select('*', { count: 'exact', head: true });

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[seed-scheme-master] done — batches ok=${processedBatches} failed=${failedBatches} ` +
    `total scheme_master rows=${totalCount} elapsed_ms=${elapsedMs}`,
  );

  return new Response(
    JSON.stringify({
      mfapi_received: allSchemes.length,
      rows_considered: rows.length,
      batches_ok: processedBatches,
      batches_failed: failedBatches,
      scheme_master_total: totalCount,
      elapsed_ms: elapsedMs,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
});
