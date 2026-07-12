import { useEffect, useRef } from 'react';
import { AppState, InteractionManager, type AppStateStatus } from 'react-native';
import {
  trackUxJsStall,
  trackUxScreenReady,
  type UxCacheState,
  type UxReadiness,
  type UxSurface,
} from '@/src/lib/uxTelemetry';

interface UxScreenReadyOptions {
  readiness?: UxReadiness;
  cacheState?: UxCacheState;
  rowCount?: number | null;
  fundCount?: number | null;
  transactionCount?: number | null;
  coldStart?: boolean;
}

export function useUxScreenReady(
  surface: UxSurface,
  ready: boolean,
  options: UxScreenReadyOptions = {},
): void {
  const startedAtRef = useRef(Date.now());
  const emittedRef = useRef(false);

  useEffect(() => {
    startedAtRef.current = Date.now();
    emittedRef.current = false;
  }, [surface]);

  useEffect(() => {
    if (!ready || emittedRef.current) return undefined;
    emittedRef.current = true;
    const task = InteractionManager.runAfterInteractions(() => {
      trackUxScreenReady({
        surface,
        readiness: options.readiness ?? 'content_ready',
        elapsedMs: Date.now() - startedAtRef.current,
        coldStart: options.coldStart,
        cacheState: options.cacheState,
        rowCount: options.rowCount,
        fundCount: options.fundCount,
        transactionCount: options.transactionCount,
      });
    });

    return () => task.cancel();
  }, [
    options.cacheState,
    options.coldStart,
    options.fundCount,
    options.readiness,
    options.rowCount,
    options.transactionCount,
    ready,
    surface,
  ]);
}

export function useUxJsStallMonitor(
  surface: UxSurface,
  enabled = true,
  intervalMs = 5_000,
): void {
  const surfaceRef = useRef(surface);

  useEffect(() => {
    surfaceRef.current = surface;
  }, [surface]);

  useEffect(() => {
    if (!enabled) return undefined;
    let appState: AppStateStatus = AppState.currentState;
    let expectedAt = Date.now() + intervalMs;

    const appStateSub = AppState.addEventListener('change', (nextState) => {
      appState = nextState;
      expectedAt = Date.now() + intervalMs;
    });

    const interval = setInterval(() => {
      const now = Date.now();
      const stallMs = now - expectedAt;
      expectedAt = now + intervalMs;
      if (appState !== 'active') return;
      trackUxJsStall({ surface: surfaceRef.current, stallMs });
    }, intervalMs);

    return () => {
      appStateSub.remove();
      clearInterval(interval);
    };
  }, [enabled, intervalMs]);
}
