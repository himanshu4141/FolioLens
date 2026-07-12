import { useEffect, useMemo, useRef } from 'react';
import { InteractionManager, Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { usePathname } from 'expo-router';
import { useUxJsStallMonitor } from '@/src/hooks/useUxTelemetry';
import {
  normalizeUxSurfaceFromPathname,
  setUxTelemetryContext,
  trackUxScreenReady,
} from '@/src/lib/uxTelemetry';

export function UxRuntimeTelemetryObserver() {
  const pathname = usePathname();
  const surface = useMemo(() => normalizeUxSurfaceFromPathname(pathname), [pathname]);
  const firstRouteRef = useRef(true);

  useEffect(() => {
    setUxTelemetryContext({
      platform: Platform.OS,
      app_version: Constants.expoConfig?.version ?? null,
      eas_update_id: Updates.updateId ?? null,
      eas_update_created_at: Updates.createdAt?.toISOString() ?? null,
      is_embedded_launch: Updates.isEmbeddedLaunch,
    });
  }, []);

  useEffect(() => {
    const startedAt = Date.now();
    const coldStart = firstRouteRef.current;
    firstRouteRef.current = false;
    const task = InteractionManager.runAfterInteractions(() => {
      trackUxScreenReady({
        surface,
        readiness: 'route_painted',
        elapsedMs: Date.now() - startedAt,
        coldStart,
        cacheState: 'unknown',
      });
    });

    return () => task.cancel();
  }, [pathname, surface]);

  useUxJsStallMonitor(surface);

  return null;
}
