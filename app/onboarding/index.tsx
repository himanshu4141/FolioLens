import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as WebBrowser from 'expo-web-browser';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/src/lib/supabase';
import { useSession } from '@/src/hooks/useSession';
import { FolioLensLogo } from '@/src/components/clearLens/FolioLensLogo';
import { DesktopFormFrame } from '@/src/components/responsive';
import { AutoRefreshSetup } from '@/src/components/onboarding/AutoRefreshSetup';
import { FeedbackSheet, type FeedbackKind } from '@/src/components/FeedbackSheet';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensFonts,
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import {
  EMPTY_DRAFT,
  type OnboardingDraft,
  type OnboardingStep,
  clearOnboardingDraft,
  isValidDob,
  isValidPan,
  loadOnboardingDraft,
  reduceOnboarding,
  saveOnboardingDraft,
} from '@/src/utils/onboardingDraft';
import { uploadCasPdf } from '@/src/utils/casPdfUpload';
import { analytics } from '@/src/lib/analytics';

type WizardStyles = ReturnType<typeof makeStyles>;
type Cl = ClearLensTokens['colors'];

const STEP_ORDER: OnboardingStep[] = ['welcome', 'identity', 'import', 'done'];

// Both CAMS and KFintech issue a combined Consolidated Account Statement
// covering every AMC (regardless of which RTA serviced the AMC). Both forms
// are public and ask for PAN + email — no login required. CAMS Online is
// listed first because its form is a single page; KFintech is functionally
// equivalent. MFCentral was the previous recommendation but offers no
// advantage over either RTA for the CAS request itself and forces login.
const PORTAL_OPTIONS: {
  id: string;
  name: string;
  url: string;
  description: string;
  recommended?: boolean;
}[] = [
  {
    id: 'cams',
    name: 'CAMS Online',
    url: 'https://www.camsonline.com/Investors/Statements/Consolidated-Account-Statement',
    description: 'Recommended — no login. Single-page form: just PAN + email.',
    recommended: true,
  },
  {
    id: 'kfintech',
    name: 'KFintech',
    url: 'https://mfs.kfintech.com/investor/General/ConsolidatedAccountStatement',
    description: 'Also no login. Same combined CAS — useful if CAMS is having issues.',
  },
];

const DEPOSITORY_OPTIONS: {
  id: string;
  name: string;
  url: string;
  description: string;
  recommended?: boolean;
}[] = [
  {
    id: 'cdsl',
    name: 'CDSL CAS',
    url: 'https://www.cdslindia.com/cas/logincas.aspx',
    description: 'Best if your broker / demat account is with CDSL. Download a Detailed CAS PDF.',
    recommended: true,
  },
  {
    id: 'nsdl',
    name: 'NSDL e-CAS',
    url: 'https://nsdlcas.nsdl.com/',
    description: 'Best if your broker / demat account is with NSDL. Download a Detailed CAS PDF.',
  },
];

export default function OnboardingScreen() {
  return (
    <DesktopFormFrame>
      <OnboardingWizard />
    </DesktopFormFrame>
  );
}

// DOB display format is DD-MM-YYYY (Indian convention); storage is ISO
// YYYY-MM-DD on user_profile.dob. Parse / format helpers keep the boundary
// thin.
const DOB_DISPLAY_RE = /^(\d{2})-(\d{2})-(\d{4})$/;

function parseDobDisplay(value: string): string | null {
  const m = DOB_DISPLAY_RE.exec(value);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function formatDobDisplay(iso: string): string {
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  const [yyyy, mm, dd] = parts;
  return `${dd}-${mm}-${yyyy}`;
}

// Auto-insert dashes as the user types, so they don't have to remember the
// hyphens (cap to DD-MM-YYYY).
function maskDobInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}

async function fetchSavedProfile(userId: string): Promise<SavedProfile | null> {
  const { data } = await supabase
    .from('user_profile')
    .select('pan, dob, kfintech_email, cas_inbox_token, cas_inbox_confirmation_url, cas_auto_forward_setup_completed_at')
    .eq('user_id', userId)
    .maybeSingle();
  return data ?? null;
}

async function markAutoForwardSetupComplete(userId: string): Promise<void> {
  const { error } = await supabase
    .from('user_profile')
    .update({
      cas_auto_forward_setup_completed_at: new Date().toISOString(),
      cas_inbox_confirmation_url: null,
    })
    .eq('user_id', userId);
  if (error) throw error;
}

interface SavedProfile {
  pan: string | null;
  dob: string | null;
  kfintech_email: string | null;
  cas_inbox_token: string | null;
  cas_inbox_confirmation_url: string | null;
  cas_auto_forward_setup_completed_at: string | null;
}

