import { useEffect, useState } from 'react';
import { InteractionManager } from 'react-native';

export type FundDetailTab = 'performance' | 'nav' | 'composition';
export type MountedFundDetailModule = FundDetailTab | null;
export type FundDetailEntryState = 'loading' | 'error' | 'ready';

interface FundDetailEntryInput {
  isRestoring: boolean;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  hasDetail: boolean;
  hasCachedFund: boolean;
}
export function resolveFundDetailEntryState({
  isRestoring,
  isLoading,
  isError,
  isSuccess,
  hasDetail,
  hasCachedFund,
}: FundDetailEntryInput): FundDetailEntryState {
  if (isRestoring) return 'loading';
  if (hasDetail || hasCachedFund) return 'ready';
  if (isError) return 'error';
  if (isSuccess) return 'error';
  if (isLoading) return 'loading';
  return 'loading';
}

interface MountedModuleInput {
  activeTab: FundDetailTab;
  hasDetail: boolean;
  navUnavailable: boolean;
  performanceReady: boolean;
}

export function getMountedFundDetailModule({
  activeTab,
  hasDetail,
  navUnavailable,
  performanceReady,
}: MountedModuleInput): MountedFundDetailModule {
  if (!hasDetail) return null;
  if (activeTab === 'performance') {
    return performanceReady && !navUnavailable ? 'performance' : null;
  }
  return activeTab;
}

interface InteractionTask {
  cancel(): void;
}

type RunAfterInteractions = (callback: () => void) => InteractionTask;

export function schedulePerformanceChartReadiness(
  isFocused: boolean,
  activeTab: FundDetailTab,
  onReady: () => void,
  runAfterInteractions: RunAfterInteractions = InteractionManager.runAfterInteractions,
): (() => void) | undefined {
  if (!isFocused || activeTab !== 'performance') return undefined;

  let cancelled = false;
  const task = runAfterInteractions(() => {
    if (!cancelled) onReady();
  });

  return () => {
    cancelled = true;
    task.cancel();
  };
}

export function usePerformanceChartReadiness(
  isFocused: boolean,
  activeTab: FundDetailTab,
): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    return schedulePerformanceChartReadiness(
      isFocused,
      activeTab,
      () => setReady(true),
    );
  }, [activeTab, isFocused]);

  return ready;
}
