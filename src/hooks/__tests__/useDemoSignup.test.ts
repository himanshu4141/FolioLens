jest.mock('@/src/lib/supabase', () => ({
  supabase: { functions: { invoke: jest.fn() } },
}));

jest.mock('@/src/lib/analytics', () => ({
  analytics: { track: jest.fn(), identify: jest.fn() },
}));

// eslint-disable-next-line import/first -- mocks must register before module imports
import { submitDemoSignup } from '../useDemoSignup';
// eslint-disable-next-line import/first
import { supabase } from '@/src/lib/supabase';
// eslint-disable-next-line import/first
import { analytics } from '@/src/lib/analytics';
// eslint-disable-next-line import/first
import { EMPTY_ATTRIBUTION } from '@/src/utils/entryAttribution';

const mockedInvoke = supabase.functions.invoke as jest.MockedFunction<typeof supabase.functions.invoke>;
const mockedTrack = analytics.track as jest.MockedFunction<typeof analytics.track>;
const mockedIdentify = analytics.identify as jest.MockedFunction<typeof analytics.identify>;

const BASE_INPUT = {
  email: 'User@Example.COM',
  marketing_consent: false,
  attribution: { ...EMPTY_ATTRIBUTION, utm_source: 'twitter' },
};

describe('submitDemoSignup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lowercases the email, POSTs the full payload, identifies in PostHog, and resolves with the response', async () => {
    mockedInvoke.mockResolvedValue({
      data: { ok: true, isReturning: false },
      error: null,
    } as Awaited<ReturnType<typeof supabase.functions.invoke>>);

    const result = await submitDemoSignup(BASE_INPUT);

    expect(result).toEqual({ ok: true, isReturning: false });
    expect(mockedInvoke).toHaveBeenCalledWith('demo-signup', {
      body: expect.objectContaining({
        email: 'user@example.com',
        marketing_consent: false,
        utm_source: 'twitter',
      }),
    });
    expect(mockedIdentify).toHaveBeenCalledWith(
      'user@example.com',
      expect.objectContaining({ email: 'user@example.com', demo_signup: true, marketing_consent: false }),
    );
  });

  it('emits demo_signup_submitted before invoke and demo_signup_succeeded after success', async () => {
    mockedInvoke.mockResolvedValue({
      data: { ok: true, isReturning: true },
      error: null,
    } as Awaited<ReturnType<typeof supabase.functions.invoke>>);

    await submitDemoSignup({ ...BASE_INPUT, marketing_consent: true });

    const events = mockedTrack.mock.calls.map((c) => c[0]);
    expect(events).toEqual(['demo_signup_submitted', 'demo_signup_succeeded']);
    expect(mockedTrack).toHaveBeenLastCalledWith('demo_signup_succeeded', {
      is_returning: true,
      marketing_consent: true,
    });
  });

  it('throws and emits demo_signup_failed when the function returns an error envelope', async () => {
    mockedInvoke.mockResolvedValue({
      data: null,
      error: { message: 'Server exploded' },
    } as Awaited<ReturnType<typeof supabase.functions.invoke>>);

    await expect(submitDemoSignup(BASE_INPUT)).rejects.toThrow('Server exploded');

    expect(mockedTrack).toHaveBeenCalledWith(
      'demo_signup_failed',
      expect.objectContaining({ reason: 'Server exploded' }),
    );
    expect(mockedIdentify).not.toHaveBeenCalled();
  });

  it('throws and emits demo_signup_failed when ok=false in the body', async () => {
    mockedInvoke.mockResolvedValue({
      data: { ok: false, error: 'Enter a valid email address' },
      error: null,
    } as Awaited<ReturnType<typeof supabase.functions.invoke>>);

    await expect(submitDemoSignup(BASE_INPUT)).rejects.toThrow(/valid email/);

    expect(mockedTrack).toHaveBeenLastCalledWith(
      'demo_signup_failed',
      expect.objectContaining({ reason: expect.stringContaining('valid email') }),
    );
  });

  it('falls back to a generic error message when the body is empty', async () => {
    mockedInvoke.mockResolvedValue({ data: null, error: null } as Awaited<
      ReturnType<typeof supabase.functions.invoke>
    >);
    await expect(submitDemoSignup(BASE_INPUT)).rejects.toThrow(/Could not sign up/);
  });

  it('truncates the error reason in analytics to 200 chars', async () => {
    const longError = 'x'.repeat(500);
    mockedInvoke.mockResolvedValue({
      data: null,
      error: { message: longError },
    } as Awaited<ReturnType<typeof supabase.functions.invoke>>);

    await expect(submitDemoSignup(BASE_INPUT)).rejects.toThrow();

    const failedCall = mockedTrack.mock.calls.find((c) => c[0] === 'demo_signup_failed');
    expect(failedCall).toBeDefined();
    const reason = failedCall![1] as { reason: string };
    expect(reason.reason.length).toBe(200);
  });

  it('passes has_utm_source=false in submitted event when no utm_source is present', async () => {
    mockedInvoke.mockResolvedValue({
      data: { ok: true, isReturning: false },
      error: null,
    } as Awaited<ReturnType<typeof supabase.functions.invoke>>);

    await submitDemoSignup({ ...BASE_INPUT, attribution: EMPTY_ATTRIBUTION });

    expect(mockedTrack).toHaveBeenCalledWith(
      'demo_signup_submitted',
      expect.objectContaining({ has_utm_source: false, utm_source: null }),
    );
  });
});
