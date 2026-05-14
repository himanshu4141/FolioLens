jest.mock('@tanstack/react-query', () => ({ useQuery: jest.fn() }));
jest.mock('@/src/lib/data/userProfile', () => ({
  userProfileRepo: { from: jest.fn() },
}));

// eslint-disable-next-line import/first -- mocks must register before module imports
import {
  USER_PROFILE_COLUMNS,
  fetchUserProfile,
  userProfileQueryKey,
} from '@/src/hooks/useUserProfile';
// eslint-disable-next-line import/first
import { userProfileRepo } from '@/src/lib/data/userProfile';

function makeChain(response: { data: unknown; error: unknown }) {
  const chain: Record<string, jest.Mock> = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.maybeSingle.mockReturnValue(response);
  return chain;
}

const mockFrom = userProfileRepo.from as jest.Mock;

const FULL_PROFILE = {
  pan: 'ABCDE1234F',
  dob: '1990-01-15',
  kfintech_email: 'user@example.com',
  cas_inbox_token: 'G9Z6KZNE',
  cas_inbox_confirmation_url: null,
  cas_auto_forward_setup_completed_at: '2026-05-01T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('userProfileQueryKey()', () => {
  it('produces a stable key shape so all callers share one cache entry', () => {
    expect(userProfileQueryKey('user-1')).toEqual(['user-profile', 'user-1']);
    expect(userProfileQueryKey(undefined)).toEqual(['user-profile', undefined]);
  });
});

describe('USER_PROFILE_COLUMNS', () => {
  // The whole point of this hook is that *every* caller selects the same
  // columns, so the React Query cache value never has a partial shape.
  // Pin the column list so a future caller can't drop one and reintroduce
  // the cache-shape collision that this hook was created to fix.
  it.each([
    'pan',
    'dob',
    'kfintech_email',
    'cas_inbox_token',
    'cas_inbox_confirmation_url',
    'cas_auto_forward_setup_completed_at',
  ])('includes %s', (column) => {
    expect(USER_PROFILE_COLUMNS).toContain(column);
  });
});

describe('fetchUserProfile()', () => {
  it('returns the row when the SELECT succeeds', async () => {
    const chain = makeChain({ data: FULL_PROFILE, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await fetchUserProfile('user-1');

    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(chain.select).toHaveBeenCalledWith(USER_PROFILE_COLUMNS);
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(result).toEqual(FULL_PROFILE);
  });

  it('returns null when the row does not exist', async () => {
    const chain = makeChain({ data: null, error: null });
    mockFrom.mockReturnValue(chain);

    const result = await fetchUserProfile('user-1');

    expect(result).toBeNull();
  });

  it('throws so the caller can surface a real failure rather than degrade silently', async () => {
    const chain = makeChain({ data: null, error: { message: 'PGRST116' } });
    mockFrom.mockReturnValue(chain);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(fetchUserProfile('user-1')).rejects.toEqual({ message: 'PGRST116' });

    errSpy.mockRestore();
  });
});
