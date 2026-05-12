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

  it('returns the server-rendered error from response context when the function errors', async () => {
    // Simulates a FunctionsHttpError: the supabase-js wrapper exposes the
    // raw Response on `.context` so the user-facing copy survives the
    // round-trip (instead of leaking "Failed to send a request to the
    // Edge Function" into the UI).
    const fakeContext = {
      json: jest.fn().mockResolvedValue({ error: 'Enter a valid email address' }),
    };
    mockedInvoke.mockResolvedValue({
      data: null,
      error: { message: 'Failed to send a request to the Edge Function', context: fakeContext },
    } as unknown as Awaited<ReturnType<typeof supabase.functions.invoke>>);

    await expect(submitDemoSignup(BASE_INPUT)).rejects.toThrow('Enter a valid email address');

    expect(mockedTrack).toHaveBeenCalledWith(
      'demo_signup_failed',
      expect.objectContaining({ reason: 'Enter a valid email address' }),
    );
    expect(mockedIdentify).not.toHaveBeenCalled();
  });

  it('falls back to a network-failure message when the error has no parsable context', async () => {
    mockedInvoke.mockResolvedValue({
      data: null,
      error: { message: 'Failed to send a request to the Edge Function' },
    } as unknown as Awaited<ReturnType<typeof supabase.functions.invoke>>);

    await expect(submitDemoSignup(BASE_INPUT)).rejects.toThrow(/couldn't reach the server/i);

    expect(mockedTrack).toHaveBeenCalledWith(
      'demo_signup_failed',
      expect.objectContaining({ reason: expect.stringMatching(/couldn't reach the server/i) }),
    );
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
    await expect(submitDemoSignup(BASE_INPUT)).rejects.toThrow(/Something went wrong/);
  });

  it('captures the raw error.message (truncated) on the analytics event for debugging', async () => {
    const longError = 'x'.repeat(500);
    mockedInvoke.mockResolvedValue({
      data: null,
      error: { message: longError },
    } as unknown as Awaited<ReturnType<typeof supabase.functions.invoke>>);

    await expect(submitDemoSignup(BASE_INPUT)).rejects.toThrow();

    const failedCall = mockedTrack.mock.calls.find((c) => c[0] === 'demo_signup_failed');
    expect(failedCall).toBeDefined();
    const event = failedCall![1] as { reason: string; raw: string };
    // `reason` is the user-facing friendly fallback (short); `raw` keeps the
    // original error.message for diagnostics, truncated to 200.
    expect(event.raw.length).toBe(200);
    expect(event.reason).toMatch(/couldn't reach the server/i);
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
