/**
 * demo-signup — public endpoint behind the in-app "Preview the app" gate.
 *
 * The auth screen POSTs an email + marketing-consent + UTM/referrer
 * attribution here BEFORE flipping the local `previewMode` flag. We
 * record the signup in `public.demo_signup`, treating a re-submit from
 * the same email as idempotent (no error, just bump `signup_count` and
 * `last_seen_at` and optionally upgrade `marketing_consent`).
 *
 * Deployed `--no-verify-jwt` because the caller has no auth token yet —
 * they're on the sign-in page deciding whether to commit. The function
 * uses the service role key to bypass RLS on this single insert path.
 *
 * Env vars: standard SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (already
 * present in every project). No new secrets required.
 */

import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';
import {
  ValidationError,
  extractClientIp,
  normaliseDemoSignup,
  type RawDemoSignupPayload,
} from '../_shared/demo-signup-validation.ts';

Deno.serve(async (req) => {
  console.log('[demo-signup] invoked, method=%s', req.method);

  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  let raw: RawDemoSignupPayload;
  try {
    raw = (await req.json()) as RawDemoSignupPayload;
  } catch (err) {
    console.warn('[demo-signup] invalid JSON: %s', err);
    return json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  let payload;
  try {
    payload = normaliseDemoSignup(raw);
  } catch (err) {
    if (err instanceof ValidationError) {
      console.warn('[demo-signup] validation failed: %s', err.message);
      return json({ ok: false, error: err.message }, { status: err.status });
    }
    console.warn('[demo-signup] unexpected normalisation error: %s', err);
    return json({ ok: false, error: 'Invalid payload' }, { status: 400 });
  }

  console.log(
    '[demo-signup] payload_loaded email_domain=%s consent=%s utm_source=%s',
    payload.email.split('@')[1] ?? '',
    payload.marketing_consent,
    payload.utm_source ?? '-',
  );

  const ip_address = extractClientIp(req.headers);
  const user_agent = req.headers.get('user-agent')?.slice(0, 1024) ?? null;

  const supabase = createServiceClient();

  // Idempotent: look up existing row first, then either INSERT or UPDATE.
  // Doing this in two queries (vs. a Postgres ON CONFLICT upsert) keeps
  // the JSON path simpler and lets us return `isReturning` honestly.
  const { data: existing, error: lookupError } = await supabase
    .from('demo_signup')
    .select('id, signup_count, marketing_consent')
    .eq('email', payload.email)
    .maybeSingle();

  if (lookupError) {
    console.warn('[demo-signup] lookup failed: %s', lookupError.message);
    return json({ ok: false, error: 'Database error' }, { status: 500 });
  }

  if (existing) {
    // Returning user. Bump the counter, refresh last_seen, only upgrade
    // marketing_consent (never silently revoke it — they have to actively
    // ask via a different flow to opt out).
    const nextConsent = existing.marketing_consent || payload.marketing_consent;
    const { error: updateError } = await supabase
      .from('demo_signup')
      .update({
        signup_count: (existing.signup_count ?? 1) + 1,
        last_seen_at: new Date().toISOString(),
        marketing_consent: nextConsent,
        ip_address,
        user_agent,
        utm_source: payload.utm_source,
        utm_medium: payload.utm_medium,
        utm_campaign: payload.utm_campaign,
        utm_content: payload.utm_content,
        utm_term: payload.utm_term,
        page_url: payload.page_url,
        referrer: payload.referrer,
      })
      .eq('id', existing.id);

    if (updateError) {
      console.warn('[demo-signup] update failed id=%s: %s', existing.id, updateError.message);
      return json({ ok: false, error: 'Database error' }, { status: 500 });
    }
    console.log('[demo-signup] returning_user id=%s', existing.id);
    return json({ ok: true, isReturning: true });
  }

  const { data: inserted, error: insertError } = await supabase
    .from('demo_signup')
    .insert({
      email: payload.email,
      marketing_consent: payload.marketing_consent,
      source: 'app_preview',
      utm_source: payload.utm_source,
      utm_medium: payload.utm_medium,
      utm_campaign: payload.utm_campaign,
      utm_content: payload.utm_content,
      utm_term: payload.utm_term,
      page_url: payload.page_url,
      referrer: payload.referrer,
      ip_address,
      user_agent,
    })
    .select('id')
    .single();

  if (insertError) {
    console.warn('[demo-signup] insert failed: %s', insertError.message);
    return json({ ok: false, error: 'Database error' }, { status: 500 });
  }

  console.log('[demo-signup] new_signup id=%s', inserted?.id);
  return json({ ok: true, isReturning: false });
});
