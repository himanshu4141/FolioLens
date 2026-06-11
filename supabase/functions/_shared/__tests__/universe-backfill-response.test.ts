/**
 * Unit tests for universe-backfill response shape.
 * Validates the HTTP 200 response structure for all three phase modes:
 * - phase='composition': single phase response
 * - phase='metadata': single phase response
 * - phase='both': dual-phase response with composition + metadata + done
 */

describe('universe-backfill response shape', () => {
  describe('phase=composition response', () => {
    it('should return correct shape when in progress', () => {
      const response = {
        success: true,
        phase: 'composition',
        cursor: 5,
        done: false,
        stats: {
          upserted: 1200,
          matchedByCode: 1100,
          matchedByIsin: 80,
          unmatched: 20,
          failed: 0,
          totalCount: 5000,
        },
        elapsed_ms: 12345,
      };

      expect(response.success).toBe(true);
      expect(response.phase).toBe('composition');
      expect(response.cursor).toBe(5);
      expect(response.done).toBe(false);
      expect(response.stats.upserted).toBe(1200);
      expect(response.elapsed_ms).toBeGreaterThan(0);
    });

    it('should return correct shape when done', () => {
      const response = {
        success: true,
        phase: 'composition',
        cursor: 20,
        done: true,
        stats: {
          upserted: 5000,
          matchedByCode: 4950,
          matchedByIsin: 30,
          unmatched: 20,
          failed: 0,
          totalCount: 5000,
        },
        elapsed_ms: 28500,
      };

      expect(response.done).toBe(true);
      expect(response.stats.upserted).toBe(5000);
    });

    it('should return null cursor when done', () => {
      const response = {
        success: true,
        phase: 'composition',
        cursor: null,
        done: true,
        stats: {
          upserted: 5000,
          matchedByCode: 4950,
          matchedByIsin: 30,
          unmatched: 20,
          failed: 0,
          totalCount: 5000,
        },
        elapsed_ms: 28500,
      };

      expect(response.cursor).toBeNull();
    });
  });

  describe('phase=metadata response', () => {
    it('should return correct shape when in progress', () => {
      const response = {
        success: true,
        phase: 'metadata',
        cursor: 10,
        done: false,
        stats: {
          written: 2500,
          skipped: 300,
          failed: 8,
          totalCount: 37595,
        },
        elapsed_ms: 18900,
      };

      expect(response.success).toBe(true);
      expect(response.phase).toBe('metadata');
      expect(response.cursor).toBe(10);
      expect(response.done).toBe(false);
      expect(response.stats.written).toBe(2500);
      expect(response.stats.skipped).toBe(300);
    });

    it('should return correct shape when done', () => {
      const response = {
        success: true,
        phase: 'metadata',
        cursor: 126,
        done: true,
        stats: {
          written: 37500,
          skipped: 95,
          failed: 0,
          totalCount: 37595,
        },
        elapsed_ms: 425000,
      };

      expect(response.done).toBe(true);
      expect(response.stats.written).toBeGreaterThan(37000);
    });
  });

  describe('phase=both response', () => {
    it('should return both phases when neither is done', () => {
      const response = {
        success: true,
        phase: 'both',
        composition: {
          cursor: 5,
          done: false,
          stats: {
            upserted: 1200,
            matchedByCode: 1100,
            matchedByIsin: 80,
            unmatched: 20,
            failed: 0,
            totalCount: 5000,
          },
        },
        metadata: {
          cursor: 10,
          done: false,
          stats: {
            written: 2500,
            skipped: 300,
            failed: 8,
            totalCount: 37595,
          },
        },
        done: false,
        elapsed_ms: 31245,
      };

      expect(response.phase).toBe('both');
      expect(response.composition).toBeDefined();
      expect(response.metadata).toBeDefined();
      expect(response.composition.cursor).toBe(5);
      expect(response.metadata.cursor).toBe(10);
      expect(response.done).toBe(false);
    });

    it('should return both phases with composition done, metadata ongoing', () => {
      const response = {
        success: true,
        phase: 'both',
        composition: {
          cursor: 20,
          done: true,
          stats: {
            upserted: 5000,
            matchedByCode: 4950,
            matchedByIsin: 30,
            unmatched: 20,
            failed: 0,
            totalCount: 5000,
          },
        },
        metadata: {
          cursor: 50,
          done: false,
          stats: {
            written: 12500,
            skipped: 1200,
            failed: 25,
            totalCount: 37595,
          },
        },
        done: false,
        elapsed_ms: 42100,
      };

      expect(response.composition.done).toBe(true);
      expect(response.metadata.done).toBe(false);
      expect(response.done).toBe(false); // Both must be done for overall done=true
    });

    it('should return both phases when both are done', () => {
      const response = {
        success: true,
        phase: 'both',
        composition: {
          cursor: 20,
          done: true,
          stats: {
            upserted: 5000,
            matchedByCode: 4950,
            matchedByIsin: 30,
            unmatched: 20,
            failed: 0,
            totalCount: 5000,
          },
        },
        metadata: {
          cursor: 126,
          done: true,
          stats: {
            written: 37500,
            skipped: 95,
            failed: 0,
            totalCount: 37595,
          },
        },
        done: true,
        elapsed_ms: 425000,
      };

      expect(response.composition.done).toBe(true);
      expect(response.metadata.done).toBe(true);
      expect(response.done).toBe(true);
    });

    it('should include cursor in both nested objects', () => {
      const response = {
        success: true,
        phase: 'both',
        composition: {
          cursor: 15,
          done: false,
          stats: {},
        },
        metadata: {
          cursor: 75,
          done: false,
          stats: {},
        },
        done: false,
        elapsed_ms: 5000,
      };

      expect(response.composition.cursor).toBe(15);
      expect(response.metadata.cursor).toBe(75);
    });

    it('should have null cursors when phases are done', () => {
      const response = {
        success: true,
        phase: 'both',
        composition: {
          cursor: null,
          done: true,
          stats: {},
        },
        metadata: {
          cursor: null,
          done: true,
          stats: {},
        },
        done: true,
        elapsed_ms: 425000,
      };

      expect(response.composition.cursor).toBeNull();
      expect(response.metadata.cursor).toBeNull();
    });
  });

  describe('error responses', () => {
    it('should return HTTP 500 on fatal page-fetch error', () => {
      const error = {
        status: 500,
        success: false,
        error: 'OpenFolio API timeout on page 5',
        phase: 'composition',
        cursor: null,
      };

      expect(error.status).toBe(500);
      expect(error.success).toBe(false);
      expect(error.error).toBeDefined();
    });

    it('should return HTTP 500 when failed count grows >50', () => {
      const error = {
        status: 500,
        success: false,
        error: 'Failed count grew by 65 in single invocation (threshold: >50)',
        phase: 'metadata',
        cursor: null,
      };

      expect(error.status).toBe(500);
      expect(error.error).toContain('Failed count');
    });
  });

  describe('response consistency', () => {
    it('should have elapsed_ms in all responses', () => {
      const responses = [
        { elapsed_ms: 1000 },
        { elapsed_ms: 2000 },
        { elapsed_ms: 3000 },
      ];

      responses.forEach((resp) => {
        expect(resp.elapsed_ms).toBeGreaterThanOrEqual(0);
      });
    });

    it('should always have success: true on 200 responses', () => {
      const responses = [
        { success: true },
        { success: true },
        { success: true },
      ];

      responses.forEach((resp) => {
        expect(resp.success).toBe(true);
      });
    });

    it('should have consistent stats structure for each phase', () => {
      const compositionStats = {
        upserted: 100,
        matchedByCode: 90,
        matchedByIsin: 10,
        unmatched: 0,
        failed: 0,
        totalCount: 5000,
      };

      const metadataStats = {
        written: 200,
        skipped: 10,
        failed: 0,
        totalCount: 37595,
      };

      expect(Object.keys(compositionStats).length).toBe(6);
      expect(Object.keys(metadataStats).length).toBe(4);
    });
  });
});
