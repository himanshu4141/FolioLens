jest.mock('@/src/lib/analytics', () => ({
  analytics: { track: jest.fn() },
}));

// Minimal `useEffect` / `useRef` shim — Jest in Node has no React renderer
// hooked up, so we capture the effect body as it's registered, then run it
// manually. The shared module-level `let`s below are populated each call.
let capturedEffect: (() => void) | null = null;
let capturedRef: { current: boolean } | null = null;
jest.mock('react', () => ({
  useEffect: (fn: () => void) => {
    capturedEffect = fn;
  },
  useRef: <T,>(initial: T) => {
    const ref = { current: initial } as { current: boolean };
    capturedRef = ref;
    return ref as unknown as { current: T };
  },
}));

// eslint-disable-next-line import/first -- mocks must be registered before the modules they replace are imported
import { useTrackInsightViewed } from '../useTrackInsightViewed';
// eslint-disable-next-line import/first -- mocks must be registered before the modules they replace are imported
import { analytics } from '@/src/lib/analytics';

describe('useTrackInsightViewed', () => {
  beforeEach(() => {
    (analytics.track as jest.Mock).mockClear();
    capturedEffect = null;
    capturedRef = null;
  });

  it('emits insight_viewed once with surface + null fund_id', () => {
    useTrackInsightViewed('home');
    expect(capturedEffect).not.toBeNull();
    capturedEffect!();
    expect(analytics.track).toHaveBeenCalledWith('insight_viewed', {
      surface: 'home',
      fund_id: null,
    });
  });

  it('forwards fund_id when provided', () => {
    useTrackInsightViewed('fund_detail', 'fund-123');
    capturedEffect!();
    expect(analytics.track).toHaveBeenCalledWith('insight_viewed', {
      surface: 'fund_detail',
      fund_id: 'fund-123',
    });
  });

  it('does not re-emit when the effect runs after an emit', () => {
    useTrackInsightViewed('insights');
    capturedEffect!();
    expect(analytics.track).toHaveBeenCalledTimes(1);
    capturedEffect!();
    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(capturedRef?.current).toBe(true);
  });
});
