jest.mock('@/src/lib/supabase', () => ({
  supabase: {
    functions: { invoke: jest.fn() },
    auth: { signOut: jest.fn() },
  },
}));

jest.mock('@/src/lib/analytics', () => ({
  analytics: { track: jest.fn() },
}));

// eslint-disable-next-line import/first -- mocks must be registered before the modules they replace are imported
import { deleteAccount } from '../useDeleteAccount';
// eslint-disable-next-line import/first
import { supabase } from '@/src/lib/supabase';
// eslint-disable-next-line import/first
import { analytics } from '@/src/lib/analytics';

const mockedInvoke = supabase.functions.invoke as jest.MockedFunction<
  typeof supabase.functions.invoke
>;
const mockedSignOut = supabase.auth.signOut as jest.MockedFunction<typeof supabase.auth.signOut>;
const mockedTrack = analytics.track as jest.MockedFunction<typeof analytics.track>;

describe('deleteAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSignOut.mockResolvedValue({ error: null } as Awaited<ReturnType<typeof supabase.auth.signOut>>);
  });

  it('emits account_deleted, signs the user out, and resolves on success', async () => {
    mockedInvoke.mockResolvedValue({ data: { ok: true }, error: null } as Awaited<
      ReturnType<typeof supabase.functions.invoke>
    >);

    await expect(deleteAccount()).resolves.toEqual({ ok: true });
    expect(mockedInvoke).toHaveBeenCalledWith('delete-account', { body: {} });
    expect(mockedTrack).toHaveBeenCalledWith('account_deleted');
    expect(mockedSignOut).toHaveBeenCalledTimes(1);
  });

  it('throws, does not emit, and does not sign out when the function returns an error envelope', async () => {
    mockedInvoke.mockResolvedValue({
      data: null,
      error: { message: 'Unauthorized' },
    } as Awaited<ReturnType<typeof supabase.functions.invoke>>);

    await expect(deleteAccount()).rejects.toThrow('Unauthorized');
    expect(mockedTrack).not.toHaveBeenCalled();
    expect(mockedSignOut).not.toHaveBeenCalled();
  });

  it('throws, does not emit, and does not sign out when ok=false in the body', async () => {
    mockedInvoke.mockResolvedValue({
      data: { ok: false, error: 'Could not delete account. Please try again.' },
      error: null,
    } as Awaited<ReturnType<typeof supabase.functions.invoke>>);

    await expect(deleteAccount()).rejects.toThrow('Could not delete account. Please try again.');
    expect(mockedTrack).not.toHaveBeenCalled();
    expect(mockedSignOut).not.toHaveBeenCalled();
  });

  it('throws a generic message when the function returns an empty body', async () => {
    mockedInvoke.mockResolvedValue({ data: null, error: null } as Awaited<
      ReturnType<typeof supabase.functions.invoke>
    >);

    await expect(deleteAccount()).rejects.toThrow('Could not delete account.');
    expect(mockedTrack).not.toHaveBeenCalled();
    expect(mockedSignOut).not.toHaveBeenCalled();
  });
});
