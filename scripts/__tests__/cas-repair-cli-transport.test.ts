import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const transport = require('../cas-repair/run-exact-target-repair-with-cli.cjs') as {
  normalizeStoredToken: (value: string) => string;
  parsePrimaryPooler: (value: unknown) => { host: string; database: string };
  parseTemporaryRole: (value: unknown) => { user: string; password: string; ttlSeconds: number };
  runCliTransport: (options: Record<string, unknown>) => Promise<number>;
};

const ROOT = path.join(process.cwd(), 'scripts', 'cas-repair');
const PROJECT_REF = 'imkgazlrxtlhkfptkzjc';
const ACCESS_TOKEN = `sbp_${'a'.repeat(40)}`;
const TEMP_PASSWORD = 'synthetic-temporary-password-never-print';

function response(value: unknown, ok = true) {
  return {
    ok,
    text: async () => JSON.stringify(value),
  };
}

function poolerResponse(host = 'aws-0-eu-west-1.pooler.supabase.com') {
  return [
    {
      database_type: 'PRIMARY',
      connection_string: `postgresql://postgres.${PROJECT_REF}:[YOUR-PASSWORD]@${host}:6543/postgres`,
    },
  ];
}

function roleResponse(overrides: Record<string, unknown> = {}) {
  return {
    role: 'cli_login_postgres',
    password: TEMP_PASSWORD,
    ttl_seconds: 300,
    ...overrides,
  };
}

