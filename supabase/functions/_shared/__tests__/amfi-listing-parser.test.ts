import {
  extractLatestXlsxUrl,
  parsePeriodFromHref,
  extractClassificationPeriod,
} from '../amfi-listing-parser';

// ---------------------------------------------------------------------------
// parsePeriodFromHref
// ---------------------------------------------------------------------------

describe('parsePeriodFromHref', () => {
  it('parses cutoff-date form 30JunYYYY as H1', () => {
    expect(parsePeriodFromHref('/Themes/Theme1/downloads/AverageMarketCapitalization_30Jun2024.xlsx'))
      .toEqual({ half: 1, year: 2024 });
  });

  it('parses cutoff-date form 31DecYYYY as H2', () => {
    expect(parsePeriodFromHref('/Themes/Theme1/downloads/AverageMarketCapitalization_31Dec2024.xlsx'))
      .toEqual({ half: 2, year: 2024 });
  });

  it('parses cutoff-date form without separator', () => {
    expect(parsePeriodFromHref('AverageMarketCapitalization30Jun2025.pdf'))
      .toEqual({ half: 1, year: 2025 });
  });

  it('parses long-form range Jan-Jun YYYY as H1', () => {
    expect(parsePeriodFromHref('/x/Average Market Capitalization of List Companies during Jan-June 2021.xlsx'))
      .toEqual({ half: 1, year: 2021 });
  });

  it('parses long-form range Jul-Dec YYYY as H2', () => {
    expect(parsePeriodFromHref('/x/Average Market Capitalization of Listed Companies during Jul - Dec_2020_Final.pdf'))
      .toEqual({ half: 2, year: 2020 });
  });

  it('parses explicit half label H1-YYYY', () => {
    expect(parsePeriodFromHref('/x/categorisation-of-stocks-h1-2025.xlsx'))
      .toEqual({ half: 1, year: 2025 });
  });

  it('parses explicit half label h2_YYYY', () => {
    expect(parsePeriodFromHref('/x/categorisation-h2_2024.xlsx'))
      .toEqual({ half: 2, year: 2024 });
  });

  it('returns null when no period is recognisable', () => {
    expect(parsePeriodFromHref('/x/random-document.xlsx')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractClassificationPeriod
// ---------------------------------------------------------------------------

describe('extractClassificationPeriod', () => {
  it('formats H1-YYYY for Jun cutoff', () => {
    expect(extractClassificationPeriod('AverageMarketCapitalization_30Jun2024.xlsx')).toBe('H1-2024');
  });

  it('formats H2-YYYY for Dec cutoff', () => {
    expect(extractClassificationPeriod('AverageMarketCapitalization_31Dec2024.xlsx')).toBe('H2-2024');
  });

  it('falls back to today when URL is unrecognisable (Jan = H1)', () => {
    const jan = new Date(Date.UTC(2026, 0, 15));
    expect(extractClassificationPeriod('random.xlsx', jan)).toBe('H1-2026');
  });

  it('falls back to today when URL is unrecognisable (Jul = H2)', () => {
    const jul = new Date(Date.UTC(2026, 6, 15));
    expect(extractClassificationPeriod('random.xlsx', jul)).toBe('H2-2026');
  });

  it('boundary: June is H1, July is H2', () => {
    const jun = new Date(Date.UTC(2026, 5, 30));
    const jul = new Date(Date.UTC(2026, 6, 1));
    expect(extractClassificationPeriod('random.xlsx', jun)).toBe('H1-2026');
    expect(extractClassificationPeriod('random.xlsx', jul)).toBe('H2-2026');
  });
});

// ---------------------------------------------------------------------------
// extractLatestXlsxUrl
// ---------------------------------------------------------------------------

describe('extractLatestXlsxUrl', () => {
  it('returns null url and empty candidates when no .xlsx hrefs', () => {
    const result = extractLatestXlsxUrl('<html><body><a href="/x.pdf">pdf</a></body></html>');
    expect(result.url).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it('returns the absolute URL of the only .xlsx', () => {
    const html = `<a href="/Themes/Theme1/downloads/AverageMarketCapitalization_30Jun2024.xlsx">June 2024</a>`;
    const result = extractLatestXlsxUrl(html);
    expect(result.url).toBe('https://www.amfiindia.com/Themes/Theme1/downloads/AverageMarketCapitalization_30Jun2024.xlsx');
    expect(result.candidates).toHaveLength(1);
  });

  it('picks the latest period when multiple .xlsx are listed', () => {
    const html = `
      <ul>
        <li><a href="/x/AverageMarketCapitalization_30Jun2020.xlsx">2020 H1</a></li>
        <li><a href="/x/AverageMarketCapitalization_31Dec2024.xlsx">2024 H2</a></li>
        <li><a href="/x/AverageMarketCapitalization_30Jun2024.xlsx">2024 H1</a></li>
        <li><a href="/x/AverageMarketCapitalization_30Jun2025.xlsx">2025 H1</a></li>
      </ul>
    `;
    const result = extractLatestXlsxUrl(html);
    expect(result.url).toBe('https://www.amfiindia.com/x/AverageMarketCapitalization_30Jun2025.xlsx');
    expect(result.candidates).toHaveLength(4);
  });

  it('returns every candidate in document order so callers can surface them on failure', () => {
    const html = `
      <a href="/a-30Jun2020.xlsx">x</a>
      <a href="/b-31Dec2021.xlsx">x</a>
      <a href="/c-30Jun2024.xlsx">x</a>
    `;
    const { candidates } = extractLatestXlsxUrl(html);
    expect(candidates).toEqual([
      '/a-30Jun2020.xlsx',
      '/b-31Dec2021.xlsx',
      '/c-30Jun2024.xlsx',
    ]);
  });

  it('handles protocol-relative URLs', () => {
    const html = `<a href="//cdn.amfiindia.com/x_30Jun2024.xlsx">x</a>`;
    expect(extractLatestXlsxUrl(html).url).toBe('https://cdn.amfiindia.com/x_30Jun2024.xlsx');
  });

  it('handles absolute URLs unchanged', () => {
    const html = `<a href="https://other.example/x_30Jun2024.xlsx">x</a>`;
    expect(extractLatestXlsxUrl(html).url).toBe('https://other.example/x_30Jun2024.xlsx');
  });

  it('handles single-quoted href attributes', () => {
    const html = `<a href='/Themes/x_30Jun2024.xlsx'>x</a>`;
    expect(extractLatestXlsxUrl(html).url).toBe('https://www.amfiindia.com/Themes/x_30Jun2024.xlsx');
  });

  it('handles long-form filenames mixed with cutoff-date filenames in the same ranking', () => {
    const html = `
      <a href="/x/AverageMarketCapitalization%20Jan-Jun%202021.xlsx">2021 H1</a>
      <a href="/x/AverageMarketCapitalization_30Jun2024.xlsx">2024 H1</a>
    `;
    const result = extractLatestXlsxUrl(html);
    expect(result.url).toContain('30Jun2024');
  });

  it('still returns the unrecognised candidate when nothing parses (tie-broken by string order)', () => {
    const html = `<a href="/x/random-a.xlsx">a</a><a href="/x/random-b.xlsx">b</a>`;
    const result = extractLatestXlsxUrl(html);
    // Both score 0; string-descending sort gives "random-b" as the head.
    expect(result.url).toBe('https://www.amfiindia.com/x/random-b.xlsx');
  });
});
