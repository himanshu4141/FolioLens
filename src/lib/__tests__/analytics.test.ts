import { analytics } from '../analytics';

describe('analytics fallback (Node testEnvironment)', () => {
  it('exposes the contract used by callers', () => {
    expect(typeof analytics.track).toBe('function');
    expect(typeof analytics.identify).toBe('function');
    expect(typeof analytics.reset).toBe('function');
    expect(typeof analytics.captureException).toBe('function');
  });

  it('reports as disabled', () => {
    expect(analytics.isEnabled).toBe(false);
  });

  it('every method no-ops without throwing', () => {
    expect(() => analytics.track('event', { k: 'v' })).not.toThrow();
    expect(() => analytics.identify('user-1', { plan: 'free' })).not.toThrow();
    expect(() => analytics.reset()).not.toThrow();
    expect(() => analytics.captureException(new Error('boom'))).not.toThrow();
    expect(() => analytics.captureException('string error')).not.toThrow();
  });
});
