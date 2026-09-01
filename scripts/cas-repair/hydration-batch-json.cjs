#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const MAX_JSON_BYTES = 65_536;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(4);
}

function readJson(path, label) {
  let text;
  try {
    const size = fs.statSync(path).size;
    if (size <= 0 || size > MAX_JSON_BYTES) fail(`${label} was invalid`);
    text = fs.readFileSync(path, 'utf8');
  } catch {
    fail(`${label} was invalid`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} was invalid`);
  }
}

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function prepare(scopePath, planPath) {
  const scope = readJson(scopePath, 'authoritative hydration scope');
  if (!hasExactKeys(scope, ['mode', 'scheme_codes']) || scope.mode !== 'exact-target-repair') {
    fail('authoritative hydration scope was invalid');
  }
  const codes = scope.scheme_codes;
  if (!Array.isArray(codes) || codes.length === 0 || codes.length > 1_000) {
    fail('authoritative hydration scope was invalid');
  }
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (
      !Number.isSafeInteger(code)
      || code <= 0
      || (index > 0 && code <= codes[index - 1])
    ) {
      fail('authoritative hydration scope was invalid');
    }
  }

  const plan = codes
    .map((code) => JSON.stringify({ mode: 'exact-target-repair', scheme_codes: [code] }))
    .join('\n') + '\n';
  try {
    fs.writeFileSync(planPath, plan, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(planPath, 0o600);
  } catch {
    fail('authoritative hydration plan could not be created');
  }
  process.stdout.write(`${codes.length}\n`);
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
    fail('authoritative hydration response was unresolved');
  }
}

const [, , mode, ...args] = process.argv;
if (mode === 'prepare' && args.length === 2) {
  prepare(args[0], args[1]);
} else if (mode === 'validate-response' && args.length === 1) {
  validateResponse(args[0]);
} else {
  fail('hydration batch helper usage was invalid');
}
