import { shouldStartFreshCycle } from '../refresh-cycle';

describe('shouldStartFreshCycle', () => {
  it('does not reset when no refresh is due (ad-hoc / single-phase resume)', () => {
    expect(
      shouldStartFreshCycle({ force: false, refreshDueMonth: null, cycleStartedMonth: null }),
    ).toBe(false);
    // Even an explicit force is a no-op when nothing is due — the phase blocks
    // handle force=true on their own; this guard only governs cycle resets.
    expect(
      shouldStartFreshCycle({ force: true, refreshDueMonth: null, cycleStartedMonth: '2026-06' }),
    ).toBe(false);
  });

  it('starts a fresh cycle on an explicit force for the due month (monthly kickoff)', () => {
    expect(
      shouldStartFreshCycle({ force: true, refreshDueMonth: '2026-06', cycleStartedMonth: null }),
    ).toBe(true);
    expect(
      shouldStartFreshCycle({
        force: true,
        refreshDueMonth: '2026-06',
        cycleStartedMonth: '2026-06',
      }),
    ).toBe(true);
  });

  it('starts a fresh cycle the first time a new month is observed', () => {
    // No cycle started yet.
    expect(
      shouldStartFreshCycle({ force: false, refreshDueMonth: '2026-06', cycleStartedMonth: null }),
    ).toBe(true);
    // A new month after last month completed (or stalled).
    expect(
      shouldStartFreshCycle({
        force: false,
        refreshDueMonth: '2026-07',
        cycleStartedMonth: '2026-06',
      }),
    ).toBe(true);
  });

  it('RESUMES (does not reset) when the due month is already in progress — the deadlock fix', () => {
    // This is the exact case that previously reset the cursor on every resume
    // run, pinning the backfill at page 2 forever.
    expect(
      shouldStartFreshCycle({
        force: false,
        refreshDueMonth: '2026-06',
        cycleStartedMonth: '2026-06',
      }),
    ).toBe(false);
  });
});
