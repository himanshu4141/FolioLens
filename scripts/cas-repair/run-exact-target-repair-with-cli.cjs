#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const { Buffer } = require('node:buffer');
const fs = require('node:fs');
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
const MANAGEMENT_REQUEST_TIMEOUT_MS = 30_000;
const CHILD_TERMINATION_GRACE_MS = 2_000;
const CHILD_KILL_CONFIRM_INTERVAL_MS = 50;
const CHILD_KILL_CONFIRM_ATTEMPTS = 40;
const HYDRATION_PER_REQUEST_SLACK_MS = 5_000;
const HYDRATION_PHASE_SLACK_MS = 30_000;
const HYDRATION_REQUEST_TIMEOUT_MS = 90_000;
const MAX_HYDRATION_SCHEMES = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MODES = new Set(['diagnose', 'probe', 'dry-run', 'backup', 'apply', 'hydrate', 'rollback']);
const SCRIPT_DIR = path.dirname(require.resolve('./run-exact-target-repair-with-cli.cjs'));
const LOW_LEVEL_RUNNER = path.join(SCRIPT_DIR, 'run-exact-target-repair.sh');
const DOCKER_PSQL = path.join(SCRIPT_DIR, 'docker-psql.sh');
const DIAGNOSTIC_PSQL = path.join(SCRIPT_DIR, 'diagnose-cli-authority.psql');
const AUTHORITY_PROBE_PSQL = path.join(SCRIPT_DIR, 'check-cli-authority.psql');
const HYDRATION_HELPER = require('./hydration-batch-json.cjs');
const HANDOFF_PREFIX = '/tmp/foliolens-q5-hydration-handoff.';
const HANDOFF_PATTERN = /^\/tmp\/foliolens-q5-hydration-handoff\.[A-Za-z0-9]+$/;
const ACCESS_TOKEN_PATTERN = /^sbp_(oauth_)?[a-f0-9]{40}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9._-]+$/;
const DIAGNOSTIC_CODES = new Set([
  'role_assumption_missing',
  'role_assumption_not_applied',
  'table_authority_missing',
  'resolver_authority_missing',
  'ready',
  'readiness_statement_failed',
]);
const DIAGNOSTIC_STRIPPED_ENV = [
  'Q5_TARGET_IMPORT_ID',
  'Q5_EXPECTED_TARGET_COUNT',
  'Q5_EXPECTED_TARGET_DIGEST',
  'Q5_EXPECTED_UNRELATED_COUNT',
  'Q5_EXPECTED_UNRELATED_DIGEST',
  'Q5_BACKUP_SHA256',
  'Q5_APPROVE_EXACT_TARGET_DELETE',
  'Q5_EXPECTED_RESTORE_COUNT',
  'Q5_BACKUP_PLAINTEXT_PATH',
];
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
  if (result?.error) {
    throw controlledError(failureMessage);
  }
  return result;
}

async function fetchJsonWithTimeout({
  fetchFn,
  url,
  init,
  label,
  setTimer,
  clearTimer,
}) {
  const controller = new AbortController();
  const timeout = setTimer(() => controller.abort(), MANAGEMENT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    return await readJsonResponse(response, label);
  } catch {
    throw controlledError(`${label} request failed`);
  } finally {
    clearTimer(timeout);
  }
}