describe('C2 CLI-authenticated repair transport', () => {
  it('normalizes the Supabase CLI keyring encoding without changing plain tokens', () => {
    expect(transport.normalizeStoredToken(ACCESS_TOKEN)).toBe(ACCESS_TOKEN);
    expect(
      transport.normalizeStoredToken(
        `go-keyring-base64:${Buffer.from(ACCESS_TOKEN).toString('base64')}`,
      ),
    ).toBe(ACCESS_TOKEN);
  });

  it('accepts only the exact official dev primary pooler and temporary role', () => {
    expect(transport.parsePrimaryPooler(poolerResponse())).toEqual({
      host: 'aws-0-eu-west-1.pooler.supabase.com',
      database: 'postgres',
    });
    expect(transport.parseTemporaryRole(roleResponse())).toEqual({
      user: `cli_login_postgres.${PROJECT_REF}`,
      password: TEMP_PASSWORD,
      ttlSeconds: 300,
    });

    expect(() => transport.parsePrimaryPooler(poolerResponse('example.invalid'))).toThrow(
      'authorized dev project',
    );
    expect(() =>
      transport.parseTemporaryRole(roleResponse({ role: 'postgres' })),
    ).toThrow('temporary login response was invalid');
    expect(() => transport.parseTemporaryRole(roleResponse({ ttl_seconds: 30 }))).toThrow(
      'temporary login response was invalid',
    );
  });

  it('keeps both credentials out of argv and runs the low-level repair under the TTL', async () => {
    const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv; timeout?: number }[] = [];
    const fetchCalls: { url: string; init: Record<string, unknown> }[] = [];
    const spawnSync = jest.fn((command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({
        command,
        args: [...args],
        env: options.env ? { ...(options.env as NodeJS.ProcessEnv) } : undefined,
        timeout: options.timeout as number | undefined,
      });
      if (command === 'supabase') return { status: 0, stdout: '2.114.0\n' };
      if (command === '/usr/bin/security') {
        return {
          status: 0,
          stdout: `go-keyring-base64:${Buffer.from(ACCESS_TOKEN).toString('base64')}\n`,
        };
      }
      return { status: 0 };
    });
    const fetchFn = jest.fn(async (url: string, init: Record<string, unknown>) => {
      fetchCalls.push({ url, init });
      return url.endsWith('/config/database/pooler')
        ? response(poolerResponse())
        : response(roleResponse());
    });

    const status = await transport.runCliTransport({
      mode: 'dry-run',
      env: {
        Q5_PSQL_BIN: '/synthetic/psql',
        Q5_TARGET_IMPORT_ID: '00000000-0000-4000-8000-000000000001',
      },
      platform: 'darwin',
      spawnSync,
      fetchFn,
      sleep: async () => undefined,
      now: () => 1_000_000,
      lowLevelRunner: '/synthetic/runner',
    });

    expect(status).toBe(0);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].url).toContain(`/projects/${PROJECT_REF}/config/database/pooler`);
    const allArgs = calls.flatMap((call) => call.args);
    expect(allArgs.join('\n')).not.toContain(ACCESS_TOKEN);
    expect(allArgs.join('\n')).not.toContain(TEMP_PASSWORD);
    const probe = calls.find((call) => call.command === '/synthetic/psql');
    expect(probe?.args).toContain('--command=select 1');
    expect(probe?.args).toContain('--port=5432');
    expect(probe?.env?.PGPASSWORD).toBe(TEMP_PASSWORD);
    const runner = calls.find((call) => call.command === '/synthetic/runner');
    expect(runner?.args).toEqual(['dry-run']);
    expect(runner?.env?.Q5_REPAIR_AUTH_MODE).toBe('cli-temporary');
    expect(runner?.env?.Q5_DEV_DB_USER).toBe(`cli_login_postgres.${PROJECT_REF}`);
    expect(runner?.timeout).toBeLessThanOrEqual(240_000);
  });

  it('supports a harmless readiness-only probe and never invokes the repair runner', async () => {
    const commands: string[] = [];
    let output = '';
    const spawnSync = jest.fn((command: string) => {
      commands.push(command);
      if (command === 'supabase') return { status: 0, stdout: '2.114.0\n' };
      if (command === '/usr/bin/security') return { status: 0, stdout: ACCESS_TOKEN };
      return { status: 0 };
    });
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(response(poolerResponse()))
      .mockResolvedValueOnce(response(roleResponse()));

    const status = await transport.runCliTransport({
      mode: 'probe',
      env: { Q5_PSQL_BIN: '/synthetic/psql' },
      platform: 'darwin',
      spawnSync,
      fetchFn,
      sleep: async () => undefined,
      now: () => 1_000_000,
      lowLevelRunner: '/must-not-run',
      stdout: (value: string) => {
        output += value;
      },
    });

    expect(status).toBe(0);
    expect(output).toBe('{"cli_transport":"ready"}\n');
    expect(commands).not.toContain('/must-not-run');
  });

  it('refuses inherited password or connection overrides before Keychain access', async () => {
    const spawnSync = jest.fn();
    await expect(
      transport.runCliTransport({
        mode: 'dry-run',
        env: { Q5_DEV_DB_PASSWORD: 'must-not-be-read' },
        platform: 'darwin',
        spawnSync,
      }),
    ).rejects.toThrow('connection overrides are forbidden');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('fails closed on readiness exhaustion without invoking the repair runner', async () => {
    const commands: string[] = [];
    const spawnSync = jest.fn((command: string) => {
      commands.push(command);
      if (command === 'supabase') return { status: 0, stdout: '2.114.0\n' };
      if (command === '/usr/bin/security') return { status: 0, stdout: ACCESS_TOKEN };
      return { status: 1 };
    });
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(response(poolerResponse()))
      .mockResolvedValueOnce(response(roleResponse()));
    let clock = 1_000_000;

    await expect(
      transport.runCliTransport({
        mode: 'dry-run',
        env: { Q5_PSQL_BIN: '/synthetic/psql' },
        platform: 'darwin',
        spawnSync,
        fetchFn,
        sleep: async () => {
          clock += 60_000;
        },
        now: () => clock,
        lowLevelRunner: '/must-not-run',
      }),
    ).rejects.toThrow('temporary Supabase CLI login did not become ready');
    expect(commands).not.toContain('/must-not-run');
  });

  it('uses an ephemeral Docker container and copies only allowlisted environment names', () => {
    const source = fs.readFileSync(path.join(ROOT, 'docker-psql.sh'), 'utf8');
    expect(source).toContain('run --rm -i');
    expect(source).toContain('--env PGPASSWORD');
    expect(source).not.toContain('--env "PGPASSWORD=');
    expect(source).toContain('--volume "$SCRIPT_DIR:$SCRIPT_DIR:ro"');
    expect(source).toContain("POSTGRES_IMAGE='postgres:17-alpine'");
    expect(source).toContain('refusing unexpected plaintext backup mount');
    expect(source).toContain('exec docker "${docker_args[@]}"');
  });

  it('requires explicit, unexpired CLI target metadata in the low-level runner', () => {
    const source = fs.readFileSync(path.join(ROOT, 'run-exact-target-repair.sh'), 'utf8');
    expect(source).toContain("Q5_REPAIR_AUTH_MODE:-password");
    expect(source).toContain('Q5_CLI_ROLE_EXPIRES_AT_EPOCH');
    expect(source).toContain(`cli_login_postgres.$DEV_PROJECT_REF`);
    expect(source).toContain('refusing invalid or expired Supabase CLI database target');
  });
});
