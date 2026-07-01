let activeSyncOperations = 0;

/**
 * Mark a native data sync as active and return an idempotent completion
 * callback. A counter, rather than a boolean, preserves correctness when a
 * high-level sync derives its scope and then calls the lower-level sync.
 */
export function beginSyncActivity(): () => void {
  activeSyncOperations += 1;
  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    activeSyncOperations = Math.max(0, activeSyncOperations - 1);
  };
}

export function isSyncInFlight(): boolean {
  return activeSyncOperations > 0;
}
