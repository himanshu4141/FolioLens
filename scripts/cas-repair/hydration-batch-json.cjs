#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEV_FUNCTION_URL =
  'https://imkgazlrxtlhkfptkzjc.supabase.co/functions/v1/sync-fund-meta';
const APPROVAL_SENTINEL = 'APPROVE_Q5_EXACT_TARGET_DELETE';
const HANDOFF_PATTERN = /^\/tmp\/foliolens-q5-hydration-handoff\.[A-Za-z0-9]+$/;
const MAX_JSON_BYTES = 65_536;
const MAX_SCHEMES = 1_000;
const PLAN_NAME = 'plan.jsonl';
const METADATA_NAME = 'metadata.json';
const PUBLISHED_NAME = 'published';
const REQUEST_PREFIX = 'request.';
const CONNECT_TIMEOUT_SECONDS = 10;
const REQUEST_TIMEOUT_SECONDS = 90;

const EXIT = Object.freeze({
  GENERIC: 4,
  HANDOFF: 41,
  REQUEST: 42,
  HTTP: 43,
  RESPONSE: 44,
  AGGREGATE: 45,
  CLEANUP: 46,
});

class ControlledError extends Error {
  constructor(message, exitCode = EXIT.GENERIC) {
    super(message);
    this.exitCode = exitCode;
  }
}

function fail(message, exitCode = EXIT.GENERIC) {
  throw new ControlledError(message, exitCode);
}

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function readBoundedFile(filePath, label) {
  try {
    const size = fs.statSync(filePath).size;
    if (size <= 0 || size > MAX_JSON_BYTES) fail(`${label} was invalid`);
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error instanceof ControlledError) throw error;
    fail(`${label} was invalid`);
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readBoundedFile(filePath, label));
  } catch (error) {
    if (error instanceof ControlledError) throw error;
    fail(`${label} was invalid`);
  }
}

function validateCodes(codes, label = 'authoritative hydration scope') {
  if (!Array.isArray(codes) || codes.length === 0 || codes.length > MAX_SCHEMES) {
    fail(`${label} was invalid`);
  }
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (
      !Number.isSafeInteger(code)
      || code <= 0
      || (index > 0 && code <= codes[index - 1])
    ) {
      fail(`${label} was invalid`);
    }
  }
  return codes;
}

function readScope(scopePath) {
  const scope = readJson(scopePath, 'authoritative hydration scope');
  if (!hasExactKeys(scope, ['mode', 'scheme_codes']) || scope.mode !== 'exact-target-repair') {
    fail('authoritative hydration scope was invalid');
  }
  return validateCodes(scope.scheme_codes);
}

function canonicalPlan(codes) {
  return codes
    .map((code) => JSON.stringify({ mode: 'exact-target-repair', scheme_codes: [code] }))
    .join('\n') + '\n';
}

function planDigest(plan) {
  return crypto.createHash('sha256').update(plan).digest('hex');
}

