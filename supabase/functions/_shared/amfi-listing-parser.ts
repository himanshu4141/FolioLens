/**
 * Pure helpers for parsing AMFI's "Categorisation of Stocks" listing page.
 * Lives in _shared/ so it can run under Jest without pulling in any Deno
 * surface — the sync-stock-market-cap edge function imports from here.
 *
 * Page shape (as of 2026-05): https://www.amfiindia.com/otherdata/categorisation-of-stocks
 * lists each half-yearly cycle as a card linking to an .xlsx under
 * `/Themes/Theme1/downloads/`. The filenames embed the period in one of three
 * styles that have shifted across cycles:
 *
 *   - 30Jun2024 / 31Dec2024            — cutoff-date form (current)
 *   - Jan-Jun 2020 / Jul - Dec 2021    — long-form range (legacy)
 *   - H1-2025 / h2_2024                — explicit half (also seen)
 */

export interface ListingPeriod {
  half: 1 | 2;
  year: number;
}

export interface ExtractResult {
  /** Best candidate URL, absolute. `null` if no .xlsx hrefs at all. */
  url: string | null;
  /** Every .xlsx href found on the page, in document order. */
  candidates: string[];
}

/**
 * Scrapes the listing-page HTML for the freshest .xlsx href. Returns the
 * full list of candidates so callers can surface them in error responses
 * (the next failure to diagnose is "AMFI changed the page" — having the
 * actual hrefs in the response saves a re-run).
 */
export function extractLatestXlsxUrl(html: string): ExtractResult {
  const hrefRe = /href\s*=\s*["']([^"']+\.xlsx[^"']*)["']/gi;
  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    candidates.push(m[1]);
  }
  if (candidates.length === 0) return { url: null, candidates };

  // Sort by period score (year * 100 + half), descending. Unrecognised
  // patterns score 0 so they lose to anything we recognise. Tie-break by
  // descending string order — alphabetically later filenames win, which
  // for AMFI's naming is the same as "more recent".
  const ranked = candidates
    .map((href) => ({ href, rank: scorePeriod(parsePeriodFromHref(href)) }))
    .sort((a, b) => (b.rank - a.rank) || b.href.localeCompare(a.href));

  return { url: toAbsolute(ranked[0].href), candidates };
}

function toAbsolute(href: string): string {
  if (href.startsWith('http')) return href;
  if (href.startsWith('//')) return `https:${href}`;
  if (href.startsWith('/')) return `https://www.amfiindia.com${href}`;
  return `https://www.amfiindia.com/${href}`;
}

/**
 * Parses the half-year period out of an AMFI filename. Returns `null` if
 * nothing recognisable was found — the caller treats that as period score
 * 0 so unrecognised candidates lose the ranking against recognised ones.
 */
export function parsePeriodFromHref(href: string): ListingPeriod | null {
  const lower = href.toLowerCase();

  // Explicit half label, e.g. H1-2025 / h2_2024.
  const halfMatch = lower.match(/h([12])[-_ ]?(\d{4})/);
  if (halfMatch) return { half: halfMatch[1] === '1' ? 1 : 2, year: Number(halfMatch[2]) };

  // Cutoff date, e.g. 30Jun2024 / 31Dec2024 (with optional separator).
  if (lower.includes('30jun')) {
    const yearMatch = lower.match(/30jun[_ ]?(\d{4})/);
    if (yearMatch) return { half: 1, year: Number(yearMatch[1]) };
  }
  if (lower.includes('31dec')) {
    const yearMatch = lower.match(/31dec[_ ]?(\d{4})/);
    if (yearMatch) return { half: 2, year: Number(yearMatch[1]) };
  }

  // Long-form range. The two halves use `Jan-Jun` / `Jul-Dec` with arbitrary
  // separators / whitespace. Match either family + the trailing year.
  const rangeMatch = lower.match(/(jan\s*-\s*jun|jul\s*-\s*dec)[^\d]*(\d{4})/);
  if (rangeMatch) {
    return { half: rangeMatch[1].startsWith('jan') ? 1 : 2, year: Number(rangeMatch[2]) };
  }

  return null;
}

function scorePeriod(p: ListingPeriod | null): number {
  if (!p) return 0;
  return p.year * 100 + p.half;
}

/**
 * Best-effort period extractor for the `classification_period` column on
 * the `stock_market_cap` table. Always returns a string — falls back to
 * the half corresponding to `fallback` if the URL doesn't match any
 * recognised pattern. Used for idempotency / no-op detection only,
 * never user-facing.
 */
export function extractClassificationPeriod(sourceUrl: string, fallback: Date = new Date()): string {
  const parsed = parsePeriodFromHref(sourceUrl);
  if (parsed) return `H${parsed.half}-${parsed.year}`;
  const month = fallback.getUTCMonth() + 1;
  const year = fallback.getUTCFullYear();
  return `H${month <= 6 ? 1 : 2}-${year}`;
}
