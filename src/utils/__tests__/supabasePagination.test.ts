import { paginateRangeQuery, SUPABASE_DEFAULT_PAGE_SIZE } from '../supabasePagination';

interface Row {
  id: number;
}

function makeFakeTable(totalRows: number) {
  const rows: Row[] = Array.from({ length: totalRows }, (_, i) => ({ id: i + 1 }));
  const calls: { from: number; to: number }[] = [];
  const buildPage = async (from: number, to: number) => {
    calls.push({ from, to });
    // Mirror the inclusive-range semantics of PostgREST.
    return { data: rows.slice(from, to + 1), error: null as { message: string } | null };
  };
  return { rows, calls, buildPage };
}

describe('paginateRangeQuery', () => {
  it('returns a single page when total rows fit under page size', async () => {
    const { calls, buildPage } = makeFakeTable(750);
    const out = await paginateRangeQuery<Row>(buildPage);
    expect(out).toHaveLength(750);
    expect(calls).toEqual([{ from: 0, to: 999 }]);
  });

  it('walks multiple pages until a short page signals completion', async () => {
    const { calls, buildPage } = makeFakeTable(2_300);
    const out = await paginateRangeQuery<Row>(buildPage);
    expect(out).toHaveLength(2_300);
    // Pages of 1000 each: 0–999, 1000–1999, 2000–2999 (last page returns 300).
    expect(calls).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
      { from: 2000, to: 2999 },
    ]);
    // Order preserved.
    expect(out[0].id).toBe(1);
    expect(out[2_299].id).toBe(2_300);
  });

  it('stops cleanly when the table size is an exact page-size multiple', async () => {
    const { calls, buildPage } = makeFakeTable(2_000);
    const out = await paginateRangeQuery<Row>(buildPage, { pageSize: 1000 });
    expect(out).toHaveLength(2_000);
    // 2 full pages + 1 empty probe (length === 0 < pageSize → stops).
    expect(calls).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
      { from: 2000, to: 2999 },
    ]);
  });

  it('returns empty array when table has zero rows', async () => {
    const { calls, buildPage } = makeFakeTable(0);
    const out = await paginateRangeQuery<Row>(buildPage);
    expect(out).toEqual([]);
    expect(calls).toEqual([{ from: 0, to: 999 }]);
  });

  it('respects a custom pageSize', async () => {
    const { calls, buildPage } = makeFakeTable(450);
    const out = await paginateRangeQuery<Row>(buildPage, { pageSize: 200 });
    expect(out).toHaveLength(450);
    expect(calls).toEqual([
      { from: 0, to: 199 },
      { from: 200, to: 399 },
      { from: 400, to: 599 },
    ]);
  });

  it('throws when the underlying query reports an error', async () => {
    const buildPage = async () => ({
      data: null,
      error: { message: 'connection refused' },
    });
    await expect(paginateRangeQuery<Row>(buildPage)).rejects.toThrow(
      /paginateRangeQuery: connection refused/,
    );
  });

  it('caps at maxPages to prevent runaway loops', async () => {
    let calls = 0;
    const buildPage = async () => {
      calls += 1;
      // Always return a full page — would loop forever without the cap.
      return {
        data: Array.from({ length: SUPABASE_DEFAULT_PAGE_SIZE }, (_, i) => ({ id: i })),
        error: null as { message: string } | null,
      };
    };
    const out = await paginateRangeQuery<Row>(buildPage, { maxPages: 3 });
    expect(calls).toBe(3);
    expect(out).toHaveLength(3 * SUPABASE_DEFAULT_PAGE_SIZE);
  });

  it('handles null data rows defensively (treats as zero-length)', async () => {
    const buildPage = async () => ({
      data: null as Row[] | null,
      error: null as { message: string } | null,
    });
    const out = await paginateRangeQuery<Row>(buildPage);
    expect(out).toEqual([]);
  });
});
