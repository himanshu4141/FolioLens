import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

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
const DEMO_INBOUND_EMAIL = 'demo-inbound@fundlens.local';
const DEMO_INBOUND_ID = 'demo-inbound-session';

if (!SUPABASE_URL || !DEMO_EMAIL || !DEMO_PASSWORD) {
  console.error(
    'Missing required env. Need EXPO_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and demo email/password.',
  );
  process.exit(1);
}

const serviceSupabase = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

const REAL_FUNDS = [
  {
    schemeCode: 118955,
    schemeName: 'HDFC Flexi Cap Fund - Direct Plan - Growth',
    schemeCategory: 'Flexi Cap Fund',
    benchmarkIndex: 'Nifty 500 TRI',
    benchmarkSymbol: '^NIFTY500',
  },
  {
    schemeCode: 119218,
    schemeName: 'DSP Equity Opportunities Fund - Direct Plan - Growth',
    schemeCategory: 'Large & Mid Cap Fund',
    benchmarkIndex: 'Nifty LargeMidcap 250 TRI',
    benchmarkSymbol: '^NIFTYLMI250',
  },
  {
    schemeCode: 120599,
    schemeName: 'ICICI Prudential Multicap Fund - Direct Plan - Growth',
    schemeCategory: 'Multi Cap Fund',
    benchmarkIndex: 'Nifty 500 TRI',
    benchmarkSymbol: '^NIFTY500',
  },
];

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  if (serviceSupabase) {
    const user = await getOrCreateDemoUserWithServiceRole();
    await resetDemoPortfolio(serviceSupabase, user.id);
    await seedProfile(serviceSupabase, user.id);
    await seedDemoMarketData(serviceSupabase);
    await seedDemoCompositionData(serviceSupabase);
    const realFunds = await buildSeedFunds(serviceSupabase);
    const funds = await seedFunds(serviceSupabase, user.id, realFunds);
    await seedTransactions(serviceSupabase, user.id, funds);
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
    await resetDemoPortfolio(publicSupabase, user.id);
    await seedProfile(publicSupabase, user.id);
    await seedDemoMarketData(publicSupabase);
    await seedDemoCompositionData(publicSupabase);

    const liveDemoFunds = await buildSeedFunds(publicSupabase);
    const funds = await seedFunds(publicSupabase, user.id, liveDemoFunds);
    await seedTransactions(publicSupabase, user.id, funds);
  }

  console.log(`Demo user ready: ${DEMO_EMAIL}`);
  console.log('Use the local dev auth shortcut to sign in.');
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
          user_metadata: { role: 'demo', seeded_by: 'scripts/seed-demo-user.mjs' },
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
    user_metadata: { role: 'demo', seeded_by: 'scripts/seed-demo-user.mjs' },
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

async function resetDemoPortfolio(client, userId) {
  await mustSucceed(client.from('transaction').delete().eq('user_id', userId));
  await mustSucceed(client.from('user_fund').delete().eq('user_id', userId));
  await mustSucceed(client.from('cas_import').delete().eq('user_id', userId));
  await mustSucceed(client.from('cas_inbound_session').delete().eq('user_id', userId));
  await mustSucceed(client.from('user_profile').delete().eq('user_id', userId));
}

async function seedProfile(client, userId) {
  await mustSucceed(
    client.from('user_profile').upsert(
      {
        user_id: userId,
        pan: DEMO_PAN,
        kfintech_email: DEMO_KFINTECH_EMAIL,
      },
      { onConflict: 'user_id' },
    ),
  );

  await mustSucceed(
    client.from('cas_inbound_session').upsert(
      {
        user_id: userId,
        inbound_email_id: DEMO_INBOUND_ID,
        inbound_email_address: DEMO_INBOUND_EMAIL,
      },
      { onConflict: 'user_id' },
    ),
  );
}

