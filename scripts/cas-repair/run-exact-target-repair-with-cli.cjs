#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const { Buffer } = require('node:buffer');
const path = require('node:path');
const { setTimeout: sleepTimer } = require('node:timers/promises');

const DEV_PROJECT_REF = 'imkgazlrxtlhkfptkzjc';
const MANAGEMENT_API_BASE = `https://api.supabase.com/v1/projects/${DEV_PROJECT_REF}`;
const KEYRING_SERVICE = 'Supabase CLI';
const MINIMUM_CLI_VERSION = [2, 114, 0];
const SESSION_POOLER_PORT = '5432';
const MINIMUM_TTL_SECONDS = 60;
const MAXIMUM_TTL_SECONDS = 600;
const EXPIRY_SAFETY_SECONDS = 45;
const MAX_CHILD_RUNTIME_MS = 240_000;
const MODES = new Set(['probe', 'dry-run', 'backup', 'apply', 'hydrate', 'rollback']);
const SCRIPT_DIR = path.dirname(require.resolve('./run-exact-target-repair-with-cli.cjs'));
const LOW_LEVEL_RUNNER = path.join(SCRIPT_DIR, 'run-exact-target-repair.sh');
const DOCKER_PSQL = path.join(SCRIPT_DIR, 'docker-psql.sh');
const ACCESS_TOKEN_PATTERN = /^sbp_(oauth_)?[a-f0-9]{40}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9._-]+$/;

function controlledError(message) {
  return new Error(message);
}

function parseCliVersion(output) {
  const match = String(output).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\D.*)?$/);
  if (!match) throw controlledError('unable to verify the Supabase CLI version');
  return match.slice(1).map(Number);
}

function versionAtLeast(actual, minimum = MINIMUM_CLI_VERSION) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function normalizeStoredToken(value) {
  const prefix = 'go-keyring-base64:';
  const trimmed = String(value).trim();
  if (!trimmed.startsWith(prefix)) return trimmed;
  return Buffer.from(trimmed.slice(prefix.length), 'base64').toString('utf8');
}

async function readJsonResponse(response, label) {
  if (!response || response.ok !== true) {
    throw controlledError(`${label} request failed`);
  }
  const text = await response.text();
  if (text.length === 0 || text.length > 65_536) {
    throw controlledError(`${label} response was invalid`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw controlledError(`${label} response was invalid`);
  }
}

function parsePrimaryPooler(value) {
  if (!Array.isArray(value)) throw controlledError('pooler response was invalid');
  const primary = value.filter((entry) => entry?.database_type === 'PRIMARY');
  if (primary.length !== 1 || typeof primary[0].connection_string !== 'string') {
    throw controlledError('primary pooler configuration was not unique');
  }

  let parsed;
  try {
    parsed = new URL(primary[0].connection_string.replace('[YOUR-PASSWORD]', 'placeholder'));
  } catch {
    throw controlledError('primary pooler connection was invalid');
  }
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !parsed.hostname.endsWith('.pooler.supabase.com') ||
    username !== `postgres.${DEV_PROJECT_REF}` ||
    parsed.pathname !== '/postgres' ||
    password !== 'placeholder'
  ) {
    throw controlledError('primary pooler did not match the authorized dev project');
  }
  return { host: parsed.hostname, database: 'postgres' };
}

function parseTemporaryRole(value) {
  if (
    !value ||
    value.role !== 'cli_login_postgres' ||
    typeof value.password !== 'string' ||
    value.password.length < 16 ||
    value.password.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value.password) ||
    !Number.isInteger(value.ttl_seconds) ||
    value.ttl_seconds < MINIMUM_TTL_SECONDS ||
    value.ttl_seconds > MAXIMUM_TTL_SECONDS
  ) {
    throw controlledError('temporary login response was invalid');
  }
  return {
    user: `${value.role}.${DEV_PROJECT_REF}`,
    password: value.password,
    ttlSeconds: value.ttl_seconds,
  };
}

function safeSpawn(spawnSync, command, args, options, failureMessage) {
  const result = spawnSync(command, args, options);
  if (result?.error && result.error.code !== 'ETIMEDOUT') {
    throw controlledError(failureMessage);
  }
  return result;
}

async function waitForTemporaryLogin({ spawnSync, sleep, psqlBin, childEnv, deadlineMs, now }) {
  const args = [
    `--host=${childEnv.Q5_DEV_DB_HOST}`,
    `--port=${childEnv.Q5_DEV_DB_PORT}`,
    `--dbname=${childEnv.Q5_DEV_DB_NAME}`,
    `--username=${childEnv.Q5_DEV_DB_USER}`,
    '--no-psqlrc',
    '--tuples-only',
    '--no-align',
    '--command=select 1',
  ];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = safeSpawn(
      spawnSync,
      psqlBin,
      args,
      { env: childEnv, stdio: 'ignore', timeout: 20_000 },
      'unable to start the psql readiness probe',
    );
    if (result.status === 0) return;
    if (now() + 15_000 >= deadlineMs) break;
    await sleep(Math.min(3_000 * 1.5 ** attempt, 10_000));
  }
  throw controlledError('temporary Supabase CLI login did not become ready');
}

