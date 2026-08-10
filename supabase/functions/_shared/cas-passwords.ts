export interface CASPasswordProfile {
  pan?: string | null;
  dob?: string | null;
}

export interface CASPasswordAttempts {
  primary: string;
  depositoryFallback: string | null;
  mode: 'custom' | 'profile';
}

export function buildCASPasswordAttempts(
  profile: CASPasswordProfile | null | undefined,
  passwordOverride: string | null,
): CASPasswordAttempts {
  if (passwordOverride) {
    return {
      primary: passwordOverride,
      depositoryFallback: null,
      mode: 'custom',
    };
  }

  const pan = profile?.pan?.trim().toUpperCase() ?? '';
  const dob = profile?.dob?.trim() ?? '';
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  const depositoryFallback = pan && dateParts
    ? `${pan}${dateParts[3]}${dateParts[2]}${dateParts[1]}`
    : null;

  return {
    primary: pan,
    depositoryFallback,
    mode: 'profile',
  };
}
