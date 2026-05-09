/**
 * useUserProfile — single source of truth for the `user_profile` row.
 *
 * Every screen that reads user_profile shares the React Query key
 * `['user-profile', userId]`. If two callers share that key but each
 * `select()`s a different subset of columns, whichever screen mounts first
 * seeds the cache with its own narrow shape, and subsequent screens read
 * `undefined` for the columns they need until `refetchOnMount: 'always'`
 * resolves. That race produced three user-visible bugs at once:
 *
 *   - Settings → Portfolio import showed "Open import flow to create your
 *     inbox" even though the row had a `cas_inbox_token`.
 *   - Settings → Account showed "PAN not set" even though PAN was saved.
 *   - "Set up auto-forward" deep-link landed on the Welcome step instead of
 *     the AutoRefresh setup screen.
 *
 * This hook centralises the SELECT so the cache shape is stable: every
 * caller pulls the same six columns and reads only the fields it needs.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/src/lib/supabase';

export interface UserProfile {
  pan: string | null;
  dob: string | null;
  kfintech_email: string | null;
  cas_inbox_token: string | null;
  cas_inbox_confirmation_url: string | null;
  cas_auto_forward_setup_completed_at: string | null;
}

export const USER_PROFILE_COLUMNS =
  'pan, dob, kfintech_email, cas_inbox_token, cas_inbox_confirmation_url, cas_auto_forward_setup_completed_at' as const;

export async function fetchUserProfile(userId: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from('user_profile')
    .select(USER_PROFILE_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    // Surface the real cause instead of silently degrading. Common culprits
    // are a stale PostgREST schema cache after a column add, RLS misconfig,
    // or a missing migration on the connected project. The wizard's
    // hydration depends on this row to decide the initial step, so a
    // swallowed error sends the user back through Welcome / Identity even
    // when the profile is fully populated.
    console.error('[useUserProfile] fetchUserProfile failed', error);
    throw error;
  }
  return (data as UserProfile | null) ?? null;
}

export function userProfileQueryKey(userId: string | undefined) {
  return ['user-profile', userId] as const;
}

export function useUserProfile(userId: string | undefined) {
  return useQuery<UserProfile | null>({
    queryKey: userProfileQueryKey(userId),
    queryFn: () => fetchUserProfile(userId!),
    enabled: !!userId,
    // Always refetch on mount. The wizard's IdentityStep upserts
    // user_profile and invalidates this key, but if a screen was opened in
    // a different navigation stack the cached value can outlive the upsert.
    // Forcing a refetch on mount guarantees the row reflects the DB.
    refetchOnMount: 'always',
  });
}
