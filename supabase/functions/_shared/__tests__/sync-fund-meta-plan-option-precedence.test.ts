/**
 * Unit tests for sync-fund-meta's plan/option provenance precedence guard.
 *
 * Mirrors the logic in supabase/functions/sync-fund-meta/index.ts across both
 * the OF branch and the mfdata-exclusive fallback: a row already classified
 * from AMFI's own NAVAll columns (plan_option_source='amfi') must never be
 * downgraded by a lower-precedence source — OF regressing to name-inference,
 * an OF response that omits the field, or mfdata's coarser labels.
 */

interface OfMeta {
  plan_type?: string | null;
  option_type?: string | null;
  plan_option_source?: string | null;
}

interface MfData {
  plan_type?: string | null;
  option_type?: string | null;
}

function buildPlanOptionPayload(
  existingPlanOptionSource: string | null,
  ofMeta: OfMeta | null,
  mfdata: MfData | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (ofMeta) {
    const incomingOfPlanOptionSource = ofMeta.plan_option_source ?? null;
    const canWriteOfPlanOption =
      existingPlanOptionSource !== 'amfi' || incomingOfPlanOptionSource === 'amfi';
    if (canWriteOfPlanOption) {
      if (ofMeta.plan_type != null) payload.plan_type = ofMeta.plan_type;
      if (ofMeta.option_type != null) payload.option_type = ofMeta.option_type;
      if (incomingOfPlanOptionSource != null) payload.plan_option_source = incomingOfPlanOptionSource;
    }
  }

  if (mfdata) {
    const canFillFromMfdata = existingPlanOptionSource !== 'amfi';
    let mfdataSourcedPlanOrOption = false;
    if (canFillFromMfdata && payload.plan_type == null && mfdata.plan_type != null) {
      payload.plan_type = mfdata.plan_type;
      mfdataSourcedPlanOrOption = true;
    }
    if (canFillFromMfdata && payload.option_type == null && mfdata.option_type != null) {
      payload.option_type = mfdata.option_type;
      mfdataSourcedPlanOrOption = true;
    }
    if (mfdataSourcedPlanOrOption && payload.plan_option_source == null) {
      payload.plan_option_source = 'mfdata';
    }
  }

  return payload;
}

describe('sync-fund-meta plan/option precedence guard', () => {
  describe('OF branch', () => {
    it('does not downgrade an amfi-sourced row when OF regresses to name-inference', () => {
      const payload = buildPlanOptionPayload(
        'amfi',
        { plan_type: 'Regular', option_type: 'Growth', plan_option_source: 'name' },
        null,
      );
      expect(payload).toEqual({});
    });

    it('does not downgrade an amfi-sourced row when OF omits provenance entirely', () => {
      const payload = buildPlanOptionPayload(
        'amfi',
        { plan_type: 'Regular', option_type: 'Growth' },
        null,
      );
      expect(payload).toEqual({});
    });

    it('allows an amfi-sourced row to be refreshed by another amfi-sourced OF value', () => {
      const payload = buildPlanOptionPayload(
        'amfi',
        { plan_type: 'Direct', option_type: 'IDCW', plan_option_source: 'amfi' },
        null,
      );
      expect(payload).toEqual({
        plan_type: 'Direct',
        option_type: 'IDCW',
        plan_option_source: 'amfi',
      });
    });
  });

  describe('mfdata-exclusive branch', () => {
    it('does not let mfdata fill plan_type/option_type on an amfi-sourced row when OF is absent', () => {
      const payload = buildPlanOptionPayload('amfi', null, {
        plan_type: 'Regular',
        option_type: 'Growth',
      });
      expect(payload).toEqual({});
    });

    it('lets mfdata fill in plan_type/option_type when the row has no prior amfi classification', () => {
      const payload = buildPlanOptionPayload(null, null, {
        plan_type: 'Regular',
        option_type: 'Growth',
      });
      expect(payload).toEqual({
        plan_type: 'Regular',
        option_type: 'Growth',
        plan_option_source: 'mfdata',
      });
    });

    it('does not overwrite plan_option_source already set by the OF branch in the same run', () => {
      const payload = buildPlanOptionPayload(
        'name',
        { plan_type: 'Direct', plan_option_source: 'name' },
        { option_type: 'Growth' },
      );
      expect(payload).toEqual({
        plan_type: 'Direct',
        option_type: 'Growth',
        plan_option_source: 'name',
      });
    });
  });
});
