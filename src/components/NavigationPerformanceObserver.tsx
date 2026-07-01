import { useEffect } from 'react';
import { InteractionManager } from 'react-native';
import { usePathname } from 'expo-router';
import {
  cancelAllNavigationMeasurements,
  cancelNavigationMeasurement,
  markNavigationRouteCommitted,
  markNavigationUsable,
} from '@/src/lib/navigationPerformance';

export function NavigationPerformanceObserver() {
  const pathname = usePathname();

  useEffect(() => {
    const navigationIds = markNavigationRouteCommitted(pathname);
    if (navigationIds.length === 0) return;

    const task = InteractionManager.runAfterInteractions(() => {
      for (const navigationId of navigationIds) {
        markNavigationUsable(navigationId);
      }
    });

    return () => {
      task.cancel();
      for (const navigationId of navigationIds) {
        cancelNavigationMeasurement(navigationId);
      }
    };
  }, [pathname]);

  useEffect(() => cancelAllNavigationMeasurements, []);

  return null;
}