async function runCliTransport(options = {}) {
  const env = options.env ?? process.env;
  const spawnSync = options.spawnSync ?? childProcess.spawnSync;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const sleep = options.sleep ?? ((milliseconds) => sleepTimer(milliseconds));
  const now = options.now ?? (() => Date.now());
  const platform = options.platform ?? process.platform;
  const lowLevelRunner = options.lowLevelRunner ?? LOW_LEVEL_RUNNER;
  const dockerPsql = options.dockerPsql ?? DOCKER_PSQL;
  const mode = options.mode ?? process.argv[2];
  let childEnv;
  let token = '';
  let temporaryPassword = '';

  try {
    if (!MODES.has(mode)) {
      throw controlledError('usage: run-exact-target-repair-with-cli.cjs {probe|dry-run|backup|apply|hydrate|rollback}');
    }
    if (platform !== 'darwin') {
      throw controlledError('the C2 CLI credential bridge currently requires macOS Keychain');
    }
    for (const name of [
      'Q5_DEV_DB_PASSWORD',
      'SUPABASE_DB_PASSWORD',
      'Q5_DEV_DB_HOST',
      'Q5_DEV_DB_USER',
      'Q5_DEV_DB_PORT',
      'Q5_DEV_DB_NAME',
    ]) {
      if (env[name]) throw controlledError('database password and connection overrides are forbidden in CLI mode');
    }

    const versionResult = safeSpawn(
      spawnSync,
      'supabase',
      ['--version'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
      'Supabase CLI is required',
    );
    if (versionResult.status !== 0 || !versionAtLeast(parseCliVersion(versionResult.stdout))) {
      throw controlledError('Supabase CLI 2.114.0 or later is required');
    }

    const profile = env.SUPABASE_PROFILE || 'supabase';
    if (!PROFILE_PATTERN.test(profile)) throw controlledError('Supabase CLI profile name was invalid');
    const keychainResult = safeSpawn(
      spawnSync,
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYRING_SERVICE, '-a', profile, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, maxBuffer: 4_096 },
      'unable to read the Supabase CLI Keychain login',
    );
    if (keychainResult.status !== 0) {
      throw controlledError('Supabase CLI login was not available in macOS Keychain');
    }
    token = normalizeStoredToken(keychainResult.stdout);
    if (!ACCESS_TOKEN_PATTERN.test(token)) {
      throw controlledError('Supabase CLI Keychain login was invalid');
    }

    if (typeof fetchFn !== 'function') throw controlledError('Node fetch support is required');
    const authorization = `Bearer ${token}`;
    const poolerResponse = await fetchFn(`${MANAGEMENT_API_BASE}/config/database/pooler`, {
      headers: { Authorization: authorization },
    });
    const pooler = parsePrimaryPooler(
      await readJsonResponse(poolerResponse, 'pooler configuration'),
    );
    const loginResponse = await fetchFn(`${MANAGEMENT_API_BASE}/cli/login-role`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ read_only: false }),
    });
    token = '';
    const temporary = parseTemporaryRole(
      await readJsonResponse(loginResponse, 'temporary login'),
    );
    temporaryPassword = temporary.password;
    const issuedAtMs = now();
    const deadlineMs = issuedAtMs + temporary.ttlSeconds * 1_000;
    const expiresAtEpoch = Math.floor(deadlineMs / 1_000);
    const psqlBin = env.Q5_PSQL_BIN || dockerPsql;

    childEnv = { ...env };
    delete childEnv.SUPABASE_ACCESS_TOKEN;
    delete childEnv.SUPABASE_DB_PASSWORD;
    Object.assign(childEnv, {
      Q5_PSQL_BIN: psqlBin,
      Q5_REPAIR_AUTH_MODE: 'cli-temporary',
      Q5_CLI_ROLE_EXPIRES_AT_EPOCH: String(expiresAtEpoch),
      Q5_DEV_DB_HOST: pooler.host,
      Q5_DEV_DB_PORT: SESSION_POOLER_PORT,
      Q5_DEV_DB_NAME: pooler.database,
      Q5_DEV_DB_USER: temporary.user,
      Q5_DEV_DB_PASSWORD: temporaryPassword,
      PGPASSWORD: temporaryPassword,
      PGSSLMODE: 'require',
      PGCONNECT_TIMEOUT: '15',
      PGAPPNAME: 'foliolens-q5-exact-target-repair',
    });

    await waitForTemporaryLogin({ spawnSync, sleep, psqlBin, childEnv, deadlineMs, now });
    if (mode === 'probe') {
      if (options.stdout) options.stdout('{"cli_transport":"ready"}\n');
      else process.stdout.write('{"cli_transport":"ready"}\n');
      return 0;
    }

    const remainingMs = deadlineMs - now() - EXPIRY_SAFETY_SECONDS * 1_000;
    const timeout = Math.min(MAX_CHILD_RUNTIME_MS, remainingMs);
    if (timeout < 15_000) throw controlledError('temporary login lifetime was insufficient');
    const result = safeSpawn(
      spawnSync,
      lowLevelRunner,
      [mode],
      { env: childEnv, stdio: 'inherit', timeout, killSignal: 'SIGTERM' },
      'unable to start the exact-target repair runner',
    );
    if (result.error?.code === 'ETIMEDOUT') {
      throw controlledError('exact-target repair stopped before temporary login expiry');
    }
    if (typeof result.status !== 'number') {
      throw controlledError('exact-target repair runner ended unexpectedly');
    }
    return result.status;
  } finally {
    token = '';
    temporaryPassword = '';
    if (childEnv) {
      delete childEnv.Q5_DEV_DB_PASSWORD;
      delete childEnv.PGPASSWORD;
    }
  }
}

module.exports = {
  DEV_PROJECT_REF,
  parseCliVersion,
  versionAtLeast,
  normalizeStoredToken,
  parsePrimaryPooler,
  parseTemporaryRole,
  runCliTransport,
};

if (require.main === module) {
  runCliTransport()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      process.stderr.write(`C2 CLI transport failed: ${error.message}\n`);
      process.exitCode = 2;
    });
}
