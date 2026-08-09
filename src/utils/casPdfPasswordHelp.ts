export interface DobFallbackPromptInput {
  dobMissing: boolean;
  uploadFailed: boolean;
  errorMessage: string | null;
  customPassword: string;
}

interface WizardUploadFailureInput extends DobFallbackPromptInput {
  hasSavedPan: boolean;
}

export function shouldShowDobFallbackPrompt({
  dobMissing,
  uploadFailed,
  errorMessage,
  customPassword,
}: DobFallbackPromptInput): boolean {
  return dobMissing
    && uploadFailed
    && !customPassword.trim()
    && /password/i.test(errorMessage ?? '');
}

export function wizardStepAfterCasUploadFailure(
  input: WizardUploadFailureInput,
): 'identity' | null {
  return input.hasSavedPan && shouldShowDobFallbackPrompt(input)
    ? 'identity'
    : null;
}
