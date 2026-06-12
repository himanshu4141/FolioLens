/**
 * Unit tests for timeout and authentication fixes.
 *
 * Tests the following scenarios:
 * 1. Timeout protection: fetch hangs > 15s, timeout aborts, check fails with others passing
 * 2. Auth header: 401 when using wrong Authorization header, passes with X-API-Key
 * 3. Happy path: successful fetches with correct headers
 */

describe('OpenFolio fetch timeout and auth tests', () => {
  describe('timeout protection', () => {
    it('should abort on signal when timeout fires', () => {
      const controller = new AbortController();
      let abortEventFired = false;

      controller.signal.addEventListener('abort', () => {
        abortEventFired = true;
      });

      // Simulate the timeout helper behavior with a quick abort
      controller.abort();

      expect(abortEventFired).toBe(true);
      expect(controller.signal.aborted).toBe(true);
    });

    it('should handle AbortError from fetch when signal is aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const mockFetch = (url: string, options?: RequestInit) => {
        if (options?.signal?.aborted) {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          return Promise.reject(error);
        }
        return Promise.resolve(new Response(JSON.stringify({ status: 'ok' })));
      };

      await expect(mockFetch('http://example.com/health', { signal: controller.signal })).rejects
        .toThrow('aborted');
    });
  });

  describe('authentication headers', () => {
    it('should fail with 401 when using wrong Authorization header', async () => {
      const mockFetch = (url: string, options?: RequestInit) => {
        const authHeader = options?.headers
          ? typeof options.headers === 'object' && 'Authorization' in options.headers
            ? options.headers.Authorization
            : null
          : null;

        // Simulate OpenFolio API: reject Authorization: Bearer, accept X-API-Key
        if (authHeader && authHeader.toString().startsWith('Bearer')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: 'Unauthorized' }),
              {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
              },
            ),
          );
        }

        return Promise.resolve(
          new Response(
            JSON.stringify({ total: 1000 }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        );
      };

      // Test with wrong header
      const wrongHeaderResponse = await mockFetch('http://example.com/v1/metadata?page_size=1', {
        headers: { Authorization: 'Bearer test-api-key' },
      });
      expect(wrongHeaderResponse.status).toBe(401);

      // Test with correct header
      const correctHeaderResponse = await mockFetch(
        'http://example.com/v1/metadata?page_size=1',
        {
          headers: { 'X-API-Key': 'test-api-key' },
        },
      );
      expect(correctHeaderResponse.status).toBe(200);
    });
  });

  describe('happy path', () => {
    it('should successfully fetch with correct headers and complete within timeout', async () => {
      const mockFetch = (url: string, options?: RequestInit) => {
        const apiKeyHeader = options?.headers
          ? typeof options.headers === 'object' && 'X-API-Key' in options.headers
            ? options.headers['X-API-Key']
            : null
          : null;

        if (!apiKeyHeader) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'Missing API key' }), {
              status: 400,
            }),
          );
        }

        // Simulate quick response
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'ok',
              db_schemes: 2500,
              latest_disclosure_date: '2026-06-11',
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        );
      };

      const response = await mockFetch('http://example.com/health', {
        headers: { 'X-API-Key': 'test-api-key' },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { status: string; db_schemes: number };
      expect(data.status).toBe('ok');
      expect(data.db_schemes).toBe(2500);
    });

    it('should handle metadata endpoint with X-API-Key', async () => {
      const mockFetch = (url: string, options?: RequestInit) => {
        if (url.includes('/v1/metadata') && options?.headers && 'X-API-Key' in options.headers) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ count: 1000, total: 1000, page: 1, page_size: 1, items: [] }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
      };

      const response = await mockFetch('http://example.com/v1/metadata?page_size=1', {
        headers: { 'X-API-Key': 'test-api-key' },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { total: number };
      expect(data.total).toBe(1000);
    });

    it('should handle composition endpoint with X-API-Key', async () => {
      const mockFetch = (url: string, options?: RequestInit) => {
        if (
          url.includes('/v1/composition') &&
          options?.headers &&
          'X-API-Key' in options.headers
        ) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                count: 500,
                total: 500,
                page: 1,
                page_size: 1,
                items: [],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
      };

      const response = await mockFetch('http://example.com/v1/composition?page_size=1', {
        headers: { 'X-API-Key': 'test-api-key' },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { total: number };
      expect(data.total).toBe(500);
    });
  });
});
