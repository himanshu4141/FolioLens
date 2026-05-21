import AsyncStorage from '@react-native-async-storage/async-storage';

export const ONBOARDING_DRAFT_KEY = 'foliolens-onboarding-draft-v1';

export type OnboardingStep = 'welcome' | 'identity' | 'import' | 'done';

export interface OnboardingDraft {
  step: OnboardingStep;
  pan: string;
  dob: string | null;          // ISO YYYY-MM-DD, optional
  importResult: { funds: number; transactions: number } | null;
}

export const EMPTY_DRAFT: OnboardingDraft = {
  step: 'welcome',
  pan: '',
  dob: null,
  importResult: null,
};

export type OnboardingAction =
  | { type: 'hydrate'; draft: OnboardingDraft }
  | { type: 'goto'; step: OnboardingStep }
  | { type: 'set_pan'; pan: string }
  | { type: 'set_dob'; dob: string | null }
  | { type: 'import_complete'; funds: number; transactions: number }
  | { type: 'reset' };

export function reduceOnboarding(state: OnboardingDraft, action: OnboardingAction): OnboardingDraft {
  switch (action.type) {
    case 'hydrate':
      return action.draft;
    case 'goto':
      return { ...state, step: action.step };
    case 'set_pan':
      // Store PAN uppercase + trimmed; UI displays the same.
      return { ...state, pan: action.pan.trim().toUpperCase() };
    case 'set_dob':
      return { ...state, dob: action.dob };
    case 'import_complete':
      return {
        ...state,
        importResult: { funds: action.funds, transactions: action.transactions },
        step: 'done',
      };
    case 'reset':
      return EMPTY_DRAFT;
    default:
      return state;
  }
}

// PAN format: AAAA[entity-type][A]NNNN[A]
// The 4th character is the entity-type code:
//   P = Individual,  C = Company,           H = HUF (Hindu Undivided Family),
//   F = Firm,        A = Association of Persons (AOP),
//   T = Trust,       B = Body of Individuals (BOI),
//   L = Local authority,  J = Artificial Juridical Person,  G = Government.
// Restricting to those ten codes catches typos in this position (e.g. D, O,
// I) that the looser /^[A-Z]{5}[0-9]{4}[A-Z]$/ accepted — and a CAS PDF
// issued for the real PAN would never unlock with the typo'd one anyway.
const PAN_REGEX = /^[A-Z]{3}[PCHFATBLJG][A-Z][0-9]{4}[A-Z]$/;

export function isValidPan(pan: string): boolean {
  return PAN_REGEX.test(pan.trim().toUpperCase());
}

const DOB_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDob(dob: string | null | undefined): boolean {
  if (!dob) return false;
  if (!DOB_REGEX.test(dob)) return false;
  const parsed = new Date(dob);
  if (Number.isNaN(parsed.getTime())) return false;
  // Sanity: between 1900 and today
  const year = parsed.getUTCFullYear();
  return year >= 1900 && parsed.getTime() <= Date.now();
}

export async function loadOnboardingDraft(): Promise<OnboardingDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(ONBOARDING_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingDraft>;

    return {
      step: isOnboardingStep(parsed.step) ? parsed.step : 'welcome',
      pan: typeof parsed.pan === 'string' ? parsed.pan : '',
      dob: typeof parsed.dob === 'string' ? parsed.dob : null,
      importResult:
        parsed.importResult &&
        typeof parsed.importResult === 'object' &&
        typeof parsed.importResult.funds === 'number' &&
        typeof parsed.importResult.transactions === 'number'
          ? { funds: parsed.importResult.funds, transactions: parsed.importResult.transactions }
          : null,
    };
  } catch {
    // Storage corruption or unparseable JSON — treat as no draft.
    return null;
  }
}

export async function saveOnboardingDraft(draft: OnboardingDraft): Promise<void> {
  try {
    await AsyncStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Best-effort persistence — never throw out of the reducer caller.
  }
}

export async function clearOnboardingDraft(): Promise<void> {
  try {
    await AsyncStorage.removeItem(ONBOARDING_DRAFT_KEY);
  } catch {
    // Swallow.
  }
}

function isOnboardingStep(value: unknown): value is OnboardingStep {
  return value === 'welcome' || value === 'identity' || value === 'import' || value === 'done';
}
