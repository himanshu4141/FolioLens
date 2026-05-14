/**
 * Capture UTM + referrer attribution from the auth screen's entry point.
 *
 * Sources:
 *  - Web: window.location.search + document.referrer + window.location.href
 *  - Native: the URL the app was launched with (if any) — only populated
 *    when someone tapped a deep link carrying utm_* params; otherwise
 *    everything's null.
 *
 * Pure-ish — the only side effects are `window` / DOM reads on web. Safe
 * to call once on auth-screen mount and stash the result in a ref.
 */

export interface EntryAttribution {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  page_url: string | null;
  referrer: string | null;
}

export const EMPTY_ATTRIBUTION: EntryAttribution = {
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_content: null,
  utm_term: null,
  page_url: null,
  referrer: null,
};

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse UTM + referrer + page_url from any URL string. Exported for tests
 * and for the native deep-link path; web callers should prefer
 * `readEntryAttributionFromBrowser` so they also pick up document.referrer.
 */
export function parseAttributionFromUrl(
  url: string | null | undefined,
  referrer: string | null = null,
): EntryAttribution {
  if (!url) return { ...EMPTY_ATTRIBUTION, referrer: nonEmpty(referrer) };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ...EMPTY_ATTRIBUTION, referrer: nonEmpty(referrer) };
  }

  const out: EntryAttribution = {
    ...EMPTY_ATTRIBUTION,
    page_url: url,
    referrer: nonEmpty(referrer),
  };
  for (const key of UTM_KEYS) {
    out[key] = nonEmpty(parsed.searchParams.get(key));
  }
  return out;
}

/**
 * Browser entry-attribution reader. Returns EMPTY_ATTRIBUTION when called
 * outside a browser (SSR, native).
 */
export function readEntryAttributionFromBrowser(): EntryAttribution {
  if (typeof window === 'undefined' || !window.location) return EMPTY_ATTRIBUTION;
  const referrer = typeof document !== 'undefined' ? document.referrer : null;
  return parseAttributionFromUrl(window.location.href, referrer);
}
