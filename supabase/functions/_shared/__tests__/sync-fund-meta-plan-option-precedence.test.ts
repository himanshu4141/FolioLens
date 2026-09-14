/**
 * Unit tests for sync-fund-meta's plan/option provenance precedence.
 *
 * The guard against downgrading a row already classified from AMFI's own
 * NAVAll columns (plan_option_source='amfi') is NOT an app-side check based
 * on a SELECT taken earlier in this invocation — it's a WHERE predicate
 * Postgres evaluates against the row's live state at UPDATE time
 * (`plan_option_source.neq.amfi,plan_option_source.is.null`, skipped only
 * when the incoming source is itself 'amfi'). That's required because this
 * function (daily) and universe-backfill (hourly) can be concurrently
 * mid-run against the same row, so a guard based on an earlier read would be
 * stale by write time — see supabase/functions/sync-fund-meta/index.ts's
 * planOptionPayload comment.
 *
 * Jest can't exercise the live predicate against Postgres. What's testable
 * here, and what a regression would actually break, are the pure decisions
 * the handler makes before that predicate ever reaches the database:
 *   1. Same-run precedence between OF and mfdata (OF wins when both supply a
 *      value; mfdata only fills what OF left blank this run).
 *   2. Whether the restrictive DB-side filter gets attached to the UPDATE.
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

function buildPlanOptionPayload(ofMeta: OfMeta | null, mfdata: MfData | null): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (ofMeta) {
    const incomingOfPlanOptionSource = ofMeta.plan_option_source ?? null;
    if (ofMeta.plan_type != null) payload.plan_type = ofMeta.plan_type;
    if (ofMeta.option_type != null) payload.option_type = ofMeta.option_type;
    if (incomingOfPlanOptionSource != null) payload.plan_option_source = incomingOfPlanOptionSource;
  }

  if (mfdata) {
    let mfdataSourcedPlanOrOption = false;
    if (payload.plan_type == null && mfdata.plan_type != null) {
      payload.plan_type = mfdata.plan_type;
      mfdataSourcedPlanOrOption = true;
    }
    if (payload.option_type == null && mfdata.option_type != null) {
      payload.option_type = mfdata.option_type;
      mfdataSourcedPlanOrOption = true;
    }
    if (mfdataSourcedPlanOrOption && payload.plan_option_source == null) {
      payload.plan_option_source = 'mfdata';
    }
  }

  return payload;
}

function requiresAmfiGuard(planOptionPayload: Record<string, unknown>): boolean {
  return planOptionPayload.plan_option_source !== 'amfi';
}

describe('sync-fund-meta plan/option payload builder', () => {
  describe('OF branch', () => {
    it('includes OF plan_type/option_type/plan_option_source unconditionally', () => {
      const payload = buildPlanOptionPayload(
        { plan_type: 'Regular', option_type: 'Growth', plan_option_source: 'name' },
        null,
      );
      expect(payload).toEqual({ plan_type: 'Regular', option_type: 'Growth', plan_option_source: 'name' });
    });

    it('omits plan_option_source when OF response predates the field', () => {
      const payload = buildPlanOptionPayload({ plan_type: 'Regular', option_type: 'Growth' }, null);
      expect(payload).toEqual({ plan_type: 'Regular', option_type: 'Growth' });
    });
  });

  describe('mfdata-exclusive branch', () => {
    it('lets mfdata fill plan_type/option_type when OF is absent', () => {
      const payload = buildPlanOptionPayload(null, { plan_type: 'Regular', option_type: 'Growth' });
      expect(payload).toEqual({
        plan_type: 'Regular',
        option_type: 'Growth',
        plan_option_source: 'mfdata',
      });
    });

    it('does not let mfdata overwrite a plan_type OF already supplied this run', () => {
      const payload = buildPlanOptionPayload(
        { plan_type: 'Direct', plan_option_source: 'amfi' },
        { plan_type: 'Regular', option_type: 'Growth' },
      );
      expect(payload).toEqual({
        plan_type: 'Direct',
        option_type: 'Growth',
        plan_option_source: 'amfi',
      });
    });

    it('does not overwrite plan_option_source already set by the OF branch in the same run', () => {
      const payload = buildPlanOptionPayload(
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

describe('sync-fund-meta plan/option amfi-guard decision', () => {
  it('requires the DB-evaluated guard when the final source is name', () => {
    expect(requiresAmfiGuard(buildPlanOptionPayload({ plan_option_source: 'name' }, null))).toBe(true);
  });

  it('requires the DB-evaluated guard when the final source is mfdata', () => {
    expect(
      requiresAmfiGuard(buildPlanOptionPayload(null, { plan_type: 'Regular' })),
    ).toBe(true);
  });

  it('skips the guard and writes unconditionally when the final source is amfi', () => {
    expect(requiresAmfiGuard(buildPlanOptionPayload({ plan_option_source: 'amfi' }, null))).toBe(false);
  });
});