function runBoundedProcessGroup({
  spawn,
  kill,
  setTimer,
  clearTimer,
  signalSource,
  command,
  args,
  env,
  timeoutMs,
  deadlineMessage = 'exact-target repair stopped before temporary login expiry',
  interruptMessage = 'exact-target repair stopped after operator interrupt',
  startFailureMessage = 'unable to start the exact-target repair runner',
  stopFailureMessage = 'unable to confirm the exact-target repair stopped',
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { env, stdio: 'inherit', detached: true });
    } catch {
      reject(controlledError(startFailureMessage));
      return;
    }

    let deadlineTimer;
    let forceTimer;
    let settled = false;
    let stopSent = false;
    let stopMessage = deadlineMessage;
    let killConfirmationAttempts = 0;

    const onOperatorInterrupt = () => {
      requestStop(interruptMessage);
    };

    const removeSignalHandlers = () => {
      signalSource.removeListener('SIGINT', onOperatorInterrupt);
      signalSource.removeListener('SIGTERM', onOperatorInterrupt);
    };

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimer(deadlineTimer);
      if (forceTimer) clearTimer(forceTimer);
      removeSignalHandlers();
      callback();
    };

    const failStop = () =>
      finish(() => reject(controlledError(stopFailureMessage)));

    const completeStop = () => finish(() => reject(controlledError(stopMessage)));

    const confirmForcedStop = () => {
      try {
        kill(-child.pid, 0);
      } catch (error) {
        if (error?.code === 'ESRCH') return completeStop();
        failStop();
        return;
      }
      if (killConfirmationAttempts >= CHILD_KILL_CONFIRM_ATTEMPTS) {
        failStop();
        return;
      }
      killConfirmationAttempts += 1;
      forceTimer = setTimer(confirmForcedStop, CHILD_KILL_CONFIRM_INTERVAL_MS);
    };

    const forceStop = () => {
      try {
        kill(-child.pid, 0);
      } catch (error) {
        if (error?.code === 'ESRCH') return completeStop();
        failStop();
        return;
      }
      try {
        kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error?.code === 'ESRCH') return completeStop();
        return failStop();
      }
      killConfirmationAttempts = 0;
      forceTimer = setTimer(confirmForcedStop, CHILD_KILL_CONFIRM_INTERVAL_MS);
    };

    function requestStop(message) {
      if (settled) return;
      stopMessage = message;
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        failStop();
        return;
      }
      if (stopSent) {
        forceStop();
        return;
      }
      try {
        kill(-child.pid, 'SIGTERM');
        stopSent = true;
      } catch (error) {
        if (error?.code === 'ESRCH') {
          completeStop();
        } else {
          failStop();
        }
        return;
      }
      forceTimer = setTimer(forceStop, CHILD_TERMINATION_GRACE_MS);
    }

    signalSource.on('SIGINT', onOperatorInterrupt);
    signalSource.on('SIGTERM', onOperatorInterrupt);

    child.once('error', () => {
      if (stopSent) {
        failStop();
      } else {
        finish(() => reject(controlledError(startFailureMessage)));
      }
    });

    child.once('close', (code) => {
      if (!stopSent) {
        if (typeof code !== 'number') {
          finish(() => reject(controlledError('exact-target repair runner ended unexpectedly')));
          return;
        }
        if (!Number.isInteger(child.pid) || child.pid <= 0) {
          failStop();
          return;
        }
        try {
          kill(-child.pid, 0);
        } catch (error) {
          if (error?.code === 'ESRCH') {
            finish(() => resolve(code));
          } else {
            failStop();
          }
          return;
        }
        requestStop('exact-target repair process group outlived its runner');
        return;
      }

      try {
        kill(-child.pid, 0);
      } catch (error) {
        if (error?.code === 'ESRCH') {
          completeStop();
        } else {
          failStop();
        }
      }
    });

    deadlineTimer = setTimer(
      () => requestStop(deadlineMessage),
      timeoutMs,
    );
  });
}

function createHydrationHandoff(fsModule = fs) {
  let handoffDir;
  try {
    handoffDir = fsModule.mkdtempSync(HANDOFF_PREFIX);
    fsModule.chmodSync(handoffDir, 0o700);
  } catch {
    throw controlledError('unable to create the authoritative hydration handoff');
  }
  if (!HANDOFF_PATTERN.test(handoffDir)) {
    throw controlledError('authoritative hydration handoff path was invalid');
  }
  return handoffDir;
}

function cleanupHydrationHandoff(handoffDir, fsModule = fs) {
  if (!handoffDir) return;
  if (!HANDOFF_PATTERN.test(handoffDir)) {
    throw controlledError('authoritative hydration handoff path was invalid');
  }
  try {
    fsModule.rmSync(handoffDir, { recursive: true, force: true });
    if (fsModule.existsSync(handoffDir)) throw new Error('handoff remains');
  } catch {
    throw controlledError('authoritative hydration handoff cleanup failed');
  }
}