function OnboardingWizard() {
  const router = useRouter();
  const { session } = useSession();
  const queryClient = useQueryClient();
  const tokens = useClearLensTokens();
  const cl = tokens.colors;
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const [draft, dispatch] = useReducer(reduceOnboarding, EMPTY_DRAFT);
  const [hydrated, setHydrated] = useState(false);

  // Pull saved PAN / DOB / email from `user_profile` so the wizard can
  // skip Welcome (when PAN saved) and Identity (when both PAN + DOB saved),
  // and lock any field already set so a returning user can't accidentally
  // overwrite it.
  const { data: profile } = useQuery<SavedProfile | null>({
    queryKey: ['user-profile', session?.user.id],
    queryFn: () => fetchSavedProfile(session!.user.id),
    enabled: !!session?.user.id,
    // Always refetch on mount. A cached `null` from a previous visit (or a
    // different navigation stack that opened the wizard before the row was
    // written) would otherwise look like "no row exists", and hydration
    // would render the Identity form empty even when PAN + DOB are in DB.
    refetchOnMount: 'always',
  });

  useEffect(() => {
    // useQuery returns `data === undefined` while the fetch is in flight, and
    // either `null` (no row) or the SavedProfile object once it settles.
    // Hydrating before it settles dispatches the wizard into step='welcome'
    // with empty PAN/DOB, then `setHydrated(true)` flips and the user sees
    // the welcome screen. If they click Continue before the row arrives,
    // `handleAdvance` reads `profile?.pan` as undefined and pushes them to
    // Identity instead of Import — and by the time the row lands, the user
    // is already past the gate. Wait for the query to settle.
    if (profile === undefined) return;

    let cancelled = false;
    (async () => {
      const saved = await loadOnboardingDraft();
      if (cancelled) return;
      const initialEmail = session?.user.email ?? '';
      const seed: OnboardingDraft = saved
        ? { ...saved, email: saved.email || initialEmail }
        : { ...EMPTY_DRAFT, email: initialEmail };

      // If user_profile has saved values, hydrate the draft with them so the
      // form reflects the DB state and the saved-locked rendering kicks in.
      const merged: OnboardingDraft = {
        ...seed,
        pan: (profile?.pan ?? seed.pan) || '',
        dob: profile?.dob ?? seed.dob,
        email: profile?.kfintech_email || seed.email,
      };

      // Decide initial step based on what's already saved on user_profile.
      // PAN saved → skip Welcome. PAN + DOB saved → skip Identity too.
      let initialStep: OnboardingStep = merged.step;
      if (initialStep === 'welcome' && profile?.pan) {
        initialStep = profile.dob ? 'import' : 'identity';
      } else if (initialStep === 'identity' && profile?.pan && profile.dob) {
        initialStep = 'import';
      }

      console.log('[onboarding:wizard] hydrated', {
        platform: Platform.OS,
        initial_step: initialStep,
        saved_step: saved?.step ?? null,
        profile_present: !!profile,
        profile_has_pan: !!profile?.pan,
        profile_has_dob: !!profile?.dob,
        profile_has_kfintech_email: !!profile?.kfintech_email,
        draft_seeded_from_storage: !!saved,
      });

      dispatch({
        type: 'hydrate',
        draft: { ...merged, step: initialStep },
      });
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
    // We deliberately wait until the user_profile query resolves before
    // hydrating — `profile` is part of the deps so a late-arriving DB row
    // still drives the right initial step.
  }, [session?.user.email, profile]);

  useEffect(() => {
    if (!hydrated) return;
    void saveOnboardingDraft(draft);
  }, [draft, hydrated]);

  // Analytics: onboarding funnel. Three events fire from this single effect
  // so the wiring stays close to the state machine that drives them.
  //   `onboarding_started` once, the first time the user sees a non-done step
  //   `onboarding_step_completed` on each step→step transition (named after
  //     the step the user is *leaving*, which is what funnel queries want)
  //   `onboarding_completed` once, when the wizard reaches `done`
  const onboardingStartedRef = useRef(false);
  const previousStepRef = useRef<OnboardingStep | null>(null);
  const onboardingCompletedRef = useRef(false);

  useEffect(() => {
    if (!hydrated) return;
    const currentStep = draft.step;
    if (!onboardingStartedRef.current && currentStep !== 'done') {
      onboardingStartedRef.current = true;
      analytics.track('onboarding_started', {
        entry_point: profile?.pan ? 'returning_anon' : 'fresh_install',
      });
    }
    const previous = previousStepRef.current;
    if (previous && previous !== currentStep) {
      analytics.track('onboarding_step_completed', {
        step: previous,
        step_index: STEP_ORDER.indexOf(previous),
      });
      if (currentStep === 'done' && !onboardingCompletedRef.current) {
        onboardingCompletedRef.current = true;
        analytics.track('onboarding_completed');
      }
    }
    previousStepRef.current = currentStep;
  }, [hydrated, draft.step, profile?.pan]);

  const currentIndex = STEP_ORDER.indexOf(draft.step);

  function handleAdvance() {
    let next: OnboardingStep | null = null;
    if (draft.step === 'welcome') {
      next = profile?.pan && profile.dob ? 'import' : 'identity';
    } else if (draft.step === 'identity') {
      next = 'import';
    }
    if (next) {
      console.log('[onboarding:wizard] advance', { from: draft.step, to: next });
      dispatch({ type: 'goto', step: next });
    }
  }

  function handleBack() {
    let prev: OnboardingStep | null = null;
    if (draft.step === 'identity') {
      prev = 'welcome';
    } else if (draft.step === 'import') {
      prev = profile?.pan && profile.dob ? 'welcome' : 'identity';
    }
    if (prev) {
      console.log('[onboarding:wizard] back', { from: draft.step, to: prev });
      dispatch({ type: 'goto', step: prev });
    }
  }

  async function handleFinish() {
    console.log('[onboarding:wizard] finish', {
      imported: !!draft.importResult,
      funds: draft.importResult?.funds ?? 0,
      transactions: draft.importResult?.transactions ?? 0,
    });

    // After a successful import, invalidate every cached query so the
    // portfolio / money trail / timeline screens we're about to navigate
    // back to refetch against the just-imported funds and transactions.
    // Without this, React Query serves whatever was cached pre-import
    // (typically an empty portfolio for first-time users) and the user
    // has to manually pull-to-refresh before any data shows up.
    if (draft.importResult) {
      await queryClient.invalidateQueries();
    }

    await clearOnboardingDraft();
    router.replace('/(tabs)');
  }

  if (!hydrated) {
    // hydrated only flips after the user_profile query has settled (see the
    // hydration effect's `if (profile === undefined) return` guard), so this
    // doubles as both "draft loaded from storage" and "DB row resolved".
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={cl.emerald} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.topBar}>
        {draft.step !== 'welcome' && draft.step !== 'done' ? (
          <TouchableOpacity
            onPress={handleBack}
            hitSlop={8}
            style={styles.iconButton}
            activeOpacity={0.76}
          >
            <Ionicons name="chevron-back" size={22} color={cl.navy} />
          </TouchableOpacity>
        ) : (
          <View style={styles.iconButton} />
        )}
        <ProgressPills currentIndex={currentIndex} styles={styles} />
        <View style={styles.iconButton} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {draft.step === 'welcome' && (
          <WelcomeStep onContinue={handleAdvance} styles={styles} cl={cl} />
        )}
        {draft.step === 'identity' && (
          <IdentityStep
            draft={draft}
            dispatch={dispatch}
            session={session}
            onContinue={handleAdvance}
            lockedPan={profile?.pan ?? null}
            lockedDob={profile?.dob ?? null}
            styles={styles}
            cl={cl}
            tokens={tokens}
          />
        )}
        {draft.step === 'import' && (
          <ImportStep
            draft={draft}
            dispatch={dispatch}
            onSkip={() => dispatch({ type: 'goto', step: 'done' })}
            inboxToken={profile?.cas_inbox_token ?? null}
            pendingConfirmationUrl={profile?.cas_inbox_confirmation_url ?? null}
            autoForwardCompletedAt={profile?.cas_auto_forward_setup_completed_at ?? null}
            onConfirmClicked={() => {
              queryClient.invalidateQueries({ queryKey: ['user-profile', session?.user.id] });
            }}
            onAutoForwardCompleted={async () => {
              await markAutoForwardSetupComplete(session!.user.id);
              await queryClient.invalidateQueries({ queryKey: ['user-profile', session?.user.id] });
            }}
            styles={styles}
            cl={cl}
            tokens={tokens}
          />
        )}
        {draft.step === 'done' && (
          <DoneStep
            draft={draft}
            onFinish={handleFinish}
            hasInboxToken={!!profile?.cas_inbox_token}
            autoForwardCompletedAt={profile?.cas_auto_forward_setup_completed_at ?? null}
            styles={styles}
            cl={cl}
          />
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ProgressPills({
  currentIndex,
  styles,
}: {
  currentIndex: number;
  styles: WizardStyles;
}) {
  return (
    <View style={styles.pillsRow}>
      {STEP_ORDER.map((step, idx) => (
        <View
          key={step}
          style={[
            styles.pill,
            idx <= currentIndex ? styles.pillActive : styles.pillInactive,
          ]}
        />
      ))}
    </View>
  );
}

function WelcomeStep({
  onContinue,
  styles,
  cl,
}: {
  onContinue: () => void;
  styles: WizardStyles;
  cl: Cl;
}) {
  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <LinearGradient colors={[cl.heroSurface, cl.slate]} style={styles.hero}>
        <FolioLensLogo size={36} light showWordmark />
        <Text style={styles.heroHeadline}>Let&apos;s pull in your portfolio.</Text>
        <Text style={styles.heroSubhead}>
          We need your Consolidated Account Statement (CAS) — a free statement
          from CAMS or KFintech that lists every mutual fund you own.
        </Text>
      </LinearGradient>

      <View style={styles.bullets}>
        <Bullet icon="trending-up-outline" text="See your real return (XIRR) instantly" styles={styles} cl={cl} />
        <Bullet icon="pie-chart-outline" text="Sector + asset exposure across AMCs" styles={styles} cl={cl} />
        <Bullet icon="git-branch-outline" text="Money trail of every transaction" styles={styles} cl={cl} />
      </View>

      <View style={styles.privacyCard}>
        <Ionicons name="shield-checkmark-outline" size={18} color={cl.emeraldDeep} />
        <Text style={styles.privacyText}>
          Read-only. Stored encrypted. Never shared with third parties.
        </Text>
      </View>

      <View style={styles.footerSpace} />

      <PrimaryButton label="Get started" onPress={onContinue} styles={styles} cl={cl} />
    </ScrollView>
  );
}

function IdentityStep({
  draft,
  dispatch,
  session,
  onContinue,
  lockedPan,
  lockedDob,
  styles,
  cl,
  tokens,
}: {
  draft: OnboardingDraft;
  dispatch: React.Dispatch<
    | { type: 'set_pan'; pan: string }
    | { type: 'set_dob'; dob: string | null }
    | { type: 'set_email'; email: string }
    | { type: 'goto'; step: OnboardingStep }
  >;
  session: ReturnType<typeof useSession>['session'];
  onContinue: () => void;
  /** PAN already saved on user_profile — when set, the field renders read-only. */
  lockedPan: string | null;
  /** DOB already saved on user_profile — when set, the field renders read-only. */
  lockedDob: string | null;
  styles: WizardStyles;
  cl: Cl;
  tokens: ClearLensTokens;
}) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // dobText is the on-screen DD-MM-YYYY string; draft.dob (and the DB) are ISO.
  const [dobText, setDobText] = useState(draft.dob ? formatDobDisplay(draft.dob) : '');
  // Mirrors the Account screen's correction flow: PAN/DOB are write-once after
  // first save, so locked-state hints expose a "Wrong? Request correction"
  // tappable that opens a pre-filled bug-report sheet. Lets the user fix a
  // typo without leaving the wizard mid-flow.
  const [correctionField, setCorrectionField] = useState<'pan' | 'dob' | null>(null);

  const panLocked = !!lockedPan;
  const dobLocked = !!lockedDob;

  const dobIso = useMemo(
    () => (dobText.length > 0 ? parseDobDisplay(dobText) : null),
    [dobText],
  );

  const panValid = panLocked || isValidPan(draft.pan);
  const dobValid =
    dobLocked || dobText.length === 0 || (dobIso !== null && isValidDob(dobIso));
  const emailValid = /\S+@\S+\.\S+/.test(draft.email);
  const canContinue = panValid && dobValid && emailValid && !saving;

  async function handleContinue() {
    if (!canContinue || !session?.user.id) return;
    setSaving(true);
    setError(null);

    const dobValue = dobLocked
      ? lockedDob
      : dobText.length > 0
        ? dobIso
        : null;
    if (!dobLocked && dobText.length > 0 && dobValue) {
      dispatch({ type: 'set_dob', dob: dobValue });
    }

    // Build the upsert payload, but never overwrite a saved-locked PAN.
    // We send the locked value back so the row's NOT-NULL constraint stays
    // happy and the upsert doesn't accidentally null out a stored value.
    const upsertPayload: {
      user_id: string;
      pan: string;
      dob: string | null;
      kfintech_email: string;
    } = {
      user_id: session.user.id,
      pan: panLocked ? lockedPan! : draft.pan,
      dob: dobValue,
      kfintech_email: draft.email,
    };

    console.log('[onboarding:identity] upsert_start', {
      pan_locked: panLocked,
      dob_locked: dobLocked,
      pan_changed: !panLocked && draft.pan.length === 10,
      dob_being_set: !dobLocked && !!dobValue,
      kfintech_email_present: !!draft.email,
    });

    const startedAt = Date.now();
    const { error: upsertError } = await supabase
      .from('user_profile')
      .upsert(upsertPayload, { onConflict: 'user_id' });
    const elapsedMs = Date.now() - startedAt;

    setSaving(false);
    if (upsertError) {
      console.warn('[onboarding:identity] upsert_failed', {
        message: upsertError.message,
        code: upsertError.code,
        details: upsertError.details,
        elapsed_ms: elapsedMs,
      });
      setError(upsertError.message || 'Could not save your details. Try again.');
      return;
    }
    console.log('[onboarding:identity] upsert_ok', { elapsed_ms: elapsedMs });
    queryClient.invalidateQueries({ queryKey: ['user-profile', session.user.id] });
    onContinue();
  }

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.stepHeader}>
        <Text style={styles.stepTitle}>Tell us who you are</Text>
        <Text style={styles.stepBody}>
          {panLocked
            ? 'These details unlock your CAS PDF and are saved permanently.'
            : 'Your PAN unlocks the CAS PDF, and is saved permanently — double-check before continuing. Date of birth is only needed if you import a CDSL or NSDL statement.'}
        </Text>
      </View>

      <View style={styles.field}>
        <View style={styles.fieldLabelRow}>
          <Text style={styles.fieldLabel}>PAN</Text>
          {panLocked ? (
            <View style={styles.savedBadge}>
              <Ionicons name="lock-closed" size={11} color={cl.emeraldDeep} />
              <Text style={styles.savedBadgeText}>Saved</Text>
            </View>
          ) : null}
        </View>
        {panLocked ? (
          <View style={styles.lockedField}>
            <Text style={styles.lockedFieldText}>{lockedPan}</Text>
          </View>
        ) : (
          <TextInput
            value={draft.pan}
            onChangeText={(value) => dispatch({ type: 'set_pan', pan: value })}
            placeholder="ABCPE1234F"
            placeholderTextColor={cl.textTertiary}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={10}
            style={styles.input}
          />
        )}
        {panLocked ? (
          <View style={styles.lockedFieldHintRow}>
            <Text style={styles.fieldHint}>PAN is saved and cannot be changed in-app.</Text>
            <Text
              style={styles.correctionLink}
              onPress={() => setCorrectionField('pan')}
            >
              Wrong PAN? Request correction
            </Text>
          </View>
        ) : draft.pan.length > 0 && !panValid ? (
          <Text style={styles.fieldError}>
            PAN should look like ABCPE1234F (5 letters, 4 digits, 1 letter).
          </Text>
        ) : (
          <Text style={styles.fieldHint}>
            10 characters. We use this to unlock CAMS / KFintech CAS PDFs.
          </Text>
        )}
      </View>

      <View style={styles.field}>
        <View style={styles.fieldLabelRow}>
          <Text style={styles.fieldLabel}>Date of birth (optional)</Text>
          {dobLocked ? (
            <View style={styles.savedBadge}>
              <Ionicons name="lock-closed" size={11} color={cl.emeraldDeep} />
              <Text style={styles.savedBadgeText}>Saved</Text>
            </View>
          ) : null}
        </View>
        {dobLocked ? (
          <View style={styles.lockedField}>
            <Text style={styles.lockedFieldText}>{formatDobDisplay(lockedDob!)}</Text>
          </View>
        ) : (
          <TextInput
            value={dobText}
            onChangeText={(value) => {
              const masked = maskDobInput(value);
              setDobText(masked);
              if (masked.length === 0) {
                dispatch({ type: 'set_dob', dob: null });
              } else {
                const iso = parseDobDisplay(masked);
                if (iso && isValidDob(iso)) {
                  dispatch({ type: 'set_dob', dob: iso });
                }
              }
            }}
            placeholder="DD-MM-YYYY"
            placeholderTextColor={cl.textTertiary}
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={10}
            autoCorrect={false}
            autoCapitalize="none"
            style={styles.input}
          />
        )}
        {dobLocked ? (
          <View style={styles.lockedFieldHintRow}>
            <Text style={styles.fieldHint}>Date of birth is saved and cannot be changed in-app.</Text>
            <Text
              style={styles.correctionLink}
              onPress={() => setCorrectionField('dob')}
            >
              Wrong date? Request correction
            </Text>
          </View>
        ) : dobText.length > 0 && !dobValid ? (
          <Text style={styles.fieldError}>Use DD-MM-YYYY format, e.g. 12-05-1990.</Text>
        ) : (
          <Text style={styles.fieldHint}>Required only for CDSL / NSDL CAS PDFs.</Text>
        )}
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Email</Text>
        <TextInput
          value={draft.email}
          onChangeText={(value) => dispatch({ type: 'set_email', email: value })}
          placeholder="you@example.com"
          placeholderTextColor={cl.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          style={styles.input}
        />
        <Text style={styles.fieldHint}>
          We&apos;ll send your CAS reminders here. Pre-filled from your sign-in.
        </Text>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Ionicons
            name="warning-outline"
            size={16}
            color={tokens.semantic.sentiment.negativeText}
          />
          <Text style={styles.errorBoxText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.footerSpace} />
      <PrimaryButton
        label={saving ? 'Saving…' : 'Continue'}
        onPress={handleContinue}
        disabled={!canContinue}
        loading={saving}
        styles={styles}
        cl={cl}
      />

      <FeedbackSheet
        visible={correctionField !== null}
        kind={correctionField !== null ? ('bug_report' as FeedbackKind) : null}
        onClose={() => setCorrectionField(null)}
        initialTitle={
          correctionField === 'pan'
            ? `Correct my PAN (currently ${lockedPan ? maskPanForCorrection(lockedPan) : 'set'})`
            : correctionField === 'dob'
              ? `Correct my date of birth (currently ${lockedDob ? formatDobDisplay(lockedDob) : 'set'})`
              : ''
        }
        initialBody={
          correctionField === 'pan'
            ? `My current saved PAN is ${lockedPan ? maskPanForCorrection(lockedPan) : '—'}. The correct PAN is:\n\n[enter correct PAN]\n\nReason: `
            : correctionField === 'dob'
              ? `My current saved date of birth is ${lockedDob ? formatDobDisplay(lockedDob) : '—'}. The correct date of birth (DD-MM-YYYY) is:\n\n[enter correct DOB]\n\nReason: `
              : ''
        }
      />
    </ScrollView>
  );
}

function maskPanForCorrection(pan: string): string {
  if (pan.length !== 10) return pan;
  return pan.slice(0, 2) + '•'.repeat(6) + pan.slice(8);
}

type ImportSubScreen = 'choose' | 'request' | 'autoRefresh';
type HoldingMode = 'soa' | 'demat' | 'unsure';
type RequestKind = 'rta' | 'depository';

function ImportStep({
  draft,
  dispatch,
  onSkip,
  inboxToken,
  pendingConfirmationUrl,
  autoForwardCompletedAt,
  onConfirmClicked,
  onAutoForwardCompleted,
  styles,
  cl,
  tokens,
}: {
  draft: OnboardingDraft;
  dispatch: React.Dispatch<
    | { type: 'import_complete'; funds: number; transactions: number }
    | { type: 'goto'; step: OnboardingStep }
  >;
  onSkip: () => void;
  /** User's stable inbox token. Null while user_profile is still loading. */
  inboxToken: string | null;
  /** Captured by Edge Function when Gmail emails the verification link. */
  pendingConfirmationUrl: string | null;
  /** Set once the user confirms the advanced auto-forward setup is complete. */
  autoForwardCompletedAt: string | null;
  /** Called after the user clicks the Gmail confirm CTA so the parent can refetch. */
  onConfirmClicked: () => void;
  /** Called when the user marks the provider-side auto-forward setup complete. */
  onAutoForwardCompleted: () => Promise<void>;
  styles: WizardStyles;
  cl: Cl;
  tokens: ClearLensTokens;
}) {
  const [sub, setSub] = useState<ImportSubScreen>('choose');
  const [holdingMode, setHoldingMode] = useState<HoldingMode>('unsure');
  const [requestKind, setRequestKind] = useState<RequestKind>('rta');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The `error` state is shared between sub-screens. Clear it on every sub
  // transition so an error from one path (e.g. Upload's parser failure)
  // doesn't leak into the next one (e.g. the "Get a fresh CAS" portal list).
  useEffect(() => {
    setError(null);
  }, [sub]);

  const [browserVisited, setBrowserVisited] = useState(false);
  const appState = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (appState.current === 'background' && next === 'active' && browserVisited) {
        console.log('[onboarding:portal] returned_to_foreground_after_browser');
      }
      appState.current = next;
    });
    return () => subscription.remove();
  }, [browserVisited]);

  async function handleUpload() {
    setError(null);
    let picked: DocumentPicker.DocumentPickerResult;
    try {
      picked = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
        base64: false,
      });
    } catch (pickerErr) {
      console.warn('[onboarding:upload] picker_threw', {
        message: pickerErr instanceof Error ? pickerErr.message : String(pickerErr),
      });
      return;
    }
    if (picked.canceled || !picked.assets?.[0]) {
      console.log('[onboarding:upload] picker_cancelled', { canceled: picked.canceled });
      return;
    }

    const asset = picked.assets[0];
    console.log('[onboarding:upload] start', {
      platform: Platform.OS,
      file_name: asset.name,
      size_bytes: asset.size ?? null,
      mime: asset.mimeType ?? null,
      sub: sub,
    });

    setUploading(true);
    const startedAt = Date.now();
    try {
      const result = await uploadCasPdf(asset);
      const elapsed = Date.now() - startedAt;
      console.log('[onboarding:upload] success', {
        funds: result.funds,
        transactions: result.transactions,
        elapsed_ms: elapsed,
      });
      dispatch({
        type: 'import_complete',
        funds: result.funds,
        transactions: result.transactions,
      });
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      const msg = err instanceof Error ? err.message : 'Upload failed.';
      console.warn('[onboarding:upload] failed', {
        message: msg,
        elapsed_ms: elapsed,
        likely_read_error: /read/i.test(msg),
      });
      setError(
        /read/i.test(msg)
          ? 'Could not read the PDF file. Re-download and try again.'
          : msg,
      );
    } finally {
      setUploading(false);
    }
  }

  async function handleOpenPortal(url: string) {
    const portalId =
      [...PORTAL_OPTIONS, ...DEPOSITORY_OPTIONS].find((p) => p.url === url)?.id ?? 'unknown';
    console.log('[onboarding:portal] open', {
      portal_id: portalId,
      platform: Platform.OS,
      mode: Platform.OS === 'web' ? 'new_tab' : 'in_app_browser',
    });
    try {
      setBrowserVisited(true);
      if (Platform.OS === 'web') {
        await Linking.openURL(url);
      } else {
        await WebBrowser.openBrowserAsync(url, {
          presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        });
      }
    } catch (err) {
      console.warn('[onboarding:portal] open_failed', {
        portal_id: portalId,
        message: err instanceof Error ? err.message : String(err),
      });
      Alert.alert('Could not open portal', err instanceof Error ? err.message : 'Try again.');
    }
  }

  function openRequest(kind: RequestKind) {
    setRequestKind(kind);
    setSub('request');
  }

  if (sub === 'request') {
    const portalOptions = requestKind === 'depository' ? DEPOSITORY_OPTIONS : PORTAL_OPTIONS;
    const requestTitle =
      requestKind === 'depository' ? 'Get a depository CAS' : 'Get a fresh CAS';
    const requestBody =
      requestKind === 'depository'
        ? 'Use this if your mutual fund units are held in demat form through a broker. Download a Detailed CAS PDF, then upload it here.'
        : 'Either portal returns the same combined CAS for folio / SOA mutual fund holdings — pick one, fill the form, and the statement lands in your email in 1–2 minutes.';
    return (
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.stepHeader}>
          <Pressable onPress={() => setSub('choose')} style={styles.miniBack} hitSlop={6}>
            <Ionicons name="chevron-back" size={18} color={cl.emeraldDeep} />
            <Text style={styles.miniBackText}>Import options</Text>
          </Pressable>
          <Text style={styles.stepTitle}>{requestTitle}</Text>
          <Text style={styles.stepBody}>{requestBody}</Text>
        </View>

        <View style={styles.calloutCard}>
          <Ionicons name="time-outline" size={18} color={cl.emeraldDeep} />
          <Text style={styles.calloutText}>
            <Text style={styles.bold}>Download a Detailed CAS, not a holdings summary.</Text>{' '}
            Pick a date range that starts before your first ever mutual-fund
            purchase (when in doubt, use <Text style={styles.bold}>01/01/2000</Text>)
            and ends today. Holdings-only statements cannot build Money Trail or
            XIRR because they do not contain transaction history.
          </Text>
        </View>

        {portalOptions.map((portal) => (
          <Pressable
            key={portal.id}
            onPress={() => handleOpenPortal(portal.url)}
            style={({ pressed }) => [styles.portalCard, pressed && styles.portalCardPressed]}
          >
            <View style={styles.portalIcon}>
              <Ionicons name="open-outline" size={22} color={cl.emeraldDeep} />
            </View>
            <View style={styles.portalCopy}>
              <View style={styles.portalNameRow}>
                <Text style={styles.portalName}>{portal.name}</Text>
                {portal.recommended ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>RECOMMENDED</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.portalDescription}>{portal.description}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={cl.textTertiary} />
          </Pressable>
        ))}

        <View style={styles.tipsCard}>
          <Text style={styles.tipsHeading}>Once you have the email</Text>
          <Text style={styles.tipsLine}>1. Open the email or download page on this device.</Text>
          <Text style={styles.tipsLine}>2. Save the PDF (long-press → Save to Files / Downloads).</Text>
          <Text style={styles.tipsLine}>3. Come back to FolioLens and tap Upload below.</Text>
          {requestKind === 'depository' ? (
            <Text style={styles.tipsLine}>
              4. If prompted, the password is your PAN or PAN + date of birth;
              FolioLens tries both from your profile.
            </Text>
          ) : null}
        </View>

        {(browserVisited || Platform.OS === 'web') ? (
          <View style={styles.banner}>
            <Ionicons name="checkmark-circle" size={18} color={cl.emeraldDeep} />
            <Text style={styles.bannerText}>Got the email? Upload your CAS now.</Text>
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorBox}>
            <Ionicons
              name="warning-outline"
              size={16}
              color={tokens.semantic.sentiment.negativeText}
            />
            <Text style={styles.errorBoxText}>{error}</Text>
          </View>
        ) : null}

        <View style={styles.footerSpace} />

        <PrimaryButton
          label={uploading ? 'Importing…' : 'Upload the PDF'}
          onPress={handleUpload}
          loading={uploading}
          disabled={uploading}
          styles={styles}
          cl={cl}
        />
        <SecondaryButton label="I'll do this later" onPress={onSkip} styles={styles} />
      </ScrollView>
    );
  }

  if (sub === 'autoRefresh' && inboxToken) {
    return (
      <View style={styles.flex}>
        <View style={styles.subBackBar}>
          <Pressable onPress={() => setSub('choose')} style={styles.miniBack} hitSlop={6}>
            <Ionicons name="chevron-back" size={18} color={cl.emeraldDeep} />
            <Text style={styles.miniBackText}>Import options</Text>
          </Pressable>
        </View>
        <AutoRefreshSetup
          inboxToken={inboxToken}
          pendingConfirmationUrl={pendingConfirmationUrl}
          autoForwardCompletedAt={autoForwardCompletedAt}
          onConfirmClicked={onConfirmClicked}
          onAutoForwardCompleted={onAutoForwardCompleted}
          onContinue={() => dispatch({ type: 'goto', step: 'done' })}
        />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={styles.stepHeader}>
        <Text style={styles.stepTitle}>How would you like to start?</Text>
        <Text style={styles.stepBody}>
          First choose where your mutual fund units are held. This decides
          whether CAMS / KFintech or CDSL / NSDL is the right source.
        </Text>
      </View>

      <HoldingModeSelector
        value={holdingMode}
        onChange={setHoldingMode}
        styles={styles}
        cl={cl}
      />

      {holdingMode === 'demat' ? (
        <View style={styles.modeCallout}>
          <Ionicons name="business-outline" size={18} color={cl.emeraldDeep} />
          <Text style={styles.modeCalloutText}>
            For demat or broker-held units, use a{' '}
            <Text style={styles.bold}>CDSL / NSDL Detailed CAS</Text>. CAMS and
            KFintech RTA statements may not include those demat holdings.
          </Text>
        </View>
      ) : holdingMode === 'soa' ? (
        <View style={styles.modeCallout}>
          <Ionicons name="document-text-outline" size={18} color={cl.emeraldDeep} />
          <Text style={styles.modeCalloutText}>
            For AMC / folio / SOA holdings, CAMS or KFintech CAS is the fastest
            path. Auto-refresh can watch future CAMS / KFintech CAS emails.
          </Text>
        </View>
      ) : (
        <View style={styles.modeCallout}>
          <Ionicons name="help-circle-outline" size={18} color={cl.emeraldDeep} />
          <Text style={styles.modeCalloutText}>
            Not sure? If you invest through a broker or demat account, start
            with CDSL / NSDL. If you invest directly with an AMC, start with
            CAMS / KFintech.
          </Text>
        </View>
      )}

      <ChoiceCard
        title={
          holdingMode === 'demat'
            ? 'Upload CDSL / NSDL CAS PDF'
            : 'Upload a CAS PDF'
        }
        description={
          holdingMode === 'demat'
            ? 'Use a Detailed CAS from your depository. We ignore equity sections and import only mutual funds.'
            : 'Got one already? Upload it now and we will do the rest.'
        }
        icon="cloud-upload-outline"
        recommended
        onPress={handleUpload}
        styles={styles}
        cl={cl}
      />
      <ChoiceCard
        title={holdingMode === 'demat' ? 'Get CDSL / NSDL CAS' : 'Get CAMS / KFintech CAS'}
        description={
          holdingMode === 'demat'
            ? 'For demat holdings. Download a Detailed CAS from your depository, then upload it.'
            : 'For folio / SOA holdings. Takes about 2 minutes and arrives by email.'
        }
        icon={holdingMode === 'demat' ? 'business-outline' : 'paper-plane-outline'}
        onPress={() => openRequest(holdingMode === 'demat' ? 'depository' : 'rta')}
        styles={styles}
        cl={cl}
      />
      {holdingMode === 'unsure' ? (
        <ChoiceCard
          title="Try CDSL / NSDL instead"
          description="Use this if your broker or demat account holds the mutual fund units."
          icon="business-outline"
          onPress={() => openRequest('depository')}
          styles={styles}
          cl={cl}
        />
      ) : null}
      {inboxToken ? (
        holdingMode === 'demat' ? (
          <View style={styles.modeCallout}>
            <Ionicons name="mail-unread-outline" size={18} color={cl.emeraldDeep} />
            <Text style={styles.modeCalloutText}>
              Auto-refresh is currently tuned for CAMS / KFintech CAS emails.
              For demat holdings, upload a CDSL / NSDL Detailed CAS when you
              want to refresh.
            </Text>
          </View>
        ) : (
          <ChoiceCard
            title="Set up auto-refresh (advanced)"
            description={
              pendingConfirmationUrl
                ? 'Confirm Gmail forwarding — we captured your verification link.'
                : 'Forward future CAMS / KFintech CAS emails and your portfolio updates itself.'
            }
            icon="mail-unread-outline"
            onPress={() => setSub('autoRefresh')}
            styles={styles}
            cl={cl}
          />
        )
      ) : null}

      {uploading ? (
        <View style={styles.uploadingRow}>
          <ActivityIndicator color={cl.emeraldDeep} />
          <Text style={styles.uploadingText}>Importing your CAS…</Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBox}>
          <Ionicons
            name="warning-outline"
            size={16}
            color={tokens.semantic.sentiment.negativeText}
          />
          <Text style={styles.errorBoxText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.footerSpace} />
      <SecondaryButton label="I'll do this later" onPress={onSkip} styles={styles} />
      {/* Reference draft to keep the prop in the API for future steps. */}
      <View style={{ display: 'none' }}>{draft.pan ? null : null}</View>
    </ScrollView>
  );
}

function DoneStep({
  draft,
  onFinish,
  hasInboxToken,
  autoForwardCompletedAt,
  styles,
  cl,
}: {
  draft: OnboardingDraft;
  onFinish: () => void;
  /** True if the user has a cas_inbox_token, i.e. the auto-refresh nudge is meaningful. */
  hasInboxToken: boolean;
  /** Set once the user confirms provider-side auto-forward setup is complete. */
  autoForwardCompletedAt: string | null;
  styles: WizardStyles;
  cl: Cl;
}) {
  const result = draft.importResult;
  const imported = !!result;
  const autoRefreshReady = !!autoForwardCompletedAt;
  const doneTitle = imported
    ? 'Your portfolio is ready'
    : autoRefreshReady
      ? 'Auto-refresh is ready'
      : "We'll be here when you're ready";

  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={styles.successHero}>
        <View style={[styles.successIcon, !imported && !autoRefreshReady && styles.successIconMuted]}>
          <Ionicons
            name={imported || autoRefreshReady ? 'checkmark-circle' : 'time-outline'}
            size={56}
            color={imported || autoRefreshReady ? cl.emeraldDeep : cl.textSecondary}
          />
        </View>
        <Text style={styles.stepTitle}>{doneTitle}</Text>
        {imported ? (
          <Text style={styles.stepBody}>
            Imported{' '}
            <Text style={styles.bold}>
              {result!.funds} fund{result!.funds === 1 ? '' : 's'}
            </Text>{' '}
            and{' '}
            <Text style={styles.bold}>
              {result!.transactions} transaction{result!.transactions === 1 ? '' : 's'}
            </Text>
            . XIRR, sector exposure, and Money Trail are calculating now.
          </Text>
        ) : autoRefreshReady ? (
          <Text style={styles.stepBody}>
            FolioLens will import the next forwarded CAMS or KFintech CAS
            automatically. To see your portfolio now, manually forward your
            latest CAS email to the same private address.
          </Text>
        ) : (
          <Text style={styles.stepBody}>
            No CAS imported yet — your home screen will be empty until you upload one.
            Come back anytime via{' '}
            <Text style={styles.bold}>Settings → Portfolio import</Text>.
          </Text>
        )}
      </View>

      {hasInboxToken && !autoRefreshReady ? (
        <View style={styles.nudgeCard}>
          <View style={styles.nudgeIconWrap}>
            <Ionicons name="mail-unread-outline" size={20} color={cl.emeraldDeep} />
          </View>
          <View style={styles.nudgeBody}>
            <Text style={styles.nudgeTitle}>Never re-upload again</Text>
            <Text style={styles.nudgeText}>
              Forward future CAS emails to your FolioLens import inbox and the
              portfolio updates automatically. Set it up from Settings → Account →
              Auto-refresh inbox.
            </Text>
          </View>
        </View>
      ) : null}

      <View style={styles.tipsCard}>
        <Text style={styles.tipsHeading}>
          {imported || autoRefreshReady ? "What's next" : 'When you have a CAS'}
        </Text>
        {imported ? (
          <>
            <Text style={styles.tipsLine}>• Glance at the home screen for your XIRR vs Nifty 50.</Text>
            <Text style={styles.tipsLine}>• Open Money Trail to inspect every transaction.</Text>
            <Text style={styles.tipsLine}>
              • {autoRefreshReady
                ? 'Future CAS emails should import automatically.'
                : 'Set up auto-refresh later to never re-upload.'}
            </Text>
          </>
        ) : autoRefreshReady ? (
          <>
            <Text style={styles.tipsLine}>• Keep the Gmail filter enabled for CAMS / KFintech CAS emails.</Text>
            <Text style={styles.tipsLine}>• Forward your latest CAS manually if you want data immediately.</Text>
            <Text style={styles.tipsLine}>• If a monthly CAS does not appear, upload the PDF from Settings.</Text>
          </>
        ) : (
          <>
            <Text style={styles.tipsLine}>• Request one from CAMS Online or KFintech (no login needed).</Text>
            <Text style={styles.tipsLine}>• Save the PDF the RTA emails you to this device.</Text>
            <Text style={styles.tipsLine}>• Reopen the wizard and tap Upload a CAS PDF.</Text>
          </>
        )}
      </View>

      <View style={styles.footerSpace} />
      <PrimaryButton
        label={imported ? 'Open my portfolio' : 'Open FolioLens'}
        onPress={onFinish}
        styles={styles}
        cl={cl}
      />
    </ScrollView>
  );
}

