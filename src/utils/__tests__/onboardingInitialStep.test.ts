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

    it('skips welcome → identity when PAN saved but DOB missing', () => {
      expect(
        pickOnboardingInitialStep({
          draftStep: 'welcome',
          pan: 'ABCDE1234F',
          dob: null,
          requestedMode: null,
        }),
      ).toBe('identity');
    });

    it('skips welcome → import when PAN and DOB both saved', () => {
      expect(
        pickOnboardingInitialStep({
          draftStep: 'welcome',
          pan: 'ABCDE1234F',
          dob: '1990-01-15',
          requestedMode: null,
        }),
      ).toBe('import');
    });

    it('skips identity → import when both saved', () => {
      expect(
        pickOnboardingInitialStep({
          draftStep: 'identity',
          pan: 'ABCDE1234F',
          dob: '1990-01-15',
          requestedMode: null,
        }),
      ).toBe('import');
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

    it('falls through to identity when DOB missing', () => {
      // welcome+PAN auto-promotes to identity even without the deep-link
      expect(
        pickOnboardingInitialStep({
          draftStep: 'welcome',
          pan: 'ABCDE1234F',
          dob: null,
          requestedMode: 'request-cas',
        }),
      ).toBe('identity');
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
