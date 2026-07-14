type SeedPortfolioForUser = (
  client: MockSupabaseClient,
  userId: string,
  options: { seedGlobalReferenceData: boolean },
) => Promise<void>;

type WriteOperation = {
  table: string;
  operation: 'delete' | 'insert' | 'upsert';
};

type QueryState = {
  operation?: WriteOperation['operation'];
  selectOptions?: { count?: string; head?: boolean };
};

type MockSupabaseClient = {
  from: (table: string) => MockQueryBuilder;
};

type MockQueryBuilder = {
  delete: () => MockQueryBuilder;
  insert: (_rows: unknown) => { error: null };
  upsert: (_rows: unknown, _options?: unknown) => MockQueryBuilder;
  select: (_columns?: string, _options?: { count?: string; head?: boolean }) => MockQueryBuilder;
  eq: (_column: string, _value: unknown) => MockQueryBuilder | { count: number; error: null } | { error: null };
  in: (_column: string, _values: unknown[]) => MockQueryBuilder;
  gte: (_column: string, _value: unknown) => MockQueryBuilder;
  order: (_column: string, _options?: unknown) => { data: unknown[]; error: null };
  single: () => { data: { id: string }; error: null };
};

const REFERENCE_TABLES = new Set([
  'nav_history',
  'index_history',
  'fund_portfolio_composition',
  'scheme_master',
]);

const SCHEME_CODES = [118955, 119218, 120599];

// eslint-disable-next-line @typescript-eslint/no-require-imports -- Core seeder is CommonJS so Jest can load it without ESM config.
const { seedPortfolioForUser } = require('../seed-demo-user-core.cjs') as {
  seedPortfolioForUser: SeedPortfolioForUser;
};

function createMockSupabaseClient() {
  const writes: WriteOperation[] = [];
  let fundId = 0;

  function record(table: string, operation: WriteOperation['operation']) {
    writes.push({ table, operation });
  }

  function builder(table: string): MockQueryBuilder {
    const state: QueryState = {};
    const query: MockQueryBuilder = {
      delete: () => {
        state.operation = 'delete';
        record(table, 'delete');
        return query;
      },
      insert: (_rows: unknown) => {
        record(table, 'insert');
        return { error: null };
      },
      upsert: (_rows: unknown, _options?: unknown) => {
        state.operation = 'upsert';
        record(table, 'upsert');
        return query;
      },
      select: (_columns?: string, options?: { count?: string; head?: boolean }) => {
        state.selectOptions = options;
        return query;
      },
      eq: () => {
        if (state.operation === 'delete') return { error: null };
        if (table === 'nav_history' && state.selectOptions?.head) {
          return { count: 365, error: null };
        }
        return query;
      },
      in: () => query,
      gte: () => query,
      order: () => ({
        data: SCHEME_CODES.map((schemeCode) => ({
          scheme_code: schemeCode,
          nav_date: '2023-01-01',
          nav: 100,
        })),
        error: null,
      }),
      single: () => {
        fundId += 1;
        return { data: { id: `fund-${fundId}` }, error: null };
      },
    };

    return query;
  }

  return {
    client: {
      from: (table: string) => builder(table),
    },
    writes,
  };
}

describe('reviewer seeding safety', () => {
  it('does not write shared reference tables in user-scoped-only mode', async () => {
    const { client, writes } = createMockSupabaseClient();

    await seedPortfolioForUser(client, 'reviewer-user-id', {
      seedGlobalReferenceData: false,
    });

    expect(writes.filter((write) => REFERENCE_TABLES.has(write.table))).toEqual([]);
    expect(writes).toEqual(
      expect.arrayContaining([
        { table: 'user_profile', operation: 'upsert' },
        { table: 'cas_inbound_session', operation: 'upsert' },
        { table: 'user_fund', operation: 'upsert' },
        { table: 'transaction', operation: 'insert' },
      ]),
    );
  });
});
