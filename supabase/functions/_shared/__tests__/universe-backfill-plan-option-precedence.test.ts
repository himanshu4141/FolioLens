/**
 * Unit tests for universe-backfill's plan/option provenance precedence.
 *
 * The actual guard against downgrading a row already classified from AMFI's
 * own NAVAll columns (plan_option_source='amfi') is NOT an app-side check —
 * it's a WHERE predicate Postgres evaluates against the row's live state at
 * UPDATE time (`plan_option_source.neq.amfi,plan_option_source.is.null`,
 * skipped only when the incoming source is itself 'amfi'). That's required
 * because universe-backfill (hourly) and sync-fund-meta (daily) can be
 * concurrently mid-run against the same row, so any guard based on a value
 * read earlier in either invocation would be stale by write time — see
 * supabase/functions/universe-backfill/index.ts's planOptionPatch comment.
 *
 * Jest can't exercise the live predicate against Postgres (this repo's
 * Supabase CI validation replays migrations, not application code, against
 * an ephemeral stack). What's testable here, and what a regression would
 * actually break, are the two pure decisions the handler makes before that
 * predicate ever reaches the database:
 *   1. What plan/option fields go in the patch (unconditional — no app-side
 *      gating happens here anymore).
 *   2. Whether the restrictive filter is attached to that UPDATE at all.
 */

function buildPlanOptionPatch(item: {
  plan_type?: string | null;
  option_type?: string | null;
  plan_option_source?: string | null;
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const incomingPlanOptionSource = item.plan_option_source ?? null;
  if (item.plan_type != null) patch.plan_type = item.plan_type;
  if (item.option_type != null) patch.option_type = item.option_type;
  if (incomingPlanOptionSource != null) patch.plan_option_source = incomingPlanOptionSource;
  return patch;
}

function requiresAmfiGuard(planOptionPatch: Record<string, unknown>): boolean {
  return planOptionPatch.plan_option_source !== 'amfi';
}

describe('universe-backfill plan/option patch builder', () => {
  it('includes plan_type/option_type/plan_option_source unconditionally when OF supplies them', () => {
    const patch = buildPlanOptionPatch({
      plan_type: 'Regular',
      option_type: 'Growth',
      plan_option_source: 'name',
    });
    expect(patch).toEqual({ plan_type: 'Regular', option_type: 'Growth', plan_option_source: 'name' });
  });

  it('omits plan_option_source when the OF response predates the field', () => {
    const patch = buildPlanOptionPatch({
      plan_type: 'Regular',
      option_type: 'Growth',
      plan_option_source: undefined,
    });
    expect(patch).toEqual({ plan_type: 'Regular', option_type: 'Growth' });
  });

  it('is empty when OF supplies nothing plan/option-related', () => {
    const patch = buildPlanOptionPatch({});
    expect(patch).toEqual({});
  });
});

describe('universe-backfill plan/option amfi-guard decision', () => {
  it('requires the DB-evaluated guard when the incoming source is name', () => {
    expect(requiresAmfiGuard(buildPlanOptionPatch({ plan_option_source: 'name' }))).toBe(true);
  });

  it('requires the DB-evaluated guard when the incoming source is mixed', () => {
    expect(requiresAmfiGuard(buildPlanOptionPatch({ plan_option_source: 'mixed' }))).toBe(true);
  });

  it('requires the DB-evaluated guard when the response predates provenance (no source at all)', () => {
    expect(
      requiresAmfiGuard(buildPlanOptionPatch({ plan_type: 'Regular', plan_option_source: undefined })),
    ).toBe(true);
  });

  it('skips the guard and writes unconditionally when the incoming source is amfi', () => {
    expect(requiresAmfiGuard(buildPlanOptionPatch({ plan_option_source: 'amfi' }))).toBe(false);
  });
});
