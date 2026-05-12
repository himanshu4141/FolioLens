/**
 * useUserTransactions — fetches every transaction for the current user in
 * one paginated query and stores it under `['user-transactions', userId]`.
 *
 * Portfolio, Fund Detail, Money Trail, Wealth Journey all need the same
 * underlying transaction set with slightly different projections. Sharing
 * a single cache means navigating between any two of them is free —
 * compute happens in JS off rows that are already in memory.
 *
 * Append-only table → safe to cache aggressively. The CAS import flow
 * invalidates this key after writing new rows.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/src/lib/supabase';
import { useSession } from '@/src/hooks/useSession';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { perfEnd, perfStart } from '@/src/lib/perfMark';

export interface UserTransactionRow {
  fund_id: string;
  transaction_date: string;
  transaction_type: string;
  units: number;
  amount: number;
}

const TX_COLUMNS = 'fund_id, transaction_date, transaction_type, units, amount';
const PAGE_SIZE = 1000;

export async function fetchUserTransactions(userId: string): Promise<UserTransactionRow[]> {
  perfStart('query:userTransactions');
  const rows: UserTransactionRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('transaction')
      .select(TX_COLUMNS)
      .eq('user_id', userId)
      .order('transaction_date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    rows.push(...((data ?? []) as UserTransactionRow[]));
    if ((data ?? []).length < PAGE_SIZE) break;
  }
  perfEnd('query:userTransactions', { rows: rows.length });
  return rows;
}

export function useUserTransactions() {
  const { session } = useSession();
  const userId = session?.user.id;
  return useQuery({
    queryKey: ['user-transactions', userId],
    enabled: !!userId,
    queryFn: () => fetchUserTransactions(userId!),
    staleTime: STALE_TIMES.USER_TRANSACTIONS,
  });
}