function writePrivateExclusive(
  filePath,
  value,
  failureMessage = 'authoritative hydration handoff could not be created',
  exitCode = EXIT.HANDOFF,
) {
  try {
    fs.writeFileSync(filePath, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.chmodSync(filePath, 0o600);
  } catch {
    fail(failureMessage, exitCode);
  }
}

function assertPrivateNode(nodePath, type, mode, label) {
  let stat;
  try {
    stat = fs.lstatSync(nodePath);
  } catch {
    fail(`${label} was invalid`, EXIT.HANDOFF);
  }
  const typeMatches = type === 'directory' ? stat.isDirectory() : stat.isFile();
  const ownerMatches = typeof process.getuid !== 'function' || stat.uid === process.getuid();
  if (stat.isSymbolicLink() || !typeMatches || !ownerMatches || (stat.mode & 0o777) !== mode) {
    fail(`${label} was invalid`, EXIT.HANDOFF);
  }
}

function assertHandoffRoot(handoffDir) {
  if (typeof handoffDir !== 'string' || !HANDOFF_PATTERN.test(handoffDir)) {
    fail('authoritative hydration handoff was invalid', EXIT.HANDOFF);
  }
  assertPrivateNode(handoffDir, 'directory', 0o700, 'authoritative hydration handoff');
}

function prepare(scopePath, planPath) {
  const codes = readScope(scopePath);
  const plan = canonicalPlan(codes);
  try {
    fs.writeFileSync(planPath, plan, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(planPath, 0o600);
  } catch {
    fail('authoritative hydration plan could not be created');
  }
  return codes.length;
}

function stageHandoff(scopePath, handoffDir) {
  assertHandoffRoot(handoffDir);
  const pendingDir = path.join(handoffDir, '.pending');
  const publishedDir = path.join(handoffDir, PUBLISHED_NAME);
  if (fs.existsSync(pendingDir) || fs.existsSync(publishedDir)) {
    fail('authoritative hydration handoff was not empty', EXIT.HANDOFF);
  }

  const codes = readScope(scopePath);
  const plan = canonicalPlan(codes);
  const metadata = `${JSON.stringify({
    version: 1,
    count: codes.length,
    sha256: planDigest(plan),
  })}\n`;

  try {
    fs.mkdirSync(pendingDir, { mode: 0o700 });
    fs.chmodSync(pendingDir, 0o700);
    writePrivateExclusive(path.join(pendingDir, PLAN_NAME), plan);
    writePrivateExclusive(path.join(pendingDir, METADATA_NAME), metadata);
  } catch (error) {
    try {
      fs.rmSync(pendingDir, { recursive: true, force: true });
    } catch {
      // The parent owns final cleanup and will fail closed.
    }
    if (error instanceof ControlledError) throw error;
    fail('authoritative hydration handoff could not be published', EXIT.HANDOFF);
  }
}

function validateStagedHandoff(handoffDir) {
  assertHandoffRoot(handoffDir);
  const pendingDir = path.join(handoffDir, '.pending');
  const planPath = path.join(pendingDir, PLAN_NAME);
  const metadataPath = path.join(pendingDir, METADATA_NAME);
  assertPrivateNode(pendingDir, 'directory', 0o700, 'authoritative hydration handoff');
  assertPrivateNode(planPath, 'file', 0o600, 'authoritative hydration plan');
  assertPrivateNode(metadataPath, 'file', 0o600, 'authoritative hydration metadata');
  const plan = readBoundedFile(planPath, 'authoritative hydration plan');
  const codes = parsePlan(plan);
  const metadata = readJson(metadataPath, 'authoritative hydration metadata');
  if (
    !hasExactKeys(metadata, ['version', 'count', 'sha256'])
    || metadata.version !== 1
    || metadata.count !== codes.length
    || metadata.sha256 !== planDigest(plan)
  ) {
    fail('authoritative hydration handoff changed', EXIT.HANDOFF);
  }
}

function publishHandoff(handoffDir) {
  validateStagedHandoff(handoffDir);
  const pendingDir = path.join(handoffDir, '.pending');
  const publishedDir = path.join(handoffDir, PUBLISHED_NAME);
  if (fs.existsSync(publishedDir)) {
    fail('authoritative hydration handoff was not empty', EXIT.HANDOFF);
  }
  try {
    fs.renameSync(pendingDir, publishedDir);
  } catch {
    fail('authoritative hydration handoff could not be published', EXIT.HANDOFF);
  }
}

function prepareHandoff(scopePath, handoffDir) {
  stageHandoff(scopePath, handoffDir);
  publishHandoff(handoffDir);
}

function readHandoffMetadata(handoffDir) {
  assertHandoffRoot(handoffDir);
  const publishedDir = path.join(handoffDir, PUBLISHED_NAME);
  const metadataPath = path.join(publishedDir, METADATA_NAME);
  assertPrivateNode(publishedDir, 'directory', 0o700, 'authoritative hydration handoff');
  assertPrivateNode(metadataPath, 'file', 0o600, 'authoritative hydration metadata');
  const metadata = readJson(metadataPath, 'authoritative hydration metadata');
  if (
    !hasExactKeys(metadata, ['version', 'count', 'sha256'])
    || metadata.version !== 1
    || !Number.isSafeInteger(metadata.count)
    || metadata.count <= 0
    || metadata.count > MAX_SCHEMES
    || typeof metadata.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(metadata.sha256)
  ) {
    fail('authoritative hydration metadata was invalid', EXIT.HANDOFF);
  }
  return metadata;
}

function parsePlan(plan) {
  if (!plan.endsWith('\n')) fail('authoritative hydration plan was invalid', EXIT.HANDOFF);
  const lines = plan.slice(0, -1).split('\n');
  const codes = lines.map((line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      fail('authoritative hydration plan was invalid', EXIT.HANDOFF);
    }
    if (
      !hasExactKeys(request, ['mode', 'scheme_codes'])
      || request.mode !== 'exact-target-repair'
      || !Array.isArray(request.scheme_codes)
      || request.scheme_codes.length !== 1
    ) {
      fail('authoritative hydration plan was invalid', EXIT.HANDOFF);
    }
    return request.scheme_codes[0];
  });
  validateCodes(codes, 'authoritative hydration plan');
  if (canonicalPlan(codes) !== plan) {
    fail('authoritative hydration plan was invalid', EXIT.HANDOFF);
  }
  return codes;
}

function unlinkSnapshotInputs(handoffDir) {
  const publishedDir = path.join(handoffDir, PUBLISHED_NAME);
  try {
    fs.unlinkSync(path.join(publishedDir, PLAN_NAME));
    fs.unlinkSync(path.join(publishedDir, METADATA_NAME));
    fs.rmdirSync(publishedDir);
  } catch {
    fail('authoritative hydration handoff cleanup failed', EXIT.CLEANUP);
  }
}

function snapshotHandoff(handoffDir, expectedCount, expectedDigest) {
  const metadata = readHandoffMetadata(handoffDir);
  const planPath = path.join(handoffDir, PUBLISHED_NAME, PLAN_NAME);
  assertPrivateNode(planPath, 'file', 0o600, 'authoritative hydration plan');
  const plan = readBoundedFile(planPath, 'authoritative hydration plan');
  const codes = parsePlan(plan);
  if (
    metadata.count !== expectedCount
    || metadata.sha256 !== expectedDigest
    || codes.length !== expectedCount
    || planDigest(plan) !== expectedDigest
  ) {
    fail('authoritative hydration handoff changed', EXIT.HANDOFF);
  }
  unlinkSnapshotInputs(handoffDir);
  return codes;
}

function validateResponse(responsePath) {
  const response = readJson(responsePath, 'authoritative hydration response');
  if (
    !hasExactKeys(response, ['success', 'updated', 'failed', 'skipped'])
    || response.success !== true
    || response.updated !== 1
    || response.failed !== 0
    || response.skipped !== 0
  ) {
    fail('authoritative hydration response was unresolved', EXIT.RESPONSE);
  }
}

function removeRequestDirectory(requestDir) {
  if (!requestDir) return;
  try {
    fs.rmSync(requestDir, { recursive: true, force: false });
    if (fs.existsSync(requestDir)) fail('authoritative hydration cleanup failed', EXIT.CLEANUP);
  } catch (error) {
    if (error instanceof ControlledError) throw error;
    fail('authoritative hydration cleanup failed', EXIT.CLEANUP);
  }
}

function assertExecutionEnvironment(env) {
  const forbidden = [
    'Q5_DEV_DB_PASSWORD',
    'PGPASSWORD',
    'Q5_DEV_DB_HOST',
    'Q5_DEV_DB_USER',
    'Q5_DEV_DB_PORT',
    'Q5_DEV_DB_NAME',
    'Q5_PSQL_BIN',
    'Q5_CLI_ROLE_EXPIRES_AT_EPOCH',
    'Q5_BACKUP_PLAINTEXT_PATH',
    'Q5_BACKUP_PATH',
    'Q5_BACKUP_KEY_FILE',
    'Q5_TARGET_IMPORT_ID',
    'SUPABASE_ACCESS_TOKEN',
    'SUPABASE_DB_PASSWORD',
    'PGOPTIONS',
  ];
  if (forbidden.some((name) => Object.prototype.hasOwnProperty.call(env, name))) {
    fail('authoritative hydration environment was invalid', EXIT.HANDOFF);
  }
  if (
    env.Q5_REPAIR_AUTH_MODE !== 'cli-hydration-execute'
    || env.Q5_APPROVE_EXACT_TARGET_DELETE !== APPROVAL_SENTINEL
    || env.Q5_DEV_FUNCTIONS_URL !== DEV_FUNCTION_URL
    || typeof env.Q5_DEV_SERVICE_ROLE_KEY !== 'string'
    || env.Q5_DEV_SERVICE_ROLE_KEY.length === 0
    || env.Q5_DEV_SERVICE_ROLE_KEY.length > 4_096
    || /[\u0000-\u001f\u007f]/.test(env.Q5_DEV_SERVICE_ROLE_KEY)
    || !/^[1-9][0-9]{0,3}$/.test(env.Q5_HYDRATION_PLAN_COUNT ?? '')
    || !/^[a-f0-9]{64}$/.test(env.Q5_HYDRATION_PLAN_SHA256 ?? '')
  ) {
    fail('authoritative hydration environment was invalid', EXIT.HANDOFF);
  }
  assertHandoffRoot(env.Q5_HYDRATION_HANDOFF_DIR);
}

function executeHandoff(env = process.env, spawnSync = childProcess.spawnSync) {
  assertExecutionEnvironment(env);
  const expectedCount = Number(env.Q5_HYDRATION_PLAN_COUNT);
  if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0 || expectedCount > MAX_SCHEMES) {
    fail('authoritative hydration metadata was invalid', EXIT.HANDOFF);
  }
  const codes = snapshotHandoff(
    env.Q5_HYDRATION_HANDOFF_DIR,
    expectedCount,
    env.Q5_HYDRATION_PLAN_SHA256,
  );

  let requestDir = '';
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let updated = 0;
  try {
    for (const code of codes) {
      if (interrupted) fail('authoritative hydration interrupted', EXIT.REQUEST);
      try {
        requestDir = fs.mkdtempSync(
          path.join(env.Q5_HYDRATION_HANDOFF_DIR, REQUEST_PREFIX),
        );
        fs.chmodSync(requestDir, 0o700);
      } catch {
        fail('authoritative hydration request setup failed', EXIT.REQUEST);
      }
      const payloadPath = path.join(requestDir, 'payload.json');
      const responsePath = path.join(requestDir, 'response.json');
      writePrivateExclusive(
        payloadPath,
        `${JSON.stringify({ mode: 'exact-target-repair', scheme_codes: [code] })}\n`,
        'authoritative hydration request setup failed',
        EXIT.REQUEST,
      );
      writePrivateExclusive(
        responsePath,
        '\n',
        'authoritative hydration request setup failed',
        EXIT.REQUEST,
      );
      const curlConfig = [
        'silent',
        'request = "POST"',
        `url = "${env.Q5_DEV_FUNCTIONS_URL}"`,
        `connect-timeout = ${CONNECT_TIMEOUT_SECONDS}`,
        `max-time = ${REQUEST_TIMEOUT_SECONDS}`,
        `header = "Authorization: Bearer ${env.Q5_DEV_SERVICE_ROLE_KEY}"`,
        'header = "Content-Type: application/json"',
        `data-binary = "@${payloadPath}"`,
        `output = "${responsePath}"`,
        'write-out = "%{http_code}"',
      ].join('\n') + '\n';

      const result = spawnSync('curl', ['--config', '-'], {
        env: { PATH: env.PATH },
        encoding: 'utf8',
        input: curlConfig,
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: (REQUEST_TIMEOUT_SECONDS + 5) * 1_000,
        maxBuffer: 32,
      });
      if (result?.error || result?.status !== 0) {
        fail('authoritative hydration request failed', EXIT.REQUEST);
      }
      if (result.stdout !== '200') {
        fail('authoritative hydration request failed', EXIT.HTTP);
      }
      validateResponse(responsePath);
      removeRequestDirectory(requestDir);
      requestDir = '';
      updated += 1;
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (requestDir) removeRequestDirectory(requestDir);
  }

  if (interrupted || updated !== expectedCount) {
    fail('authoritative hydration aggregate was invalid', EXIT.AGGREGATE);
  }
  process.stdout.write(`${JSON.stringify({ updated, failed: 0, skipped: 0 })}\n`);
}

module.exports = {
  CONNECT_TIMEOUT_SECONDS,
  EXIT,
  MAX_SCHEMES,
  REQUEST_TIMEOUT_SECONDS,
  canonicalPlan,
  executeHandoff,
  hasExactKeys,
  planDigest,
  prepare,
  prepareHandoff,
  publishHandoff,
  readHandoffMetadata,
  snapshotHandoff,
  stageHandoff,
  validateResponse,
};

if (require.main === module) {
  const [, , mode, ...args] = process.argv;
  try {
    if (mode === 'prepare' && args.length === 2) {
      process.stdout.write(`${prepare(args[0], args[1])}\n`);
    } else if (mode === 'prepare-handoff' && args.length === 2) {
      prepareHandoff(args[0], args[1]);
    } else if (mode === 'stage-handoff' && args.length === 2) {
      stageHandoff(args[0], args[1]);
    } else if (mode === 'publish-handoff' && args.length === 1) {
      publishHandoff(args[0]);
    } else if (mode === 'execute-handoff' && args.length === 0) {
      executeHandoff();
    } else if (mode === 'validate-response' && args.length === 1) {
      validateResponse(args[0]);
    } else {
      fail('hydration batch helper usage was invalid');
    }
  } catch (error) {
    const message = error instanceof ControlledError
      ? error.message
      : 'authoritative hydration failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof ControlledError ? error.exitCode : EXIT.GENERIC;
  }
}
