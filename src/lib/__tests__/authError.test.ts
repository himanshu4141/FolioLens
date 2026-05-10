import { isAuthSessionInvalidError } from '../authError';
import { AuthApiError, AuthError } from '@supabase/supabase-js';

describe('isAuthSessionInvalidError', () => {
  it('returns false for null / undefined', () => {
    expect(isAuthSessionInvalidError(null)).toBe(false);
    expect(isAuthSessionInvalidError(undefined)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isAuthSessionInvalidError(401)).toBe(false);
    expect(isAuthSessionInvalidError('JWT expired')).toBe(false);
    expect(isAuthSessionInvalidError(true)).toBe(false);
  });

  it('returns true for AuthApiError with status 401', () => {
    const err = new AuthApiError('invalid_grant', 401, 'invalid_grant');
    expect(isAuthSessionInvalidError(err)).toBe(true);
  });

  it('returns true for AuthApiError with status 403', () => {
    const err = new AuthApiError('forbidden', 403, 'forbidden');
    expect(isAuthSessionInvalidError(err)).toBe(true);
  });

  it('returns false for AuthApiError with status 400 (validation error)', () => {
    const err = new AuthApiError('bad input', 400, 'invalid_input');
    expect(isAuthSessionInvalidError(err)).toBe(false);
  });

  it('returns true for the base AuthError class with status 401', () => {
    const err = new AuthError('some other auth library error', 401);
    expect(isAuthSessionInvalidError(err)).toBe(true);
  });

  it('returns true for PostgREST JWT-expired error code (PGRST301)', () => {
    const err = { code: 'PGRST301', message: 'JWT expired', details: null, hint: null };
    expect(isAuthSessionInvalidError(err)).toBe(true);
  });

  it('returns true for PostgREST anonymous-role-disallowed error code (PGRST302)', () => {
    const err = { code: 'PGRST302', message: 'Anonymous role disallowed' };
    expect(isAuthSessionInvalidError(err)).toBe(true);
  });

  it('returns false for unrelated PostgREST errors (e.g. unique violation)', () => {
    const err = { code: '23505', message: 'duplicate key value violates unique constraint' };
    expect(isAuthSessionInvalidError(err)).toBe(false);
  });

  it('returns true for generic plain object with status 401 (edge function invoke)', () => {
    const err = { status: 401, message: 'Unauthorized' };
    expect(isAuthSessionInvalidError(err)).toBe(true);
  });

  it('returns false for generic plain object with status 500', () => {
    const err = { status: 500, message: 'Server error' };
    expect(isAuthSessionInvalidError(err)).toBe(false);
  });

  it('returns true for an Error instance whose message names "JWT expired"', () => {
    expect(isAuthSessionInvalidError(new Error('JWT expired'))).toBe(true);
    expect(isAuthSessionInvalidError(new Error('jwt is expired and useless'))).toBe(true);
  });

  it('returns true for an Error instance whose message contains "invalid_grant"', () => {
    expect(isAuthSessionInvalidError(new Error('invalid_grant from upstream'))).toBe(true);
  });

  it('returns false for unrelated Error messages', () => {
    expect(isAuthSessionInvalidError(new Error('Network request failed'))).toBe(false);
    expect(isAuthSessionInvalidError(new Error('Database timeout'))).toBe(false);
  });

  it('handles non-string status / code gracefully', () => {
    expect(isAuthSessionInvalidError({ status: '401' })).toBe(false);
    expect(isAuthSessionInvalidError({ code: 401 })).toBe(false);
  });
});
