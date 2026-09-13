/**
 * Pure name-inference helpers for seed-scheme-master's one-shot bootstrap of
 * scheme_master from mfapi.in's full scheme list. Extracted from
 * seed-scheme-master/index.ts so they can be unit-tested without a live Deno
 * runtime (that file reads Deno env vars and calls Deno.serve at module
 * scope, so it can't be imported directly into Jest).
 *
 * These are the lowest-precedence, last-resort tier of plan/option
 * inference — see the "Inference inventory" table in
 * docs/plans/amfi-nav-format-change.md. A row this module classifies is
 * stamped plan_option_source='name' by the caller, and seed-scheme-master's
 * upsert (`ignoreDuplicates: true`) never touches a scheme_code that already
 * exists in scheme_master, so a row already classified from AMFI's own
 * Plan/Option columns (plan_option_source='amfi') is never downgraded.
 */

/**
 * Detect plan type from an mfapi.in scheme name. Word-boundary matching
 * (`\b`) treats a space and a ` - ` dash-separator identically, so this
 * tolerates both "Fund - Direct Plan - Growth" and "Fund Direct Plan Growth"
 * without requiring the dash. The dash between "Direct"/"Regular" and
 * "Growth" is likewise optional (`-?`) — the classic AMFI shape
 * "Fund - Direct Growth" has only a space there, not a literal dash; a
 * dash-required pattern would silently miss it. Returns null for
 * family-only names that carry no Direct/Regular signal at all — never
 * guesses.
 */
export function detectPlanType(name: string): 'direct' | 'regular' | null {
  const n = name.toLowerCase();
  if (/\bdirect\s+plan\b/.test(n) || /\bdirect\s*-?\s*growth\b/.test(n)) return 'direct';
  if (/\bregular\s+plan\b/.test(n) || /\bregular\s*-?\s*growth\b/.test(n)) return 'regular';
  return null;
}

/** Infer an AMC display name from an mfapi.in scheme name. Best-effort only. */
export function inferAmcName(name: string): string | null {
  const m = name.match(/^(.+?)\s+(Mutual\s+Fund|Fund|Asset Management)/i);
  if (m) return m[1].trim();
  const words = name.split(/\s+/).slice(0, 3).join(' ');
  return words || null;
}
