import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const require = createRequire(import.meta.url);
const { seedPortfolioForUser } = require('./seed-demo-user-core.cjs');

const ROOT = process.cwd();
loadLocalEnv(path.join(ROOT, '.env.local'));

const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL ??
  process.env.SUPABASE_URL ??
  '';
const SUPABASE_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const DEMO_EMAIL =
  process.env.DEV_DEMO_EMAIL ??
  process.env.EXPO_PUBLIC_DEV_AUTH_EMAIL ??
  '';
const DEMO_PASSWORD =
  process.env.DEV_DEMO_PASSWORD ??
  process.env.EXPO_PUBLIC_DEV_AUTH_PASSWORD ??
  '';
const DEMO_PAN = process.env.DEV_DEMO_PAN ?? 'ABCDE1234F';
const DEMO_KFINTECH_EMAIL = process.env.DEV_DEMO_KFINTECH_EMAIL ?? 'demo-import@example.com';
const DEMO_INBOUND_EMAIL = process.env.DEV_DEMO_INBOUND_EMAIL ?? 'demo-inbound@fundlens.local';
const DEMO_INBOUND_ID = process.env.DEV_DEMO_INBOUND_ID ?? 'demo-inbound-session';
const SEED_USER_LABEL = process.env.SEED_USER_LABEL ?? 'Demo';
const SEED_USER_USAGE_HINT =
  process.env.SEED_USER_USAGE_HINT ?? 'Use the local dev auth shortcut to sign in.';
const SEED_USER_METADATA_ROLE = process.env.SEED_USER_METADATA_ROLE ?? 'demo';
const SEED_USER_METADATA_KIND = process.env.SEED_USER_METADATA_KIND?.trim() ?? '';
const SEED_USER_METADATA_SEEDED_BY =
  process.env.SEED_USER_METADATA_SEEDED_BY ?? 'scripts/seed-demo-user.mjs';
const SEED_GLOBAL_REFERENCE_DATA =
  (process.env.SEED_GLOBAL_REFERENCE_DATA ?? 'true') !== 'false';

const serviceSupabase = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

if (isMainModule()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

async function main() {
  if (!SUPABASE_URL || !DEMO_EMAIL || !DEMO_PASSWORD) {
    console.error(
      'Missing required env. Need EXPO_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and demo email/password.',
    );
    process.exit(1);
  }

  if (serviceSupabase) {
    const user = await getOrCreateDemoUserWithServiceRole();
    await seedPortfolioForUser(serviceSupabase, user.id, seedOptions());
  } else {
    if (!SUPABASE_PUBLISHABLE_KEY) {
      throw new Error(
        'SUPABASE_SERVICE_ROLE_KEY is missing and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is also unavailable.',
      );
    }

    const publicSupabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const user = await getOrCreateDemoUserWithPublicClient(publicSupabase);
    await seedPortfolioForUser(publicSupabase, user.id, seedOptions());
  }

  console.log(`${SEED_USER_LABEL} user ready: ${DEMO_EMAIL}`);
  if (SEED_USER_USAGE_HINT) console.log(SEED_USER_USAGE_HINT);
}

function seedOptions() {
  return {
    seedGlobalReferenceData: SEED_GLOBAL_REFERENCE_DATA,
    pan: DEMO_PAN,
    kfintechEmail: DEMO_KFINTECH_EMAIL,
    inboundEmail: DEMO_INBOUND_EMAIL,
    inboundId: DEMO_INBOUND_ID,
  };
}

function isMainModule() {
  return process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function seedUserMetadata() {
  const metadata = {
    role: SEED_USER_METADATA_ROLE,
    seeded_by: SEED_USER_METADATA_SEEDED_BY,
  };

  if (SEED_USER_METADATA_KIND) {
    metadata.kind = SEED_USER_METADATA_KIND;
  }

  return metadata;
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

async function getOrCreateDemoUserWithServiceRole() {
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await serviceSupabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const existing = data.users.find((user) => user.email?.toLowerCase() === DEMO_EMAIL.toLowerCase());
    if (existing) {
      const { data: updated, error: updateError } = await serviceSupabase.auth.admin.updateUserById(
        existing.id,
        {
          password: DEMO_PASSWORD,
          email_confirm: true,
          user_metadata: seedUserMetadata(),
        },
      );

      if (updateError) throw updateError;
      return updated.user;
    }

    if (data.users.length < perPage) break;
    page += 1;
  }

  const { data, error } = await serviceSupabase.auth.admin.createUser({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    email_confirm: true,
    user_metadata: seedUserMetadata(),
  });

  if (error) throw error;
  return data.user;
}

async function getOrCreateDemoUserWithPublicClient(client) {
  const { data: signInData, error: signInError } = await client.auth.signInWithPassword({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
  });

  if (!signInError && signInData.user) {
    return signInData.user;
  }

  const { data: signUpData, error: signUpError } = await client.auth.signUp({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
  });

  if (signUpError) throw signUpError;
  if (!signUpData.user) {
    throw new Error('Demo sign-up did not return a user.');
  }

  const { data: retryData, error: retryError } = await client.auth.signInWithPassword({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
  });

  if (retryError || !retryData.user) {
    throw retryError ?? new Error('Demo sign-in failed after sign-up.');
  }

  return retryData.user;
}
