export const FUNDS_LIST_VIRTUALIZATION = {
  initialNumToRender: 6,
  maxToRenderPerBatch: 6,
  windowSize: 7,
} as const;

export const MONEY_TRAIL_LIST_VIRTUALIZATION = {
  initialNumToRender: 12,
  maxToRenderPerBatch: 12,
  windowSize: 7,
} as const;

export type VirtualizedFundRowInputs = {
  fund: unknown;
  portfolioPct: number | null;
  expanded?: boolean;
  latestNavDate?: string | null;
  benchmarkXirr?: number;
  styles: unknown;
  tokens: unknown;
  onToggle?: unknown;
  onOpen: unknown;
  onOpenTransactions?: unknown;
};

export function areVirtualizedFundRowInputsEqual(
  previous: VirtualizedFundRowInputs,
  next: VirtualizedFundRowInputs,
): boolean {
  return (
    previous.fund === next.fund &&
    previous.portfolioPct === next.portfolioPct &&
    previous.expanded === next.expanded &&
    previous.latestNavDate === next.latestNavDate &&
    previous.benchmarkXirr === next.benchmarkXirr &&
    previous.styles === next.styles &&
    previous.tokens === next.tokens &&
    previous.onToggle === next.onToggle &&
    previous.onOpen === next.onOpen &&
    previous.onOpenTransactions === next.onOpenTransactions
  );
}

export type VirtualizedTransactionRowInputs = {
  transaction: unknown;
  isFirst: boolean;
  isLast: boolean;
  styles: unknown;
  tokens: unknown;
  onOpen: unknown;
};

export function areVirtualizedTransactionRowInputsEqual(
  previous: VirtualizedTransactionRowInputs,
  next: VirtualizedTransactionRowInputs,
): boolean {
  return (
    previous.transaction === next.transaction &&
    previous.isFirst === next.isFirst &&
    previous.isLast === next.isLast &&
    previous.styles === next.styles &&
    previous.tokens === next.tokens &&
    previous.onOpen === next.onOpen
  );
}
