import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const ROOT = process.cwd();
const PROD_PROJECT_REF = 'ohcaaioabjvzewfysqgh';
const PROD_SUPABASE_URL = `https://${PROD_PROJECT_REF}.supabase.co`;
const SEED_SCRIPT = path.join(ROOT, 'scripts', 'seed-demo-user.mjs');
const REVIEWER_KIND_BY_EMAIL = new Map([
  ['play-review@foliolens.in', 'portfolio'],
  ['play-review-delete@foliolens.in', 'delete-test'],
]);

loadLocalEnv(path.join(ROOT, '.env.local'));

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const config = readConfig();
  validateConfig(config);

  runSyntheticPortfolioSeeder(config);

  const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const user = await findAuthUserByEmail(supabase, config.reviewerEmail);
  await stampReviewerMetadata(supabase, user.id, user.user_metadata, config);
  const counts = await loadReviewerCounts(supabase, user.id);

  console.log(`Reviewer account ready: ${config.reviewerEmail}`);
  console.log(`Reviewer kind: ${config.reviewerKind}`);
  console.log(
    `Seeded rows: user_fund=${counts.userFunds}, transaction=${counts.transactions}, ` +
      `user_profile=${counts.userProfile}, cas_inbound_session=${counts.casInboundSession}`,
  );
  console.log('Password was not printed. Store it only in Play Console and the password manager.');
}

function readConfig() {
  return {
    supabaseUrl: (
      process.env.SUPABASE_URL ??
      process.env.EXPO_PUBLIC_SUPABASE_URL ??
      ''
    ).trim().replace(/\/$/, ''),
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '',
    reviewerEmail: process.env.REVIEWER_EMAIL?.trim().toLowerCase() ?? '',
    reviewerPassword: process.env.REVIEWER_PASSWORD ?? '',
    reviewerKind: process.env.REVIEWER_KIND?.trim() ?? '',
    seedTarget: process.env.REVIEWER_SEED_TARGET?.trim().toLowerCase() ?? '',
  };
}

function validateConfig(config) {
  const missing = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!config.reviewerEmail) missing.push('REVIEWER_EMAIL');
  if (!config.reviewerPassword) missing.push('REVIEWER_PASSWORD');
  if (!config.reviewerKind) missing.push('REVIEWER_KIND');

  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }

  const expectedKind = REVIEWER_KIND_BY_EMAIL.get(config.reviewerEmail);
  if (!expectedKind) {
    throw new Error(
      `REVIEWER_EMAIL must be one of: ${Array.from(REVIEWER_KIND_BY_EMAIL.keys()).join(', ')}`,
    );
  }

  if (config.reviewerKind !== expectedKind) {
    throw new Error(
      `REVIEWER_KIND must be ${expectedKind} for ${config.reviewerEmail}; got ${config.reviewerKind}.`,
    );
  }

  const isProductionUrl =
    config.supabaseUrl === PROD_SUPABASE_URL || config.supabaseUrl.includes(PROD_PROJECT_REF);

  if (isProductionUrl && config.seedTarget !== 'production') {
    throw new Error(
      'Refusing to seed PROD without REVIEWER_SEED_TARGET=production.',
    );
  }

  if (!isProductionUrl && config.seedTarget === 'production') {
    throw new Error(
      `REVIEWER_SEED_TARGET=production was set, but SUPABASE_URL is ${config.supabaseUrl}.`,
    );
  }
}

function runSyntheticPortfolioSeeder(config) {
  const result = spawnSync(process.execPath, [SEED_SCRIPT], {
    cwd: ROOT,
    env: {
      ...process.env,
      SUPABASE_URL: config.supabaseUrl,
      EXPO_PUBLIC_SUPABASE_URL: config.supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: config.serviceRoleKey,
      DEV_DEMO_EMAIL: config.reviewerEmail,
      DEV_DEMO_PASSWORD: config.reviewerPassword,
      DEV_DEMO_PAN: process.env.REVIEWER_PAN ?? 'ABCDE1234F',
      DEV_DEMO_KFINTECH_EMAIL:
        process.env.REVIEWER_KFINTECH_EMAIL ?? `${config.reviewerKind}@foliolens-review.local`,
      DEV_DEMO_INBOUND_EMAIL:
        process.env.REVIEWER_INBOUND_EMAIL ?? `${config.reviewerKind}-inbound@foliolens-review.local`,
      DEV_DEMO_INBOUND_ID:
        process.env.REVIEWER_INBOUND_ID ?? `${config.reviewerKind}-inbound-session`,
      SEED_USER_LABEL: 'Reviewer',
      SEED_USER_USAGE_HINT: '',
      SEED_USER_METADATA_ROLE: 'reviewer',
      SEED_USER_METADATA_KIND: config.reviewerKind,
      SEED_USER_METADATA_SEEDED_BY: 'scripts/seed-reviewer-user.mjs',
    },
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Synthetic portfolio seeder exited with status ${result.status}.`);
  }
}

async function findAuthUserByEmail(supabase, email) {
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
    if (user) return user;

    if (data.users.length < perPage) break;
    page += 1;
  }

  throw new Error(`Seed script completed, but auth user was not found: ${email}`);
}

async function stampReviewerMetadata(supabase, userId, existingMetadata, config) {
  const baseMetadata =
    existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata)
      ? existingMetadata
      : {};

  const { error } = await supabase.auth.admin.updateUserById(userId, {
    email_confirm: true,
    user_metadata: {
      ...baseMetadata,
      role: 'reviewer',
      reviewer_kind: config.reviewerKind,
      seeded_by: 'scripts/seed-reviewer-user.mjs',
    },
  });

  if (error) throw error;
}

async function loadReviewerCounts(supabase, userId) {
  const [userFunds, transactions, userProfile, casInboundSession] = await Promise.all([
    countRows(supabase, 'user_fund', userId),
    countRows(supabase, 'transaction', userId),
    countRows(supabase, 'user_profile', userId),
    countRows(supabase, 'cas_inbound_session', userId),
  ]);

  return {
    userFunds,
    transactions,
    userProfile,
    casInboundSession,
  };
}

async function countRows(supabase, table, userId) {
  const { count, error } = await supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) throw error;
  return count ?? 0;
}

function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
