export interface ServiceRoleCapabilityResult {
  data: unknown;
  error: unknown;
}

export type ServiceRoleCapabilityProbe = (
  apiKey: string,
  authorization: string,
) => Promise<ServiceRoleCapabilityResult>;

export async function hasServiceRoleCapability(
  authorization: string | null,
  probe: ServiceRoleCapabilityProbe,
): Promise<boolean> {
  if (authorization == null) return false;
  const match = authorization.match(/^Bearer ([^\s]+)$/);
  if (!match) return false;

  try {
    const result = await probe(match[1], authorization);
    return result.error == null && result.data === 2;
  } catch {
    return false;
  }
}
