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
 *
 * Read-through layering: this hook reads from the on-device SQLite repo
 * first (`txRepo.readAll`). When the repo is empty (cold start, signed-
 * out and back in, schema reset) we fall through to a full Supabase
 * pull and write the result into SQLite so the next caller gets the
 * fast path. The background sync orchestrator keeps the repo fresh
 * across opens.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/src/lib/supabase';
import { useSession } from '@/src/hooks/useSession';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { perfEnd, perfStart } from '@/src/lib/perfMark';
import * as txRepo from '@/src/lib/db/tx';
import { SQLITE_AVAILABLE } from '@/src/lib/db/availability';

export interface UserTransactionRow {
  // PK columns Portfolio / Fund Detail / xirr math need.
  fund_id: string;
  transaction_date: string;
  transaction_type: string;
  units: number;
  amount: number;
  // Extra columns Money Trail + Wealth Journey use for ordering,
  // display, and folio-level breakdowns. Included here so every
  // screen reads from the same `['user-transactions', userId]` cache
  // entry instead of issuing its own SELECT with a different shape
  // (which was the class of bug that bit PR #134's persister).
  id: string;
  nav_at_transaction: number | null;
  folio_number: string | null;
  cas_import_id: string | null;
  created_at: string | null;
}

const TX_COLUMNS =
  'id, fund_id, transaction_date, transaction_type, units, amount, nav_at_transaction, folio_number, cas_import_id, created_at';
const PAGE_SIZE = 1000;

/**
 * Direct Supabase pull, bypassing the SQLite read-through. The sync
 * orchestrator uses this for delta refresh — without it, `syncDelta`
 * would call back into the SQLite-first wrapper and the "fresh" rows
 * it diffs against the watermark would just be the SQLite rows it's
 * trying to update. `sinceDate` lets delta callers ship only new rows
 * over the wire (the watermark is the local table's max
 * `transaction_date`).
 */
export async function fetchUserTransactionsRemote(
  userId: string,
  sinceDate: string | null = null,
): Promise<UserTransactionRow[]> {
  const rows: UserTransactionRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let q = supabase
      .from('transaction')
      .select(TX_COLUMNS)
      .eq('user_id', userId)
      .order('transaction_date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (sinceDate) q = q.gte('transaction_date', sinceDate);
    const { data, error } = await q;

    if (error) throw error;
    rows.push(...((data ?? []) as UserTransactionRow[]));
    if ((data ?? []).length < PAGE_SIZE) break;
  }
  return rows;
}

export async function fetchUserTransactions(userId: string): Promise<UserTransactionRow[]> {
  perfStart('query:userTransactions');
  if (SQLITE_AVAILABLE) {
    try {
      const local = await txRepo.readAll();
      if (local.length > 0) {
        perfEnd('query:userTransactions', { rows: local.length, source: 'sqlite' });
        return local;
      }
    } catch (err) {
      // SQLite open / read failure — log and fall through to Supabase
      // so the user still sees their data. The bootstrap pipeline will
      // log this via analytics.
      console.warn('[useUserTransactions] sqlite read failed; falling back', err);
    }
  }

  const fresh = await fetchUserTransactionsRemote(userId);
  if (fresh.length > 0 && SQLITE_AVAILABLE) {
    try {
      await txRepo.bulkInsert(fresh);
    } catch (err) {
      console.warn('[useUserTransactions] sqlite write failed', err);
    }
  }
  perfEnd('query:userTransactions', { rows: fresh.length, source: 'supabase' });
  return fresh;
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
