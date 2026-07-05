import { useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useRouter } from 'expo-router';
import { useSession } from '@/src/hooks/useSession';
import { authClient } from '@/src/lib/auth';
import { analytics } from '@/src/lib/analytics';
import {
  OAuthCompletionCoordinator,
  type OAuthCallbackSource,
  type OAuthIntent,
  type OAuthTelemetryMetadata,
} from '@/src/lib/oauthCompletion';

const oauthCompletionCoordinator = new OAuthCompletionCoordinator({
  provider: {
    exchangeCodeForSession: (code) => authClient.exchangeCodeForSession(code),
    setSession: (tokens) => authClient.setSession(tokens),
  },
  track: (event, properties) => analytics.track(event, properties),
});

export function getOAuthTelemetryMetadata(): OAuthTelemetryMetadata {
  const appVariant = Constants.expoConfig?.extra?.appVariant;
  return {
    platform: Platform.OS,
    app_version: Constants.expoConfig?.version ?? null,
    app_variant: typeof appVariant === 'string' ? appVariant : null,
    eas_channel: Updates.channel ?? null,
    eas_update_id: Updates.updateId ?? null,
  };
}

export function useOAuthCompletion() {
  const router = useRouter();
  const { waitForSession, reconcileSession } = useSession();
  const metadata = useMemo(() => getOAuthTelemetryMetadata(), []);

  const completeCallback = useCallback((url: string, source: OAuthCallbackSource) => (
    oauthCompletionCoordinator.completeCallback(url, source, {
      metadata,
      waitForSession,
      reconcileSession,
      navigateToTabs: () => router.replace('/(tabs)'),
    })
  ), [metadata, reconcileSession, router, waitForSession]);

  const beginAttempt = useCallback((intent: OAuthIntent) => (
    oauthCompletionCoordinator.beginAttempt(intent, metadata)
  ), [metadata]);

  const recordBrowserReturned = useCallback((resultType: string) => {
    oauthCompletionCoordinator.recordBrowserReturned(resultType);
  }, []);

  const recordFailure = useCallback((reason: string) => {
    oauthCompletionCoordinator.recordFailure(reason);
  }, []);

  return useMemo(() => ({
    metadata,
    beginAttempt,
    recordBrowserReturned,
    recordFailure,
    completeCallback,
  }), [
    metadata,
    beginAttempt,
    recordBrowserReturned,
    recordFailure,
    completeCallback,
  ]);
}
