import { useState } from 'react';
import { functionsClient } from '@/src/lib/functions';
import { analytics } from '@/src/lib/analytics';
import type { EntryAttribution } from '@/src/utils/entryAttribution';

export interface DemoSignupInput {
  email: string;
  marketing_consent: boolean;
  attribution: EntryAttribution;
}

export interface DemoSignupResult {
  ok: true;
  isReturning: boolean;
}

interface DemoSignupResponse {
  ok: boolean;
  isReturning?: boolean;
  error?: string;
}

/**
 * Submits the in-app preview-gate form to the `demo-signup` edge
 * function and emits the appropriate PostHog funnel events.
 *
 * Exported as a plain async (separate from the hook below) so unit
 * tests can exercise the full flow without standing up React state.
 *
 * On success, identifies the user in PostHog with their email so all
 * subsequent demo-session events are attributed to them. If they
 * later sign up properly the auth-state listener re-identifies them
 * by Supabase user id; PostHog can be configured to alias the two.
 */
/**
 * Pulls a user-friendly message out of a `supabase.functions.invoke`
 * error. The wrapper's `.message` is dev-vocabulary; the real
 * server-rendered error (set by `normaliseDemoSignup` or the function
 * body) sits on `(error as any).context`, which is the original
 * `Response`. Returns null when no useful body is present so the caller
 * can fall through to a generic "couldn't reach the server" line.
 */
async function extractServerErrorMessage(error: unknown): Promise<string | null> {
  const ctx = (error as { context?: unknown })?.context;
  if (!ctx || typeof (ctx as Response).json !== 'function') return null;
  try {
    const body = await (ctx as Response).json();
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
      return (body as { error: string }).error;
    }
  } catch {
    // Body wasn't JSON or stream is gone — give up; caller will use
    // the fallback message.
  }
  return null;
}

export async function submitDemoSignup(input: DemoSignupInput): Promise<DemoSignupResult> {
  const trimmedEmail = input.email.trim().toLowerCase();

  analytics.track('demo_signup_submitted', {
    marketing_consent: input.marketing_consent,
    has_utm_source: input.attribution.utm_source != null,
    utm_source: input.attribution.utm_source,
  });

  const res = await functionsClient.invoke<DemoSignupResponse>('demo-signup', {
    body: {
      email: trimmedEmail,
      marketing_consent: input.marketing_consent,
      utm_source: input.attribution.utm_source,
      utm_medium: input.attribution.utm_medium,
      utm_campaign: input.attribution.utm_campaign,
      utm_content: input.attribution.utm_content,
      utm_term: input.attribution.utm_term,
      page_url: input.attribution.page_url,
      referrer: input.attribution.referrer,
    },
  });

  if (res.error) {
    // Prefer the server's user-facing message (e.g. "Enter a valid email
    // address" from normaliseDemoSignup) over the supabase-js wrapper text
    // ("Failed to send a request to the Edge Function") which leaks
    // dev-tooling vocabulary into the UI. The wrapper attaches the original
    // Response on `.context`; if that body parses to JSON with a string
    // `error` field, surface that; otherwise fall back to a plain network-
    // failure line.
    const friendly = (await extractServerErrorMessage(res.error))
      ?? "Couldn't reach the server. Check your connection and try again.";
    analytics.track('demo_signup_failed', {
      reason: friendly.slice(0, 200),
      raw: (res.error.message ?? '').slice(0, 200),
    });
    throw new Error(friendly);
  }

  const data = res.data;
  if (!data?.ok) {
    const msg = data?.error ?? "Something went wrong. Please try again in a moment.";
    analytics.track('demo_signup_failed', { reason: msg.slice(0, 200) });
    throw new Error(msg);
  }

  analytics.identify(trimmedEmail, {
    email: trimmedEmail,
    marketing_consent: input.marketing_consent,
    demo_signup: true,
  });
  analytics.track('demo_signup_succeeded', {
    is_returning: !!data.isReturning,
    marketing_consent: input.marketing_consent,
  });

  return { ok: true, isReturning: !!data.isReturning };
}

/**
 * Thin stateful wrapper around `submitDemoSignup` for the
 * `DemoSignupSheet` UI. The submit returns `null` on error and the
 * caller reads `error` from state rather than catching, so the JSX
 * stays free of try/catch.
 */
export function useDemoSignup() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(input: DemoSignupInput): Promise<DemoSignupResult | null> {
    setIsSubmitting(true);
    setError(null);
    try {
      return await submitDemoSignup(input);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again in a moment.",
      );
      return null;
    } finally {
      setIsSubmitting(false);
    }
  }

  return { submit, isSubmitting, error, resetError: () => setError(null) };
}
