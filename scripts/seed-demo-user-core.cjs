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

async function seedPortfolioForUser(
  client,
  userId,
  {
    seedGlobalReferenceData = true,
    pan = 'ABCDE1234F',
    kfintechEmail = 'demo-import@example.com',
    inboundEmail = 'demo-inbound@fundlens.local',
    inboundId = 'demo-inbound-session',
  } = {},
) {
  await resetDemoPortfolio(client, userId);
  await seedProfile(client, userId, {
    pan,
    kfintechEmail,
    inboundEmail,
    inboundId,
  });

  if (seedGlobalReferenceData) {
    await seedDemoMarketData(client);
    await seedDemoCompositionData(client);
  }

  const realFunds = await buildSeedFunds(client);
  const funds = await seedFunds(client, userId, realFunds, {
    seedSchemeMaster: seedGlobalReferenceData,
  });
  await seedTransactions(client, userId, funds);
}

async function resetDemoPortfolio(client, userId) {
  await mustSucceed(client.from('transaction').delete().eq('user_id', userId));
  await mustSucceed(client.from('user_fund').delete().eq('user_id', userId));
  await mustSucceed(client.from('cas_import').delete().eq('user_id', userId));
  await mustSucceed(client.from('cas_inbound_session').delete().eq('user_id', userId));
  await mustSucceed(client.from('user_profile').delete().eq('user_id', userId));
}

async function seedProfile(client, userId, { pan, kfintechEmail, inboundEmail, inboundId }) {
  await mustSucceed(
    client.from('user_profile').upsert(
      {
        user_id: userId,
        pan,
        kfintech_email: kfintechEmail,
      },
      { onConflict: 'user_id' },
    ),
  );

  await mustSucceed(
    client.from('cas_inbound_session').upsert(
      {
        user_id: userId,
        inbound_email_id: inboundId,
        inbound_email_address: inboundEmail,
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

async function seedFunds(client, userId, fundsToSeed, { seedSchemeMaster = true } = {}) {
  const inserted = [];

  for (const fund of fundsToSeed) {
    if (seedSchemeMaster) {
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
    }

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

  const redemptionNav = findNavOnOrBefore(
    navByScheme.get(funds[0].schemeCode) ?? [],
    '2025-10-10',
  );

  rows.push({
    user_id: userId,
    fund_id: funds[0].id,
    transaction_date: '2025-10-10',
    transaction_type: 'redemption',
    units: 18.25,
    nav_at_transaction: round4(redemptionNav),
    amount: round2(18.25 * redemptionNav),
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

module.exports = {
  REAL_FUNDS,
  seedPortfolioForUser,
};
