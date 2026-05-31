/**
 * Source precedence for `fund_portfolio_composition` rows.
 *
 * A scheme can have multiple rows for the same month — one per source — that
 * coexist under the UNIQUE (scheme_code, portfolio_date, source) key. The app
 * must always render the single best row. Precedence, highest wins:
 *
 *   official > amfi > category_fallback > category_rules
 *
 * Historically the read path leaned on the alphabetical order of the source
 * string ('amfi' < 'category_rules'), which silently breaks the moment a
 * higher-precedence value like 'official' is introduced ('official' sorts
 * LAST). This module makes the ranking explicit and is the single source of
 * truth for every best-row selector.
 *
 * Mirrors `COMPOSITION_SOURCE_RANK` in
 * `supabase/functions/_shared/openfolio.ts` (the Deno side can't import from
 * `src/`).
 */

export const COMPOSITION_SOURCE_RANK: Record<string, number> = {
  official: 3,
  amfi: 2,
  category_fallback: 1,
  category_rules: 0,
};

/** Numeric rank for a source string. Unknown / null sources rank below all. */
export function compositionSourceRank(source: string | null | undefined): number {
  if (source == null) return -1;
  return COMPOSITION_SOURCE_RANK[source] ?? -1;
}

/**
 * `true` when `a` is a strictly better source than `b` (purely by rank).
 */
export function isBetterCompositionSource(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return compositionSourceRank(a) > compositionSourceRank(b);
}

/**
 * Pick the best row per `scheme_code` from a flat list, by source precedence
 * then most-recent `portfolio_date`. Stable: ties keep the first occurrence,
 * so callers can pre-order by date if they want a specific tie-break.
 */
export function pickBestCompositionRows<
  T extends { scheme_code: number; source: string | null; portfolio_date: string },
>(rows: readonly T[]): T[] {
  const best = new Map<number, T>();
  for (const row of rows) {
    const existing = best.get(row.scheme_code);
    if (!existing) {
      best.set(row.scheme_code, row);
      continue;
    }
    const rowRank = compositionSourceRank(row.source);
    const existingRank = compositionSourceRank(existing.source);
    if (rowRank > existingRank) {
      best.set(row.scheme_code, row);
    } else if (rowRank === existingRank && row.portfolio_date > existing.portfolio_date) {
      best.set(row.scheme_code, row);
    }
  }
  return [...best.values()];
}