function calculateHydrationExecutionTimeout(count) {
  if (!Number.isSafeInteger(count) || count <= 0 || count > MAX_HYDRATION_SCHEMES) {
    throw controlledError('authoritative hydration plan count was invalid');
  }
  const perRequestMs = HYDRATION_REQUEST_TIMEOUT_MS + HYDRATION_PER_REQUEST_SLACK_MS;
  const requestBudgetMs = count * perRequestMs;
  const timeoutMs = requestBudgetMs + HYDRATION_PHASE_SLACK_MS;
  if (
    !Number.isSafeInteger(requestBudgetMs)
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw controlledError('authoritative hydration execution deadline was invalid');
  }
  return timeoutMs;
}

function buildHydrationExecutionEnv(sourceEnv, handoffDir, metadata) {
  const result = {
    PATH: sourceEnv.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    Q5_REPAIR_AUTH_MODE: 'cli-hydration-execute',
    Q5_APPROVE_EXACT_TARGET_DELETE: sourceEnv.Q5_APPROVE_EXACT_TARGET_DELETE,
    Q5_DEV_FUNCTIONS_URL: sourceEnv.Q5_DEV_FUNCTIONS_URL,
    Q5_DEV_SERVICE_ROLE_KEY: sourceEnv.Q5_DEV_SERVICE_ROLE_KEY,
    Q5_HYDRATION_HANDOFF_DIR: handoffDir,
    Q5_HYDRATION_PLAN_COUNT: String(metadata.count),
    Q5_HYDRATION_PLAN_SHA256: metadata.sha256,
  };
  for (const name of ['LANG', 'LC_ALL', 'TZ']) {
    if (typeof sourceEnv[name] === 'string' && sourceEnv[name].length > 0) {
      result[name] = sourceEnv[name];
    }
  }
  return result;
}

function hydrationFailureMessage(code) {
  switch (code) {
    case 41: return 'authoritative hydration handoff failed';
    case 42: return 'authoritative hydration request transport failed';
    case 43: return 'authoritative hydration HTTP contract failed';
    case 44: return 'authoritative hydration response contract failed';
    case 45: return 'authoritative hydration aggregate contract failed';
    case 46: return 'authoritative hydration cleanup failed';
    default: return 'authoritative hydration execution failed';
  }
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
    `--file=${AUTHORITY_PROBE_PSQL}`,
  ];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = spawnSync(psqlBin, args, {
      env: childEnv,
      stdio: 'ignore',
      timeout: 20_000,
    });
    if (result?.error && result.error.code !== 'ETIMEDOUT') {
      throw controlledError('unable to start the psql readiness probe');
    }
    if (result.status === 0) return;
    if (now() + 15_000 >= deadlineMs) break;
    await sleep(Math.min(3_000 * 1.5 ** attempt, 10_000));
  }
  throw controlledError('temporary Supabase CLI login did not become ready');
}

function parseDiagnosticResult(result) {
  if (result?.error || result?.status !== 0) return 'readiness_statement_failed';
  const match = String(result.stdout ?? '').match(/^([a-z_]+)\n?$/);
  if (!match || !DIAGNOSTIC_CODES.has(match[1])) return 'readiness_statement_failed';
  return match[1];
}

function runCliDiagnostic({ spawnSync, psqlBin, childEnv }) {
  const args = [
    `--host=${childEnv.Q5_DEV_DB_HOST}`,
    `--port=${childEnv.Q5_DEV_DB_PORT}`,
    `--dbname=${childEnv.Q5_DEV_DB_NAME}`,
    `--username=${childEnv.Q5_DEV_DB_USER}`,
    '--no-psqlrc',
    '--tuples-only',
    '--no-align',
    `--file=${DIAGNOSTIC_PSQL}`,
  ];
  try {
    const result = spawnSync(psqlBin, args, {
      env: childEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
      maxBuffer: 1_024,
    });
    return parseDiagnosticResult(result);
  } catch {
    return 'readiness_statement_failed';
  }
}

