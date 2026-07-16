import Constants from 'expo-constants';

/**
 * Helpers for the per-user CAS inbox address.
 *
 * Each user has an opaque `cas_inbox_token` stored on `user_profile`.
 * Their forwarding address is:
 *
 *   - dev / preview: `cas-dev-<token>@foliolens.in`
 *   - prod:          `cas-<token>@foliolens.in`
 *
 * Resolved from `EXPO_PUBLIC_INBOUND_DOMAIN`, falling back to
 * `foliolens.in` so a missing env var keeps prod working.
 *
 * A production Vercel router catches all Resend inbound mail and dispatches
 * CAS emails to dev or prod by local-part. These helpers are shared between
 * the client (Settings + onboarding UI) and the unit tests; the Edge Function
 * reproduces the same parsing inline because Deno cannot import from `src/`.
 */

// Alphabet matches the SQL generator: A–Z minus I, L, O; 2–9.
const TOKEN_REGEX = /^[A-HJKMNP-Z2-9]{8}$/;
const DEFAULT_INBOX_DOMAIN = 'foliolens.in';
const DEV_SUPABASE_PROJECT_REF = 'imkgazlrxtlhkfptkzjc';
const PROD_SUPABASE_PROJECT_REF = 'ohcaaioabjvzewfysqgh';

export type InboxEnvironment = 'dev' | 'prod';

export function getInboxDomain(): string {
  const fromEnv = process.env.EXPO_PUBLIC_INBOUND_DOMAIN;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_INBOX_DOMAIN;
}

export function getInboxEnvironment(): InboxEnvironment {
  const explicit = process.env.EXPO_PUBLIC_INBOUND_ENV;
  if (explicit === 'dev' || explicit === 'prod') return explicit;

  const variant = Constants.expoConfig?.extra?.appVariant;
  if (variant === 'production') return 'prod';
  if (variant) return 'dev';

  const appBaseUrl = process.env.EXPO_PUBLIC_APP_BASE_URL ?? '';
  if (appBaseUrl) return appBaseUrl.includes('app.foliolens.in') ? 'prod' : 'dev';

  // Last-resort fallback, only reachable when none of the signals above
  // are present. Once the backend base is a foliolens.in proxy host
  // (api.foliolens.in / api-dev.foliolens.in) neither project ref
  // substring ever appears here, so this is a legacy safety net, not a
  // signal either environment should rely on going forward.
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  if (supabaseUrl.includes(DEV_SUPABASE_PROJECT_REF)) return 'dev';
  if (supabaseUrl.includes(PROD_SUPABASE_PROJECT_REF)) return 'prod';

  return 'prod';
}

/**
 * Build the user-facing address from a token.
 *
 * Throws on invalid token shape so a UI can never show a malformed address.
 */
export function formatInboxAddress(token: string): string {
  if (!isValidInboxToken(token)) {
    throw new Error(`Invalid inbox token: ${JSON.stringify(token)}`);
  }
  const prefix = getInboxEnvironment() === 'dev' ? 'cas-dev' : 'cas';
  return `${prefix}-${token}@${getInboxDomain()}`;
}

/**
 * Extract the inbox token from a raw `to` header value.
 *
 * Handles all common forms a mail client may send:
 *   - "cas-ABC23456@foliolens.in"
 *   - "cas-dev-ABC23456@foliolens.in"
 *   - "<cas-ABC23456@foliolens.in>"
 *   - "FolioLens <cas-dev-ABC23456@foliolens.in>"
 *   - "cas-abc23456@foliolens.in"           (case-insensitive)
 *   - "cas-dev-ABC23456@foliolens.in, foo@bar"  (multi-recipient — first match wins)
 *
 * The host is taken from the env-resolved inbound domain.
 *
 * Returns the token (uppercased to canonical form) or null if not found.
 */
export function parseInboxToken(toHeader: string | null | undefined): string | null {
  if (!toHeader) return null;
  const re = new RegExp(`cas(?:-dev)?-([A-Za-z0-9]+)@${escapeRegex(getInboxDomain())}`, 'i');
  const match = re.exec(toHeader);
  if (!match) return null;
  const candidate = match[1].toUpperCase();
  return isValidInboxToken(candidate) ? candidate : null;
}

export function isValidInboxToken(token: string): boolean {
  return typeof token === 'string' && TOKEN_REGEX.test(token);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