function Bullet({
  icon,
  text,
  styles,
  cl,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
  styles: WizardStyles;
  cl: Cl;
}) {
  return (
    <View style={styles.bulletRow}>
      <View style={styles.bulletIconWrap}>
        <Ionicons name={icon} size={16} color={cl.emeraldDeep} />
      </View>
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

function HoldingModeSelector({
  value,
  onChange,
  styles,
  cl,
}: {
  value: HoldingMode;
  onChange: (value: HoldingMode) => void;
  styles: WizardStyles;
  cl: Cl;
}) {
  return (
    <View style={styles.modeCard}>
      <Text style={styles.modeLabel}>Holding mode</Text>
      <Text style={styles.modeTitle}>Where do you hold these mutual funds?</Text>
      <View style={styles.modeGrid}>
        <HoldingModeButton
          value="soa"
          selected={value === 'soa'}
          title="AMC / folio"
          detail="CAMS, KFintech, MFCentral"
          icon="document-text-outline"
          onPress={onChange}
          styles={styles}
          cl={cl}
        />
        <HoldingModeButton
          value="demat"
          selected={value === 'demat'}
          title="Demat / broker"
          detail="CDSL or NSDL"
          icon="business-outline"
          onPress={onChange}
          styles={styles}
          cl={cl}
        />
        <HoldingModeButton
          value="unsure"
          selected={value === 'unsure'}
          title="Not sure"
          detail="Show both paths"
          icon="help-circle-outline"
          onPress={onChange}
          styles={styles}
          cl={cl}
        />
      </View>
    </View>
  );
}

function HoldingModeButton({
  value,
  selected,
  title,
  detail,
  icon,
  onPress,
  styles,
  cl,
}: {
  value: HoldingMode;
  selected: boolean;
  title: string;
  detail: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: (value: HoldingMode) => void;
  styles: WizardStyles;
  cl: Cl;
}) {
  return (
    <Pressable
      onPress={() => onPress(value)}
      style={[styles.modeOption, selected && styles.modeOptionSelected]}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
    >
      <Ionicons
        name={icon}
        size={18}
        color={selected ? cl.emeraldDeep : cl.textSecondary}
      />
      <Text style={[styles.modeOptionTitle, selected && styles.modeOptionTitleSelected]}>
        {title}
      </Text>
      <Text style={styles.modeOptionDetail}>{detail}</Text>
    </Pressable>
  );
}

function ChoiceCard({
  title,
  description,
  icon,
  recommended,
  onPress,
  styles,
  cl,
}: {
  title: string;
  description: string;
  icon: keyof typeof Ionicons.glyphMap;
  recommended?: boolean;
  onPress: () => void;
  styles: WizardStyles;
  cl: Cl;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.choiceCard, pressed && styles.choiceCardPressed]}
    >
      <View style={styles.choiceIconWrap}>
        <Ionicons name={icon} size={24} color={cl.emeraldDeep} />
      </View>
      <View style={styles.choiceCopy}>
        <View style={styles.portalNameRow}>
          <Text style={styles.choiceTitle}>{title}</Text>
          {recommended ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>RECOMMENDED</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.choiceDescription}>{description}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={cl.textTertiary} />
    </Pressable>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
  loading,
  styles,
  cl,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  styles: WizardStyles;
  cl: Cl;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[styles.primaryButton, disabled && styles.primaryButtonDisabled]}
      activeOpacity={0.82}
    >
      {loading ? (
        <ActivityIndicator color={cl.textOnDark} />
      ) : (
        <Text style={styles.primaryButtonText}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}

function SecondaryButton({
  label,
  onPress,
  styles,
}: {
  label: string;
  onPress: () => void;
  styles: WizardStyles;
}) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.secondaryButton} activeOpacity={0.76}>
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    flex: { flex: 1 },
    screen: {
      flex: 1,
      backgroundColor: cl.background,
    },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: ClearLensSpacing.sm,
    },
    iconButton: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pillsRow: {
      flex: 1,
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: ClearLensSpacing.md,
    },
    pill: {
      flex: 1,
      height: 4,
      borderRadius: 2,
    },
    pillActive: {
      backgroundColor: cl.emeraldDeep,
    },
    pillInactive: {
      backgroundColor: cl.borderLight,
    },
    scroll: {
      paddingHorizontal: ClearLensSpacing.md,
      paddingBottom: ClearLensSpacing.xxl,
      gap: ClearLensSpacing.md,
    },
    hero: {
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.lg,
      gap: ClearLensSpacing.md,
      overflow: 'hidden',
    },
    heroHeadline: {
      ...ClearLensTypography.h1,
      color: cl.textOnDark,
      lineHeight: 32,
    },
    heroSubhead: {
      ...ClearLensTypography.body,
      color: cl.textOnDark,
      opacity: 0.84,
    },
    bullets: {
      gap: ClearLensSpacing.sm,
    },
    bulletRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      paddingHorizontal: ClearLensSpacing.sm,
    },
    bulletIconWrap: {
      width: 32,
      height: 32,
      borderRadius: ClearLensRadii.full,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: cl.mint50,
    },
    bulletText: {
      ...ClearLensTypography.bodySmall,
      flex: 1,
      color: cl.navy,
      fontFamily: ClearLensFonts.semiBold,
    },
    privacyCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.mint50,
    },
    privacyText: {
      ...ClearLensTypography.caption,
      flex: 1,
      color: cl.emeraldDeep,
      fontFamily: ClearLensFonts.semiBold,
    },
    stepHeader: {
      gap: 6,
      paddingTop: ClearLensSpacing.sm,
    },
    subBackBar: {
      paddingHorizontal: ClearLensSpacing.md,
      paddingTop: ClearLensSpacing.sm,
      paddingBottom: ClearLensSpacing.xs,
    },
    miniBack: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginBottom: 4,
    },
    miniBackText: {
      ...ClearLensTypography.caption,
      color: cl.emeraldDeep,
      fontFamily: ClearLensFonts.bold,
    },
    stepTitle: {
      ...ClearLensTypography.h1,
      color: cl.navy,
    },
    stepBody: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
    },
    field: {
      gap: 6,
    },
    fieldLabelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
    },
    fieldLabel: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      fontFamily: ClearLensFonts.bold,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    fieldHint: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
    },
    lockedFieldHintRow: {
      gap: 4,
    },
    correctionLink: {
      ...ClearLensTypography.caption,
      fontFamily: ClearLensFonts.semiBold,
      color: cl.emeraldDeep,
    },
    savedBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: ClearLensRadii.sm,
      backgroundColor: cl.mint50,
    },
    savedBadgeText: {
      ...ClearLensTypography.caption,
      fontSize: 9,
      color: cl.emeraldDeep,
      fontFamily: ClearLensFonts.bold,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
    },
    lockedField: {
      minHeight: 50,
      paddingHorizontal: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.md,
      borderWidth: 1,
      borderColor: cl.border,
      backgroundColor: cl.surfaceSoft,
      justifyContent: 'center',
    },
    lockedFieldText: {
      ...ClearLensTypography.body,
      color: cl.navy,
      fontFamily: ClearLensFonts.semiBold,
      letterSpacing: 1,
    },
    fieldError: {
      ...ClearLensTypography.caption,
      color: tokens.semantic.sentiment.negativeText,
    },
    input: {
      ...ClearLensTypography.body,
      minHeight: 50,
      paddingHorizontal: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.md,
      borderWidth: 1,
      borderColor: cl.border,
      backgroundColor: cl.surface,
      color: cl.navy,
    },
    errorBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      padding: ClearLensSpacing.sm,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.negativeBg,
    },
    errorBoxText: {
      ...ClearLensTypography.caption,
      flex: 1,
      color: tokens.semantic.sentiment.negativeText,
    },
    modeCard: {
      gap: ClearLensSpacing.sm,
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.lg,
      backgroundColor: cl.surface,
      borderWidth: 1,
      borderColor: cl.border,
      ...ClearLensShadow,
    },
    modeLabel: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      fontFamily: ClearLensFonts.bold,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    modeTitle: {
      ...ClearLensTypography.body,
      color: cl.navy,
      fontFamily: ClearLensFonts.bold,
    },
    modeGrid: {
      flexDirection: 'row',
      gap: ClearLensSpacing.sm,
      flexWrap: 'wrap',
    },
    modeOption: {
      flexGrow: 1,
      flexBasis: 150,
      gap: 4,
      padding: ClearLensSpacing.sm,
      borderRadius: ClearLensRadii.md,
      borderWidth: 1,
      borderColor: cl.border,
      backgroundColor: cl.surfaceSoft,
    },
    modeOptionSelected: {
      borderColor: cl.mint,
      backgroundColor: cl.positiveBg,
    },
    modeOptionTitle: {
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
      fontFamily: ClearLensFonts.bold,
    },
    modeOptionTitleSelected: {
      color: cl.emeraldDeep,
    },
    modeOptionDetail: {
      ...ClearLensTypography.caption,
      color: cl.textSecondary,
    },
    modeCallout: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: ClearLensSpacing.sm,
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.mint50,
    },
    modeCalloutText: {
      ...ClearLensTypography.bodySmall,
      flex: 1,
      color: cl.textSecondary,
      lineHeight: 20,
    },
    choiceCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.md,
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.lg,
      backgroundColor: cl.surface,
      borderWidth: 1,
      borderColor: cl.border,
      ...ClearLensShadow,
    },
    choiceCardPressed: {
      backgroundColor: cl.surfaceSoft,
    },
    choiceIconWrap: {
      width: 44,
      height: 44,
      borderRadius: ClearLensRadii.md,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: cl.mint50,
    },
    choiceCopy: {
      flex: 1,
      gap: 4,
    },
    choiceTitle: {
      ...ClearLensTypography.body,
      color: cl.navy,
      fontFamily: ClearLensFonts.bold,
    },
    choiceDescription: {
      ...ClearLensTypography.caption,
      color: cl.textSecondary,
    },
    portalNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
    },
    portalCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.md,
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.surface,
      borderWidth: 1,
      borderColor: cl.border,
    },
    portalCardPressed: {
      backgroundColor: cl.surfaceSoft,
    },
    portalIcon: {
      width: 40,
      height: 40,
      borderRadius: ClearLensRadii.md,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: cl.mint50,
    },
    portalCopy: {
      flex: 1,
      gap: 2,
    },
    portalName: {
      ...ClearLensTypography.body,
      color: cl.navy,
      fontFamily: ClearLensFonts.bold,
    },
    portalDescription: {
      ...ClearLensTypography.caption,
      color: cl.textSecondary,
    },
    badge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: ClearLensRadii.sm,
      backgroundColor: cl.mint50,
    },
    badgeText: {
      ...ClearLensTypography.caption,
      fontSize: 9,
      color: cl.emeraldDeep,
      fontFamily: ClearLensFonts.bold,
      letterSpacing: 0.4,
    },
    calloutCard: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: ClearLensSpacing.sm,
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.lg,
      backgroundColor: cl.positiveBg,
      borderWidth: 1,
      borderColor: cl.mint,
    },
    calloutText: {
      flex: 1,
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
      lineHeight: 18,
    },
    nudgeCard: {
      flexDirection: 'row',
      gap: ClearLensSpacing.sm,
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.lg,
      backgroundColor: cl.positiveBg,
      borderWidth: 1,
      borderColor: cl.mint,
    },
    nudgeIconWrap: {
      width: 28,
      height: 28,
      alignItems: 'center',
      justifyContent: 'center',
    },
    nudgeBody: {
      flex: 1,
      gap: 4,
    },
    nudgeTitle: {
      ...ClearLensTypography.body,
      color: cl.navy,
      fontFamily: ClearLensFonts.bold,
    },
    nudgeText: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
      lineHeight: 18,
    },
    tipsCard: {
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.surfaceSoft,
      gap: 4,
    },
    tipsHeading: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      fontFamily: ClearLensFonts.bold,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    tipsLine: {
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
    },
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.mint50,
    },
    bannerText: {
      ...ClearLensTypography.bodySmall,
      flex: 1,
      color: cl.emeraldDeep,
      fontFamily: ClearLensFonts.bold,
    },
    uploadingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.surfaceSoft,
    },
    uploadingText: {
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
      fontFamily: ClearLensFonts.semiBold,
    },
    successHero: {
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      paddingTop: ClearLensSpacing.lg,
    },
    successIcon: {
      width: 84,
      height: 84,
      borderRadius: ClearLensRadii.full,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: cl.mint50,
    },
    successIconMuted: {
      backgroundColor: cl.surfaceSoft,
    },
    bold: {
      fontFamily: ClearLensFonts.bold,
      color: cl.navy,
    },
    footerSpace: {
      height: ClearLensSpacing.md,
    },
    primaryButton: {
      minHeight: 52,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.emeraldDeep,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryButtonDisabled: {
      opacity: 0.5,
    },
    primaryButtonText: {
      ...ClearLensTypography.body,
      color: cl.textOnDark,
      fontFamily: ClearLensFonts.bold,
    },
    secondaryButton: {
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: ClearLensSpacing.sm,
    },
    secondaryButtonText: {
      ...ClearLensTypography.bodySmall,
      color: cl.textTertiary,
      fontFamily: ClearLensFonts.semiBold,
    },
  });
}
