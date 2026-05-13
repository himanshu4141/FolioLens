import { useMutation } from '@tanstack/react-query';
import { authClient } from '@/src/lib/auth';
import { functionsClient } from '@/src/lib/functions';
import { analytics } from '@/src/lib/analytics';

interface DeleteAccountResponse {
  ok: boolean;
  error?: string;
}

/**
 * Calls the `delete-account` Edge Function with the user's current JWT,
 * then signs the local session out so the app drops back to /auth.
 *
 * Exported as a plain async so it can be unit-tested without instantiating
 * a React Query client (the hook below is a thin wrapper around it).
 *
 * Analytics: emits `account_deleted` *before* sign-out so the event is
 * attributed to the user's distinct id (sign-out calls `analytics.reset()`
 * via the `_layout.tsx` auth-state listener and any subsequent capture
 * would land on a fresh anonymous id).
 */
export async function deleteAccount(): Promise<DeleteAccountResponse> {
  const res = await functionsClient.invoke<DeleteAccountResponse>('delete-account', {
    body: {},
  });
  if (res.error) {
    throw new Error(res.error.message ?? 'Could not delete account.');
  }
  const data = res.data;
  if (!data?.ok) {
    throw new Error(data?.error ?? 'Could not delete account.');
  }
  analytics.track('account_deleted');
  await authClient.signOut();
  return data;
}

export function useDeleteAccount() {
  return useMutation({ mutationFn: deleteAccount });
}
