/**
 * useMoneyTrail — Money Trail screen's view model.
 *
 * Reads the user's full transaction list and fund roster through the
 * shared cache keys (`['user-transactions', userId]`,
 * `['user-funds', userId]`) — same keys Portfolio and Fund Detail
 * already populate. A navigation from Portfolio → Money Trail (or
 * vice versa) now pays zero network cost for the inputs; the only
 * work that runs is the in-memory transform.
 *
 * Pre-PR #140: this hook had its own paginated SELECTs against
 * `transaction` and `fund` (`fetchAllTransactionRows`, `fetchFundRows`).
 * That meant ~547 transactions + 20 funds re-fetched every time the
 * user opened Money Trail, despite Portfolio having just loaded them.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/src/hooks/useSession';
import { useAppStore } from '@/src/store/appStore';
import { PREVIEW_MONEY_TRAIL } from '@/src/lib/previewData';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { perfEnd, perfStart } from '@/src/lib/perfMark';
import { fetchUserFunds } from '@/src/hooks/useUserFunds';
import { fetchUserTransactions } from '@/src/hooks/useUserTransactions';
import type { QueryClient } from '@tanstack/react-query';
import {
  buildAnnualMoneyFlows,
  buildMoneyTrailSummary,
  buildMoneyTrailTransactions,
  getUniqueAmcOptions,
  getUniqueFundOptions,
  type AnnualMoneyFlow,
  type PortfolioTransaction,
  type RawMoneyTrailTransaction,
} from '@/src/utils/moneyTrail';

export interface MoneyTrailData {
  transactions: PortfolioTransaction[];
  annualFlows: AnnualMoneyFlow[];
  summary: ReturnType<typeof buildMoneyTrailSummary>;
  fundOptions: { id: string; name: string }[];
  amcOptions: string[];
}

export async function fetchMoneyTrailData(
  qc: QueryClient,
  userId: string,
): Promise<MoneyTrailData> {
  perfStart('query:moneyTrail');
  const [allFunds, allTxs] = await Promise.all([
    qc.fetchQuery({
      queryKey: ['user-funds', userId],
      queryFn: () => fetchUserFunds(userId),
      staleTime: STALE_TIMES.USER_FUNDS,
    }),
    qc.fetchQuery({
      queryKey: ['user-transactions', userId],
      queryFn: () => fetchUserTransactions(userId),
      staleTime: STALE_TIMES.USER_TRANSACTIONS,
    }),
  ]);

  const fundsById = new Map<string, (typeof allFunds)[number]>();
  for (const fund of allFunds) {
    if (fund.id) fundsById.set(fund.id, fund);
  }

  const rawRows: RawMoneyTrailTransaction[] = allTxs.map((tx) => {
    const fund = fundsById.get(tx.fund_id);
    return {
      id: tx.id,
      fund_id: tx.fund_id,
      fund_name: fund?.scheme_name ?? null,
      scheme_category: fund?.scheme_category ?? null,
      transaction_date: tx.transaction_date,
      transaction_type: tx.transaction_type,
      units: tx.units,
      amount: tx.amount,
      nav_at_transaction: tx.nav_at_transaction,
      folio_number: tx.folio_number,
      cas_import_id: tx.cas_import_id,
      created_at: tx.created_at,
    };
  });

  const transactions = buildMoneyTrailTransactions(rawRows);
  perfEnd('query:moneyTrail', {
    txs: allTxs.length,
    funds: allFunds.length,
    transactions: transactions.length,
  });
  return {
    transactions,
    annualFlows: buildAnnualMoneyFlows(transactions),
    summary: buildMoneyTrailSummary(transactions),
    fundOptions: getUniqueFundOptions(transactions),
    amcOptions: getUniqueAmcOptions(transactions),
  };
}

export function useMoneyTrail() {
  const { session } = useSession();
  const previewMode = useAppStore((s) => s.previewMode);
  const userId = session?.user.id;
  const qc = useQueryClient();

  return useQuery({
    queryKey: previewMode ? ['money-trail', 'preview'] : ['money-trail', userId],
    enabled: previewMode || !!userId,
    queryFn: () =>
      previewMode ? Promise.resolve(PREVIEW_MONEY_TRAIL) : fetchMoneyTrailData(qc, userId!),
    staleTime: STALE_TIMES.MONEY_TRAIL,
  });
}
