import {
  getMountedFundDetailModule,
  resolveFundDetailEntryState,
  schedulePerformanceChartReadiness,
} from '@/src/components/clearLens/fund-detail/fundDetailTransition';

describe('Fund Detail transition state', () => {
  it('renders a warm cached hero without waiting for detail data', () => {
    expect(resolveFundDetailEntryState({
      isRestoring: false,
      isLoading: true,
      isError: false,
      hasDetail: false,
      hasCachedFund: true,
    })).toBe('ready');
  });

  it('keeps a cold deep link in loading and exposes terminal errors', () => {
    expect(resolveFundDetailEntryState({
      isRestoring: false,
      isLoading: true,
      isError: false,
      hasDetail: false,
      hasCachedFund: false,
    })).toBe('loading');
    expect(resolveFundDetailEntryState({
      isRestoring: false,
      isLoading: false,
      isError: true,
      hasDetail: false,
      hasCachedFund: false,
    })).toBe('error');
  });

  it('mounts exactly the selected module and gates Performance', () => {
    expect(getMountedFundDetailModule({
      activeTab: 'performance',
      hasDetail: true,
      navUnavailable: false,
      performanceReady: false,
    })).toBeNull();
    expect(getMountedFundDetailModule({
      activeTab: 'performance',
      hasDetail: true,
      navUnavailable: false,
      performanceReady: true,
    })).toBe('performance');
    expect(getMountedFundDetailModule({
      activeTab: 'nav',
      hasDetail: true,
      navUnavailable: false,
      performanceReady: true,
    })).toBe('nav');
    expect(getMountedFundDetailModule({
      activeTab: 'composition',
      hasDetail: true,
      navUnavailable: false,
      performanceReady: true,
    })).toBe('composition');
    expect(getMountedFundDetailModule({
      activeTab: 'nav',
      hasDetail: false,
      navUnavailable: false,
      performanceReady: true,
    })).toBeNull();
  });

  it('cancels deferred chart readiness and ignores a late callback', () => {
    let callback: (() => void) | undefined;
    const cancel = jest.fn();
    const onReady = jest.fn();
    const runAfterInteractions = jest.fn((next: () => void) => {
      callback = next;
      return { cancel };
    });

    const cleanup = schedulePerformanceChartReadiness(
      true,
      'performance',
      onReady,
      runAfterInteractions,
    );

    expect(runAfterInteractions).toHaveBeenCalledTimes(1);
    cleanup?.();
    callback?.();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();
  });
});
