/**
 * Compare Funds — pure utilities for the comparison screen.
 *
 * - `computeHoldingOverlap` — Jaccard-style overlap between two top-holding
 *   lists. Uses ISIN as the primary key (rock solid), falls back to normalised
 *   stock names where ISIN is missing. Returns the percentage overlap and the
 *   matched/total counts so the UI can disclose the basis.
 *
 * - `computeTrailingReturn` — annualised return between the NAV closest to N
 *   years ago and the latest NAV. Standard CAGR. Returns null if the series
 *   doesn't span the requested window.
 *
 * - `holdingsKey` — internal helper that picks ISIN when available, otherwise a
 *   normalised name. Exported only for tests.
 */
import type { HoldingItem } from '@/src/types/app';
import type { NavPoint } from './navUtils';

export interface HoldingOverlapResult {
  /** Percentage 0–100 (Jaccard similarity × 100). */
  overlapPct: number;
  /** How many holdings matched between the two sets. */
  matchedCount: number;
  /** Size of the union of holdings considered. */
  unionCount: number;
}

const NORMALISE_RX = /[^a-z0-9]+/g;

export function holdingsKey(h: Pick<HoldingItem, 'isin' | 'name'>): string {
  if (h.isin && h.isin.trim().length > 0) return h.isin.trim().toUpperCase();
  return (h.name ?? '').toLowerCase().replace(NORMALISE_RX, '');
}

/**
 * Computes a Jaccard overlap between two top-holdings lists.
 *
 * `topN` clamps each list to its first N entries (default 10) so a fund with a
 * very long disclosure isn't penalised against one with only the standard 10.
 */
export function computeHoldingOverlap(
  a: HoldingItem[] | null | undefined,
  b: HoldingItem[] | null | undefined,
  topN = 10,
): HoldingOverlapResult {
  const trim = (xs: HoldingItem[] | null | undefined): HoldingItem[] =>
    Array.isArray(xs) ? xs.slice(0, topN) : [];
  const aList = trim(a);
  const bList = trim(b);

  if (aList.length === 0 || bList.length === 0) {
    return { overlapPct: 0, matchedCount: 0, unionCount: 0 };
  }

  const aKeys = new Set(aList.map(holdingsKey).filter((k) => k.length > 0));
  const bKeys = new Set(bList.map(holdingsKey).filter((k) => k.length > 0));

  if (aKeys.size === 0 || bKeys.size === 0) {
    return { overlapPct: 0, matchedCount: 0, unionCount: 0 };
  }

  let matched = 0;
  for (const k of aKeys) if (bKeys.has(k)) matched += 1;

  const unionSize = new Set([...aKeys, ...bKeys]).size;
  const overlapPct = unionSize === 0 ? 0 : (matched / unionSize) * 100;

  return { overlapPct, matchedCount: matched, unionCount: unionSize };
}

/**
 * Picks the NAV row whose date is closest to `target` without going past it,
 * unless no row exists before `target`, in which case it returns the earliest
 * row whose date is after `target`. Returns null only if the series is empty.
 *
 * Assumes `series` is ascending by date.
 */
export function findNavNearDate(series: NavPoint[], target: string): NavPoint | null {
  if (series.length === 0) return null;
  let lastBefore: NavPoint | null = null;
  for (const p of series) {
    if (p.date <= target) lastBefore = p;
    else if (lastBefore) return lastBefore;
    else return p;
  }
  return lastBefore;
}

/**
 * Computes the annualised return (CAGR) between the NAV `years` years ago and
 * the latest NAV. Returns null when the series is too short to span the window
 * (the earliest NAV must be on or before `today − years`), the start/end NAV
 * is non-positive, or the series is empty.
 */
export function computeTrailingReturn(
  series: NavPoint[],
  years: number,
  today?: Date,
): number | null {
  if (series.length === 0 || years <= 0) return null;
  const now = today ?? new Date();
  const targetDate = new Date(now);
  targetDate.setFullYear(targetDate.getFullYear() - years);
  const targetStr = targetDate.toISOString().split('T')[0];

  const seriesFirst = series[0];
  if (seriesFirst.date > targetStr) return null;

  const startNav = findNavNearDate(series, targetStr);
  const endNav = series[series.length - 1];
  if (!startNav || startNav.value <= 0 || endNav.value <= 0) return null;

  const ratio = endNav.value / startNav.value;
  if (ratio <= 0) return null;
  const cagr = Math.pow(ratio, 1 / years) - 1;
  return Number.isFinite(cagr) ? cagr : null;
}

/**
 * Pretty-print a trailing return. Always shows the sign on positive numbers so
 * it parses the same as the rest of the app's signed-delta convention.
 */
export function formatTrailingReturn(value: number | null): string {
  if (value === null) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(1)}%`;
}
