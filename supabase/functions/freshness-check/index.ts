/**
 * freshness-check — daily health check for silent failures.
 *
 * Runs every day at 08:00 UTC via pg_cron. Checks:
 *   (1) Held NAV age: max(nav_date) in user_fund >= today - 3 days
 *   (2) Cron failures: recent failed runs = 0
 *   (3) Backfill cursors: universe_backfill_* staleness and failure tracking
 *   (4) OpenFolio health: /health endpoint response (status, db_schemes, disclosure date)
 *   (5) Composition staleness: max(portfolio_date) of source='official' within 75 days
 *
 * On any failed check, sends one consolidated alert email via Resend (same pathway
 * as notify-feedback). Logs a structured [freshness-check] summary line.
 *
 * Env vars:
 *   OPENFOLIO_API_BASE     Base URL for OpenFolio API (to call /health endpoint)
 *   FOLIOLENS_INBOUND_ROUTER_SECRET   HMAC key for signing alerts to router
 *   ROUTER_FRESHNESS_ALERT_URL        Vercel router endpoint for alerts
 *
 * Deploy with --no-verify-jwt (called by pg_cron).
 */

import { encodeBase64 } from 'jsr:@std/encoding@1/base64';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';
import {
  checkBackfillCursors,
  checkCompositionStaleness,
  checkCronFailures,
  checkNavFreshness,
  checkOpenFolioHealth,
  type CheckResult,
  type CursorRow,
  type OpenFolioHealthResponse,
} from '../_shared/freshness-check.ts';

const OPENFOLIO_API_BASE = Deno.env.get('OPENFOLIO_API_BASE') ?? 'https://api.openfolio.com';
const FOLIOLENS_INBOUND_ROUTER_SECRET = Deno.env.get('FOLIOLENS_INBOUND_ROUTER_SECRET') ?? '';
const ROUTER_FRESHNESS_ALERT_URL =
  Deno.env.get('ROUTER_FRESHNESS_ALERT_URL') ?? 'https://app.foliolens.in/api/freshness-alert';
const NOTIFY_ENVIRONMENT = Deno.env.get('NOTIFY_ENVIRONMENT') ?? 'dev';

async function signRouterPayload(body: string): Promise<{ signature: string; timestamp: number }> {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(FOLIOLENS_INBOUND_ROUTER_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = `${timestamp}.${body}`;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  return { signature: `v1,${encodeBase64(new Uint8Array(sig))}`, timestamp };
}

async function fetchNavMaxDate(
  supabase: ReturnType<typeof createServiceClient>,
): Promise<string | null> {
  const { data: heldRows, error: heldError } = await supabase
    .from('user_fund')
    .select('scheme_code')
    .eq('is_active', true);

  if (heldError || !Array.isArray(heldRows) || heldRows.length === 0) {
    return null;
  }

  const heldCodes = [
    ...new Set(
      heldRows
        .map((row) => row.scheme_code)
        .filter((code): code is number => Number.isFinite(code)),
    ),
  ];
  if (heldCodes.length === 0) return null;

  const { data, error } = await supabase
    .from('nav_history')
    .select('nav_date')
    .in('scheme_code', heldCodes)
    .order('nav_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data?.nav_date) {
    return null;
  }

  return data.nav_date;
}

async function fetchCronFailureCount(
  supabase: ReturnType<typeof createServiceClient>,
): Promise<number> {
  const { data, error } = await supabase.rpc('recent_cron_failures', { hours: 24 });

  if (error || !Array.isArray(data)) {
    console.warn('[freshness-check] recent_cron_failures rpc failed: %s', error?.message);
    return -1; // Signal error: -1 means we couldn't fetch the data
  }

  return data.length;
}

async function fetchBackfillCursors(
  supabase: ReturnType<typeof createServiceClient>,
): Promise<CursorRow[]> {
  const { data, error } = await supabase
    .from('app_config')
    .select('key, value, updated_at')
    .like('key', 'universe_backfill_%_cursor');

  if (error || !Array.isArray(data)) {
    console.warn('[freshness-check] backfill cursor fetch failed: %s', error?.message);
    return [];
  }

  return data;
}

async function fetchMaxPortfolioDate(
  supabase: ReturnType<typeof createServiceClient>,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('fund_portfolio_composition')
    .select('portfolio_date')
    .eq('source', 'official')
    .order('portfolio_date', { ascending: false })
    .limit(1)
    .single();

  if (error || !data?.portfolio_date) {
    return null;
  }

  return data.portfolio_date;
}

async function fetchOpenFolioHealth(baseUrl: string): Promise<OpenFolioHealthResponse | null> {
  try {
    const res = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      console.warn('[freshness-check] OpenFolio /health non-2xx: %d', res.status);
      return null;
    }

    return (await res.json()) as OpenFolioHealthResponse;
  } catch (err) {
    console.warn('[freshness-check] OpenFolio /health fetch failed: %s', err);
    return null;
  }
}

