/**
 * Pure helpers for the demo-signup edge function — normalisation, validation,
 * payload shaping. Extracted so they can be tested without the Deno runtime.
 */

export interface RawDemoSignupPayload {
  email?: unknown;
  marketing_consent?: unknown;
  utm_source?: unknown;
  utm_medium?: unknown;
  utm_campaign?: unknown;
  utm_content?: unknown;
  utm_term?: unknown;
  page_url?: unknown;
  referrer?: unknown;
}

export interface NormalisedDemoSignup {
  email: string;
  marketing_consent: boolean;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  page_url: string | null;
  referrer: string | null;
}

/**
 * Same regex the DB CHECK constraint enforces. Doing it client-side too
 * avoids a round-trip + a CHECK violation when someone fat-fingers the
 * field. Case-insensitive — the constraint normalises with `~*`.
 */
const EMAIL_REGEX = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

const STRING_FIELD_MAX_LEN = 512;
const URL_FIELD_MAX_LEN = 2048;

function trimmedString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

export function isValidEmail(value: string): boolean {
  if (value.length > 254) return false; // RFC 5321 sanity cap
  return EMAIL_REGEX.test(value);
}

export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Coerce + validate the payload posted by the in-app sheet. Throws
 * `ValidationError` on bad input — the caller turns that into a 400.
 *
 * Email is lowercased so duplicate detection in the table works
 * case-insensitively (the table also has a `lower(email)` index).
 */
export function normaliseDemoSignup(input: RawDemoSignupPayload | null | undefined): NormalisedDemoSignup {
  if (!input || typeof input !== 'object') {
    throw new ValidationError('Missing payload');
  }

  const rawEmail = trimmedString(input.email, STRING_FIELD_MAX_LEN);
  if (!rawEmail) throw new ValidationError('Email is required');
  const email = rawEmail.toLowerCase();
  if (!isValidEmail(email)) throw new ValidationError('Enter a valid email address');

  const marketing_consent = input.marketing_consent === true;

  return {
    email,
    marketing_consent,
    utm_source: trimmedString(input.utm_source, STRING_FIELD_MAX_LEN),
    utm_medium: trimmedString(input.utm_medium, STRING_FIELD_MAX_LEN),
    utm_campaign: trimmedString(input.utm_campaign, STRING_FIELD_MAX_LEN),
    utm_content: trimmedString(input.utm_content, STRING_FIELD_MAX_LEN),
    utm_term: trimmedString(input.utm_term, STRING_FIELD_MAX_LEN),
    page_url: trimmedString(input.page_url, URL_FIELD_MAX_LEN),
    referrer: trimmedString(input.referrer, URL_FIELD_MAX_LEN),
  };
}

/**
 * Best-effort client IP extraction from common reverse-proxy headers.
 * Supabase Edge Functions sit behind their own ingress; `x-forwarded-for`
 * is the canonical source. Returns null if no recognisable header is
 * present rather than guessing.
 */
export function extractClientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    // X-Forwarded-For may be a comma-separated chain — the first entry
    // is the original client, the rest are proxies.
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const realIp = headers.get('x-real-ip');
  if (realIp) return realIp.trim().slice(0, 64);
  return null;
}
