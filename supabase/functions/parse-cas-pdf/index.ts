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
  countParsedTransactions,
  importCASData,
  type CASParseResult,
} from '../_shared/import-cas.ts';
import { trackServerEvent } from '../_shared/analytics.ts';

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

  const fileName = req.headers.get('x-file-name') ?? 'cas.pdf';
  const passwordOverride = req.headers.get('x-password-override')?.trim() || null;

  const { data: profile } = await supabase
    .from('user_profile')
    .select('pan, dob')
    .eq('user_id', user.id)
    .maybeSingle();

  function computeCdslPassword(pan: string, dob: string): string {
    // dob is ISO YYYY-MM-DD; CDSL/NSDL password format is PAN + DDMMYYYY
    const [yyyy, mm, dd] = dob.split('-');
    return `${pan.toUpperCase()}${dd}${mm}${yyyy}`;
  }

  // If user supplied a custom password, use it exclusively — they've opted out of defaults.
  // Otherwise fall back to PAN (primary) and PAN+DOB (CDSL/NSDL fallback).
  const password = passwordOverride ?? (profile?.pan ?? '');
  const cdslPassword = passwordOverride
    ? null
    : (profile?.pan && profile?.dob ? computeCdslPassword(profile.pan, profile.dob) : null);

  console.log(
    '[parse-cas-pdf] user=%s, file=%s, size=%d bytes, has_dob=%s, custom_pw=%s',
    user.id, fileName, pdfBytesRaw.byteLength, !!profile?.dob, !!passwordOverride,
  );

  if (!password) {
    console.warn('[parse-cas-pdf] no password available for user %s', user.id);
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
    console.error('[parse-cas-pdf] failed to create import record:', importError?.message);
    return json({ error: 'Failed to create import record' }, { status: 500 });
  }

  const importId = importRecord.id as string;
  console.log('[parse-cas-pdf] import record created, import_id=%s', importId);

  let parsed: CASParseResult;
  // Diagnostic context captured outside the try/catch so the catch block can
  // write it into cas_import.error_message — Supabase MCP only exposes HTTP
  // summaries from the function logs, but the DB row is queryable via SQL,
  // so when prod imports fail with "Unauthorized" we need this context to
  // tell apart Vercel deployment-protection HTML, parser-route 401s on a
  // wrong/missing secret, and an unexpected URL being hit.
  let diagContext = '';
  try {
    const parserUrl = resolveParserUrl(req);
    if (!CAS_PARSER_SHARED_SECRET) {
      throw new Error('CAS parser secret is not configured');
    }

    // Diagnostic context — helps debug 401s from the upstream Vercel parser.
    // We log the resolved URL, the *prefix* of the shared secret (first 4
    // chars + length) so a value mismatch between Supabase Edge and the
    // Vercel project's env can be spotted in logs without fully exposing
    // either side, and whether a Vercel protection bypass token was sent.
    const secretPrefix = CAS_PARSER_SHARED_SECRET.slice(0, 4);
    console.log(
      '[parse-cas-pdf] parser_call url=%s, secret_prefix=%s***, secret_len=%d, vercel_bypass_set=%s, file=%s, pdf_bytes=%d, has_cdsl_password=%s',
      parserUrl,
      secretPrefix,
      CAS_PARSER_SHARED_SECRET.length,
      VERCEL_PROTECTION_BYPASS_TOKEN ? 'true' : 'false',
      fileName,
      pdfBytesRaw.byteLength,
      cdslPassword ? 'true' : 'false',
    );

    const parserStartedAt = Date.now();
    const parserRes = await fetch(parserUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-file-name': fileName,
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

    // Capture the raw response body once. We need the text either way: a
    // 200 path parses it as JSON, a non-OK path logs a truncated prefix so
    // we can tell apart Vercel deployment-protection HTML (auth wall) from
    // the parser route's own JSON 401 body.
    const rawBody = await parserRes.text();
    let parserBody: { error?: string; mutual_funds?: unknown[] } = {};
    let bodyParseError: string | null = null;
    try {
      parserBody = rawBody ? JSON.parse(rawBody) : {};
    } catch (jsonErr) {
      bodyParseError = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
    }

    console.log(
      '[parse-cas-pdf] parser_response status=%d, content_type=%s, body_len=%d, json_ok=%s, elapsed_ms=%d',
      parserRes.status,
      parserRes.headers.get('content-type') ?? 'unknown',
      rawBody.length,
      bodyParseError ? 'false' : 'true',
      parserElapsed,
    );

    if (!parserRes.ok) {
      // On non-OK, log the body prefix so the user can tell whether it's
      // an HTML auth-wall page or a JSON parser-route rejection.
      const bodyPrefix = rawBody.slice(0, 240).replace(/\s+/g, ' ');
      console.warn(
        '[parse-cas-pdf] parser_non_ok status=%d body_prefix=%s',
        parserRes.status,
        bodyPrefix,
      );
      diagContext = `url=${parserUrl} status=${parserRes.status} secret_prefix=${secretPrefix}*** secret_len=${CAS_PARSER_SHARED_SECRET.length} bypass_set=${VERCEL_PROTECTION_BYPASS_TOKEN ? 'true' : 'false'} content_type=${parserRes.headers.get('content-type') ?? 'unknown'} body_prefix=${bodyPrefix}`;
      throw new Error(parserBody.error ?? `Parser request failed with status ${parserRes.status}`);
    }

    parsed = parserBody as CASParseResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[parse-cas-pdf] parser error: %s', msg);

    // Persist diag context alongside the user-facing message so we can read
    // back the URL hit, the status, the secret prefix used and the response
    // body prefix from the cas_import row when investigating failures.
    const persistedMsg = diagContext ? `${msg} | ${diagContext}` : msg;
    await supabase
      .from('cas_import')
      .update({ import_status: 'failed', error_message: persistedMsg })
      .eq('id', importId);

    const msgLower = msg.toLowerCase();
    const isPasswordError = msgLower.includes('password') || msgLower.includes('decrypt');
    const isHoldingsOnly = msgLower.includes('holdings-only') || msgLower.includes('detailed cas');
    trackServerEvent(
      'cas_parse_failed',
      {
        source: 'parse-cas-pdf',
        failure_reason: isPasswordError
          ? 'wrong_password'
          : isHoldingsOnly
            ? 'holdings_only'
            : 'parser_error',
        error_message: msg.slice(0, 240),
      },
      user.id,
    );
    return json(
      {
        error: isHoldingsOnly
          ? msg
          : isPasswordError
            ? 'Wrong PDF password. For CAMS/KFintech/MFCentral PDFs, the password is your PAN. For CDSL/NSDL PDFs, set your date of birth in Settings → Account.'
            : `Failed to parse CAS PDF: ${msg}`,
      },
      { status: 422 },
    );
  }

  const parsedFolios = parsed?.mutual_funds ?? [];
  const parsedTransactions = countParsedTransactions(parsed);
  console.log(
    '[parse-cas-pdf] parser returned %d folios and %d raw transactions',
    parsedFolios.length,
    parsedTransactions,
  );

  if (parsedFolios.length === 0) {
    const msg = 'No mutual fund data found in this CAS PDF';
    await supabase
      .from('cas_import')
      .update({ import_status: 'failed', error_message: msg })
      .eq('id', importId);

    return json(
      {
        error: 'We could not find any mutual fund entries in this PDF. Please upload a detailed CAS statement.',
      },
      { status: 422 },
    );
  }

  if (parsedTransactions === 0) {
    const msg = 'Detailed CAS required: parser found holdings but no transaction rows';
    await supabase
      .from('cas_import')
      .update({ import_status: 'failed', error_message: msg })
      .eq('id', importId);

    return json(
      {
        error:
          'This PDF has holdings but no transaction history. Please upload a Detailed CAS covering your full investment date range.',
      },
      { status: 422 },
    );
  }

  const { fundsUpdated, transactionsAdded, errors } = await importCASData(
    supabase, user.id, importId, parsed,
  );

  const status = errors.length > 0 && fundsUpdated === 0 ? 'failed' : 'success';
  await supabase
    .from('cas_import')
    .update({
      import_status: status,
      funds_updated: fundsUpdated,
      transactions_added: transactionsAdded,
      error_message: errors.length > 0 ? errors.join('; ') : null,
    })
    .eq('id', importId);

  console.log(
    '[parse-cas-pdf] done, import_id=%s, status=%s, funds=%d, txns=%d, errors=%d',
    importId, status, fundsUpdated, transactionsAdded, errors.length,
  );

  if (fundsUpdated === 0 && errors.length > 0) {
    console.error('[parse-cas-pdf] all scheme upserts failed; first error: %s', errors[0]);
    trackServerEvent(
      'cas_parse_failed',
      {
        source: 'parse-cas-pdf',
        failure_reason: 'import_all_failed',
        scheme_errors: errors.length,
        first_error: errors[0]?.slice(0, 240),
      },
      user.id,
    );
    return json({ error: 'Import failed — no funds could be saved. Please try again.' }, { status: 500 });
  }

  if (fundsUpdated > 0) {
    const headers = { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

    console.log('[parse-cas-pdf] triggering sync-nav in background');
    fetch(`${SUPABASE_URL}/functions/v1/sync-nav`, {
      method: 'POST',
      headers,
    }).catch((err) => console.error('[parse-cas-pdf] sync-nav trigger failed:', err));

    console.log('[parse-cas-pdf] triggering sync-index in background');
    fetch(`${SUPABASE_URL}/functions/v1/sync-index`, {
      method: 'POST',
      headers,
    }).catch((err) => console.error('[parse-cas-pdf] sync-index trigger failed:', err));
  }

  trackServerEvent(
    'cas_parse_success',
    {
      source: 'parse-cas-pdf',
      funds_updated: fundsUpdated,
      transactions_added: transactionsAdded,
      partial: errors.length > 0,
      partial_errors: errors.length,
    },
    user.id,
  );

  return json({ ok: true, funds: fundsUpdated, transactions: transactionsAdded });
});