async function seedDemoCompositionData(client) {
  const sectorAllocation = {
    'Financial Services': 29.1,
    'Consumer Cyclical': 13.0,
    Healthcare: 8.2,
    'Basic Materials': 7.2,
    Technology: 5.7,
    Industrials: 5.0,
    Energy: 4.2,
    'Communication Services': 3.1,
  };

  const topHoldings = [
    {
      name: 'HDFC Bank Ltd',
      isin: 'INE040A01034',
      sector: 'Financial Services',
      marketCap: 'Large Cap',
      pctOfNav: 5.4,
    },
    {
      name: 'ICICI Bank Ltd',
      isin: 'INE090A01021',
      sector: 'Financial Services',
      marketCap: 'Large Cap',
      pctOfNav: 4.7,
    },
    {
      name: 'Axis Bank Ltd',
      isin: 'INE238A01034',
      sector: 'Financial Services',
      marketCap: 'Large Cap',
      pctOfNav: 3.3,
    },
    {
      name: 'Kotak Mahindra Bank Ltd',
      isin: 'INE237A01028',
      sector: 'Financial Services',
      marketCap: 'Large Cap',
      pctOfNav: 2.0,
    },
    {
      name: 'Infosys Ltd',
      isin: 'INE009A01021',
      sector: 'Technology',
      marketCap: 'Large Cap',
      pctOfNav: 2.0,
    },
  ];

  // Compute market-cap pcts from the demo top_holdings rather than stamping
  // SEBI category defaults. The seed lists 5 holdings (all Large Cap by
  // AMFI's H2-2025 classification) adding to ~17.4% of NAV; the rest of
  // each fund's equity flows into "not classified" because we don't have
  // disclosed holdings for it in this seed. This matches the behaviour of
  // the production pipeline and prevents demo accounts from re-introducing
  // the fake 38/33/29 pattern that the M6 fix removes.
  const capBuckets = topHoldings.reduce(
    (acc, h) => {
      const w = typeof h.pctOfNav === 'number' ? h.pctOfNav : 0;
      if (h.marketCap === 'Large Cap') acc.large += w;
      else if (h.marketCap === 'Mid Cap') acc.mid += w;
      else if (h.marketCap === 'Small Cap') acc.small += w;
      else acc.notClassified += w;
      return acc;
    },
    { large: 0, mid: 0, small: 0, notClassified: 0 },
  );

  const rows = REAL_FUNDS.map((fund, index) => {
    const equityPct = round2(81.8 + index * 1.6);
    const classifiedTotal = capBuckets.large + capBuckets.mid + capBuckets.small;
    const equityNotInTopHoldings = Math.max(0, equityPct - classifiedTotal - capBuckets.notClassified);
    return {
      scheme_code: fund.schemeCode,
      portfolio_date: '2026-03-31',
      equity_pct: equityPct,
      debt_pct: index === 1 ? 9.2 : 6.8,
      cash_pct: round2(index === 1 ? 7.4 : 11.4 - index * 1.1),
      other_pct: 0,
      large_cap_pct: round2(capBuckets.large),
      mid_cap_pct: round2(capBuckets.mid),
      small_cap_pct: round2(capBuckets.small),
      not_classified_pct: round2(capBuckets.notClassified + equityNotInTopHoldings),
      sector_allocation: sectorAllocation,
      top_holdings: topHoldings,
      source: 'amfi',
    };
  });

  await mustSucceed(
    client
      .from('fund_portfolio_composition')
      .upsert(rows, { onConflict: 'scheme_code,portfolio_date,source' }),
  );
}

async function seedDemoMarketData(client) {
  const navRows = [];
  for (const [fundIndex, fund] of REAL_FUNDS.entries()) {
    navRows.push(...buildDemoNavRows(fund.schemeCode, fundIndex));
  }

  for (const chunk of chunkRows(navRows, 500)) {
    await mustSucceed(client.from('nav_history').upsert(chunk, { onConflict: 'scheme_code,nav_date' }));
  }

  const indexes = [
    { symbol: '^NSEI', name: 'Nifty 50', start: 17800, strength: 0.88 },
    { symbol: '^NIFTY100', name: 'Nifty 100', start: 18500, strength: 0.82 },
    { symbol: '^BSESN', name: 'BSE Sensex', start: 60200, strength: 0.86 },
    { symbol: '^NIFTY500', name: 'Nifty 500 TRI', start: 15100, strength: 0.84 },
    { symbol: '^NIFTYLMI250', name: 'Nifty LargeMidcap 250 TRI', start: 14300, strength: 0.8 },
  ];

  const indexRows = indexes.flatMap((index) => buildDemoIndexRows(index));
  for (const chunk of chunkRows(indexRows, 500)) {
    await mustSucceed(client.from('index_history').upsert(chunk, { onConflict: 'index_symbol,index_date' }));
  }
}

function buildDemoNavRows(schemeCode, fundIndex) {
  return buildDailyRows((date, day) => {
    const base = 92 + fundIndex * 24;
    const trend = day * (0.045 + fundIndex * 0.006);
    const seasonal = Math.sin(day / 31 + fundIndex) * 2.2 + Math.cos(day / 77) * 1.4;
    const correction = day > 820 && day < 910 ? -((day - 820) / 90) * (6 + fundIndex * 1.2) : 0;
    const rebound = day >= 910 ? Math.min((day - 910) / 120, 1) * (4.2 + fundIndex) : 0;

    return {
      scheme_code: schemeCode,
      nav_date: toIsoDate(date),
      nav: round4(base + trend + seasonal + correction + rebound),
    };
  });
}

