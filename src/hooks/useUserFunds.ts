/**
 * useUserFunds — fetches the user's complete fund roster in one shot and
 * stores it under a stable cache key (`['user-funds', userId]`).
 *
 * Multiple screens consume the same underlying `fund` rows — Portfolio,
 * Fund Detail, Compare, Funds list. Routing them all through a single
 * React Query cache means a fund row that Portfolio already loaded is
 * available instantly to Fund Detail (via `qc.fetchQuery` from non-hook
 * call sites), instead of each screen issuing its own SELECT.
 *
 * One producer, one fixed SELECT shape — this is the lesson from PR #135's
 * cache-shape-collision fix. Anything else that needs fund metadata reads
 * from this cache rather than writing a parallel cache key with a
 * different shape.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/src/lib/supabase';
import { useSession } from '@/src/hooks/useSession';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { perfEnd, perfStart } from '@/src/lib/perfMark';

export interface UserFundRow {
  id: string | null;
  user_id: string | null;
  scheme_code: number | null;
  scheme_name: string | null;
  scheme_category: string | null;
  benchmark_index: string | null;
  benchmark_index_symbol: string | null;
  isin: string | null;
  expense_ratio: number | null;
  aum_cr: number | null;
  min_sip_amount: number | null;
  fund_meta_synced_at: string | null;
  is_active: boolean | null;
}

const FUND_COLUMNS =
  'id, user_id, scheme_code, scheme_name, scheme_category, benchmark_index, benchmark_index_symbol, isin, expense_ratio, aum_cr, min_sip_amount, fund_meta_synced_at, is_active';

export async function fetchUserFunds(userId: string): Promise<UserFundRow[]> {
  perfStart('query:userFunds');
  const { data, error } = await supabase
    .from('fund')
    .select(FUND_COLUMNS)
    .eq('user_id', userId);
  perfEnd('query:userFunds', { rows: data?.length ?? 0 });
  if (error) throw error;
  return (data ?? []) as UserFundRow[];
}

export function useUserFunds() {
  const { session } = useSession();
  const userId = session?.user.id;
  return useQuery({
    queryKey: ['user-funds', userId],
    enabled: !!userId,
    queryFn: () => fetchUserFunds(userId!),
    staleTime: STALE_TIMES.USER_FUNDS,
  });
}
