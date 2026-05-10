/**
 * Detects whether an error thrown by a Supabase call (auth, postgrest, or
 * an edge function invoke) means the user's session is no longer valid.
 *
 * Drives the global query / mutation handler in `queryClient.ts`: if any
 * query rejects with one of these shapes, we sign the user out and let
 * `AuthGate` redirect to /auth. Without this, a revoked Google token or
 * an expired JWT leaves the user staring at error toasts forever.
 *
 * Three shapes count:
 *
 *  1. Supabase Auth errors with HTTP status 401 / 403 — e.g. AuthApiError
 *     'invalid_grant' returned when the OAuth refresh token has been
 *     revoked from the user's Google account, or 'session_not_found'.
 *  2. PostgREST errors thrown when the JWT has expired — code 'PGRST301'
 *     (JWT expired) or 'PGRST302' (Anonymous Role Disallowed). These come
 *     back when a logged-in client makes a query after refresh failure.
 *  3. Plain Error objects whose message names a 401 explicitly (a thin
 *     fallback for edge-function invokes that surface the status as a
 *     stringified error).
 */

import { isAuthError as isSupabaseAuthError } from '@supabase/supabase-js';

const POSTGREST_AUTH_CODES = new Set(['PGRST301', 'PGRST302']);

interface ErrorWithStatus {
  status?: unknown;
}

interface ErrorWithCode {
  code?: unknown;
}

function getStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as ErrorWithStatus).status;
  return typeof status === 'number' ? status : undefined;
}

function getCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as ErrorWithCode).code;
  return typeof code === 'string' ? code : undefined;
}

export function isAuthSessionInvalidError(err: unknown): boolean {
  if (err == null) return false;

  // 1. Supabase Auth library error class
  if (isSupabaseAuthError(err)) {
    const status = getStatus(err);
    return status === 401 || status === 403;
  }

  // 2. PostgREST JWT-expired / role-disallowed error shape
  const code = getCode(err);
  if (code && POSTGREST_AUTH_CODES.has(code)) return true;

  // 3. Generic 401 surfaces (edge-function invoke errors etc.)
  const status = getStatus(err);
  if (status === 401) return true;

  // 4. String fallback — last resort. Some non-Supabase fetch wrappers
  //    surface only the message. Match conservatively.
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('jwt expired') || msg.includes('jwt is expired')) return true;
    if (msg.includes('invalid_grant')) return true;
  }

  return false;
}