function buildDemoIndexRows(index) {
  return buildDailyRows((date, day) => {
    const trend = day * (5.2 * index.strength);
    const seasonal = Math.sin(day / 37) * 240 * index.strength + Math.cos(day / 89) * 130;
    const correction = day > 820 && day < 910 ? -((day - 820) / 90) * 950 * index.strength : 0;
    const rebound = day >= 910 ? Math.min((day - 910) / 120, 1) * 680 * index.strength : 0;

    return {
      index_symbol: index.symbol,
      index_name: index.name,
      index_date: toIsoDate(date),
      close_value: round4(index.start + trend + seasonal + correction + rebound),
    };
  });
}

function buildDailyRows(factory) {
  const rows = [];
  const start = new Date(Date.UTC(2023, 0, 1));
  const end = new Date();

  for (let cursor = new Date(start), day = 0; cursor <= end; day += 1) {
    rows.push(factory(new Date(cursor), day));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return rows;
}

async function buildSeedFunds(client) {
  const chosen = [];

  for (const fund of REAL_FUNDS) {
    const { count, error } = await client
      .from('nav_history')
      .select('*', { count: 'exact', head: true })
      .eq('scheme_code', fund.schemeCode);

    if (error) throw error;

    if ((count ?? 0) > 250) {
      chosen.push(fund);
    }
  }

  if (chosen.length < 3) {
    throw new Error(
      `Not enough live NAV history found for the preferred real schemes. Found ${chosen.length} of ${REAL_FUNDS.length}.`,
    );
  }

  return chosen;
}

async function seedFunds(client, userId, fundsToSeed) {
  const inserted = [];

  for (const fund of fundsToSeed) {
    await mustSucceed(
      client.from('scheme_master').upsert(
        {
          scheme_code: fund.schemeCode,
          scheme_name: fund.schemeName,
          scheme_category: fund.schemeCategory,
          benchmark_index: fund.benchmarkIndex,
          benchmark_index_symbol: fund.benchmarkSymbol,
        },
        { onConflict: 'scheme_code' },
      ),
    );

    const { data, error } = await client
      .from('user_fund')
      .upsert(
        {
          user_id: userId,
          scheme_code: fund.schemeCode,
          is_active: true,
        },
        { onConflict: 'user_id,scheme_code' },
      )
      .select('id')
      .single();

    if (error) throw error;
    inserted.push({ ...fund, id: data.id });
  }

  return inserted;
}

async function seedTransactions(client, userId, funds) {
  const navByScheme = await loadNavHistoryForFunds(client, funds);
  const rows = [];

  for (const [fundIndex, fund] of funds.entries()) {
    for (let month = 0; month < 16; month += 1) {
      const date = new Date(Date.UTC(2024, month, 5 + fundIndex));
      const amount = 12000 + fundIndex * 2500 + month * 350;
      const nav = findNavOnOrBefore(navByScheme.get(fund.schemeCode) ?? [], toIsoDate(date));
      if (!nav) {
        throw new Error(`Missing NAV history for scheme ${fund.schemeCode} on ${toIsoDate(date)}`);
      }
      const units = round4(amount / nav);

      rows.push({
        user_id: userId,
        fund_id: fund.id,
        transaction_date: toIsoDate(date),
        transaction_type: 'purchase',
        units,
        nav_at_transaction: round4(nav),
        amount: round2(amount),
        folio_number: `DEMO-FOLIO-${fundIndex + 1}`,
      });
    }
  }

  rows.push({
    user_id: userId,
    fund_id: funds[0].id,
    transaction_date: '2025-10-10',
    transaction_type: 'redemption',
    units: 18.25,
    nav_at_transaction: round4(findNavOnOrBefore(navByScheme.get(funds[0].schemeCode) ?? [], '2025-10-10')),
    amount: round2(18.25 * findNavOnOrBefore(navByScheme.get(funds[0].schemeCode) ?? [], '2025-10-10')),
    folio_number: 'DEMO-FOLIO-1',
  });

  await mustSucceed(client.from('transaction').insert(rows));
}

async function loadNavHistoryForFunds(client, funds) {
  const schemeCodes = funds.map((fund) => fund.schemeCode);
  const { data, error } = await client
    .from('nav_history')
    .select('scheme_code, nav_date, nav')
    .in('scheme_code', schemeCodes)
    .gte('nav_date', '2023-01-01')
    .order('nav_date', { ascending: true });

  if (error) throw error;

  const navByScheme = new Map();
  for (const row of data ?? []) {
    const existing = navByScheme.get(row.scheme_code) ?? [];
    existing.push({ date: row.nav_date, nav: row.nav });
    navByScheme.set(row.scheme_code, existing);
  }

  return navByScheme;
}

function findNavOnOrBefore(history, dateStr) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].date <= dateStr) {
      return history[i].nav;
    }
  }

  return null;
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function round2(value) {
  return Number(value.toFixed(2));
}

function round4(value) {
  return Number(value.toFixed(4));
}

function chunkRows(rows, size) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

async function mustSucceed(promise) {
  const { error } = await promise;
  if (error) throw error;
}
