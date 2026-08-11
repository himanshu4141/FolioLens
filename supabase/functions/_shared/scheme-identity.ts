export interface MfapiSchemeIdentity {
  schemeName: string;
  isin: string | null;
}

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
