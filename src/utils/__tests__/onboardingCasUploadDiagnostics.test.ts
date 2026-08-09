import {
  onboardingCasUploadOutcomeDiagnostics,
  onboardingCasUploadStartDiagnostics,
} from '../onboardingCasUploadDiagnostics';

describe('onboarding CAS upload diagnostics', () => {
  it('keeps wizard start diagnostics bucketed and statement-private', () => {
    const privateInput = {
      platform: 'ios',
      sizeBytes: 12_345,
      hasPasswordOverride: false,
      fileName: 'private-statement.pdf',
      mime: 'application/pdf',
    };

    const diagnostic = onboardingCasUploadStartDiagnostics(privateInput);
    const serialized = JSON.stringify(diagnostic);

    expect(diagnostic).toEqual({
      platform: 'ios',
      file_size_bucket: '<=512KB',
      has_password_override: false,
    });
    expect(serialized).not.toContain('private-statement.pdf');
    expect(serialized).not.toContain('12345');
    expect(serialized).not.toContain('application/pdf');
  });

  it('excludes exact counts, raw errors, and exact timing from wizard outcomes', () => {
    const privateInput = {
      elapsedMs: 12_345,
      errorKind: 'parser_error',
      funds: 5,
      transactions: 42,
      rawMessage: 'private upstream statement error',
    };

    const diagnostic = onboardingCasUploadOutcomeDiagnostics(privateInput);
    const serialized = JSON.stringify(diagnostic);

    expect(diagnostic).toEqual({
      elapsed_bucket: '5-15s',
      error_kind: 'parser_error',
    });
    expect(serialized).not.toContain('12345');
    expect(serialized).not.toContain('42');
    expect(serialized).not.toContain('private upstream statement error');
  });
});
