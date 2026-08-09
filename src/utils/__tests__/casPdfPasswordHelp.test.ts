import { shouldShowDobFallbackPrompt } from '../casPdfPasswordHelp';

describe('CAS PDF DOB fallback prompt', () => {
  const base = {
    dobMissing: true,
    uploadFailed: true,
    errorMessage: 'The PDF password was not accepted.',
    customPassword: '',
  };

  it('appears only after a password failure when DOB is absent', () => {
    expect(shouldShowDobFallbackPrompt(base)).toBe(true);
    expect(shouldShowDobFallbackPrompt({ ...base, uploadFailed: false })).toBe(false);
    expect(shouldShowDobFallbackPrompt({ ...base, errorMessage: 'Unsupported layout' })).toBe(false);
    expect(shouldShowDobFallbackPrompt({ ...base, dobMissing: false })).toBe(false);
  });

  it('does not suggest the profile fallback after an exclusive custom-password attempt', () => {
    expect(shouldShowDobFallbackPrompt({ ...base, customPassword: 'different-password' }))
      .toBe(false);
  });
});
