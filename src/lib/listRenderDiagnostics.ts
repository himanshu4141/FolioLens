import { useEffect } from 'react';
import Constants from 'expo-constants';

type VirtualizedSurface = 'funds-mobile' | 'funds-desktop' | 'money-trail';

const activeRows = new Map<VirtualizedSurface, number>();
const peakRows = new Map<VirtualizedSurface, number>();

function isPrPreview(): boolean {
  return Constants.expoConfig?.extra?.appVariant === 'preview-pr';
}

/** Privacy-safe row-mount evidence emitted only by the PR-preview app. */
export function useVirtualizedRowMount(surface: VirtualizedSurface): void {
  useEffect(() => {
    if (!isPrPreview()) return;

    const previousActive = activeRows.get(surface) ?? 0;
    if (previousActive === 0) peakRows.set(surface, 0);
    const active = previousActive + 1;
    const peak = Math.max(peakRows.get(surface) ?? 0, active);
    activeRows.set(surface, active);
    peakRows.set(surface, peak);
    console.warn('[virtualized-list]', {
      surface,
      event: 'mount',
      activeRows: active,
      peakRows: peak,
    });

    return () => {
      const remaining = Math.max(0, (activeRows.get(surface) ?? 1) - 1);
      activeRows.set(surface, remaining);
      console.warn('[virtualized-list]', {
        surface,
        event: 'unmount',
        activeRows: remaining,
        peakRows: peakRows.get(surface) ?? 0,
      });
    };
  }, [surface]);
}
