import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/src/lib/supabase';
import { useSession } from '@/src/hooks/useSession';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { perfEnd, perfStart } from '@/src/lib/perfMark';
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

interface MoneyTrailFundRow {
  id: string | null;
  scheme_name: string | null;
  scheme_category: string | null;
}

interface MoneyTrailTxRow {
  id: string;
  fund_id: string;
  transaction_date: string;
  transaction_type: string;
  units: number | null;
  amount: number | null;
  nav_at_transaction: number | null;
  folio_number: string | null;
  cas_import_id: string | null;
  created_at: string | null;
}

export interface MoneyTrailData {
  transactions: PortfolioTransaction[];
  annualFlows: AnnualMoneyFlow[];
  summary: ReturnType<typeof buildMoneyTrailSummary>;
  fundOptions: { id: string; name: string }[];
  amcOptions: string[];
}

const PAGE_SIZE = 1000;

export async function fetchMoneyTrailData(userId: string): Promise<MoneyTrailData> {
  perfStart('query:moneyTrail');
  const [txRows, fundRows] = await Promise.all([
    fetchAllTransactionRows(userId),
    fetchFundRows(userId),
  ]);

  const fundsById = new Map<string, MoneyTrailFundRow>();
  for (const fund of fundRows) {
    if (fund.id) fundsById.set(fund.id, fund);
  }

  const rawRows: RawMoneyTrailTransaction[] = txRows.map((tx) => {
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
    txs: txRows.length,
    funds: fundRows.length,
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

async function fetchAllTransactionRows(userId: string): Promise<MoneyTrailTxRow[]> {
  const rows: MoneyTrailTxRow[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('transaction')
      .select('id, fund_id, transaction_date, transaction_type, units, amount, nav_at_transaction, folio_number, cas_import_id, created_at')
      .eq('user_id', userId)
      .order('transaction_date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    rows.push(...((data ?? []) as MoneyTrailTxRow[]));
    if ((data ?? []).length < PAGE_SIZE) break;
  }

  return rows;
}

async function fetchFundRows(userId: string): Promise<MoneyTrailFundRow[]> {
  const { data, error } = await supabase
    .from('fund')
    .select('id, scheme_name, scheme_category')
    .eq('user_id', userId);

  if (error) throw error;
  return (data ?? []) as MoneyTrailFundRow[];
}

export function useMoneyTrail() {
  const { session } = useSession();
  const userId = session?.user.id;

  return useQuery({
    queryKey: ['money-trail', userId],
    enabled: !!userId,
    queryFn: () => fetchMoneyTrailData(userId!),
    staleTime: STALE_TIMES.MONEY_TRAIL,
  });
}
