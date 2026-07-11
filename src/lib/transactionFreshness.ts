export interface TransactionFreshnessMarker {
  count: number;
  latestCreatedAt: string | null;
}

export interface TransactionFreshnessRow {
  created_at: string | null;
}

export const EMPTY_TRANSACTION_FRESHNESS: TransactionFreshnessMarker = {
  count: 0,
  latestCreatedAt: null,
};

export function transactionFreshnessFromRows(
  rows: readonly TransactionFreshnessRow[] | null | undefined,
): TransactionFreshnessMarker {
  if (!rows || rows.length === 0) return EMPTY_TRANSACTION_FRESHNESS;

  let latestCreatedAt: string | null = null;
  for (const row of rows) {
    const createdAt = row.created_at;
    if (!createdAt) continue;
    if (latestCreatedAt === null || createdAt > latestCreatedAt) {
      latestCreatedAt = createdAt;
    }
  }

  return {
    count: rows.length,
    latestCreatedAt,
  };
}

export function transactionFreshnessChanged(
  cached: TransactionFreshnessMarker | null | undefined,
  remote: TransactionFreshnessMarker,
): boolean {
  if (!cached) {
    return remote.count > 0 || remote.latestCreatedAt !== null;
  }

  return (
    cached.count !== remote.count ||
    cached.latestCreatedAt !== remote.latestCreatedAt
  );
}
