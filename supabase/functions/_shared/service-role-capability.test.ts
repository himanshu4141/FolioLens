import { hasServiceRoleCapability } from './service-role-capability';
import fs from 'node:fs';
import path from 'node:path';

describe('hasServiceRoleCapability', () => {
  it.each([null, '', 'Bearer', 'Bearer ', 'Basic synthetic', 'Bearer two tokens'])(
    'rejects malformed authorization without probing: %p',
    async (authorization) => {
      const probe = jest.fn();

      await expect(hasServiceRoleCapability(authorization, probe)).resolves.toBe(false);
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it('accepts only the service-role-only schema capability', async () => {
    const probe = jest.fn().mockResolvedValue({ data: 2, error: null });

    await expect(
      hasServiceRoleCapability('Bearer synthetic-service-key', probe),
    ).resolves.toBe(true);
    expect(probe).toHaveBeenCalledWith(
      'synthetic-service-key',
      'Bearer synthetic-service-key',
    );
  });

  it.each([
    [{ data: 1, error: null }],
    [{ data: 2, error: { message: 'denied' } }],
    [{ data: 2, error: undefined }],
    [{ data: null, error: null }],
  ])('fails closed for a non-service capability result', async (result) => {
    const probe = jest.fn().mockResolvedValue(result);

    await expect(
      hasServiceRoleCapability('Bearer synthetic-service-key', probe),
    ).resolves.toBe(false);
  });

  it('fails closed when the capability probe throws', async () => {
    const probe = jest.fn().mockRejectedValue(new Error('synthetic failure'));

    await expect(
      hasServiceRoleCapability('Bearer synthetic-service-key', probe),
    ).resolves.toBe(false);
  });

  it('guards exact-target repair with the service-role-only capability', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'supabase/functions/sync-fund-meta/index.ts'),
      'utf8',
    );

    expect(source).toContain('hasServiceRoleCapability(');
    expect(source).toContain("caller.rpc('cas_import_schema_version_v2')");
    expect(source).not.toContain(
      'req.headers.get(\'Authorization\') !== `Bearer ${serviceRoleKey}`',
    );
  });
});