async function runCliTransport(options = {}) {
  const env = options.env ?? process.env;
  const spawnSync = options.spawnSync ?? childProcess.spawnSync;
  const spawn = options.spawn ?? childProcess.spawn;
  const kill = options.kill ?? process.kill.bind(process);
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const signalSource = options.signalSource ?? process;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const sleep = options.sleep ?? ((milliseconds) => sleepTimer(milliseconds));
  const now = options.now ?? (() => Date.now());
  const platform = options.platform ?? process.platform;
  const lowLevelRunner = options.lowLevelRunner ?? LOW_LEVEL_RUNNER;
  const dockerPsql = options.dockerPsql ?? DOCKER_PSQL;
  const mode = options.mode ?? process.argv[2];
  const createHandoff = options.createHydrationHandoff ?? createHydrationHandoff;
  const cleanupHandoff = options.cleanupHydrationHandoff ?? cleanupHydrationHandoff;
  const readHandoffMetadata = options.readHandoffMetadata ?? HYDRATION_HELPER.readHandoffMetadata;
  let childEnv;
  let token = '';
  let authorization = '';
  let temporaryPassword = '';
  let handoffDir = '';
  let phaseOneEnv;
  let temporaryRole;

  try {
    if (!MODES.has(mode)) {
      throw controlledError('usage: run-exact-target-repair-with-cli.cjs {diagnose|probe|dry-run|backup|apply|hydrate|rollback}');
    }
    if (platform !== 'darwin') {
      throw controlledError('the C2 CLI credential bridge currently requires macOS Keychain');
    }
    if (Object.prototype.hasOwnProperty.call(env, 'PGOPTIONS')) {
      throw controlledError('database connection and adapter overrides are forbidden in CLI mode');
    }
    for (const name of [
      'Q5_DEV_DB_PASSWORD',
      'SUPABASE_DB_PASSWORD',
      'Q5_DEV_DB_HOST',
      'Q5_DEV_DB_USER',
      'Q5_DEV_DB_PORT',
      'Q5_DEV_DB_NAME',
      'Q5_PSQL_BIN',
    ]) {
      if (env[name]) {
        throw controlledError('database connection and adapter overrides are forbidden in CLI mode');
      }
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
    authorization = `Bearer ${token}`;
    const pooler = parsePrimaryPooler(await fetchJsonWithTimeout({
      fetchFn,
      url: `${MANAGEMENT_API_BASE}/config/database/pooler`,
      init: { headers: { Authorization: authorization } },
      label: 'pooler configuration',
      setTimer,
      clearTimer,
    }));
    const loginRequestedAtMs = now();
    const loginValue = await fetchJsonWithTimeout({
      fetchFn,
      url: `${MANAGEMENT_API_BASE}/cli/login-role`,
      init: {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ read_only: false }),
      },
      label: 'temporary login',
      setTimer,
      clearTimer,
    });
    token = '';
    authorization = '';
    temporaryRole = parseTemporaryRole(loginValue);
    temporaryPassword = temporaryRole.password;
    loginValue.password = '';
    const deadlineMs = loginRequestedAtMs + temporaryRole.ttlSeconds * 1_000;
    const expiresAtEpoch = Math.floor(deadlineMs / 1_000);
    const psqlBin = dockerPsql;

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
      Q5_DEV_DB_USER: temporaryRole.user,
      Q5_DEV_DB_PASSWORD: temporaryPassword,
      PGPASSWORD: temporaryPassword,
      PGSSLMODE: 'require',
      PGCONNECT_TIMEOUT: '15',
      PGAPPNAME: 'foliolens-q5-exact-target-repair',
    });

    if (mode === 'diagnose') {
      childEnv.Q5_REPAIR_AUTH_MODE = 'cli-diagnostic';
      childEnv.PGAPPNAME = 'foliolens-c3-cli-diagnostic';
      for (const name of DIAGNOSTIC_STRIPPED_ENV) delete childEnv[name];
      const code = runCliDiagnostic({ spawnSync, psqlBin, childEnv });
      if (options.stdout) options.stdout(`${code}\n`);
      else process.stdout.write(`${code}\n`);
      return 0;
    }

    await waitForTemporaryLogin({ spawnSync, sleep, psqlBin, childEnv, deadlineMs, now });
    if (mode === 'probe') {
      if (options.stdout) options.stdout('{"cli_transport":"ready"}\n');
      else process.stdout.write('{"cli_transport":"ready"}\n');
      return 0;
    }

    const remainingMs = deadlineMs - now() - EXPIRY_SAFETY_SECONDS * 1_000;
    const timeout = Math.min(MAX_CHILD_RUNTIME_MS, remainingMs);
    if (timeout < 15_000) throw controlledError('temporary login lifetime was insufficient');
    if (mode === 'hydrate') {
      handoffDir = createHandoff();
      phaseOneEnv = {
        ...childEnv,
        Q5_HYDRATION_HANDOFF_DIR: handoffDir,
      };
      delete phaseOneEnv.Q5_DEV_FUNCTIONS_URL;
      delete phaseOneEnv.Q5_DEV_SERVICE_ROLE_KEY;
      const phaseOneStatus = await runBoundedProcessGroup({
        spawn,
        kill,
        setTimer,
        clearTimer,
        signalSource,
        command: lowLevelRunner,
        args: ['hydrate-prepare'],
        env: phaseOneEnv,
        timeoutMs: timeout,
      });
      if (phaseOneStatus !== 0) {
        throw controlledError('authoritative hydration phase one failed');
      }

      temporaryPassword = '';
      temporaryRole.password = '';
      loginValue.password = '';
      for (const name of [
        'Q5_DEV_DB_PASSWORD',
        'PGPASSWORD',
        'Q5_DEV_DB_HOST',
        'Q5_DEV_DB_USER',
        'Q5_DEV_DB_PORT',
        'Q5_DEV_DB_NAME',
        'Q5_PSQL_BIN',
        'Q5_CLI_ROLE_EXPIRES_AT_EPOCH',
        'Q5_BACKUP_PLAINTEXT_PATH',
      ]) delete childEnv[name];
      for (const name of [
        'Q5_DEV_DB_PASSWORD',
        'PGPASSWORD',
        'Q5_DEV_DB_HOST',
        'Q5_DEV_DB_USER',
        'Q5_DEV_DB_PORT',
        'Q5_DEV_DB_NAME',
        'Q5_PSQL_BIN',
        'Q5_CLI_ROLE_EXPIRES_AT_EPOCH',
      ]) delete phaseOneEnv[name];

      const metadata = readHandoffMetadata(handoffDir);
      const phaseTwoTimeout = calculateHydrationExecutionTimeout(metadata.count);
      const phaseTwoEnv = buildHydrationExecutionEnv(env, handoffDir, metadata);
      const phaseTwoStatus = await runBoundedProcessGroup({
        spawn,
        kill,
        setTimer,
        clearTimer,
        signalSource,
        command: lowLevelRunner,
        args: ['hydrate-execute'],
        env: phaseTwoEnv,
        timeoutMs: phaseTwoTimeout,
        deadlineMessage: 'authoritative hydration stopped at its plan-derived deadline',
        interruptMessage: 'authoritative hydration stopped after operator interrupt',
        startFailureMessage: 'unable to start authoritative hydration execution',
        stopFailureMessage: 'unable to confirm authoritative hydration execution stopped',
      });
      if (phaseTwoStatus !== 0) {
        throw controlledError(hydrationFailureMessage(phaseTwoStatus));
      }
      return 0;
    }
    return await runBoundedProcessGroup({
      spawn,
      kill,
      setTimer,
      clearTimer,
      signalSource,
      command: lowLevelRunner,
      args: [mode],
      env: childEnv,
      timeoutMs: timeout,
    });
  } finally {
    token = '';
    authorization = '';
    temporaryPassword = '';
    if (childEnv) {
      delete childEnv.Q5_DEV_DB_PASSWORD;
      delete childEnv.PGPASSWORD;
    }
    if (phaseOneEnv) {
      for (const name of [
        'Q5_DEV_DB_PASSWORD',
        'PGPASSWORD',
        'Q5_DEV_DB_HOST',
        'Q5_DEV_DB_USER',
        'Q5_DEV_DB_PORT',
        'Q5_DEV_DB_NAME',
        'Q5_PSQL_BIN',
        'Q5_CLI_ROLE_EXPIRES_AT_EPOCH',
      ]) delete phaseOneEnv[name];
    }
    if (temporaryRole) temporaryRole.password = '';
    cleanupHandoff(handoffDir);
  }
}

module.exports = {
  DEV_PROJECT_REF,
  parseCliVersion,
  versionAtLeast,
  normalizeStoredToken,
  parsePrimaryPooler,
  parseTemporaryRole,
  parseDiagnosticResult,
  buildHydrationExecutionEnv,
  calculateHydrationExecutionTimeout,
  cleanupHydrationHandoff,
  createHydrationHandoff,
  hydrationFailureMessage,
  runCliDiagnostic,
  runBoundedProcessGroup,
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
