import { probeUpstream } from '../upstream-probe';

const ok = (status = 200): Response =>
  ({ status, ok: status >= 200 && status < 300 }) as unknown as Response;

describe('probeUpstream', () => {
  describe('classifies "up"', () => {
    it('returns up for HTTP 200', async () => {
      const fetcher = jest.fn().mockResolvedValue(ok(200));
      const result = await probeUpstream('https://example.test/health', { fetcher });
      expect(result).toEqual({ status: 'up' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('returns up for HTTP 204', async () => {
      const fetcher = jest.fn().mockResolvedValue(ok(204));
      const result = await probeUpstream('https://example.test/health', { fetcher });
      expect(result).toEqual({ status: 'up' });
    });

    it('returns up for HTTP 301 (redirect)', async () => {
      const fetcher = jest.fn().mockResolvedValue(ok(301));
      const result = await probeUpstream('https://example.test/health', { fetcher });
      expect(result).toEqual({ status: 'up' });
    });

    it('returns up for HTTP 404 (their bug, but origin is reachable)', async () => {
      const fetcher = jest.fn().mockResolvedValue(ok(404));
      const result = await probeUpstream('https://example.test/health', { fetcher });
      expect(result).toEqual({ status: 'up' });
    });

    it('returns up for HTTP 429 (rate-limited but upstream is up)', async () => {
      const fetcher = jest.fn().mockResolvedValue(ok(429));
      const result = await probeUpstream('https://example.test/health', { fetcher });
      expect(result).toEqual({ status: 'up' });
    });

    it('returns up for HTTP 499 (boundary just below 5xx)', async () => {
      const fetcher = jest.fn().mockResolvedValue(ok(499));
      const result = await probeUpstream('https://example.test/health', { fetcher });
      expect(result).toEqual({ status: 'up' });
    });
  });

  describe('classifies "down" for 5xx', () => {
    it('returns down/http_5xx for HTTP 500', async () => {
      const fetcher = jest.fn().mockResolvedValue(ok(500));
      const result = await probeUpstream('https://example.test/health', { fetcher });
      expect(result).toEqual({ status: 'down', reason: 'http_5xx', httpStatus: 500 });
    });

    it('returns down/http_5xx for HTTP 502', async () => {
      const fetcher = jest.fn().mockResolvedValue(ok(502));
      const result = await probeUpstream('https://example.test/health', { fetcher });
      expect(result).toEqual({ status: 'down', reason: 'http_5xx', httpStatus: 502 });
    });

    it('returns down/http_5xx for Cloudflare 522 origin connection timeout', async () => {
      const fetcher = jest.fn().mockResolvedValue(ok(522));
      const result = await probeUpstream('https://example.test/health', { fetcher });
      expect(result).toEqual({ status: 'down', reason: 'http_5xx', httpStatus: 522 });
    });

    it('returns down/http_5xx for Cloudflare 524 origin response timeout', async () => {
      const fetcher = jest.fn().mockResolvedValue(ok(524));
      const result = await probeUpstream('https://example.test/health', { fetcher });
      expect(result).toEqual({ status: 'down', reason: 'http_5xx', httpStatus: 524 });
    });
  });

  describe('classifies "down" for network / timeout', () => {
    it('returns down/timeout when fetcher throws AbortError', async () => {
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      const fetcher = jest.fn().mockRejectedValue(abortError);
      const result = await probeUpstream('https://example.test/health', { fetcher });
      expect(result).toEqual({ status: 'down', reason: 'timeout' });
    });

    it('returns down/network for a DNS-style TypeError', async () => {
      const fetcher = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
      const result = await probeUpstream('https://example.test/health', { fetcher });
      expect(result).toEqual({ status: 'down', reason: 'network' });
    });

    it('returns down/network for non-Error throwables (defensive)', async () => {
      // Using a thenable that rejects with a non-Error guards the catch-all.
      const fetcher = jest.fn().mockRejectedValue('string-rejection');
      const result = await probeUpstream('https://example.test/health', { fetcher });
      expect(result).toEqual({ status: 'down', reason: 'network' });
    });
  });

  describe('controller wiring', () => {
    it('passes an AbortSignal to the fetcher so a stuck upstream can be cut off', async () => {
      const fetcher = jest.fn().mockResolvedValue(ok(200));
      await probeUpstream('https://example.test/health', { fetcher });
      const init = fetcher.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBeDefined();
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('aborts the in-flight request when timeoutMs elapses', async () => {
      // Construct a fetcher that resolves with the signal state at the moment
      // it would normally have responded. With a 5 ms timeout and a 50 ms
      // delay before observing the signal, the controller has already fired.
      let observedAborted = false;
      const fetcher = jest.fn((_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => {
            observedAborted = true;
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
          setTimeout(() => resolve(ok(200)), 50);
        }),
      );
      const result = await probeUpstream('https://example.test/health', { fetcher, timeoutMs: 5 });
      expect(observedAborted).toBe(true);
      expect(result).toEqual({ status: 'down', reason: 'timeout' });
    });

    it('uses the global fetch when no fetcher is injected', async () => {
      const spy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(ok(200));
      try {
        const result = await probeUpstream('https://example.test/health');
        expect(result).toEqual({ status: 'up' });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('uses the default timeout when no timeoutMs is given', async () => {
      // We can't observe the default-8000 directly, but we can confirm the
      // call path through the default branch by calling without timeoutMs
      // and seeing the result complete normally.
      const fetcher = jest.fn().mockResolvedValue(ok(200));
      const result = await probeUpstream('https://example.test/health', { fetcher });
      expect(result).toEqual({ status: 'up' });
    });

    it('uses fully-default options when called without any opts', async () => {
      const spy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(ok(503));
      try {
        const result = await probeUpstream('https://example.test/health');
        expect(result).toEqual({ status: 'down', reason: 'http_5xx', httpStatus: 503 });
      } finally {
        spy.mockRestore();
      }
    });
  });
});
