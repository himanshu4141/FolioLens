import { analytics } from '@/src/lib/analytics';
import {
  perfCancel,
  perfEnd,
  perfStart,
} from '@/src/lib/perfMark';

jest.mock('@/src/lib/analytics', () => ({
  analytics: {
    isEnabled: true,
    track: jest.fn(),
    identify: jest.fn(),
    reset: jest.fn(),
    captureException: jest.fn(),
  },
}));

const mockTrack = analytics.track as jest.MockedFunction<typeof analytics.track>;

describe('perfMark', () => {
  const originalWarn = console.warn;

  beforeEach(() => {
    mockTrack.mockReset();
    console.warn = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    console.warn = originalWarn;
  });

  it('keeps concurrent spans with the same label independent', () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const first = perfStart('query:portfolio');
    now = 1_010;
    const second = perfStart('query:portfolio');
    now = 1_025;

    expect(perfEnd(first)).toBe(25);
    now = 1_040;
    expect(perfEnd(second)).toBe(30);
    expect(first).not.toBe(second);
    expect(mockTrack).toHaveBeenNthCalledWith(1, 'perf_mark', expect.objectContaining({
      label: 'query:portfolio',
      elapsed_ms: 25,
    }));
    expect(mockTrack).toHaveBeenNthCalledWith(2, 'perf_mark', expect.objectContaining({
      label: 'query:portfolio',
      elapsed_ms: 30,
    }));
  });

  it('does not emit for a missing, cancelled, or already-closed span', () => {
    const closed = perfStart('closed');
    expect(perfEnd(closed)).toBeGreaterThanOrEqual(0);
    expect(perfEnd(closed)).toBe(-1);

    const cancelled = perfStart('cancelled');
    perfCancel(cancelled);
    expect(perfEnd(cancelled)).toBe(-1);
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

});
