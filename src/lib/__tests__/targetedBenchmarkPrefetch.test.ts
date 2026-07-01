import { createTargetedBenchmarkPrefetch } from '@/src/lib/targetedBenchmarkPrefetch';

describe('createTargetedBenchmarkPrefetch', () => {
  it('starts no alternate work while Portfolio remains idle without intent', () => {
    jest.useFakeTimers();
    const prefetchPortfolio = jest.fn();
    const prefetchTimeline = jest.fn();

    createTargetedBenchmarkPrefetch({
      enabled: true,
      prefetchPortfolio,
      prefetchTimeline,
    });
    jest.advanceTimersByTime(5000);

    expect(prefetchPortfolio).not.toHaveBeenCalled();
    expect(prefetchTimeline).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('prefetches exactly the benchmark receiving user intent', () => {
    const prefetchPortfolio = jest.fn();
    const prefetchTimeline = jest.fn();
    const onIntent = createTargetedBenchmarkPrefetch({
      enabled: true,
      prefetchPortfolio,
      prefetchTimeline,
    });

    onIntent('^NIFTY500TRI');

    expect(prefetchPortfolio).toHaveBeenCalledTimes(1);
    expect(prefetchPortfolio).toHaveBeenCalledWith('^NIFTY500TRI');
    expect(prefetchTimeline).toHaveBeenCalledTimes(1);
    expect(prefetchTimeline).toHaveBeenCalledWith('^NIFTY500TRI');
  });

  it('does nothing after the owning route loses focus', () => {
    const prefetchPortfolio = jest.fn();
    const prefetchTimeline = jest.fn();
    const onIntent = createTargetedBenchmarkPrefetch({
      enabled: false,
      prefetchPortfolio,
      prefetchTimeline,
    });

    onIntent('^NIFTY500TRI');

    expect(prefetchPortfolio).not.toHaveBeenCalled();
    expect(prefetchTimeline).not.toHaveBeenCalled();
  });
});
