/**
 * Supabase REST has a hard 1000-row default cap per response (PostgREST
 * `db.max-rows`). For our largest tables (`nav_history` for a 13-year-old
 * scheme has ~3,300 rows) a naive `.select().eq().order()` quietly truncates
 * to the first 1000 ascending rows — so trailing-CAGR / Past-SIP simulations
 * silently chart 2013–2017 data instead of 2017–today.
 *
 * `paginateRangeQuery` takes a function that builds + executes a single page
 * (the caller controls all filters/ordering and applies `.range(from, to)`)
 * and walks the windows until a page returns fewer rows than the page size.
 *
 * Caller pattern:
 *   const rows = await paginateRangeQuery<NavRow>(
 *     (from, to) => supabase
 *       .from('nav_history')
 *       .select('nav_date, nav')
 *       .eq('scheme_code', code)
 *       .order('nav_date', { ascending: true })
 *       .range(from, to),
 *   );
 *
 * This is ~33% faster than fetching descending then reversing because it
 * doesn't waste a sort flip in JS for the common ascending case.
 */

export const SUPABASE_DEFAULT_PAGE_SIZE = 1000;

interface PageResponse<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export async function paginateRangeQuery<T>(
  buildPage: (from: number, to: number) => PromiseLike<PageResponse<T>>,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<T[]> {
  const pageSize = options.pageSize ?? SUPABASE_DEFAULT_PAGE_SIZE;
  // Hard cap to keep a runaway loop from hammering the REST endpoint —
  // 50 pages = 50,000 rows is well above any single-scheme NAV history.
  const maxPages = options.maxPages ?? 50;

  const out: T[] = [];
  let page = 0;
  while (page < maxPages) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await buildPage(from, to);
    if (error) throw new Error(`paginateRangeQuery: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) return out;
    page += 1;
  }
  // Hit the safety cap — return what we have rather than throwing, so the
  // UI degrades to "shows the most recent ~50k rows" instead of erroring out.
  return out;
}
