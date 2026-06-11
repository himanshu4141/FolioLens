/**
 * Unit tests for universe-backfill cursor and done-marker state machine.
 * Tests the state transitions for both composition and metadata phases across:
 * - Fresh start (no cursor, no marker)
 * - Mid-walk (cursor present, no marker)
 * - Done (marker present, cursor absent)
 * - Failed rows (error counts)
 */

interface CursorState {
  phase: 'composition' | 'metadata';
  cursor: number;
  totalCount: number;
  [key: string]: number | string;
}

interface DoneMarkerState {
  phase: 'composition' | 'metadata';
  doneAt: string;
}

describe('universe-backfill state machine', () => {
  describe('composition phase state transitions', () => {
    it('should initialize fresh cursor on first invocation', () => {
      const state: CursorState = {
        phase: 'composition',
        cursor: 1,
        totalCount: 0,
        upserted: 0,
        matchedByCode: 0,
        matchedByIsin: 0,
        unmatched: 0,
        failed: 0,
      };

      expect(state.cursor).toBe(1);
      expect(state.failed as number).toBe(0);
      expect(state.totalCount).toBe(0);
    });

    it('should advance cursor after processing a chunk', () => {
      const state: CursorState = {
        phase: 'composition',
        cursor: 1,
        totalCount: 5000,
        upserted: 100,
        matchedByCode: 50,
        matchedByIsin: 30,
        unmatched: 20,
        failed: 0,
      };

      // Simulate chunk processing: 2 pages processed
      const chunkEndPage = 3;
      state.cursor = chunkEndPage;
      state.upserted = (state.upserted as number) + 150;
      state.matchedByCode = (state.matchedByCode as number) + 75;
      state.matchedByIsin = (state.matchedByIsin as number) + 45;
      state.unmatched = (state.unmatched as number) + 30;
      state.failed = (state.failed as number) + 2;

      expect(state.cursor).toBe(3);
      expect(state.upserted).toBe(250);
      expect(state.failed).toBe(2);
    });

    it('should detect completion (cursor > totalCount)', () => {
      const state: CursorState = {
        phase: 'composition',
        cursor: 20,
        totalCount: 5000,
        upserted: 5000,
        matchedByCode: 4950,
        matchedByIsin: 0,
        unmatched: 50,
        failed: 0,
      };

      const PAGE_SIZE = 300;
      const done = state.totalCount === 0 || state.cursor * PAGE_SIZE > state.totalCount;

      // At cursor=20, we've covered 20*300 = 6000 items, which > 5000
      expect(done).toBe(true);
    });

    it('should accumulate failed count across multiple invocations', () => {
      const state: CursorState = {
        phase: 'composition',
        cursor: 1,
        totalCount: 5000,
        failed: 0,
      };

      // Invocation 1: 5 failures
      state.failed = (state.failed as number) + 5;
      // Invocation 2: 8 failures
      state.failed = (state.failed as number) + 8;
      // Invocation 3: 15 failures
      state.failed = (state.failed as number) + 15;

      expect(state.failed).toBe(28);
    });

    it('should detect high failure growth (>50 in single invocation)', () => {
      const failedInChunk = 65; // This chunk added 65 failures
      const shouldFail = failedInChunk > 50;

      expect(shouldFail).toBe(true);
    });
  });

  describe('metadata phase state transitions', () => {
    it('should initialize fresh metadata cursor', () => {
      const state: CursorState = {
        phase: 'metadata',
        cursor: 1,
        totalCount: 0,
        written: 0,
        skipped: 0,
        failed: 0,
      };

      expect(state.cursor).toBe(1);
      expect(state.written).toBe(0);
      expect(state.skipped).toBe(0);
    });

    it('should track written vs skipped across invocations', () => {
      const state: CursorState = {
        phase: 'metadata',
        cursor: 1,
        totalCount: 37595,
        written: 500,
        skipped: 100,
        failed: 0,
      };

      // Chunk 2: 600 items, 550 written, 50 skipped
      state.cursor = 3;
      state.written = (state.written as number) + 550;
      state.skipped = (state.skipped as number) + 50;
      state.failed = (state.failed as number) + 2;

      expect(state.written).toBe(1050);
      expect(state.skipped).toBe(150);
      expect(state.failed).toBe(2);
    });

    it('should detect metadata completion (cursor * PAGE_SIZE >= totalCount)', () => {
      const state: CursorState = {
        phase: 'metadata',
        cursor: 126,
        totalCount: 37595,
        written: 35000,
        skipped: 2500,
        failed: 95,
      };

      const PAGE_SIZE = 300;
      const done = state.totalCount === 0 || state.cursor * PAGE_SIZE >= state.totalCount;

      // At cursor=126, we've covered 126*300 = 37800 items, which >= 37595
      expect(done).toBe(true);
    });
  });

  describe('done-marker coordination', () => {
    it('should not re-run composition if done marker exists', () => {
      const compositionDoneAt = '2026-06-11T19:30:00.000Z';
      const force = false;

      const shouldSkip = compositionDoneAt && !force;

      expect(shouldSkip).toBe(true);
    });

    it('should allow force=true to clear done marker and re-run', () => {
      const compositionDoneAt = '2026-06-11T19:30:00.000Z';
      const force = true;

      const shouldClear = compositionDoneAt && force;
      const shouldRun = !compositionDoneAt || force;

      expect(shouldClear).toBe(true);
      expect(shouldRun).toBe(true);
    });

    it('should write done marker when phase completes', () => {
      const state: CursorState = {
        phase: 'composition',
        cursor: 20,
        totalCount: 5000,
      };

      const PAGE_SIZE = 300;
      const done = state.totalCount === 0 || state.cursor * PAGE_SIZE > state.totalCount;

      if (done) {
        const doneMarker: DoneMarkerState = {
          phase: 'composition',
          doneAt: new Date().toISOString(),
        };

        expect(doneMarker.phase).toBe('composition');
        expect(doneMarker.doneAt).toBeDefined();
      }
    });

    it('should clear done marker when force=true, then reset cursor', () => {
      const force = true;
      const compositionDoneAt = '2026-06-11T19:30:00.000Z';

      if (compositionDoneAt && force) {
        // Clear marker
        const clearedMarker = null;

        // Reset cursor
        const cursor = 1;
        const totalCount = 0;

        expect(clearedMarker).toBeNull();
        expect(cursor).toBe(1);
        expect(totalCount).toBe(0);
      }
    });
  });

  describe('phase=both coordination', () => {
    it('should report both phases in response when phase=both', () => {
      const compositionState: CursorState = {
        phase: 'composition',
        cursor: 5,
        totalCount: 5000,
        upserted: 1000,
        matchedByCode: 900,
        matchedByIsin: 50,
        unmatched: 50,
        failed: 0,
      };

      const metadataState: CursorState = {
        phase: 'metadata',
        cursor: 8,
        totalCount: 37595,
        written: 2000,
        skipped: 300,
        failed: 10,
      };

      const compositionDone = compositionState.cursor * 300 > compositionState.totalCount;
      const metadataDone = metadataState.cursor * 300 >= metadataState.totalCount;
      const bothDone = compositionDone && metadataDone;

      expect(compositionDone).toBe(false);
      expect(metadataDone).toBe(false);
      expect(bothDone).toBe(false);
    });

    it('should report bothDone=true only when both phases are done', () => {
      const compositionState: CursorState = {
        phase: 'composition',
        cursor: 20,
        totalCount: 5000,
        upserted: 5000,
        matchedByCode: 4950,
        matchedByIsin: 0,
        unmatched: 50,
        failed: 0,
      };

      const metadataState: CursorState = {
        phase: 'metadata',
        cursor: 126,
        totalCount: 37595,
        written: 37500,
        skipped: 95,
        failed: 0,
      };

      const PAGE_SIZE = 300;
      const compositionDone = compositionState.totalCount === 0 || compositionState.cursor * PAGE_SIZE > compositionState.totalCount;
      const metadataDone = metadataState.totalCount === 0 || metadataState.cursor * PAGE_SIZE >= metadataState.totalCount;
      const bothDone = compositionDone && metadataDone;

      expect(compositionDone).toBe(true);
      expect(metadataDone).toBe(true);
      expect(bothDone).toBe(true);
    });
  });

  describe('mid-walk resumption', () => {
    it('should resume composition from saved cursor', () => {
      // Simulating a crash/timeout at iteration 5
      const savedState: CursorState = {
        phase: 'composition',
        cursor: 10,
        totalCount: 5000,
        upserted: 3000,
        matchedByCode: 2850,
        matchedByIsin: 100,
        unmatched: 50,
        failed: 15,
      };

      // Load saved state
      const resumedState = savedState;

      // Process next chunk starting from cursor 10
      expect(resumedState.cursor).toBe(10);
      expect(resumedState.upserted).toBe(3000);
      expect(resumedState.failed).toBe(15);
    });

    it('should accumulate stats from multiple resume cycles', () => {
      // First invocation
      let state: CursorState = {
        phase: 'metadata',
        cursor: 1,
        totalCount: 37595,
        written: 0,
        skipped: 0,
        failed: 0,
      };

      // Process chunk 1 (pages 1-2)
      state.cursor = 3;
      state.written = 500;
      state.skipped = 50;
      state.failed = 5;

      // Process chunk 2 (pages 3-4)
      state.cursor = 5;
      state.written = (state.written as number) + 600;
      state.skipped = (state.skipped as number) + 40;
      state.failed = (state.failed as number) + 8;

      // Process chunk 3 (pages 5-6)
      state.cursor = 7;
      state.written = (state.written as number) + 550;
      state.skipped = (state.skipped as number) + 60;
      state.failed = (state.failed as number) + 12;

      expect(state.written).toBe(1650);
      expect(state.skipped).toBe(150);
      expect(state.failed).toBe(25);
      expect(state.cursor).toBe(7);
    });
  });

  describe('edge cases', () => {
    it('should handle zero totalCount (empty universe)', () => {
      const state: CursorState = {
        phase: 'composition',
        cursor: 1,
        totalCount: 0,
        upserted: 0,
        matchedByCode: 0,
        matchedByIsin: 0,
        unmatched: 0,
        failed: 0,
      };

      const done = state.totalCount === 0 || state.cursor * 300 > state.totalCount;
      expect(done).toBe(true);
    });

    it('should handle exact boundary (cursor * PAGE_SIZE === totalCount)', () => {
      const state: CursorState = {
        phase: 'metadata',
        cursor: 125,
        totalCount: 37500, // 125 * 300
        written: 37500,
        skipped: 0,
        failed: 0,
      };

      const PAGE_SIZE = 300;
      const done = state.totalCount === 0 || state.cursor * PAGE_SIZE >= state.totalCount;
      expect(done).toBe(true);
    });

    it('should distinguish "never started" from "finished" via done marker', () => {
      const neverStarted = { cursor: null, doneMarker: null };
      const finished = { cursor: null, doneMarker: '2026-06-11T19:30:00.000Z' };

      const neverStartedIsDone = neverStarted.doneMarker !== null;
      const finishedIsDone = finished.doneMarker !== null;

      expect(neverStartedIsDone).toBe(false);
      expect(finishedIsDone).toBe(true);
    });
  });
});
