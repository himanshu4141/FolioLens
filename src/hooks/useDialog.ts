import { useCallback } from 'react';
import { useAppStore } from '@/src/store/appStore';
import type { AppDialogRequest } from '@/src/store/appStore';

/**
 * Imperative API for the global Clear Lens dialog. Use these instead of
 * `Alert.alert` / `window.confirm` / `window.alert` so the UI renders in
 * the app's own styled modal (`AppDialog`) and behaves consistently on
 * web + native.
 *
 * The underlying `<AppDialog />` is mounted once at the root
 * (`app/_layout.tsx`) and reads from `useAppStore`. Hooks below just
 * stage the request.
 *
 * Why imperative rather than Promise-returning: matches the call-shape of
 * the `Alert.alert` API the rest of the app already uses, so migrating
 * existing call sites is a near-mechanical swap (no `await`s threaded
 * through handlers).
 */

export type AlertDialogOptions = Pick<AppDialogRequest, 'title' | 'body' | 'okText'>;

export type ConfirmDialogOptions = Pick<
  AppDialogRequest,
  'title' | 'body' | 'okText' | 'cancelText' | 'destructive' | 'onConfirm' | 'onCancel'
>;

/**
 * Single-button informational dialog. Resolves silently when the user
 * taps OK. Drop-in replacement for `Alert.alert(title, body)` (which is
 * a no-op on react-native-web and stays unstyled on native).
 */
export function useAlertDialog() {
  const showDialog = useAppStore((s) => s.showDialog);
  return useCallback(
    (opts: AlertDialogOptions) => {
      showDialog({ kind: 'alert', ...opts });
    },
    [showDialog],
  );
}

/**
 * Two-button confirmation dialog. The caller wires side effects through
 * `onConfirm` (e.g. signOut, deleteAccount). `destructive: true` colours
 * the confirm button as a negative action for delete / sign-out flows.
 */
export function useConfirmDialog() {
  const showDialog = useAppStore((s) => s.showDialog);
  return useCallback(
    (opts: ConfirmDialogOptions) => {
      showDialog({ kind: 'confirm', ...opts });
    },
    [showDialog],
  );
}
