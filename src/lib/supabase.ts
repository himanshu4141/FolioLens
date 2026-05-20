import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database.types';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabasePublishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

// On web, Supabase uses localStorage by default.
// On native (iOS/Android), we persist sessions via AsyncStorage.
const storage = Platform.OS === 'web' ? undefined : AsyncStorage;

export const supabase = createClient<Database>(supabaseUrl, supabasePublishableKey, {
  auth: {
    ...(storage ? { storage } : {}),
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === 'web',
  },
});

// React-Native-only: drive Supabase's auto-refresh timer off AppState.
// The SDK's `autoRefreshToken: true` schedules the next refresh via
// setTimeout — but on native the JS thread suspends in the background,
// so the timer never fires and the access token can expire mid-suspend.
// On foreground, the SDK won't realise it's stale until something
// touches it; if at that point the refresh fails (transient network,
// rotated refresh token, refresh-token reuse race against a parallel
// query, etc.), the SDK emits SIGNED_OUT directly — bypassing our
// global 401 handler entirely. That's the failure mode behind the
// May 2026 "silent sign-outs / 5 transactions in the middle" bug:
// 8 SIGNED_OUTs in 5 days for the reporting user, zero
// `auth_session_invalidated` events.
//
// The fix Supabase recommends for React Native is to pause the
// refresh timer on background and *actively* run it on foreground.
// `startAutoRefresh()` does both: immediately refresh if the token's
// about to expire, then schedule the next tick. This converts the
// silent-stale-token failure mode into an explicit, observable
// refresh attempt — same SIGNED_OUT can still fire if the refresh
// itself fails, but at least the cause is then a real refresh
// outcome rather than the timer never firing.
//
// Web doesn't need this — `visibilitychange` already drives the
// SDK's refresh on the web platform.
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  });
}
