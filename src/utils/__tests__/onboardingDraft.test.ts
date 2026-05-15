import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearOnboardingDraft,
  EMPTY_DRAFT,
  isValidDob,
  isValidPan,
  loadOnboardingDraft,
  ONBOARDING_DRAFT_KEY,
  reduceOnboarding,
  saveOnboardingDraft,
  type OnboardingAction,
  type OnboardingDraft,
} from '../onboardingDraft';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const mockedStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  mockedStorage.getItem.mockReset();
  mockedStorage.setItem.mockReset();
  mockedStorage.removeItem.mockReset();
});

describe('isValidPan', () => {
  it('accepts canonical individual PAN', () => {
    expect(isValidPan('ABCPE1234F')).toBe(true);
  });

  it('accepts every valid 4th-char entity-type code', () => {
    expect(isValidPan('AAAPA1234H')).toBe(true); // P — Individual
    expect(isValidPan('AAACA1234H')).toBe(true); // C — Company
    expect(isValidPan('AAAHA1234H')).toBe(true); // H — HUF
    expect(isValidPan('AAAFA1234H')).toBe(true); // F — Firm
    expect(isValidPan('AAAAA1234H')).toBe(true); // A — Association of Persons
    expect(isValidPan('AAATA1234H')).toBe(true); // T — Trust
    expect(isValidPan('AAABA1234H')).toBe(true); // B — Body of Individuals
    expect(isValidPan('AAALA1234H')).toBe(true); // L — Local authority
    expect(isValidPan('AAAJA1234H')).toBe(true); // J — Artificial Juridical Person
    expect(isValidPan('AAAGA1234H')).toBe(true); // G — Government
  });

  it('uppercases and trims before validating', () => {
    expect(isValidPan('  abcpe1234f  ')).toBe(true);
  });

  it('rejects wrong length', () => {
    expect(isValidPan('ABCPE1234')).toBe(false);
    expect(isValidPan('ABCPE1234FG')).toBe(false);
  });

  it('rejects bad pattern', () => {
    expect(isValidPan('1BCPE1234F')).toBe(false); // first char digit
    expect(isValidPan('ABCDEFGHIJ')).toBe(false); // no digits
    expect(isValidPan('ABCPE12345')).toBe(false); // last char digit
  });

  it('rejects invalid 4th-char entity-type codes', () => {
    // Original regex /^[A-Z]{5}[0-9]{4}[A-Z]$/ accepted these; the typo
    // case that prompted this validation (P → O) lives here.
    expect(isValidPan('ABCDE1234F')).toBe(false); // D — not a valid entity code
    expect(isValidPan('ADNOH4999K')).toBe(false); // O — typo for P (Individual)
    expect(isValidPan('ZZZZZ0001C')).toBe(false); // Z — not a valid entity code
    expect(isValidPan('ABCIE1234F')).toBe(false); // I — looks like 1, not a valid code
  });

  it('rejects empty', () => {
    expect(isValidPan('')).toBe(false);
  });
});

describe('isValidDob', () => {
  it('accepts a real ISO date', () => {
    expect(isValidDob('1990-05-12')).toBe(true);
  });

  it('rejects null and empty', () => {
    expect(isValidDob(null)).toBe(false);
    expect(isValidDob('')).toBe(false);
    expect(isValidDob(undefined)).toBe(false);
  });

  it('rejects malformed strings', () => {
    expect(isValidDob('1990/05/12')).toBe(false);
    expect(isValidDob('05-12-1990')).toBe(false);
    expect(isValidDob('19900512')).toBe(false);
  });

  it('rejects future dates', () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 10);
    expect(isValidDob(future)).toBe(false);
  });

  it('rejects pre-1900 dates', () => {
    expect(isValidDob('1899-12-31')).toBe(false);
  });
});

