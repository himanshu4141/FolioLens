import {
  ValidationError,
  extractClientIp,
  isValidEmail,
  normaliseDemoSignup,
} from '../demo-signup-validation';

describe('isValidEmail', () => {
  it.each([
    'user@example.com',
    'User.Name+tag@Example.co.in',
    'a@b.cd',
    'first.last-name@sub.domain.example',
  ])('accepts %s', (email) => {
    expect(isValidEmail(email)).toBe(true);
  });

  it.each([
    '',
    'not-an-email',
    'missing@tld',
    'spaces in@example.com',
    '@example.com',
    'user@',
    'user@.com',
    'user@example.c', // TLD must be ≥ 2 chars
  ])('rejects %s', (email) => {
    expect(isValidEmail(email)).toBe(false);
  });

  it('rejects emails longer than 254 characters', () => {
    const local = 'a'.repeat(250);
    const long = `${local}@example.com`;
    expect(long.length).toBeGreaterThan(254);
    expect(isValidEmail(long)).toBe(false);
  });
});

describe('normaliseDemoSignup', () => {
  it('lowercases the email and accepts a minimal payload', () => {
    const result = normaliseDemoSignup({ email: 'Foo@Example.COM' });
    expect(result.email).toBe('foo@example.com');
    expect(result.marketing_consent).toBe(false);
    expect(result.utm_source).toBeNull();
    expect(result.page_url).toBeNull();
  });

  it('returns marketing_consent=true only when the field is literally true', () => {
    expect(normaliseDemoSignup({ email: 'a@b.co', marketing_consent: true }).marketing_consent).toBe(true);
    expect(normaliseDemoSignup({ email: 'a@b.co', marketing_consent: 'yes' }).marketing_consent).toBe(false);
    expect(normaliseDemoSignup({ email: 'a@b.co', marketing_consent: 1 }).marketing_consent).toBe(false);
    expect(normaliseDemoSignup({ email: 'a@b.co', marketing_consent: undefined }).marketing_consent).toBe(false);
  });

  it('passes through trimmed UTM and attribution fields', () => {
    const result = normaliseDemoSignup({
      email: 'a@b.co',
      utm_source: '  twitter  ',
      utm_medium: 'social',
      utm_campaign: 'launch',
      utm_content: 'hero-cta',
      utm_term: 'india mutual funds',
      page_url: 'https://app.foliolens.in/auth',
      referrer: 'https://foliolens.in/',
    });
    expect(result.utm_source).toBe('twitter');
    expect(result.utm_medium).toBe('social');
    expect(result.utm_campaign).toBe('launch');
    expect(result.utm_content).toBe('hero-cta');
    expect(result.utm_term).toBe('india mutual funds');
    expect(result.page_url).toBe('https://app.foliolens.in/auth');
    expect(result.referrer).toBe('https://foliolens.in/');
  });

  it('coerces empty-string optional fields to null', () => {
    const result = normaliseDemoSignup({ email: 'a@b.co', utm_source: '', referrer: '   ' });
    expect(result.utm_source).toBeNull();
    expect(result.referrer).toBeNull();
  });

  it('coerces non-string optional fields to null instead of throwing', () => {
    const result = normaliseDemoSignup({
      email: 'a@b.co',
      utm_source: 42 as unknown as string,
      page_url: { malicious: 'object' } as unknown as string,
    });
    expect(result.utm_source).toBeNull();
    expect(result.page_url).toBeNull();
  });

  it('truncates overly long generic strings to 512 chars', () => {
    const long = 'x'.repeat(600);
    const result = normaliseDemoSignup({ email: 'a@b.co', utm_source: long });
    expect(result.utm_source).toHaveLength(512);
  });

  it('truncates overly long URL fields to 2048 chars', () => {
    const long = `https://example.com/?p=${'q'.repeat(3000)}`;
    const result = normaliseDemoSignup({ email: 'a@b.co', page_url: long });
    expect(result.page_url).toHaveLength(2048);
  });

  it('throws ValidationError when input is null', () => {
    expect(() => normaliseDemoSignup(null)).toThrow(ValidationError);
  });

  it('throws ValidationError when input is not an object', () => {
    expect(() => normaliseDemoSignup('hello' as unknown as null)).toThrow(ValidationError);
  });

  it('throws ValidationError when email is missing', () => {
    expect(() => normaliseDemoSignup({})).toThrow(/Email is required/);
  });

  it('throws ValidationError when email is whitespace-only', () => {
    expect(() => normaliseDemoSignup({ email: '   ' })).toThrow(/Email is required/);
  });

  it('throws ValidationError when email is malformed', () => {
    expect(() => normaliseDemoSignup({ email: 'not-an-email' })).toThrow(/valid email/);
  });

  it('attaches 400 status to ValidationError instances', () => {
    try {
      normaliseDemoSignup({ email: 'bad' });
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).status).toBe(400);
    }
  });
});

describe('extractClientIp', () => {
  it('returns the first hop from x-forwarded-for', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1, 10.0.0.2' });
    expect(extractClientIp(headers)).toBe('203.0.113.5');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const headers = new Headers({ 'x-real-ip': '203.0.113.7' });
    expect(extractClientIp(headers)).toBe('203.0.113.7');
  });

  it('returns null when neither header is present', () => {
    expect(extractClientIp(new Headers())).toBeNull();
  });

  it('returns null when x-forwarded-for is empty / whitespace', () => {
    expect(extractClientIp(new Headers({ 'x-forwarded-for': '' }))).toBeNull();
    expect(extractClientIp(new Headers({ 'x-forwarded-for': '   ' }))).toBeNull();
  });

  it('truncates very long IP-ish values defensively', () => {
    const headers = new Headers({ 'x-forwarded-for': 'x'.repeat(200) });
    const result = extractClientIp(headers);
    expect(result?.length).toBe(64);
  });
});
