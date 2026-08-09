interface DobFallbackPromptInput {
  dobMissing: boolean;
  uploadFailed: boolean;
  errorMessage: string | null;
  customPassword: string;
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
