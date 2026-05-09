import { sanitizeProperties, sanitizeUrl } from '../analyticsSanitize';

describe('sanitizeUrl', () => {
  it('strips a Supabase magic-link hash entirely', () => {
    const before =
      'https://foliolens-dev.vercel.app/auth/confirm#access_token=eyJhbGciOiJFUzI1NiJ9.payload.sig&refresh_token=rt&token_type=bearer';
    const after = sanitizeUrl(before);
    expect(after).toBe('https://foliolens-dev.vercel.app/auth/confirm');
    expect(after).not.toContain('access_token');
    expect(after).not.toContain('refresh_token');
    expect(after).not.toContain('eyJhbGciOiJFUzI1NiJ9');
  });

  it('redacts OAuth code and state in query string but keeps shape', () => {
    const before = 'https://foliolens-dev.vercel.app/auth/callback?code=abc123&state=xyz&utm_source=email';
    const after = sanitizeUrl(before);
    expect(after).toContain('code=%3Credacted%3E');
    expect(after).toContain('state=%3Credacted%3E');
    expect(after).toContain('utm_source=email');
    expect(after).not.toContain('abc123');
    expect(after).not.toContain('xyz');
  });

  it('preserves harmless URLs unchanged', () => {
    const url = 'https://foliolens-dev.vercel.app/portfolio-insights?utm_source=newsletter';
    expect(sanitizeUrl(url)).toBe(url);
  });

  it('strips hash even when the URL is a relative pathname', () => {
    expect(sanitizeUrl('/auth/confirm#access_token=ey.payload.sig')).toBe('/auth/confirm');
  });

  it('redacts sensitive params in a relative-pathname query', () => {
    expect(sanitizeUrl('/auth/callback?code=abc&utm_campaign=launch')).toBe(
      '/auth/callback?code=%3Credacted%3E&utm_campaign=launch',
    );
  });

  it('returns the input unchanged for a value with no hash and no sensitive query', () => {
    expect(sanitizeUrl('/funds')).toBe('/funds');
  });
});

describe('sanitizeProperties', () => {
  it('rewrites $current_url and $referrer when sensitive', () => {
    const out = sanitizeProperties({
      $current_url: 'https://foliolens-dev.vercel.app/auth/confirm#access_token=ey.x.y',
      $referrer: 'https://foliolens-dev.vercel.app/auth?code=abc',
      surface: 'home',
    });
    expect(out).toEqual({
      $current_url: 'https://foliolens-dev.vercel.app/auth/confirm',
      $referrer: 'https://foliolens-dev.vercel.app/auth?code=%3Credacted%3E',
      surface: 'home',
    });
  });

  it('leaves non-URL properties alone', () => {
    const props = { surface: 'home', fund_count: 12, complicated: { nested: 'thing' } };
    expect(sanitizeProperties(props)).toBe(props);
  });

  it('returns the same object reference when nothing was mutated', () => {
    const props = { $current_url: '/funds', surface: 'funds' };
    expect(sanitizeProperties(props)).toBe(props);
  });

  it('handles undefined gracefully', () => {
    expect(sanitizeProperties(undefined)).toBeUndefined();
  });

  it('does not touch a $current_url that is not a string', () => {
    const props = { $current_url: 42 as unknown as string, foo: 'bar' };
    expect(sanitizeProperties(props)).toBe(props);
  });
});
