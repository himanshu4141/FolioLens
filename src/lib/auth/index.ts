/**
 * The one place in the app that imports `supabase.auth` directly.
 *
 * Every other module reaches the auth provider through `authClient`,
 * `isAuthError`, and the re-exported types below. Today this layer is a
 * thin pass-through to supabase-js; if we ever swap auth providers
 * (Clerk, WorkOS, Better Auth, custom JWT...), this file is the only one
 * whose implementation changes — callers keep the same surface.
 *
 * Methods are enumerated rather than re-exporting `supabase.auth` whole
 * so the supported surface area is explicit. Adding a new auth method
 * (e.g. MFA enrollment) goes through this file first.
 *
 * Implementation note: methods resolve lazily via a Proxy. Binding
 * eagerly at module load would crash `jest.mock('@/src/lib/supabase')`
 * tests whose mock only stubs the methods they exercise — they'd hit
 * `auth.X.bind()` on an undefined `X` during import. Lazy resolution
 * also preserves overloaded signatures (e.g. `linkIdentity`) that the
 * spread-args pattern doesn't.
 *
 * See `docs/EXIT-RUNBOOK.md` for the broader exit-readiness posture.
 */
import { isAuthError } from '@supabase/supabase-js';
import type {
  AuthChangeEvent,
  AuthError,
  AuthOtpResponse,
  AuthResponse,
  AuthTokenResponsePassword,
  OAuthResponse,
  Session,
  SignInWithIdTokenCredentials,
  SignInWithOAuthCredentials,
  SignInWithPasswordCredentials,
  SignInWithPasswordlessCredentials,
  Subscription,
  User,
  UserResponse,
} from '@supabase/supabase-js';

import { supabase } from '@/src/lib/supabase';

type Auth = typeof supabase.auth;

const SUPPORTED_METHODS = [
  'getSession',
  'getUser',
  'onAuthStateChange',
  'signInWithOtp',
  'signInWithOAuth',
  'signInWithPassword',
  'signOut',
  'setSession',
  'exchangeCodeForSession',
  'linkIdentity',
] as const;

type SupportedMethod = (typeof SUPPORTED_METHODS)[number];

export const authClient = new Proxy({} as Pick<Auth, SupportedMethod>, {
  get(_target, prop) {
    if (typeof prop !== 'string' || !SUPPORTED_METHODS.includes(prop as SupportedMethod)) {
      return undefined;
    }
    const method = (supabase.auth as unknown as Record<string, unknown>)[prop];
    if (typeof method !== 'function') return method;
    return (method as (...args: unknown[]) => unknown).bind(supabase.auth);
  },
});

export { isAuthError };

export type {
  AuthChangeEvent,
  AuthError,
  AuthOtpResponse,
  AuthResponse,
  AuthTokenResponsePassword,
  OAuthResponse,
  Session,
  SignInWithIdTokenCredentials,
  SignInWithOAuthCredentials,
  SignInWithPasswordCredentials,
  SignInWithPasswordlessCredentials,
  Subscription,
  User,
  UserResponse,
};