async function sendAlert(checks: CheckResult[], env: string): Promise<void> {
  const failedChecks = checks.filter((c) => !c.ok);
  if (failedChecks.length === 0) {
    console.log('[freshness-check] all checks passed, no alert sent');
    return;
  }

  if (!FOLIOLENS_INBOUND_ROUTER_SECRET) {
    console.warn('[freshness-check] skipping alert — FOLIOLENS_INBOUND_ROUTER_SECRET not set');
    return;
  }

  const alertBody = JSON.stringify({
    v: 1,
    environment: env,
    timestamp: new Date().toISOString(),
    checks: failedChecks,
    passedCount: checks.length - failedChecks.length,
    failedCount: failedChecks.length,
  });

  try {
    const { signature, timestamp } = await signRouterPayload(alertBody);
    const res = await fetch(ROUTER_FRESHNESS_ALERT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-foliolens-signature': signature,
        'x-foliolens-timestamp': String(timestamp),
      },
      body: alertBody,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(
        '[freshness-check] alert forward failed status=%d body=%s',
        res.status,
        errText.slice(0, 400),
      );
      return;
    }

    console.log('[freshness-check] alert sent to router (failed=%d)', failedChecks.length);
  } catch (err) {
    console.warn('[freshness-check] alert send threw: %s', err);
  }
}

Deno.serve(async (req) => {
  console.log('[freshness-check] invoked method=%s', req.method);

  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  const supabase = createServiceClient();
  const now = new Date();

  // Allow request body to override parameters for testing (e.g., bad OpenFolio URL)
  let overrides: Record<string, unknown> = {};
  try {
    overrides = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  } catch {
    // Ignore malformed body; use defaults
  }

  // Fetch data in parallel
  const [navMaxDate, failureCount, cursors, maxPortfolioDate, ofHealthRaw] = await Promise.all([
    fetchNavMaxDate(supabase),
    fetchCronFailureCount(supabase),
    fetchBackfillCursors(supabase),
    fetchMaxPortfolioDate(supabase),
    fetchOpenFolioHealth((overrides.openfolio_base as string) ?? OPENFOLIO_API_BASE),
  ]);

  // Run checks
  const checks: CheckResult[] = [
    checkNavFreshness(navMaxDate, now),
    failureCount === -1
      ? { name: 'Cron failures (last 24h)', ok: false, detail: 'Failed to fetch cron status' }
      : checkCronFailures(failureCount),
    checkBackfillCursors(cursors, now),
    checkOpenFolioHealth(ofHealthRaw, now),
    checkCompositionStaleness(maxPortfolioDate, now),
  ];

  // Log structured summary
  const passedCount = checks.filter((c) => c.ok).length;
  const failedCount = checks.length - passedCount;
  console.log(
    '[freshness-check] summary passed=%d failed=%d timestamp=%s',
    passedCount,
    failedCount,
    now.toISOString(),
  );

  // Send alert if any check failed
  await sendAlert(checks, NOTIFY_ENVIRONMENT);

  // Return detailed results
  return json({
    ok: failedCount === 0,
    timestamp: now.toISOString(),
    checks,
    passedCount,
    failedCount,
  });
});