describe('reduceOnboarding', () => {
  it('hydrates with the provided draft', () => {
    const next = reduceOnboarding(EMPTY_DRAFT, {
      type: 'hydrate',
      draft: { ...EMPTY_DRAFT, pan: 'ABCDE1234F', step: 'identity' },
    });
    expect(next.pan).toBe('ABCDE1234F');
    expect(next.step).toBe('identity');
  });

  it('navigates between steps', () => {
    const next = reduceOnboarding(EMPTY_DRAFT, { type: 'goto', step: 'import' });
    expect(next.step).toBe('import');
  });

  it('uppercases and trims PAN on set_pan', () => {
    const next = reduceOnboarding(EMPTY_DRAFT, { type: 'set_pan', pan: '  abcde1234f ' });
    expect(next.pan).toBe('ABCDE1234F');
  });

  it('records dob without mutation', () => {
    const next = reduceOnboarding(EMPTY_DRAFT, { type: 'set_dob', dob: '1985-03-21' });
    expect(next.dob).toBe('1985-03-21');
    expect(EMPTY_DRAFT.dob).toBeNull();
  });

  it('clears dob when set to null', () => {
    const seeded: OnboardingDraft = { ...EMPTY_DRAFT, dob: '1990-01-01' };
    const next = reduceOnboarding(seeded, { type: 'set_dob', dob: null });
    expect(next.dob).toBeNull();
  });

  it('moves to done and saves import result on import_complete', () => {
    const seeded: OnboardingDraft = { ...EMPTY_DRAFT, step: 'import' };
    const next = reduceOnboarding(seeded, {
      type: 'import_complete',
      funds: 4,
      transactions: 17,
    });
    expect(next.step).toBe('done');
    expect(next.importResult).toEqual({ funds: 4, transactions: 17 });
  });

  it('reset returns to empty draft', () => {
    const seeded: OnboardingDraft = {
      ...EMPTY_DRAFT,
      step: 'done',
      pan: 'ABCDE1234F',
      importResult: { funds: 1, transactions: 2 },
    };
    const next = reduceOnboarding(seeded, { type: 'reset' });
    expect(next).toEqual(EMPTY_DRAFT);
  });

  it('returns state unchanged for an unknown action type', () => {
    const unknown = { type: 'totally-unknown' } as unknown as OnboardingAction;
    const next = reduceOnboarding(EMPTY_DRAFT, unknown);
    expect(next).toBe(EMPTY_DRAFT);
  });
});

describe('loadOnboardingDraft', () => {
  it('returns null when nothing is stored', async () => {
    mockedStorage.getItem.mockResolvedValueOnce(null);
    await expect(loadOnboardingDraft()).resolves.toBeNull();
    expect(mockedStorage.getItem).toHaveBeenCalledWith(ONBOARDING_DRAFT_KEY);
  });

  it('hydrates a well-formed draft', async () => {
    const stored: OnboardingDraft = {
      step: 'identity',
      pan: 'ABCDE1234F',
      dob: '1990-04-12',
      importResult: { funds: 3, transactions: 9 },
    };
    mockedStorage.getItem.mockResolvedValueOnce(JSON.stringify(stored));
    await expect(loadOnboardingDraft()).resolves.toEqual(stored);
  });

  it('falls back to defaults for missing or wrong-typed fields', async () => {
    mockedStorage.getItem.mockResolvedValueOnce(JSON.stringify({}));
    await expect(loadOnboardingDraft()).resolves.toEqual(EMPTY_DRAFT);
  });

  it('coerces invalid step value to welcome', async () => {
    mockedStorage.getItem.mockResolvedValueOnce(JSON.stringify({ step: 'nope' }));
    const result = await loadOnboardingDraft();
    expect(result?.step).toBe('welcome');
  });

  it('drops importResult that is missing fields or has wrong types', async () => {
    mockedStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({ importResult: { funds: 'two', transactions: 1 } }),
    );
    await expect(loadOnboardingDraft()).resolves.toEqual(EMPTY_DRAFT);

    mockedStorage.getItem.mockResolvedValueOnce(
      JSON.stringify({ importResult: 'invalid' }),
    );
    await expect(loadOnboardingDraft()).resolves.toEqual(EMPTY_DRAFT);
  });

  it('returns null when JSON is corrupted', async () => {
    mockedStorage.getItem.mockResolvedValueOnce('{not json');
    await expect(loadOnboardingDraft()).resolves.toBeNull();
  });

  it('returns null when storage rejects', async () => {
    mockedStorage.getItem.mockRejectedValueOnce(new Error('boom'));
    await expect(loadOnboardingDraft()).resolves.toBeNull();
  });
});

describe('saveOnboardingDraft', () => {
  it('persists the serialised draft under the canonical key', async () => {
    mockedStorage.setItem.mockResolvedValueOnce();
    const draft: OnboardingDraft = { ...EMPTY_DRAFT, pan: 'ABCDE1234F' };
    await saveOnboardingDraft(draft);
    expect(mockedStorage.setItem).toHaveBeenCalledWith(
      ONBOARDING_DRAFT_KEY,
      JSON.stringify(draft),
    );
  });

  it('swallows storage errors instead of throwing', async () => {
    mockedStorage.setItem.mockRejectedValueOnce(new Error('disk full'));
    await expect(saveOnboardingDraft(EMPTY_DRAFT)).resolves.toBeUndefined();
  });
});

describe('clearOnboardingDraft', () => {
  it('removes the persisted key', async () => {
    mockedStorage.removeItem.mockResolvedValueOnce();
    await clearOnboardingDraft();
    expect(mockedStorage.removeItem).toHaveBeenCalledWith(ONBOARDING_DRAFT_KEY);
  });

  it('swallows storage errors instead of throwing', async () => {
    mockedStorage.removeItem.mockRejectedValueOnce(new Error('boom'));
    await expect(clearOnboardingDraft()).resolves.toBeUndefined();
  });
});
