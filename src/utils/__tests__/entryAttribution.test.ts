import {
  EMPTY_ATTRIBUTION,
  parseAttributionFromUrl,
  readEntryAttributionFromBrowser,
} from '../entryAttribution';

describe('parseAttributionFromUrl', () => {
  it('returns empty attribution for null / undefined / empty url', () => {
    expect(parseAttributionFromUrl(null)).toEqual(EMPTY_ATTRIBUTION);
    expect(parseAttributionFromUrl(undefined)).toEqual(EMPTY_ATTRIBUTION);
    expect(parseAttributionFromUrl('')).toEqual(EMPTY_ATTRIBUTION);
  });

  it('returns empty attribution when the URL is malformed', () => {
    expect(parseAttributionFromUrl('not a url')).toEqual(EMPTY_ATTRIBUTION);
  });

  it('extracts every UTM parameter from a well-formed URL', () => {
    const result = parseAttributionFromUrl(
      'https://app.foliolens.in/auth?utm_source=twitter&utm_medium=social&utm_campaign=launch&utm_content=hero-cta&utm_term=mutual%20funds',
    );
    expect(result.utm_source).toBe('twitter');
    expect(result.utm_medium).toBe('social');
    expect(result.utm_campaign).toBe('launch');
    expect(result.utm_content).toBe('hero-cta');
    expect(result.utm_term).toBe('mutual funds');
  });

  it('exposes the URL itself as page_url', () => {
    const url = 'https://app.foliolens.in/auth?utm_source=twitter';
    expect(parseAttributionFromUrl(url).page_url).toBe(url);
  });

  it('returns null UTM fields when the URL has no UTM params', () => {
    const result = parseAttributionFromUrl('https://app.foliolens.in/auth');
    expect(result.utm_source).toBeNull();
    expect(result.utm_medium).toBeNull();
    expect(result.page_url).toBe('https://app.foliolens.in/auth');
  });

  it('returns null for empty-string UTM values', () => {
    const result = parseAttributionFromUrl(
      'https://app.foliolens.in/auth?utm_source=&utm_medium=&utm_campaign=launch',
    );
    expect(result.utm_source).toBeNull();
    expect(result.utm_medium).toBeNull();
    expect(result.utm_campaign).toBe('launch');
  });

  it('trims whitespace from UTM values', () => {
    const result = parseAttributionFromUrl(
      'https://app.foliolens.in/auth?utm_source=%20twitter%20',
    );
    expect(result.utm_source).toBe('twitter');
  });

  it('captures referrer when provided', () => {
    const result = parseAttributionFromUrl(
      'https://app.foliolens.in/auth?utm_source=twitter',
      'https://foliolens.in/',
    );
    expect(result.referrer).toBe('https://foliolens.in/');
  });

  it('treats empty / whitespace referrer as null', () => {
    expect(parseAttributionFromUrl('https://app.foliolens.in/auth', '').referrer).toBeNull();
    expect(parseAttributionFromUrl('https://app.foliolens.in/auth', '   ').referrer).toBeNull();
  });

  it('keeps referrer null when the URL is malformed', () => {
    const result = parseAttributionFromUrl('garbage', 'https://foliolens.in/');
    expect(result.referrer).toBe('https://foliolens.in/');
    expect(result.utm_source).toBeNull();
    expect(result.page_url).toBeNull();
  });
});

describe('readEntryAttributionFromBrowser', () => {
  const originalWindow = global.window;
  const originalDocument = global.document;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (global as unknown as { window?: unknown }).window;
    } else {
      (global as unknown as { window: unknown }).window = originalWindow;
    }
    if (originalDocument === undefined) {
      delete (global as unknown as { document?: unknown }).document;
    } else {
      (global as unknown as { document: unknown }).document = originalDocument;
    }
  });

  it('returns EMPTY_ATTRIBUTION when window is undefined (native / SSR)', () => {
    delete (global as unknown as { window?: unknown }).window;
    expect(readEntryAttributionFromBrowser()).toEqual(EMPTY_ATTRIBUTION);
  });

  it('returns EMPTY_ATTRIBUTION when window.location is undefined', () => {
    (global as unknown as { window: unknown }).window = {};
    expect(readEntryAttributionFromBrowser()).toEqual(EMPTY_ATTRIBUTION);
  });

  it('reads UTMs and referrer from window / document when both are present', () => {
    (global as unknown as { window: unknown }).window = {
      location: {
        href: 'https://app.foliolens.in/auth?utm_source=twitter&utm_campaign=launch',
      },
    };
    (global as unknown as { document: unknown }).document = {
      referrer: 'https://foliolens.in/',
    };

    const result = readEntryAttributionFromBrowser();
    expect(result.utm_source).toBe('twitter');
    expect(result.utm_campaign).toBe('launch');
    expect(result.page_url).toBe('https://app.foliolens.in/auth?utm_source=twitter&utm_campaign=launch');
    expect(result.referrer).toBe('https://foliolens.in/');
  });

  it('handles a window with no document defined', () => {
    (global as unknown as { window: unknown }).window = {
      location: { href: 'https://app.foliolens.in/auth?utm_source=twitter' },
    };
    delete (global as unknown as { document?: unknown }).document;
    const result = readEntryAttributionFromBrowser();
    expect(result.utm_source).toBe('twitter');
    expect(result.referrer).toBeNull();
  });
});
