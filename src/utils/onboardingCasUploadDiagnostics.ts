import { bucketBytes } from '@/src/lib/uxTelemetry';

type UploadElapsedBucket = '<1s' | '1-5s' | '5-15s' | '15-60s' | '60s+';

function bucketElapsedMs(elapsedMs: number): UploadElapsedBucket {
  if (elapsedMs < 1_000) return '<1s';
  if (elapsedMs < 5_000) return '1-5s';
  if (elapsedMs < 15_000) return '5-15s';
  if (elapsedMs < 60_000) return '15-60s';
  return '60s+';
}

export function onboardingCasUploadStartDiagnostics(input: {
  platform: string;
  sizeBytes?: number | null;
  hasPasswordOverride: boolean;
}) {
  return {
    platform: input.platform,
    file_size_bucket: bucketBytes(input.sizeBytes),
    has_password_override: input.hasPasswordOverride,
  };
}

export function onboardingCasUploadOutcomeDiagnostics(input: {
  elapsedMs: number;
  errorKind?: string;
}) {
  return {
    elapsed_bucket: bucketElapsedMs(input.elapsedMs),
    ...(input.errorKind ? { error_kind: input.errorKind } : {}),
  };
}
