/**
 * cas-webhook-resend — receives a normalized, FolioLens-signed CAS payload
 * from the Vercel router and imports any CAS PDF attachments for the
 * addressed user.
 *
 * Issue #107 — Resend secrets and Resend-specific verification logic live
 * exclusively at the Vercel router. This function:
 *
 *   1. Verifies the FolioLens HMAC signature attached by the router
 *      (rejects spoofs without needing any Resend knowledge here)
 *   2. Resolves the user via `user_profile.cas_inbox_token`
 *   3. Downloads each attachment via the Resend-presigned `download_url`
 *      the router included in the normalized payload (no Resend API key
 *      required for the download)
 *   4. POSTs PDF bytes to the existing Vercel Python parser at
 *      `${APP_BASE_URL}/api/parse-cas-pdf` with the user's PAN (and a
 *      CDSL/NSDL fallback password from PAN+DOB)
 *   5. Runs the shared `importCASData` helper to upsert funds and transactions
 *   6. Updates the `cas_import` audit row with status + counts + errors
 *   7. Sends the status email by POSTing a FolioLens-signed payload to
 *      the router's `/api/cas-import-notify` endpoint
 *   8. Always returns 200 so the router doesn't retry on user-side errors
 *
 * Deploy with `--no-verify-jwt` (the router cannot send a Supabase JWT).
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { encodeBase64 } from 'jsr:@std/encoding/base64';
import {
  countParsedTransactions,
  importCASData,
  type CASParseResult,
} from '../_shared/import-cas.ts';
import {
  extractGmailVerificationUrl,
  isGmailForwardingVerification,
} from '../_shared/gmail-verification.ts';
import { trackServerEvent } from '../_shared/analytics.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// Issue #107: only one inbound secret on Supabase — the FolioLens-owned HMAC
// shared with the Vercel router. Resend secrets stay at the router boundary.
const FOLIOLENS_INBOUND_ROUTER_SECRET = Deno.env.get('FOLIOLENS_INBOUND_ROUTER_SECRET') ?? '';
const CAS_PARSER_SHARED_SECRET = Deno.env.get('CAS_PARSER_SHARED_SECRET') ?? '';
const APP_BASE_URL = Deno.env.get('APP_BASE_URL') ?? 'https://app.foliolens.in';
const VERCEL_PROTECTION_BYPASS_TOKEN = Deno.env.get('VERCEL_PROTECTION_BYPASS_TOKEN') ?? '';
// Where to POST status emails. The router's prod endpoint handles both DEV
// and PROD Supabase callers; the env tag in the body picks the From address.
const ROUTER_NOTIFY_URL =
  Deno.env.get('ROUTER_NOTIFY_URL') ?? 'https://app.foliolens.in/api/cas-import-notify';
// Self-tag in the notify payload so the router selects the right Resend
// template id / From address. Defaults to 'dev' so a missing env doesn't
// accidentally send prod-branded mail from a dev project.
const NOTIFY_ENVIRONMENT = Deno.env.get('NOTIFY_ENVIRONMENT') ?? 'dev';

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

// ── Router signature verification ───────────────────────────────────────────────
//
// Mirrors `sign_router_payload` in `api/_resend_inbound_router.py`. The
// router signs `<timestamp>.<rawBody>` with HMAC-SHA256 using
// `FOLIOLENS_INBOUND_ROUTER_SECRET` and sends:
//
//   x-foliolens-signature: v1,<base64sig>
//   x-foliolens-timestamp: <unix-seconds>
//
// We reject anything missing the headers, outside the 5-minute window, or
// whose signature doesn't match.

async function verifyRouterSignature(
  rawBody: string,
  headers: Headers,
): Promise<boolean> {
  if (!FOLIOLENS_INBOUND_ROUTER_SECRET) {
    console.warn(
      '[cas-webhook-resend] FOLIOLENS_INBOUND_ROUTER_SECRET not set — refusing all requests',
    );
    return false;
  }
  const sigHeader = headers.get('x-foliolens-signature');
  const tsHeader = headers.get('x-foliolens-timestamp');
  if (!sigHeader || !tsHeader) {
    console.warn('[cas-webhook-resend] missing x-foliolens-signature / x-foliolens-timestamp');
    return false;
  }
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > SIGNATURE_TOLERANCE_SECONDS) {
    console.warn('[cas-webhook-resend] x-foliolens-timestamp out of range, possible replay');
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(FOLIOLENS_INBOUND_ROUTER_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = `${ts}.${rawBody}`;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  const expected = `v1,${encodeBase64(new Uint8Array(sig))}`;
  return sigHeader === expected;
}

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

// ── Normalized payload typing ──────────────────────────────────────────────────

interface NormalizedAttachment {
  filename: string;
  download_url: string;
  content_type?: string;
  id?: string;
}

interface NormalizedRouterPayload {
  v: number;
  route: 'cas_dev' | 'cas_prod';
  token: string;
  recipient: string;
  email_id: string;
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments: NormalizedAttachment[];
}

// Adapter for the gmail-verification helpers, which were originally written
// against Resend's payload shape. The relevant fields (from/subject/text/html)
// are 1:1 in the normalized payload.
function gmailVerificationView(payload: NormalizedRouterPayload) {
  return {
    from: payload.from,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    headers: payload.headers,
  };
}

const TOKEN_REGEX = /^[A-HJKMNP-Z2-9]{8}$/;

function isPdfAttachment(attachment: NormalizedAttachment): boolean {
  const contentType = (attachment.content_type ?? '').toLowerCase();
  return (
    contentType === 'application/pdf' ||
    (attachment.filename?.toLowerCase().endsWith('.pdf') ?? false)
  );
}

async function downloadAttachmentBytes(attachment: NormalizedAttachment): Promise<Uint8Array> {
  const res = await fetch(attachment.download_url);
  if (!res.ok) {
    throw new Error(
      `Attachment download failed (${res.status}) for ${attachment.filename}`,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

// ── Password derivation ─────────────────────────────────────────────────────────

function computeCdslPassword(pan: string, dob: string): string {
  // dob is ISO YYYY-MM-DD; CDSL/NSDL password is PAN + DDMMYYYY
  const [yyyy, mm, dd] = dob.split('-');
  return `${pan.toUpperCase()}${dd}${mm}${yyyy}`;
}

// ── Notification (router callback) ──────────────────────────────────────────────

async function getAuthEmail(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error) {
    console.warn('[cas-webhook-resend] auth email lookup failed: %s', error.message);
    return null;
  }
  return data.user?.email ?? null;
}

async function sendImportNotification({
  to,
  importId,
  status,
  funds,
  transactions,
  errors,
}: {
  to: string | null;
  importId: string;
  status: 'success' | 'failed';
  funds: number;
  transactions: number;
  errors: string[];
}) {
  if (!to) {
    console.warn('[cas-webhook-resend] notification skipped, auth email missing');
    return;
  }
  const body = JSON.stringify({
    v: 1,
    to,
    import_id: importId,
    status,
    funds_updated: funds,
    transactions_added: transactions,
    errors,
    environment: NOTIFY_ENVIRONMENT,
  });
  try {
    const { signature, timestamp } = await signRouterPayload(body);
    const res = await fetch(ROUTER_NOTIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-foliolens-signature': signature,
        'x-foliolens-timestamp': String(timestamp),
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Notify endpoint returned ${res.status}: ${text}`);
    }
    console.log(
      '[cas-webhook-resend] notification sent, import_id=%s, status=%s',
      importId,
      status,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      '[cas-webhook-resend] DROPPED notification_failed: import_id=%s, status=%s, error=%s',
      importId,
      status,
      msg,
    );
  }
}

// ── Background processor ───────────────────────────────────────────────────────
//
// Same shape as before: sync handler does the bare minimum and hands off to
// EdgeRuntime.waitUntil so we always answer the router in <1s.

interface BackgroundJobArgs {
  supabase: ReturnType<typeof createClient>;
  importId: string;
  userId: string;
  pan: string;
  dob: string | null;
  attachments: NormalizedAttachment[];
}

async function finalizeImportRow(
  supabase: ReturnType<typeof createClient>,
  importId: string,
  status: 'success' | 'failed',
  funds: number,
  transactions: number,
  errors: string[],
) {
  const { error: updateErr } = await supabase
    .from('cas_import')
    .update({
      import_status: status,
      funds_updated: funds,
      transactions_added: transactions,
      error_message: errors.length > 0 ? errors.join('; ') : null,
    })
    .eq('id', importId);
  if (updateErr) {
    console.error(
      '[cas-webhook-resend] cas_import finalize failed import_id=%s: %s',
      importId,
      updateErr.message,
    );
  }
}

async function processImportInBackground(args: BackgroundJobArgs) {
  const { supabase, importId, userId, pan, dob, attachments } = args;
  const authEmailPromise = getAuthEmail(supabase, userId);

  try {
    console.log('[cas-webhook-resend] background_started import_id=%s', importId);

    const pdfAttachments = attachments.filter(isPdfAttachment);
    console.log(
      '[cas-webhook-resend] import_id=%s, user=%s, pdf_files=%d, total_files=%d',
      importId,
      userId,
      pdfAttachments.length,
      attachments.length,
    );

    if (pdfAttachments.length === 0) {
      const errorMsg = 'No PDF attachments found in email';
      await finalizeImportRow(supabase, importId, 'failed', 0, 0, [errorMsg]);
      await sendImportNotification({
        to: await authEmailPromise,
        importId,
        status: 'failed',
        funds: 0,
        transactions: 0,
        errors: [errorMsg],
      });
      return;
    }

    let totalFunds = 0;
    let totalTransactions = 0;
    const allErrors: string[] = [];
    const cdslPassword = dob ? computeCdslPassword(pan, dob) : null;

    for (const attachment of pdfAttachments) {
      try {
        const pdfBytes = await downloadAttachmentBytes(attachment);

        const parserHeaders: Record<string, string> = {
          'Content-Type': 'application/octet-stream',
          'x-file-name': attachment.filename,
          'x-password': pan,
          'x-parser-secret': CAS_PARSER_SHARED_SECRET,
        };
        if (cdslPassword) parserHeaders['x-password-cdsl'] = cdslPassword;
        if (VERCEL_PROTECTION_BYPASS_TOKEN) {
          parserHeaders['x-vercel-protection-bypass'] = VERCEL_PROTECTION_BYPASS_TOKEN;
        }

        const parserRes = await fetch(`${APP_BASE_URL}/api/parse-cas-pdf`, {
          method: 'POST',
          headers: parserHeaders,
          body: pdfBytes,
        });

        const parserBody = (await parserRes.json().catch(() => ({}))) as
          | (CASParseResult & { error?: string })
          | { error?: string };

        if (!parserRes.ok) {
          throw new Error(
            (parserBody as { error?: string }).error ?? `Parser failed (${parserRes.status})`,
          );
        }

        const parsedResult = parserBody as CASParseResult;
        const parsedTransactions = countParsedTransactions(parsedResult);
        console.log(
          '[cas-webhook-resend] attachment parsed file=%s, raw_txns=%d',
          attachment.filename,
          parsedTransactions,
        );

        if (parsedTransactions === 0) {
          throw new Error(
            'Detailed CAS required: this PDF has holdings but no transaction history. Download a Detailed CAS covering your full investment date range.',
          );
        }

        const { fundsUpdated, transactionsAdded, errors } = await importCASData(
          supabase,
          userId,
          importId,
          parsedResult,
        );

        totalFunds += fundsUpdated;
        totalTransactions += transactionsAdded;
        allErrors.push(...errors);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[cas-webhook-resend] attachment error: %s', msg);
        allErrors.push(msg);
      }
    }

    const status: 'success' | 'failed' =
      allErrors.length > 0 && totalFunds === 0 ? 'failed' : 'success';

    await finalizeImportRow(supabase, importId, status, totalFunds, totalTransactions, allErrors);

    console.log(
      '[cas-webhook-resend] background_completed import_id=%s, status=%s, funds=%d, txns=%d, errors=%d',
      importId,
      status,
      totalFunds,
      totalTransactions,
      allErrors.length,
    );

    trackServerEvent(
      status === 'success' ? 'cas_inbound_imported' : 'cas_inbound_failed',
      {
        funds_updated: totalFunds,
        transactions_added: totalTransactions,
        attachment_errors: allErrors.length,
        first_error: allErrors[0]?.slice(0, 240),
      },
      userId,
    );

    await sendImportNotification({
      to: await authEmailPromise,
      importId,
      status,
      funds: totalFunds,
      transactions: totalTransactions,
      errors: allErrors,
    });

    if (status === 'success') {
      const { error: clearErr } = await supabase
        .from('user_profile')
        .update({ cas_inbox_confirmation_url: null })
        .eq('user_id', userId)
        .not('cas_inbox_confirmation_url', 'is', null);
      if (clearErr) {
        console.warn(
          '[cas-webhook-resend] opportunistic clear failed: %s (non-fatal)',
          clearErr.message,
        );
      }
    }

    if (totalFunds > 0) {
      fetch(`${SUPABASE_URL}/functions/v1/sync-nav`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      }).catch((err) => console.error('[cas-webhook-resend] sync-nav trigger failed:', err));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      '[cas-webhook-resend] CRITICAL background failure import_id=%s: %s',
      importId,
      msg,
    );
    trackServerEvent(
      'cas_inbound_crashed',
      {
        import_id: importId,
        error_message: msg.slice(0, 240),
      },
      userId,
    );
    try {
      await finalizeImportRow(supabase, importId, 'failed', 0, 0, [
        `Background processor crashed: ${msg}`,
      ]);
      await sendImportNotification({
        to: await authEmailPromise,
        importId,
        status: 'failed',
        funds: 0,
        transactions: 0,
        errors: [`Background processor crashed: ${msg}`],
      });
    } catch (innerErr) {
      const innerMsg = innerErr instanceof Error ? innerErr.message : String(innerErr);
      console.error(
        '[cas-webhook-resend] CRITICAL secondary failure import_id=%s while reporting primary failure: %s',
        importId,
        innerMsg,
      );
    }
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const rawBody = await req.text();

  if (!(await verifyRouterSignature(rawBody, req.headers))) {
    return new Response('Invalid signature', { status: 401 });
  }

  let payload: NormalizedRouterPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (payload.v !== 1) {
    console.warn('[cas-webhook-resend] DROPPED unsupported_payload_version: v=%s', payload.v);
    return Response.json({ ok: false, reason: 'unsupported_payload_version' });
  }

  const token = (payload.token ?? '').toUpperCase();
  if (!token || !TOKEN_REGEX.test(token)) {
    console.warn(
      '[cas-webhook-resend] DROPPED no_token: recipient=%s, email_id=%s',
      payload.recipient ?? '(none)',
      payload.email_id ?? '(none)',
    );
    return Response.json({ ok: false, reason: 'no_token' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: profile, error: profileError } = await supabase
    .from('user_profile')
    .select('user_id, pan, dob')
    .eq('cas_inbox_token', token)
    .maybeSingle();

  if (profileError) {
    console.error('[cas-webhook-resend] profile lookup error: %s', profileError.message);
    return Response.json({ ok: false, reason: 'lookup_failed' });
  }

  if (!profile?.user_id || !profile?.pan) {
    console.warn(
      '[cas-webhook-resend] DROPPED unknown_token: token=%s, recipient=%s, email_id=%s',
      token,
      payload.recipient ?? '(none)',
      payload.email_id ?? '(none)',
    );
    return Response.json({ ok: false, reason: 'unknown_token' });
  }

  const userId = profile.user_id as string;
  const pan = profile.pan as string;
  const dob = (profile.dob as string | null) ?? null;

  // Gmail auto-forward verification — single UPDATE, fast, runs inline.
  const verificationView = gmailVerificationView(payload);
  if (isGmailForwardingVerification(verificationView)) {
    const url = extractGmailVerificationUrl(verificationView);
    if (!url) {
      console.warn(
        '[cas-webhook-resend] gmail-verification email matched sender+subject but no URL found, token=%s',
        token,
      );
      return Response.json({ ok: false, reason: 'gmail_verification_no_url' });
    }
    const { error: updateErr } = await supabase
      .from('user_profile')
      .update({ cas_inbox_confirmation_url: url })
      .eq('user_id', userId);
    if (updateErr) {
      console.error(
        '[cas-webhook-resend] gmail-verification url update failed: %s',
        updateErr.message,
      );
      return Response.json({ ok: false, reason: 'gmail_verification_update_failed' });
    }
    console.log(
      '[cas-webhook-resend] gmail-verification-captured token=%s, user=%s',
      token,
      userId,
    );
    return Response.json({ ok: true, captured: 'gmail_forwarding_verification' });
  }

  const pdfAttachments = (payload.attachments ?? []).filter(isPdfAttachment);
  if (pdfAttachments.length === 0) {
    console.warn(
      '[cas-webhook-resend] DROPPED no_pdfs: token=%s, recipient=%s, email_id=%s, total_files=%d',
      token,
      payload.recipient ?? '(none)',
      payload.email_id ?? '(none)',
      payload.attachments?.length ?? 0,
    );
    return Response.json({ ok: false, reason: 'no_pdfs' });
  }

  const { data: importRecord, error: importError } = await supabase
    .from('cas_import')
    .insert({
      user_id: userId,
      import_source: 'email',
      import_status: 'pending',
      raw_payload: payload as unknown as Record<string, unknown>,
    })
    .select('id')
    .single();

  if (importError || !importRecord) {
    console.error('[cas-webhook-resend] cas_import insert failed: %s', importError?.message);
    return Response.json({ ok: false, reason: 'audit_failed' });
  }

  const importId = importRecord.id as string;
  console.log(
    '[cas-webhook-resend] accepted import_id=%s, user=%s, token=%s, pdf_files=%d',
    importId,
    userId,
    token,
    pdfAttachments.length,
  );

  EdgeRuntime.waitUntil(
    processImportInBackground({
      supabase,
      importId,
      userId,
      pan,
      dob,
      attachments: pdfAttachments,
    }),
  );

  return Response.json({ ok: true, accepted: true, import_id: importId });
});
