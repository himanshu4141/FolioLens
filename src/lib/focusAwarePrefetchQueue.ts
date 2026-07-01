export interface FocusAwarePrefetchQueue {
  cancel: () => void;
}

interface FocusAwarePrefetchQueueOptions<T> {
  items: readonly T[];
  initialDelayMs: number;
  gapMs: number;
  prefetch: (item: T) => Promise<unknown>;
}

/**
 * Starts a delayed, sequential prefetch queue whose remaining work can be
 * cancelled synchronously when its owning route loses focus.
 *
 * An operation already executing is allowed to finish because the current
 * data fetchers are not AbortSignal-aware. Its completion cannot schedule
 * the next item after `cancel()`.
 */
export function startFocusAwarePrefetchQueue<T>({
  items,
  initialDelayMs,
  gapMs,
  prefetch,
}: FocusAwarePrefetchQueueOptions<T>): FocusAwarePrefetchQueue {
  let cancelled = false;
  let cursor = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(delayMs: number) {
    timer = setTimeout(runNext, delayMs);
  }

  function runNext() {
    timer = null;
    if (cancelled || cursor >= items.length) return;

    const item = items[cursor++];
    Promise.resolve(prefetch(item)).finally(() => {
      if (cancelled || cursor >= items.length) return;
      schedule(gapMs);
    });
  }

  if (items.length > 0) schedule(initialDelayMs);

  return {
    cancel() {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
