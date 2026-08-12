/**
 * parse-cas-pdf — accepts a CAS PDF uploaded directly from the app,
 * forwards it to the Vercel Python CAS parser, and imports the result.
 *
 * Request: binary PDF body
 *
 * Auth: Bearer JWT in Authorization header (Supabase user token).
 */

import { CORS, json } from '../_shared/cors.ts';
import { getUserFromRequest } from '../_shared/auth.ts';
import {
  importCASData,
  type CASParseResult,
} from '../_shared/import-cas.ts';
import { trackServerEvent } from '../_shared/analytics.ts';
import { buildCASPasswordAttempts } from '../_shared/cas-passwords.ts';
import {
  CASPreflightError,
  assertCASPreflight,
  auditErrorCode,
  buildImportOutcome,
  buildPreflightFailureOutcome,
  bucketCount,
  importFailureHttpStatus,
  reasonFromAuditError,
  safeCASFailureReason,
  userMessageForCASFailure,
  type CASFailureReason,
  type CASPreflightSummary,
} from '../_shared/cas-import-contract.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const LOCAL_CAS_PARSER_URL = Deno.env.get('LOCAL_CAS_PARSER_URL') ?? '';
const CAS_PARSER_SHARED_SECRET = Deno.env.get('CAS_PARSER_SHARED_SECRET') ?? '';
const VERCEL_PROTECTION_BYPASS_TOKEN = Deno.env.get('VERCEL_PROTECTION_BYPASS_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const DEFAULT_CAS_PARSER_URL = `${Deno.env.get('APP_BASE_URL') ?? 'https://app.foliolens.in'}/api/parse-cas-pdf`;

function resolveParserUrl(req: Request): string {
  // Prefer explicit env configuration when available. This keeps parser routing
  // stable across mobile/web/preview clients and avoids accidental calls to a
  // preview host that may not have parser secrets configured.
  if (LOCAL_CAS_PARSER_URL) {
    return LOCAL_CAS_PARSER_URL;
  }

  const origin = req.headers.get('origin');
  if (origin && /^https?:\/\//.test(origin)) {
    return new URL('/api/parse-cas-pdf', origin).toString();
  }

  const referer = req.headers.get('referer');
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      return new URL('/api/parse-cas-pdf', refererUrl.origin).toString();
    } catch {
      // ignore malformed referer and fall through to env-based URL
    }
  }

  // Native clients do not send Origin/Referer, so keep a stable production
  // parser fallback for mobile imports when no explicit env override exists.
  return DEFAULT_CAS_PARSER_URL;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  // Authenticate user inside the function. This endpoint is deployed with
  // `--no-verify-jwt` because the Supabase Functions gateway rejects the
  // project's current user tokens, while `supabase.auth.getUser()` succeeds.
  const { user, supabase, error: authError } = await getUserFromRequest(req);
  if (authError || !user || !supabase) {
    return json({ error: authError ?? 'Unauthorized' }, { status: 401 });
  }

  // Read raw PDF binary from request body.
  // Client sends the file as a Blob body (not multipart form) so that
  // supabase.functions.invoke can attach the JWT auth header reliably.
  let pdfBytesRaw: ArrayBuffer;
  try {
    pdfBytesRaw = await req.arrayBuffer();
  } catch {
    return json({ error: 'Could not read request body' }, { status: 400 });
  }

  if (pdfBytesRaw.byteLength === 0) {
    return json({ error: 'Empty file received' }, { status: 400 });
  }

  const passwordOverride = req.headers.get('x-password-override')?.trim() || null;

  const { data: profile } = await supabase
    .from('user_profile')
    .select('pan, dob')
    .eq('user_id', user.id)
    .maybeSingle();

  // If user supplied a custom password, use it exclusively — they've opted out of defaults.
  // Otherwise fall back to PAN (primary) and PAN+DOB (CDSL/NSDL fallback).
  const passwordAttempts = buildCASPasswordAttempts(profile, passwordOverride);
  const password = passwordAttempts.primary;
  const cdslPassword = passwordAttempts.depositoryFallback;

  console.log(
    '[parse-cas-pdf] request_ready password_mode=%s',
    passwordAttempts.mode,
  );

  if (!password) {
    console.warn('[parse-cas-pdf] rejected reason=missing_password');
    return json(
      { error: 'CAS PDF password required. Please set your PAN in the app settings.' },
      { status: 400 },
    );
  }

  // Create audit record
  const { data: importRecord, error: importError } = await supabase
    .from('cas_import')
    .insert({
      user_id: user.id,
      import_source: 'pdf',
      import_status: 'pending',
    })
    .select('id')
    .single();

  if (importError || !importRecord) {
    console.error('[parse-cas-pdf] audit_create_failed');
    return json({ error: 'Failed to create import record' }, { status: 500 });
  }

  const importId = importRecord.id as string;
  console.log('[parse-cas-pdf] audit_created');

  let parsed: CASParseResult;
  let parserFailureReason: CASFailureReason = 'parser_error';
  try {
    const parserUrl = resolveParserUrl(req);
    if (!CAS_PARSER_SHARED_SECRET) {
      throw new Error('CAS parser secret is not configured');
    }

    console.log('[parse-cas-pdf] parser_call_started');

    const parserStartedAt = Date.now();
    const parserRes = await fetch(parserUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-password': password,
        'x-parser-secret': CAS_PARSER_SHARED_SECRET,
        ...(cdslPassword ? { 'x-password-cdsl': cdslPassword } : {}),
        ...(VERCEL_PROTECTION_BYPASS_TOKEN
          ? { 'x-vercel-protection-bypass': VERCEL_PROTECTION_BYPASS_TOKEN }
          : {}),
      },
      body: pdfBytesRaw,
    });
    const parserElapsed = Date.now() - parserStartedAt;

    // Capture the body once for JSON decoding. It is never logged or persisted:
    // upstream parser errors may contain statement-derived details.
    const rawBody = await parserRes.text();
    let parserBody: { error?: string; reason?: string; mutual_funds?: unknown[] } = {};
    let bodyParsed = true;
    try {
      parserBody = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      bodyParsed = false;
    }

    console.log(
      '[parse-cas-pdf] parser_response status=%d json_ok=%s duration_bucket=%s',
      parserRes.status,
      bodyParsed ? 'true' : 'false',
      parserElapsed < 1000 ? '<1s' : parserElapsed < 5000 ? '1-5s' : parserElapsed < 15000 ? '5-15s' : '15s+',
    );

    if (!parserRes.ok) {
      parserFailureReason = safeCASFailureReason(parserBody.reason);
      console.warn('[parse-cas-pdf] parser_rejected reason=%s', parserFailureReason);
      throw new Error('parser_request_rejected');
    }

    parsed = parserBody as CASParseResult;
  } catch {
    console.error('[parse-cas-pdf] parser_failed reason=%s', parserFailureReason);
    await supabase
      .from('cas_import')
      .update({
        import_status: 'failed',
        funds_updated: 0,
        transactions_added: 0,
        error_message: auditErrorCode(parserFailureReason),
      })
      .eq('id', importId);

    trackServerEvent(
      'cas_parse_failed',
      {
        source: 'parse-cas-pdf',
        status: 'rejected',
        failure_reason: parserFailureReason,
      },
      user.id,
    );
    return json(
      {
        error: userMessageForCASFailure(parserFailureReason),
        reason: parserFailureReason,
      },
      { status: 422 },
    );
  }

  let preflightSummary: CASPreflightSummary;
  try {
    const preflight = assertCASPreflight(parsed);
    parsed = preflight.parsed;
    preflightSummary = preflight.summary;
  } catch (error) {
    if (!(error instanceof CASPreflightError)) throw error;
    const outcome = buildPreflightFailureOutcome('pdf', error);
    await supabase.from('cas_import').update(outcome.audit).eq('id', importId);
    console.warn(
      '[parse-cas-pdf] preflight_rejected dialect=%s rows=%s reason=%s',
      error.summary.dialect,
      error.summary.rows_bucket,
      error.reason,
    );
    trackServerEvent('cas_parse_failed', outcome.telemetry, user.id);
    return json(outcome.response.body, { status: outcome.response.status });
  }

  const {
    fundsUpdated,
    transactionsAdded,
    catalogHydrationRequested,
    errors,
  } = await importCASData(
    supabase, user.id, importId, parsed,
  );

  const outcome = buildImportOutcome({
    source: 'pdf',
    dialect: preflightSummary.dialect,
    fundsUpdated,
    transactionsAdded,
    errors,
  });
  const status = outcome.status;
  await supabase
    .from('cas_import')
    .update(outcome.audit)
    .eq('id', importId);

  console.log(
    '[parse-cas-pdf] completed status=%s dialect=%s rows=%s',
    status,
    preflightSummary.dialect,
    preflightSummary.rows_bucket,
  );

  if (fundsUpdated === 0 && errors.length > 0) {
    const failureReason = reasonFromAuditError(errors[0]);
    console.error(
      '[parse-cas-pdf] import_failed reason=%s write_failures=%s',
      failureReason,
      bucketCount(errors.length),
    );
    trackServerEvent(
      'cas_parse_failed',
      {
        source: 'parse-cas-pdf',
        status: 'failed',
        failure_reason: failureReason,
        write_failures_bucket: bucketCount(errors.length),
      },
      user.id,
    );
    return json(
      { error: userMessageForCASFailure(failureReason), reason: failureReason },
      { status: importFailureHttpStatus(failureReason) },
    );
  }

  if (fundsUpdated > 0) {
    const headers = { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

    console.log('[parse-cas-pdf] triggering sync-nav in background');
    fetch(`${SUPABASE_URL}/functions/v1/sync-nav`, {
      method: 'POST',
      headers,
    }).catch(() => console.error('[parse-cas-pdf] sync_nav_trigger_failed'));

    console.log('[parse-cas-pdf] triggering sync-index in background');
    fetch(`${SUPABASE_URL}/functions/v1/sync-index`, {
      method: 'POST',
      headers,
    }).catch(() => console.error('[parse-cas-pdf] sync_index_trigger_failed'));

    if (catalogHydrationRequested > 0) {
      console.log('[parse-cas-pdf] triggering sync-fund-meta for provisional catalog identity');
      EdgeRuntime.waitUntil(
        fetch(`${SUPABASE_URL}/functions/v1/sync-fund-meta`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'pending-cas-identities' }),
        }).then((response) => {
          if (!response.ok) console.error('[parse-cas-pdf] sync_fund_meta_trigger_failed');
        }).catch(() => console.error('[parse-cas-pdf] sync_fund_meta_trigger_failed')),
      );
    }
  }

  trackServerEvent(
    'cas_parse_success',
    outcome.telemetry,
    user.id,
  );

  return json(outcome.response);
});
