export interface MfapiSchemeIdentity {
  schemeName: string;
  isin: string | null;
}

export interface BenchmarkIdentity {
  benchmarkIndex: string;
  benchmarkIndexSymbol: string;
}

export const CAS_IDENTITY_RETRY_MS = 24 * 60 * 60 * 1000;

export function uniqueSchemeCodes(
  activeSchemeCodes: number[],
  pendingIdentityCodes: number[],
): number[] {
  return [...new Set([...activeSchemeCodes, ...pendingIdentityCodes])];
}

export function parseMfapiSchemeIdentity(value: unknown): MfapiSchemeIdentity | null {
  if (value === null || typeof value !== 'object') return null;
  const meta = (value as { meta?: unknown }).meta;
  if (meta === null || typeof meta !== 'object') return null;

  const record = meta as Record<string, unknown>;
  const rawName = record.scheme_name;
  if (typeof rawName !== 'string' || rawName.trim().length === 0) return null;

  const rawIsin = record.isin_growth;
  return {
    schemeName: rawName.trim(),
    isin: typeof rawIsin === 'string' && rawIsin.trim().length > 0
      ? rawIsin.trim()
      : null,
  };
}

export function pendingIdentityIsDue(
  attemptedAt: string | null | undefined,
  nowMs: number,
  retryMs = CAS_IDENTITY_RETRY_MS,
): boolean {
  if (!attemptedAt) return true;
  const attemptedMs = Date.parse(attemptedAt);
  return Number.isNaN(attemptedMs) || nowMs - attemptedMs >= retryMs;
}

export function categoryNameForHydration(
  isPendingIdentity: boolean,
  canonicalName: string | null | undefined,
  existingName: string | null | undefined,
): string | null {
  if (isPendingIdentity) return canonicalName?.trim() || null;
  return existingName?.trim() || null;
}

export function benchmarkForCategory(
  category: string | null | undefined,
  mappings: Map<string, BenchmarkIdentity>,
): BenchmarkIdentity | null {
  const key = category?.trim().toLowerCase();
  return key ? mappings.get(key) ?? null : null;
}
