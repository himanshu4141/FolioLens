import {
  isOnboardingMode,
  pickOnboardingInitialStep,
} from '@/src/utils/onboardingInitialStep';

describe('isOnboardingMode()', () => {
  it.each(['auto-refresh', 'request-cas', 'identity'])('accepts %s', (mode) => {
    expect(isOnboardingMode(mode)).toBe(true);
  });

  it.each([null, undefined, '', 'welcome', 'foo', 42, {}])('rejects %p', (value) => {
    expect(isOnboardingMode(value)).toBe(false);
  });
});

describe('pickOnboardingInitialStep()', () => {
  describe('with no requested mode', () => {
    it('keeps welcome when no PAN saved (fresh user)', () => {
      expect(
        pickOnboardingInitialStep({
          draftStep: 'welcome',
          pan: null,
          dob: null,
          requestedMode: null,
        }),
      ).toBe('welcome');
    });

    it('keeps welcome even when PAN is saved (drop-zone is the primary action)', () => {
      // Welcome is the dropzone hero in the new design — a returning user
      // with PAN saved still lands on Welcome so they can pick a PDF. The
      // wizard fast-paths the upload past Identity itself when PAN is set,
      // it doesn't skip Welcome.
      expect(
        pickOnboardingInitialStep({
          draftStep: 'welcome',
          pan: 'ABCDE1234F',
          dob: null,
          requestedMode: null,
        }),
      ).toBe('welcome');
      expect(
        pickOnboardingInitialStep({
          draftStep: 'welcome',
          pan: 'ABCDE1234F',
          dob: '1990-01-15',
          requestedMode: null,
        }),
      ).toBe('welcome');
    });

    it('keeps draft step when user resumes from identity', () => {
      expect(
        pickOnboardingInitialStep({
          draftStep: 'identity',
          pan: 'ABCDE1234F',
          dob: '1990-01-15',
          requestedMode: null,
        }),
      ).toBe('identity');
    });

    it('keeps draft step when user resumes from import', () => {
      expect(
        pickOnboardingInitialStep({
          draftStep: 'import',
          pan: 'ABCDE1234F',
          dob: '1990-01-15',
          requestedMode: null,
        }),
      ).toBe('import');
    });
  });

  describe('with requestedMode = identity', () => {
    it('always lands on identity so the user can review locked fields', () => {
      expect(
        pickOnboardingInitialStep({
          draftStep: 'import',
          pan: 'ABCDE1234F',
          dob: '1990-01-15',
          requestedMode: 'identity',
        }),
      ).toBe('identity');
    });
  });

  describe('with requestedMode = auto-refresh', () => {
    // Regression: this is the bug from the May 9 testing session. Settings
    // → "Set up auto-forward" sent the user back to Welcome because the
    // gate required DOB even though Gmail auto-forward setup doesn't need
    // DOB at all (DOB is only for CDSL/NSDL imports).
    it('skips to import when PAN saved even if DOB is missing', () => {
      expect(
        pickOnboardingInitialStep({
          draftStep: 'welcome',
          pan: 'ABCDE1234F',
          dob: null,
          requestedMode: 'auto-refresh',
        }),
      ).toBe('import');
    });

    it('skips to import when PAN and DOB both saved', () => {
      expect(
        pickOnboardingInitialStep({
          draftStep: 'welcome',
          pan: 'ABCDE1234F',
          dob: '1990-01-15',
          requestedMode: 'auto-refresh',
        }),
      ).toBe('import');
    });

    it('falls back to welcome when PAN is not yet saved (no shortcut to bypass identity)', () => {
      expect(
        pickOnboardingInitialStep({
          draftStep: 'welcome',
          pan: null,
          dob: null,
          requestedMode: 'auto-refresh',
        }),
      ).toBe('welcome');
    });
  });

  describe('with requestedMode = request-cas', () => {
    // Fresh CAS request from CAMS / KFintech needs both PAN and DOB on the
    // request form, so we keep that gate up.
    it('skips to import only when both PAN and DOB are saved', () => {
      expect(
        pickOnboardingInitialStep({
          draftStep: 'welcome',
          pan: 'ABCDE1234F',
          dob: '1990-01-15',
          requestedMode: 'request-cas',
        }),
      ).toBe('import');
    });

    it('falls back to welcome when DOB missing (the deep-link gate fails)', () => {
      // request-cas needs both PAN and DOB on the CAMS / KFintech form, so
      // missing DOB drops the user back to Welcome where they pick a PDF
      // (or tap "Get it in 2 mins" to traverse the get-statement flow).
      expect(
        pickOnboardingInitialStep({
          draftStep: 'welcome',
          pan: 'ABCDE1234F',
          dob: null,
          requestedMode: 'request-cas',
        }),
      ).toBe('welcome');
    });

    it('keeps welcome when nothing saved', () => {
      expect(
        pickOnboardingInitialStep({
          draftStep: 'welcome',
          pan: null,
          dob: null,
          requestedMode: 'request-cas',
        }),
      ).toBe('welcome');
    });
  });

  describe('input shapes', () => {
    it('treats undefined and null PAN/DOB the same as missing', () => {
      expect(
        pickOnboardingInitialStep({
          draftStep: 'welcome',
          pan: undefined,
          dob: undefined,
          requestedMode: 'auto-refresh',
        }),
      ).toBe('welcome');
    });
  });
});
