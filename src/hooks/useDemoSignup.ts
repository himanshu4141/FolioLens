import { useState } from 'react';
import { supabase } from '@/src/lib/supabase';
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
export async function submitDemoSignup(input: DemoSignupInput): Promise<DemoSignupResult> {
  const trimmedEmail = input.email.trim().toLowerCase();

  analytics.track('demo_signup_submitted', {
    marketing_consent: input.marketing_consent,
    has_utm_source: input.attribution.utm_source != null,
    utm_source: input.attribution.utm_source,
  });

  const res = await supabase.functions.invoke<DemoSignupResponse>('demo-signup', {
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
    const msg = res.error.message || 'Could not sign up. Please try again.';
    analytics.track('demo_signup_failed', { reason: msg.slice(0, 200) });
    throw new Error(msg);
  }

  const data = res.data;
  if (!data?.ok) {
    const msg = data?.error || 'Could not sign up. Please try again.';
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
      setError(err instanceof Error ? err.message : 'Could not sign up. Please try again.');
      return null;
    } finally {
      setIsSubmitting(false);
    }
  }

  return { submit, isSubmitting, error, resetError: () => setError(null) };
}
