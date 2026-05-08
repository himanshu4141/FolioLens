import { Platform } from 'react-native';
import { analytics } from './analytics';

let installed = false;

/**
 * Forwards uncaught JS errors and unhandled promise rejections to PostHog.
 *
 * On native, hooks into React Native's `ErrorUtils` global, which fires
 * for any error not caught by a React error boundary or a try/catch.
 * On web, registers `window.onerror` and `window.onunhandledrejection`.
 *
 * Idempotent — calling more than once is a no-op.
 */
export function installGlobalErrorHandlers(): void {
  if (installed || !analytics.isEnabled) return;
  installed = true;

  if (Platform.OS === 'web') {
    if (typeof window === 'undefined') return;
    const previousOnError = window.onerror;
    window.onerror = (message, source, lineno, colno, error) => {
      analytics.captureException(error ?? new Error(String(message)), {
        $exception_source: 'window_onerror',
        source: source ?? null,
        lineno: lineno ?? null,
        colno: colno ?? null,
      });
      return previousOnError ? previousOnError(message, source, lineno, colno, error) : false;
    };
    const previousRejection = window.onunhandledrejection;
    window.onunhandledrejection = (event) => {
      analytics.captureException(event.reason, {
        $exception_source: 'window_onunhandledrejection',
      });
      if (previousRejection) {
        previousRejection.call(window, event);
      }
    };
    return;
  }

  // React Native — ErrorUtils is a global injected by the runtime. The
  // typings don't ship in @types/react-native, so we read it via a guarded
  // any-cast. Loss of typing is acceptable for this single integration point.
  const errorUtils = (globalThis as unknown as { ErrorUtils?: { setGlobalHandler: (handler: (error: Error, isFatal?: boolean) => void) => void; getGlobalHandler: () => (error: Error, isFatal?: boolean) => void; } }).ErrorUtils;
  if (!errorUtils) return;
  const previousHandler = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    analytics.captureException(error, {
      $exception_source: 'react_native_error_utils',
      is_fatal: !!isFatal,
    });
    previousHandler?.(error, isFatal);
  });
}
