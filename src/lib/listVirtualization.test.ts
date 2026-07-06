import {
  FUNDS_LIST_VIRTUALIZATION,
  MONEY_TRAIL_LIST_VIRTUALIZATION,
  areVirtualizedFundRowInputsEqual,
} from './listVirtualization';

describe('N5 list virtualization contract', () => {
  it('keeps the initial Funds window bounded for a 25-fund portfolio', () => {
    const funds = Array.from({ length: 25 }, (_, index) => ({ id: `fund-${index}` }));

    expect(FUNDS_LIST_VIRTUALIZATION.initialNumToRender).toBeLessThan(funds.length);
    expect(funds.slice(0, FUNDS_LIST_VIRTUALIZATION.initialNumToRender)).toHaveLength(6);
  });

  it('keeps the initial Money Trail window bounded for 1,000 transactions', () => {
    const transactions = Array.from({ length: 1_000 }, (_, index) => ({
      id: `transaction-${index}`,
    }));

    expect(MONEY_TRAIL_LIST_VIRTUALIZATION.initialNumToRender).toBeLessThan(transactions.length);
    expect(transactions.slice(0, MONEY_TRAIL_LIST_VIRTUALIZATION.initialNumToRender)).toHaveLength(
      12,
    );
  });

  it('invalidates only the previously and newly expanded fund rows', () => {
    const styles = {};
    const tokens = {};
    const onToggle = jest.fn();
    const onOpen = jest.fn();
    const onOpenTransactions = jest.fn();
    const funds = Array.from({ length: 25 }, (_, index) => ({ id: `fund-${index}` }));

    const changedRows = funds.filter((fund) => {
      const shared = {
        fund,
        portfolioPct: 4,
        latestNavDate: '2026-07-05',
        styles,
        tokens,
        onToggle,
        onOpen,
        onOpenTransactions,
      };
      return !areVirtualizedFundRowInputsEqual(
        { ...shared, expanded: fund.id === 'fund-2' },
        { ...shared, expanded: fund.id === 'fund-19' },
      );
    });

    expect(changedRows.map((fund) => fund.id)).toEqual(['fund-2', 'fund-19']);
  });

  it('does not suppress a real fund-data replacement', () => {
    const shared = {
      portfolioPct: 4,
      expanded: false,
      latestNavDate: '2026-07-05',
      styles: {},
      tokens: {},
      onToggle: jest.fn(),
      onOpen: jest.fn(),
      onOpenTransactions: jest.fn(),
    };

    expect(
      areVirtualizedFundRowInputsEqual(
        { ...shared, fund: { id: 'fund-1', currentValue: 100 } },
        { ...shared, fund: { id: 'fund-1', currentValue: 101 } },
      ),
    ).toBe(false);
  });
});
