import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const transport = require('../cas-repair/run-exact-target-repair-with-cli.cjs') as {
  normalizeStoredToken: (value: string) => string;
  parsePrimaryPooler: (value: unknown) => { host: string; database: string };
  parseTemporaryRole: (value: unknown) => { user: string; password: string; ttlSeconds: number };
  parseDiagnosticResult: (value: unknown) => string;
  runCliDiagnostic: (options: Record<string, unknown>) => string;
  runBoundedProcessGroup: (options: Record<string, unknown>) => Promise<number>;
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

function successfulAsyncSpawn(
  calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[],
) {
  return jest.fn((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({
      command,
      args: [...args],
      env: options.env ? { ...(options.env as NodeJS.ProcessEnv) } : undefined,
    });
    const child = new EventEmitter() as EventEmitter & { pid: number };
    child.pid = 42_424;
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
}

describe('C2/C3 CLI-authenticated repair transport', () => {
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
    const asyncCalls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
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
    const spawn = successfulAsyncSpawn(asyncCalls);

    const status = await transport.runCliTransport({
      mode: 'dry-run',
      env: {
        Q5_TARGET_IMPORT_ID: '00000000-0000-4000-8000-000000000001',
      },
      platform: 'darwin',
      spawnSync,
      spawn,
      fetchFn,
      sleep: async () => undefined,
      now: () => 1_000_000,
      lowLevelRunner: '/synthetic/runner',
      dockerPsql: '/synthetic/psql',
    });

    expect(status).toBe(0);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].url).toContain(`/projects/${PROJECT_REF}/config/database/pooler`);
    const allArgs = calls.flatMap((call) => call.args);
    expect(allArgs.join('\n')).not.toContain(ACCESS_TOKEN);
    expect(allArgs.join('\n')).not.toContain(TEMP_PASSWORD);
    expect(allArgs.join('\n')).not.toContain('-c role=postgres');
    const probe = calls.find((call) => call.command === '/synthetic/psql');
    const readinessPath = probe?.args
      .find((arg) => arg.startsWith('--file='))
      ?.slice('--file='.length);
    expect(readinessPath).toContain('check-cli-authority.psql');
    const readiness = fs.readFileSync(readinessPath!, 'utf8');
    expect(readiness).toContain("current_role = 'postgres'");
    expect(readiness).toContain('from public.transaction where false');
    expect(readiness).toContain('from public.cas_import where false');
    expect(readiness).toContain('from public.user_fund where false');
    expect(readiness).toContain(
      'public.resolve_user_fund_activation_v1(boolean,boolean,jsonb,boolean,boolean)',
    );
    expect(probe?.args).toContain('--port=5432');
    expect(probe?.env?.PGPASSWORD).toBe(TEMP_PASSWORD);
    expect(probe?.env).not.toHaveProperty('PGOPTIONS');
    const runner = asyncCalls.find((call) => call.command === '/synthetic/runner');
    expect(runner?.args).toEqual(['dry-run']);
    expect(runner?.env?.Q5_REPAIR_AUTH_MODE).toBe('cli-temporary');
    expect(runner?.env?.Q5_DEV_DB_USER).toBe(`cli_login_postgres.${PROJECT_REF}`);
    expect(runner?.env?.Q5_PSQL_BIN).toBe('/synthetic/psql');
    expect(runner?.env).not.toHaveProperty('PGOPTIONS');
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
      env: {},
      platform: 'darwin',
      spawnSync,
      fetchFn,
      sleep: async () => undefined,
      now: () => 1_000_000,
      lowLevelRunner: '/must-not-run',
      dockerPsql: '/synthetic/psql',
      stdout: (value: string) => {
        output += value;
      },
    });

    expect(status).toBe(0);
    expect(output).toBe('{"cli_transport":"ready"}\n');
    expect(commands).not.toContain('/must-not-run');
  });

  it('accepts exactly one allowlisted diagnostic token and maps every other shape', () => {
    for (const code of [
      'role_assumption_missing',
      'role_assumption_not_applied',
      'table_authority_missing',
      'resolver_authority_missing',
      'ready',
      'readiness_statement_failed',
    ]) {
      expect(transport.parseDiagnosticResult({ status: 0, stdout: `${code}\n` })).toBe(code);
      expect(transport.parseDiagnosticResult({ status: 0, stdout: code })).toBe(code);
    }

    for (const result of [
      { status: 1, stdout: 'ready\n' },
      { status: 0, stdout: '' },
      { status: 0, stdout: 'ready\nready\n' },
      { status: 0, stdout: ' ready\n' },
      { status: 0, stdout: 'ready\nextra' },
      { status: 0, stdout: 'unknown_reason\n' },
      { status: null, stdout: 'ready\n' },
      { status: 0, stdout: 'ready\n', error: { code: 'ETIMEDOUT' } },
    ]) {
      expect(transport.parseDiagnosticResult(result)).toBe('readiness_statement_failed');
    }
  });

  it('runs one target-free diagnostic without readiness retry or low-level runner', async () => {
    const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    let output = '';
    const spawnSync = jest.fn(
      (command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({
          command,
          args: [...args],
          env: options.env ? { ...(options.env as NodeJS.ProcessEnv) } : undefined,
        });
        if (command === 'supabase') return { status: 0, stdout: '2.114.0\n' };
        if (command === '/usr/bin/security') return { status: 0, stdout: ACCESS_TOKEN };
        return { status: 0, stdout: 'ready\n' };
      },
    );
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(response(poolerResponse()))
      .mockResolvedValueOnce(response(roleResponse()));

    await expect(
      transport.runCliTransport({
        mode: 'diagnose',
        env: {
          Q5_TARGET_IMPORT_ID: '00000000-0000-4000-8000-000000000001',
          Q5_EXPECTED_TARGET_COUNT: 'synthetic-count',
          Q5_BACKUP_PLAINTEXT_PATH: '/must-not-forward',
        },
        platform: 'darwin',
        spawnSync,
        spawn: jest.fn(() => {
          throw new Error('low-level runner must not start');
        }),
        fetchFn,
        now: () => 1_000_000,
        lowLevelRunner: '/must-not-run',
        dockerPsql: '/synthetic/psql',
        stdout: (value: string) => {
          output += value;
        },
      }),
    ).resolves.toBe(0);

    const diagnosticCalls = calls.filter((call) => call.command === '/synthetic/psql');
    expect(diagnosticCalls).toHaveLength(1);
    expect(diagnosticCalls[0].args).toContainEqual(
      expect.stringContaining('--file='),
    );
    expect(diagnosticCalls[0].env?.Q5_REPAIR_AUTH_MODE).toBe('cli-diagnostic');
    expect(diagnosticCalls[0].env?.PGAPPNAME).toBe('foliolens-c3-cli-diagnostic');
    expect(diagnosticCalls[0].env).not.toHaveProperty('Q5_TARGET_IMPORT_ID');
    expect(diagnosticCalls[0].env).not.toHaveProperty('Q5_EXPECTED_TARGET_COUNT');
    expect(diagnosticCalls[0].env).not.toHaveProperty('Q5_BACKUP_PLAINTEXT_PATH');
    expect(output).toBe('ready\n');
    expect(calls.map((call) => call.command)).not.toContain('/must-not-run');
  });

  it('maps a diagnostic process failure to one aggregate code without retry', async () => {
    let diagnosticAttempts = 0;
    let output = '';
    const spawnSync = jest.fn((command: string) => {
      if (command === 'supabase') return { status: 0, stdout: '2.114.0\n' };
      if (command === '/usr/bin/security') return { status: 0, stdout: ACCESS_TOKEN };
      diagnosticAttempts += 1;
      return { status: 1, stdout: 'must-not-be-forwarded\n' };
    });
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(response(poolerResponse()))
      .mockResolvedValueOnce(response(roleResponse()));

    await expect(
      transport.runCliTransport({
        mode: 'diagnose',
        env: {},
        platform: 'darwin',
        spawnSync,
        fetchFn,
        now: () => 1_000_000,
        dockerPsql: '/synthetic/psql',
        stdout: (value: string) => {
          output += value;
        },
      }),
    ).resolves.toBe(0);

    expect(diagnosticAttempts).toBe(1);
    expect(output).toBe('readiness_statement_failed\n');
    expect(output).not.toContain('must-not-be-forwarded');
  });

  it.each(['Q5_DEV_DB_PASSWORD', 'Q5_PSQL_BIN', 'PGOPTIONS'])(
    'refuses inherited %s before Keychain access',
    async (name) => {
      const spawnSync = jest.fn();
      await expect(
        transport.runCliTransport({
          mode: 'dry-run',
          env: { [name]: 'must-not-be-read' },
          platform: 'darwin',
          spawnSync,
        }),
      ).rejects.toThrow('adapter overrides are forbidden');
      expect(spawnSync).not.toHaveBeenCalled();
    },
  );

  it('refuses even an empty inherited PGOPTIONS before Keychain access', async () => {
    const spawnSync = jest.fn();
    await expect(
      transport.runCliTransport({
        mode: 'probe',
        env: { PGOPTIONS: '' },
        platform: 'darwin',
        spawnSync,
      }),
    ).rejects.toThrow('adapter overrides are forbidden');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each(['dry-run', 'backup', 'apply', 'hydrate', 'rollback'])(
    'uses the exact CLI-temporary adapter mode for %s',
    async (mode) => {
      const asyncCalls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
      const spawnSync = jest.fn((command: string) => {
        if (command === 'supabase') return { status: 0, stdout: '2.114.0\n' };
        if (command === '/usr/bin/security') return { status: 0, stdout: ACCESS_TOKEN };
        return { status: 0 };
      });
      const fetchFn = jest
        .fn()
        .mockResolvedValueOnce(response(poolerResponse()))
        .mockResolvedValueOnce(response(roleResponse()));

      await expect(
        transport.runCliTransport({
          mode,
          env: {},
          platform: 'darwin',
          spawnSync,
          spawn: successfulAsyncSpawn(asyncCalls),
          fetchFn,
          sleep: async () => undefined,
          now: () => 1_000_000,
          lowLevelRunner: '/synthetic/runner',
          dockerPsql: '/synthetic/psql',
        }),
      ).resolves.toBe(0);

      expect(asyncCalls).toHaveLength(1);
      expect(asyncCalls[0].args).toEqual([mode]);
      expect(asyncCalls[0].env?.Q5_REPAIR_AUTH_MODE).toBe('cli-temporary');
      expect(asyncCalls[0].env).not.toHaveProperty('PGOPTIONS');
    },
  );

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
        env: {},
        platform: 'darwin',
        spawnSync,
        fetchFn,
        sleep: async () => {
          clock += 60_000;
        },
        now: () => clock,
        lowLevelRunner: '/must-not-run',
        dockerPsql: '/synthetic/psql',
      }),
    ).rejects.toThrow('temporary Supabase CLI login did not become ready');
    expect(commands).not.toContain('/must-not-run');
  });

  it('retries a timed-out readiness probe within the temporary-role deadline', async () => {
    let probeAttempts = 0;
    const spawnSync = jest.fn((command: string) => {
      if (command === 'supabase') return { status: 0, stdout: '2.114.0\n' };
      if (command === '/usr/bin/security') return { status: 0, stdout: ACCESS_TOKEN };
      probeAttempts += 1;
      if (probeAttempts === 1) return { status: null, error: { code: 'ETIMEDOUT' } };
      return { status: 0 };
    });
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(response(poolerResponse()))
      .mockResolvedValueOnce(response(roleResponse()));

    await expect(
      transport.runCliTransport({
        mode: 'probe',
        env: {},
        platform: 'darwin',
        spawnSync,
        fetchFn,
        sleep: async () => undefined,
        now: () => 1_000_000,
        dockerPsql: '/synthetic/psql',
        stdout: () => undefined,
      }),
    ).resolves.toBe(0);
    expect(probeAttempts).toBe(2);
  });

  it('anchors expiry before the bounded login request begins', async () => {
    const asyncCalls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const spawn = successfulAsyncSpawn(asyncCalls);
    const spawnSync = jest.fn((command: string) => {
      if (command === 'supabase') return { status: 0, stdout: '2.114.0\n' };
      if (command === '/usr/bin/security') return { status: 0, stdout: ACCESS_TOKEN };
      return { status: 0 };
    });
    let clock = 1_000_000;
    const fetchFn = jest.fn(async (url: string) => {
      if (url.endsWith('/config/database/pooler')) return response(poolerResponse());
      clock += 100_000;
      return response(roleResponse());
    });
    const scheduledDelays: number[] = [];

    await expect(
      transport.runCliTransport({
        mode: 'dry-run',
        env: {},
        platform: 'darwin',
        spawnSync,
        spawn,
        fetchFn,
        sleep: async () => undefined,
        now: () => clock,
        lowLevelRunner: '/synthetic/runner',
        dockerPsql: '/synthetic/psql',
        setTimer: (callback: () => void, delay: number) => {
          scheduledDelays.push(delay);
          return setTimeout(callback, delay);
        },
        clearTimer: (timer: NodeJS.Timeout) => clearTimeout(timer),
      }),
    ).resolves.toBe(0);

    const runner = asyncCalls.find((call) => call.command === '/synthetic/runner');
    expect(runner?.env?.Q5_CLI_ROLE_EXPIRES_AT_EPOCH).toBe('1300');
    expect(scheduledDelays).toContain(155_000);
  });

  it('terminates the complete detached process group at the pre-expiry cap', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-process-group-'));
    const marker = path.join(temp, 'work-completed');
    try {
      await expect(
        transport.runBoundedProcessGroup({
          spawn: nodeSpawn,
          kill: process.kill.bind(process),
          setTimer: setTimeout,
          clearTimer: clearTimeout,
          signalSource: process,
          command: '/bin/sh',
          args: ['-c', 'sleep 0.6; : > "$C2_MARKER"'],
          env: { ...process.env, C2_MARKER: marker },
          timeoutMs: 100,
        }),
      ).rejects.toThrow('repair stopped before temporary login expiry');
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('forwards an operator interrupt and stays alive until detached work stops', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-operator-interrupt-'));
    const started = path.join(temp, 'work-started');
    const committed = path.join(temp, 'work-committed');
    const modulePath = path.join(ROOT, 'run-exact-target-repair-with-cli.cjs');
    const wrapperSource = `
const childProcess = require('node:child_process');
const transport = require(${JSON.stringify(modulePath)});
transport.runBoundedProcessGroup({
  spawn: childProcess.spawn,
  kill: process.kill.bind(process),
  setTimer: setTimeout,
  clearTimer: clearTimeout,
  signalSource: process,
  command: '/bin/sh',
  args: ['-c', ': > "$C2_STARTED"; sleep 1.2; : > "$C2_COMMITTED"'],
  env: { ...process.env, C2_STARTED: ${JSON.stringify(started)}, C2_COMMITTED: ${JSON.stringify(committed)} },
  timeoutMs: 10_000,
}).then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 2; });
`;
    const wrapper = nodeSpawn(process.execPath, ['-e', wrapperSource], { stdio: 'ignore' });
    try {
      for (let attempt = 0; attempt < 40 && !fs.existsSync(started); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(fs.existsSync(started)).toBe(true);
      process.kill(wrapper.pid!, 'SIGINT');
      const exitCode = await new Promise<number | null>((resolve) => {
        wrapper.once('close', (code) => resolve(code));
      });
      expect(exitCode).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 1_400));
      expect(fs.existsSync(committed)).toBe(false);
    } finally {
      if (wrapper.exitCode === null && wrapper.pid) wrapper.kill('SIGKILL');
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('uses an ephemeral Docker container and copies only allowlisted environment names', () => {
    const source = fs.readFileSync(path.join(ROOT, 'docker-psql.sh'), 'utf8');
    expect(source).toContain('run --rm -i');
    expect(source).toContain('--env PGPASSWORD');
    expect(source).not.toContain('--env PGOPTIONS');
    expect(source).not.toContain('--env "PGPASSWORD=');
    expect(source).toContain('Q5_REPAIR_AUTH_MODE:-password');
    expect(source).toContain('cli-diagnostic');
    expect(source).toContain('-v ON_ERROR_STOP=1');
    expect(source).toContain('-q');
    expect(source).toContain("-c 'SET ROLE postgres'");
    expect(source).toContain('--volume "$SCRIPT_DIR:$SCRIPT_DIR:ro"');
    expect(source).toContain("POSTGRES_IMAGE='postgres:17-alpine'");
    expect(source).toContain('refusing unexpected plaintext backup mount');
    expect(source).toContain('exec docker "${docker_args[@]}" "$POSTGRES_IMAGE" psql \\');
    expect(source).toContain('exec docker "${docker_args[@]}" "$POSTGRES_IMAGE" psql "$@"');
  });

  it('injects the fixed same-session role command only in exact CLI-temporary mode', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-docker-adapter-'));
    const fakeDocker = path.join(temp, 'docker');
    const capture = path.join(temp, 'argv');
    fs.writeFileSync(
      fakeDocker,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$C3_CAPTURE"\n',
      { mode: 0o700 },
    );
    const adapter = path.join(ROOT, 'docker-psql.sh');
    const baseEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PATH: `${temp}:${process.env.PATH ?? ''}`,
      PGPASSWORD: 'synthetic-password-not-in-argv',
      C3_CAPTURE: capture,
    };

    try {
      const cliResult = nodeSpawnSync(adapter, ['--file=/synthetic/mode.sql'], {
        env: { ...baseEnv, Q5_REPAIR_AUTH_MODE: 'cli-temporary' },
        encoding: 'utf8',
      });
      expect(cliResult.status).toBe(0);
      const cliArgs = fs.readFileSync(capture, 'utf8').trim().split('\n');
      const psqlIndex = cliArgs.indexOf('psql');
      expect(cliArgs.slice(psqlIndex + 1)).toEqual([
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        'SET ROLE postgres',
        '--file=/synthetic/mode.sql',
      ]);
      expect(cliArgs.join('\n')).not.toContain('synthetic-password-not-in-argv');

      const diagnosticResult = nodeSpawnSync(adapter, ['--file=/synthetic/diagnostic.psql'], {
        env: { ...baseEnv, Q5_REPAIR_AUTH_MODE: 'cli-diagnostic' },
        encoding: 'utf8',
      });
      expect(diagnosticResult.status).toBe(0);
      const diagnosticArgs = fs.readFileSync(capture, 'utf8').trim().split('\n');
      const diagnosticPsqlIndex = diagnosticArgs.indexOf('psql');
      expect(diagnosticArgs.slice(diagnosticPsqlIndex + 1)).toEqual([
        '-q',
        '-c',
        'SET ROLE postgres',
        '--file=/synthetic/diagnostic.psql',
      ]);

      for (const authMode of [undefined, 'password', 'unexpected']) {
        const env: NodeJS.ProcessEnv = { ...baseEnv };
        delete env.Q5_REPAIR_AUTH_MODE;
        if (authMode !== undefined) env.Q5_REPAIR_AUTH_MODE = authMode;
        const passwordResult = nodeSpawnSync(adapter, ['--file=/synthetic/mode.sql'], {
          env,
          encoding: 'utf8',
        });
        expect({ status: passwordResult.status, stderr: passwordResult.stderr }).toEqual({
          status: 0,
          stderr: '',
        });
        const passwordArgs = fs.readFileSync(capture, 'utf8').trim().split('\n');
        const passwordPsqlIndex = passwordArgs.indexOf('psql');
        expect(passwordArgs.slice(passwordPsqlIndex + 1)).toEqual([
          '--file=/synthetic/mode.sql',
        ]);
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('stops before any later command or file when the injected role command fails', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-role-failure-'));
    const fakeDocker = path.join(temp, 'docker');
    const marker = path.join(temp, 'later-argv-executed');
    fs.writeFileSync(
      fakeDocker,
      `#!/bin/sh
while [ "$1" != "psql" ]; do shift; done
shift
if [ "$1" = "-v" ] && [ "$2" = "ON_ERROR_STOP=1" ] && [ "$3" = "-c" ] && [ "$4" = "SET ROLE postgres" ]; then
  exit 1
fi
: > "$C3_MARKER"
exit 1
`,
      { mode: 0o700 },
    );

    try {
      const result = nodeSpawnSync(
        path.join(ROOT, 'docker-psql.sh'),
        ['--command=select later_command_marker()', '--file=/synthetic/later-file.sql'],
        {
          env: {
            NODE_ENV: 'test',
            PATH: `${temp}:${process.env.PATH ?? ''}`,
            PGPASSWORD: 'synthetic-password-not-in-argv',
            Q5_REPAIR_AUTH_MODE: 'cli-temporary',
            C3_MARKER: marker,
          },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(1);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('pins the unchanged later-argv and SQL no-role-change invariant', () => {
    const sqlFiles = fs
      .readdirSync(ROOT)
      .filter((name) => /^exact-target-.*\.sql$/.test(name));
    expect(sqlFiles).toHaveLength(5);
    for (const name of sqlFiles) {
      const source = fs.readFileSync(path.join(ROOT, name), 'utf8');
      expect(source).not.toMatch(/\b(?:set|reset)\s+role\b/i);
      expect(source).not.toMatch(/\bset\s+session\s+authorization\b/i);
      expect(source).not.toMatch(/(^|\s)\\(?:connect|c)(?:\s|$)/im);
    }

    const runner = fs.readFileSync(path.join(ROOT, 'run-exact-target-repair.sh'), 'utf8');
    expect(runner).not.toContain("--command='SET ROLE");
    const psqlBaseStart = runner.indexOf('readonly PSQL_BASE=(');
    const psqlBaseEnd = runner.indexOf('\n)', psqlBaseStart);
    expect(psqlBaseStart).toBeGreaterThan(-1);
    expect(psqlBaseEnd).toBeGreaterThan(psqlBaseStart);
    expect(runner.slice(psqlBaseStart, psqlBaseEnd)).not.toMatch(/(^|\s)-c(?:\s|$)/);
  });

  it('stages the diagnostic before protected references and keeps it target-free', () => {
    const source = fs.readFileSync(path.join(ROOT, 'diagnose-cli-authority.psql'), 'utf8');
    const membership = source.indexOf('pg_has_role');
    const appliedRole = source.indexOf("current_role = 'postgres'");
    const tableCatalog = source.indexOf('has_table_privilege');
    const resolverCatalog = source.indexOf('has_function_privilege');
    const protectedReference = source.indexOf(
      'from (select count(*) as row_count from public.transaction where false)',
    );
    const resolverCall = source.lastIndexOf('public.resolve_user_fund_activation_v1(');

    expect(membership).toBeGreaterThan(-1);
    expect(appliedRole).toBeGreaterThan(membership);
    expect(tableCatalog).toBeGreaterThan(appliedRole);
    expect(resolverCatalog).toBeGreaterThan(tableCatalog);
    expect(protectedReference).toBeGreaterThan(resolverCatalog);
    expect(resolverCall).toBeGreaterThan(resolverCatalog);
    expect(source).not.toMatch(/\bcase\b/i);
    expect(source).not.toContain('Q5_TARGET_IMPORT_ID');
    expect(source).toContain('\\set ON_ERROR_STOP on');
    expect(source).toContain('\\o /dev/null');
    expect(source).toContain('\\echo ready');
  });

  it('uses the same staged boundary for silent fatal readiness', () => {
    const source = fs.readFileSync(path.join(ROOT, 'check-cli-authority.psql'), 'utf8');
    const appliedRole = source.indexOf("current_role = 'postgres'");
    const tableCatalog = source.indexOf('has_table_privilege');
    const resolverCatalog = source.indexOf('has_function_privilege');
    const protectedReference = source.indexOf(
      'from (select count(*) as row_count from public.transaction where false)',
    );
    const resolverCall = source.lastIndexOf('public.resolve_user_fund_activation_v1(');

    expect(appliedRole).toBeGreaterThan(-1);
    expect(tableCatalog).toBeGreaterThan(appliedRole);
    expect(resolverCatalog).toBeGreaterThan(tableCatalog);
    expect(protectedReference).toBeGreaterThan(resolverCatalog);
    expect(resolverCall).toBeGreaterThan(resolverCatalog);
    expect(source).not.toMatch(/\bcase\b/i);
    expect(source).not.toContain('\\echo');
    expect(source).toContain('\\set ON_ERROR_STOP on');
    expect(source).toContain('\\o /dev/null');
    expect(source.match(/select 1 \/ 0;/g)).toHaveLength(3);
    expect(source).toContain('\\quit 0');
  });

  it('requires explicit, unexpired CLI target metadata in the low-level runner', () => {
    const source = fs.readFileSync(path.join(ROOT, 'run-exact-target-repair.sh'), 'utf8');
    expect(source).toContain("Q5_REPAIR_AUTH_MODE:-password");
    expect(source).toContain('Q5_CLI_ROLE_EXPIRES_AT_EPOCH');
    expect(source).toContain(`cli_login_postgres.$DEV_PROJECT_REF`);
    expect(source).toContain('refusing invalid or expired Supabase CLI database target');
  });
});
