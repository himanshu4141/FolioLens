/**
 * notify-feedback — sign-and-forward relay for in-app feedback notifications.
 *
 * Invoked by an AFTER INSERT trigger on `public.user_feedback` via
 * `pg_net.http_post` (see migration `20260510000000_notify_feedback_trigger.sql`).
 * This function does NOT call Resend directly — same architecture as the
 * cas-import notification flow post-Issue #107: keep RESEND_API_KEY
 * isolated to the Vercel router, sign payloads with
 * FOLIOLENS_INBOUND_ROUTER_SECRET, forward to the router endpoint at
 * `/api/feedback-notify` which handles the Resend send.
 *
 * Deployed with `--no-verify-jwt` so the trigger (running as the DB user)
 * can call without bearer auth.
 *
 * Env vars (all already provisioned for cas-webhook-resend — no new
 * Supabase secrets needed):
 *   FOLIOLENS_INBOUND_ROUTER_SECRET   HMAC key shared with the Vercel router.
 *   ROUTER_FEEDBACK_NOTIFY_URL        Default https://app.foliolens.in/api/feedback-notify.
 *   NOTIFY_ENVIRONMENT                'dev' | 'prod' — passed through so the
 *                                     router can disambiguate dev vs prod.
 *
 * Failure mode: a router outage MUST NOT break user feedback submission.
 * Errors here are logged and swallowed; the function returns 200 so
 * pg_net doesn't queue retries that we can't observe anyway.
 */

import { encodeBase64 } from 'jsr:@std/encoding@1/base64';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';

const FOLIOLENS_INBOUND_ROUTER_SECRET = Deno.env.get('FOLIOLENS_INBOUND_ROUTER_SECRET') ?? '';
const ROUTER_FEEDBACK_NOTIFY_URL =
  Deno.env.get('ROUTER_FEEDBACK_NOTIFY_URL') ?? 'https://app.foliolens.in/api/feedback-notify';
const NOTIFY_ENVIRONMENT = Deno.env.get('NOTIFY_ENVIRONMENT') ?? 'dev';

interface FeedbackPayload {
  feedback_id?: string;
  user_id?: string;
  type?: string;
  title?: string;
  body?: string;
  app_version?: string | null;
  update_id?: string | null;
  created_at?: string;
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

Deno.serve(async (req) => {
  console.log('[notify-feedback] invoked, method=%s', req.method);

  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  let payload: FeedbackPayload;
  try {
    payload = (await req.json()) as FeedbackPayload;
  } catch (err) {
    console.warn('[notify-feedback] invalid JSON: %s', err);
    return json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { feedback_id, user_id, type, title, body, app_version, update_id, created_at } = payload;
  if (!feedback_id || !user_id || !type || !title || !body) {
    console.warn(
      '[notify-feedback] missing required fields, feedback_id=%s, user_id=%s, type=%s',
      feedback_id,
      user_id,
      type,
    );
    return json({ ok: false, error: 'Missing required fields' }, { status: 400 });
  }

  console.log(
    '[notify-feedback] payload_loaded feedback_id=%s, type=%s, user_id=%s',
    feedback_id,
    type,
    user_id,
  );

  if (!FOLIOLENS_INBOUND_ROUTER_SECRET) {
    console.warn(
      '[notify-feedback] skipping send — FOLIOLENS_INBOUND_ROUTER_SECRET not set',
    );
    return json({ ok: true, skipped: true });
  }

  // Best-effort user email lookup for reply-to. Failure is non-fatal.
  let userEmail: string | undefined;
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase.auth.admin.getUserById(user_id);
    if (error) {
      console.warn('[notify-feedback] user lookup failed: %s', error.message);
    } else {
      userEmail = data.user?.email ?? undefined;
    }
  } catch (err) {
    console.warn('[notify-feedback] user lookup threw: %s', err);
  }

  const routerBody = JSON.stringify({
    v: 1,
    feedback_id,
    user_id,
    user_email: userEmail ?? null,
    type,
    title,
    body,
    app_version: app_version ?? null,
    update_id: update_id ?? null,
    created_at: created_at ?? new Date().toISOString(),
    environment: NOTIFY_ENVIRONMENT,
  });

  try {
    const { signature, timestamp } = await signRouterPayload(routerBody);
    const res = await fetch(ROUTER_FEEDBACK_NOTIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-foliolens-signature': signature,
        'x-foliolens-timestamp': String(timestamp),
      },
      body: routerBody,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(
        '[notify-feedback] router non-2xx feedback_id=%s status=%d body=%s',
        feedback_id,
        res.status,
        errText.slice(0, 400),
      );
      return json({ ok: false, error: `Router ${res.status}` }, { status: 200 });
    }

    console.log('[notify-feedback] forwarded feedback_id=%s', feedback_id);
    return json({ ok: true });
  } catch (err) {
    console.warn(
      '[notify-feedback] forward failed feedback_id=%s err=%s',
      feedback_id,
      err,
    );
    return json({ ok: false, error: 'Forward threw' }, { status: 200 });
  }
});
