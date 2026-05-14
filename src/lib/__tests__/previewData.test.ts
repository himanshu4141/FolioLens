import {
  PREVIEW_FUND_CARDS,
  PREVIEW_PORTFOLIO_SUMMARY,
  PREVIEW_USER_ID,
  findPreviewFundById,
} from '../previewData';

describe('preview data fixtures', () => {
  it('exposes a stable preview user id', () => {
    expect(PREVIEW_USER_ID).toBe('preview-user');
  });

  it('returns 5 funds covering distinct categories', () => {
    expect(PREVIEW_FUND_CARDS).toHaveLength(5);
    const categories = PREVIEW_FUND_CARDS.map((f) => f.schemeCategory);
    // Multiple categories so the cap-tilt allocation strip looks varied.
    expect(new Set(categories).size).toBeGreaterThan(2);
  });

  it('every fund has a non-empty 30-day NAV history', () => {
    for (const fund of PREVIEW_FUND_CARDS) {
      expect(fund.navHistory30d).toHaveLength(30);
      for (const point of fund.navHistory30d) {
        expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(point.value).toBeGreaterThan(0);
      }
    }
  });

  it('portfolio total value equals the sum of fund current values', () => {
    const sum = PREVIEW_FUND_CARDS.reduce((acc, f) => acc + (f.currentValue ?? 0), 0);
    expect(PREVIEW_PORTFOLIO_SUMMARY.totalValue).toBeCloseTo(sum, 2);
  });

  it('portfolio total invested equals the sum of fund invested amounts', () => {
    const sum = PREVIEW_FUND_CARDS.reduce((acc, f) => acc + f.investedAmount, 0);
    expect(PREVIEW_PORTFOLIO_SUMMARY.totalInvested).toBeCloseTo(sum, 2);
  });

  it('every fund_id is unique', () => {
    const ids = PREVIEW_FUND_CARDS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('findPreviewFundById returns the matching fund', () => {
    const target = PREVIEW_FUND_CARDS[2];
    expect(findPreviewFundById(target.id)).toEqual(target);
  });

  it('findPreviewFundById returns undefined for an unknown id', () => {
    expect(findPreviewFundById('not-a-real-id')).toBeUndefined();
  });

  it('every fund has a positive currentValue (no empty positions)', () => {
    for (const fund of PREVIEW_FUND_CARDS) {
      expect(fund.currentValue).not.toBeNull();
      expect(fund.currentValue!).toBeGreaterThan(0);
    }
  });

  it('overall portfolio is profitable (positive XIRR) — preview should look like a winning portfolio', () => {
    expect(PREVIEW_PORTFOLIO_SUMMARY.xirr).toBeGreaterThan(0);
  });

  it('benchmark symbol is the Phase-8-default Nifty 50 TRI', () => {
    expect(PREVIEW_PORTFOLIO_SUMMARY.benchmarkSymbol).toBe('^NSEITRI');
  });

  it('latestNavDate is a valid YYYY-MM-DD string', () => {
    expect(PREVIEW_PORTFOLIO_SUMMARY.latestNavDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
