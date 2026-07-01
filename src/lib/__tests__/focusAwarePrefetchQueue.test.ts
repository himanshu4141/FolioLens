import { startFocusAwarePrefetchQueue } from '@/src/lib/focusAwarePrefetchQueue';

describe('startFocusAwarePrefetchQueue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('cancels the initial delayed prefetch on blur', () => {
    const prefetch = jest.fn(async () => undefined);
    const queue = startFocusAwarePrefetchQueue({
      items: ['first', 'second'],
      initialDelayMs: 1200,
      gapMs: 250,
      prefetch,
    });

    queue.cancel();
    jest.advanceTimersByTime(2000);

    expect(prefetch).not.toHaveBeenCalled();
  });

  it('does not schedule another item when blur occurs during an active prefetch', async () => {
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const prefetch = jest.fn((item: string) =>
      item === 'first' ? first : Promise.resolve(),
    );
    const queue = startFocusAwarePrefetchQueue({
      items: ['first', 'second'],
      initialDelayMs: 1200,
      gapMs: 250,
      prefetch,
    });

    jest.advanceTimersByTime(1200);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenLastCalledWith('first');

    queue.cancel();
    resolveFirst();
    await first;
    await Promise.resolve();
    jest.advanceTimersByTime(1000);

    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it('runs focused work sequentially with the configured gap', async () => {
    const prefetch = jest.fn(async () => undefined);
    startFocusAwarePrefetchQueue({
      items: ['first', 'second'],
      initialDelayMs: 1200,
      gapMs: 250,
      prefetch,
    });

    jest.advanceTimersByTime(1200);
    expect(prefetch).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    jest.advanceTimersByTime(249);
    expect(prefetch).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(2);
  });
});
