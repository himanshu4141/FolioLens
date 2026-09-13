/**
 * Unit tests for universe-backfill's plan/option provenance precedence guard.
 *
 * Mirrors the logic in supabase/functions/universe-backfill/index.ts:
 * a row already classified from AMFI's own NAVAll columns
 * (plan_option_source='amfi') must never be downgraded by a lower-precedence
 * source (OF's own name-inference fallback, or a run whose OF response
 * predates the field and omits it).
 */

function buildPlanOptionPatch(
  existingPlanOptionSource: string | null,
  item: { plan_type?: string | null; option_type?: string | null; plan_option_source?: string | null },
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const incomingPlanOptionSource = item.plan_option_source ?? null;
  const canWritePlanOption =
    existingPlanOptionSource !== 'amfi' || incomingPlanOptionSource === 'amfi';
  if (canWritePlanOption) {
    if (item.plan_type != null) patch.plan_type = item.plan_type;
    if (item.option_type != null) patch.option_type = item.option_type;
    if (incomingPlanOptionSource != null) patch.plan_option_source = incomingPlanOptionSource;
  }
  return patch;
}

describe('universe-backfill plan/option precedence guard', () => {
  it('does not downgrade an amfi-sourced row when OF regresses to name-inference', () => {
    const patch = buildPlanOptionPatch('amfi', {
      plan_type: 'Regular',
      option_type: 'Growth',
      plan_option_source: 'name',
    });
    expect(patch).toEqual({});
  });

  it('does not downgrade an amfi-sourced row when the incoming response omits provenance entirely', () => {
    const patch = buildPlanOptionPatch('amfi', {
      plan_type: 'Regular',
      option_type: 'Growth',
      plan_option_source: undefined,
    });
    expect(patch).toEqual({});
  });

  it('allows an amfi-sourced row to be refreshed by another amfi-sourced value', () => {
    const patch = buildPlanOptionPatch('amfi', {
      plan_type: 'Direct',
      option_type: 'IDCW',
      plan_option_source: 'amfi',
    });
    expect(patch).toEqual({
      plan_type: 'Direct',
      option_type: 'IDCW',
      plan_option_source: 'amfi',
    });
  });

  it('allows a name-sourced row to be filled in by a subsequent amfi value', () => {
    const patch = buildPlanOptionPatch('name', {
      plan_type: 'Direct',
      option_type: 'Growth',
      plan_option_source: 'amfi',
    });
    expect(patch).toEqual({
      plan_type: 'Direct',
      option_type: 'Growth',
      plan_option_source: 'amfi',
    });
  });

  it('allows a never-classified row (no prior scheme_master row) to be written from any source', () => {
    const patch = buildPlanOptionPatch(null, {
      plan_type: 'Regular',
      option_type: 'Growth',
      plan_option_source: 'name',
    });
    expect(patch).toEqual({
      plan_type: 'Regular',
      option_type: 'Growth',
      plan_option_source: 'name',
    });
  });
});
