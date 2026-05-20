import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as WebBrowser from 'expo-web-browser';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { userProfileRepo } from '@/src/lib/data/userProfile';
import { useSession } from '@/src/hooks/useSession';
import { useUserProfile, userProfileQueryKey } from '@/src/hooks/useUserProfile';
import { FolioLensLogo } from '@/src/components/clearLens/FolioLensLogo';
import { PortfolioDisclaimer } from '@/src/components/clearLens/PortfolioDisclaimer';
import { DesktopFormFrame } from '@/src/components/responsive';
import { AutoRefreshSetup } from '@/src/components/onboarding/AutoRefreshSetup';
import { FeedbackSheet, type FeedbackKind } from '@/src/components/FeedbackSheet';
import { useAlertDialog } from '@/src/hooks/useDialog';
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
import {
  isOnboardingMode,
  pickOnboardingInitialStep,
  type OnboardingMode,
} from '@/src/utils/onboardingInitialStep';
import { fetchPortfolioData, usePortfolio, type FundCardData } from '@/src/hooks/usePortfolio';
import { useAppStore } from '@/src/store/appStore';
import { analytics } from '@/src/lib/analytics';

type WizardStyles = ReturnType<typeof makeStyles>;
type Cl = ClearLensTokens['colors'];

const STEP_ORDER: OnboardingStep[] = ['welcome', 'identity', 'import', 'done'];

// The user-facing tiles on A2 ("Which apps do you use?") map to one of two
// statement sources. The wireframes hide the acronyms — the user picks an
// app family, and the wizard quietly routes them to CDSL/NSDL (demat) or
// CAMS/KFintech (non-demat) portals.
type AppFamily = 'demat' | 'nonDemat' | 'both';

interface AppTileOption {
  id: AppFamily;
  title: string;
  detail: string;
  /** Plain-language description of where the user's money sits. Shown in the
   *  soft callout below the tiles so the user understands what we inferred. */
  inferred: string;
}

const APP_TILES: AppTileOption[] = [
  {
    id: 'demat',
    title: 'Zerodha, Angel One, ICICI Direct, HDFC Sec…',
    detail: 'Apps where you also buy stocks',
    inferred: 'a demat account',
  },
  {
    id: 'nonDemat',
    title: 'Groww, Kuvera, INDmoney, or fund house apps',
    detail: 'Mutual funds only — no stock account',
    inferred: 'a folio / SOA account',
  },
  {
    id: 'both',
    title: 'A bit of both',
    detail: "We'll help you get both statements",
    inferred: 'a mix — we’ll show you both forms',
  },
];

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

async function markAutoForwardSetupComplete(userId: string): Promise<void> {
  const { error } = await userProfileRepo
    .from()
    .update({
      cas_auto_forward_setup_completed_at: new Date().toISOString(),
      cas_inbox_confirmation_url: null,
    })
    .eq('user_id', userId);
  if (error) throw error;
}

// Maps an upload error message to one of four broad categories that funnel
// dashboards can group by. The strings here are stable analytic dimensions —
// changing them invalidates historical PostHog filters, so add new buckets
// rather than rewording existing ones.
type UploadErrorKind = 'read_error' | 'auth_error' | 'network_error' | 'parser_error';

function categorizeUploadError(message: string): UploadErrorKind {
  if (/read|empty|not available/i.test(message)) return 'read_error';
  if (/session|sign in|auth/i.test(message)) return 'auth_error';
  if (/reach|network|fetch/i.test(message)) return 'network_error';
  return 'parser_error';
}

function OnboardingWizard() {
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const requestedMode: OnboardingMode | null = isOnboardingMode(params.mode) ? params.mode : null;
  const { session } = useSession();
  const queryClient = useQueryClient();
  const tokens = useClearLensTokens();
  const cl = tokens.colors;
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const [draft, dispatch] = useReducer(reduceOnboarding, EMPTY_DRAFT);
  const [hydrated, setHydrated] = useState(false);

  // The asset the user picked on Welcome. Held in memory only (not persisted
  // to AsyncStorage) — file URIs can be invalidated by the OS between app
  // launches. When the wizard advances Welcome → Identity, this is what
  // gets uploaded after the user enters their PAN.
  const [pickedAsset, setPickedAsset] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  // Custom PDF password — set from the "My PDF uses a different password"
  // reveal on Identity. Defaults to empty string; the upload helper falls back
  // to the server's PAN + DOB derivation when omitted.
  const [customPassword, setCustomPassword] = useState('');
  const [useCustomPassword, setUseCustomPassword] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Pull saved PAN / DOB from `user_profile` so a returning user with PAN
  // already on file can drop a PDF on Welcome and skip Identity entirely.
  const { data: profile } = useUserProfile(session?.user.id);

  useEffect(() => {
    if (profile === undefined) return;

    let cancelled = false;
    (async () => {
      const saved = await loadOnboardingDraft();
      if (cancelled) return;
      const seed: OnboardingDraft = saved ?? EMPTY_DRAFT;

      const merged: OnboardingDraft = {
        ...seed,
        pan: (profile?.pan ?? seed.pan) || '',
        dob: profile?.dob ?? seed.dob,
      };

      const initialStep: OnboardingStep = pickOnboardingInitialStep({
        draftStep: merged.step,
        pan: profile?.pan,
        dob: profile?.dob,
        requestedMode,
      });

      console.log('[onboarding:wizard] hydrated', {
        platform: Platform.OS,
        initial_step: initialStep,
        saved_step: saved?.step ?? null,
        profile_present: !!profile,
        profile_has_pan: !!profile?.pan,
        profile_has_dob: !!profile?.dob,
        draft_seeded_from_storage: !!saved,
      });

      dispatch({ type: 'hydrate', draft: { ...merged, step: initialStep } });
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [profile, requestedMode]);

  useEffect(() => {
    if (!hydrated) return;
    void saveOnboardingDraft(draft);
  }, [draft, hydrated]);

  // Analytics: onboarding funnel. Same three events as before so existing
  // funnel queries keep working through the redesign.
  const onboardingStartedRef = useRef(false);
  const previousStepRef = useRef<OnboardingStep | null>(null);
  const onboardingCompletedRef = useRef(false);
  // `onboarding_path_chosen` is a one-shot per wizard session — fires the
  // first time the user commits on Welcome (drops a PDF or taps "Get it in
  // 2 mins"), then never again, so funnel filters can split on intent
  // without double-counting users who flip between paths.
  const pathChosenRef = useRef(false);

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

  // The visible progress pills only show on Identity (A3) and Done (A4) —
  // Welcome (A1) and Import (A2) are unframed entry points in the design.
  const visibleProgressIndex =
    draft.step === 'identity' ? 1 : draft.step === 'done' ? 2 : -1;

  function handleBack() {
    let prev: OnboardingStep | null = null;
    if (draft.step === 'identity' || draft.step === 'import') {
      prev = 'welcome';
    }
    if (prev) {
      console.log('[onboarding:wizard] back', { from: draft.step, to: prev });
      // Clear transient upload state when retreating to Welcome so the user
      // can pick a different PDF without stale errors carrying over.
      setUploadError(null);
      setUseCustomPassword(false);
      setCustomPassword('');
      dispatch({ type: 'goto', step: prev });
    }
  }

  function handleSkip() {
    console.log('[onboarding:wizard] skip', { step: draft.step });
    analytics.track('onboarding_skip_clicked', {
      step: draft.step,
      step_index: STEP_ORDER.indexOf(draft.step),
      is_returning_user: !!profile?.pan,
    });
    void clearOnboardingDraft();
    router.replace('/(tabs)');
  }

  function trackPathChosen(path: 'upload' | 'request_cas') {
    if (pathChosenRef.current) return;
    pathChosenRef.current = true;
    analytics.track('onboarding_path_chosen', {
      path,
      is_returning_user: !!profile?.pan,
    });
  }

  async function runUpload(
    asset: DocumentPicker.DocumentPickerAsset,
    password?: string,
  ): Promise<void> {
    setUploading(true);
    setUploadError(null);
    const startedAt = Date.now();
    console.log('[onboarding:upload] start', {
      platform: Platform.OS,
      file_name: asset.name,
      size_bytes: asset.size ?? null,
      mime: asset.mimeType ?? null,
      has_password_override: !!password?.trim(),
    });
    const hadPasswordOverride = !!password?.trim();
    try {
      const result = await uploadCasPdf(asset, password);
      const elapsed = Date.now() - startedAt;
      console.log('[onboarding:upload] success', {
        funds: result.funds,
        transactions: result.transactions,
        elapsed_ms: elapsed,
      });
      if (hadPasswordOverride) {
        analytics.track('onboarding_password_override_used', {
          succeeded: true,
          elapsed_ms: elapsed,
        });
      }
      // Invalidate the pre-import portfolio caches (typically an empty
      // portfolio for first-time users) so Done's fund preview and the
      // eventual dashboard mount both refetch against the freshly
      // imported funds. Done's usePortfolio() picks the marking up
      // synchronously and starts fetching while the user reads the
      // success copy.
      void queryClient.invalidateQueries();
      dispatch({
        type: 'import_complete',
        funds: result.funds,
        transactions: result.transactions,
      });
      setPickedAsset(null);
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      const msg = err instanceof Error ? err.message : 'Upload failed.';
      const errorKind = categorizeUploadError(msg);
      console.warn('[onboarding:upload] failed', {
        message: msg,
        elapsed_ms: elapsed,
        error_kind: errorKind,
      });
      analytics.track('portfolio_import_failed', {
        source: 'cas_pdf',
        error_kind: errorKind,
        had_password_override: hadPasswordOverride,
        elapsed_ms: elapsed,
      });
      if (hadPasswordOverride) {
        analytics.track('onboarding_password_override_used', {
          succeeded: false,
          error_kind: errorKind,
        });
      }
      setUploadError(
        errorKind === 'read_error'
          ? 'Could not read the PDF file. Re-download and try again.'
          : msg,
      );
    } finally {
      setUploading(false);
    }
  }

  async function handlePdfPicked(asset: DocumentPicker.DocumentPickerAsset) {
    trackPathChosen('upload');
    setPickedAsset(asset);
    // Fast-path: a returning user with PAN already on file doesn't need to
    // re-enter it. Server uses saved PAN (+ DOB if present) as the default
    // PDF password, so skip Identity and start the upload immediately.
    if (profile?.pan) {
      await runUpload(asset);
      return;
    }
    dispatch({ type: 'goto', step: 'identity' });
  }

  async function handleUnlock() {
    if (!pickedAsset || !session?.user.id) return;
    setUploadError(null);
    const dobIso = draft.dob;
    const upsertPayload: {
      user_id: string;
      pan: string;
      dob: string | null;
    } = {
      user_id: session.user.id,
      pan: profile?.pan ?? draft.pan,
      dob: profile?.dob ?? dobIso,
    };
    console.log('[onboarding:identity] upsert_start', {
      pan_locked: !!profile?.pan,
      dob_locked: !!profile?.dob,
      dob_being_set: !profile?.dob && !!dobIso,
      using_custom_password: useCustomPassword && customPassword.length > 0,
    });
    const startedAt = Date.now();
    const { error: upsertError } = await userProfileRepo
      .from()
      .upsert(upsertPayload, { onConflict: 'user_id' });
    const elapsedMs = Date.now() - startedAt;
    if (upsertError) {
      console.warn('[onboarding:identity] upsert_failed', {
        message: upsertError.message,
        code: upsertError.code,
        elapsed_ms: elapsedMs,
      });
      setUploadError(upsertError.message || 'Could not save your details. Try again.');
      return;
    }
    console.log('[onboarding:identity] upsert_ok', { elapsed_ms: elapsedMs });
    queryClient.invalidateQueries({ queryKey: userProfileQueryKey(session.user.id) });

    const passwordOverride = useCustomPassword && customPassword.trim().length > 0
      ? customPassword.trim()
      : undefined;
    await runUpload(pickedAsset, passwordOverride);
  }

  async function handleFinish() {
    console.log('[onboarding:wizard] finish', {
      imported: !!draft.importResult,
      funds: draft.importResult?.funds ?? 0,
      transactions: draft.importResult?.transactions ?? 0,
    });

    // Cache was invalidated right after upload completed and Done's
    // usePortfolio() will have warmed the cache by the time the user
    // taps through. The prefetch here is a safety belt for the case
    // where Done was dismissed quickly — its work overlaps the
    // navigation animation so the dashboard renders against a warm
    // cache instead of flashing a spinner.
    if (draft.importResult) {
      const userId = session?.user.id;
      if (userId) {
        const benchmarkSymbol = useAppStore.getState().defaultBenchmarkSymbol;
        queryClient.prefetchQuery({
          queryKey: ['portfolio', userId, benchmarkSymbol],
          queryFn: () => fetchPortfolioData(queryClient, userId, benchmarkSymbol),
        });
      }
    }

    await clearOnboardingDraft();
    router.replace('/(tabs)');
  }

  if (!hydrated) {
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
        {visibleProgressIndex >= 0 ? (
          <ProgressPills currentIndex={visibleProgressIndex} styles={styles} />
        ) : (
          <View style={styles.flex} />
        )}
        {draft.step === 'welcome' ? (
          <TouchableOpacity
            onPress={handleSkip}
            hitSlop={8}
            style={styles.skipButton}
            activeOpacity={0.7}
          >
            <Text style={styles.skipText}>Skip</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.iconButton} />
        )}
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {draft.step === 'welcome' && (
          <WelcomeStep
            onPickPdf={handlePdfPicked}
            onPickerDismissed={() =>
              analytics.track('onboarding_pdf_picker_dismissed', {
                is_returning_user: !!profile?.pan,
              })
            }
            onRequestCas={() => {
              trackPathChosen('request_cas');
              dispatch({ type: 'goto', step: 'import' });
            }}
            uploading={uploading}
            uploadError={uploadError}
            styles={styles}
            cl={cl}
          />
        )}
        {draft.step === 'identity' && (
          <IdentityStep
            draft={draft}
            dispatch={dispatch}
            session={session}
            hasPickedAsset={!!pickedAsset}
            useCustomPassword={useCustomPassword}
            customPassword={customPassword}
            onToggleCustomPassword={() => {
              setUseCustomPassword((v) => !v);
              if (useCustomPassword) setCustomPassword('');
            }}
            onChangeCustomPassword={setCustomPassword}
            uploading={uploading}
            uploadError={uploadError}
            onUnlock={handleUnlock}
            lockedPan={profile?.pan ?? null}
            lockedDob={profile?.dob ?? null}
            onDone={() => router.replace('/(tabs)')}
            styles={styles}
            cl={cl}
            tokens={tokens}
          />
        )}
        {draft.step === 'import' && (
          <ImportStep
            session={session}
            inboxToken={profile?.cas_inbox_token ?? null}
            pendingConfirmationUrl={profile?.cas_inbox_confirmation_url ?? null}
            autoForwardCompletedAt={profile?.cas_auto_forward_setup_completed_at ?? null}
            initialSub={requestedMode === 'auto-refresh' ? 'autoRefresh' : 'apps'}
            onUploadInstead={() => dispatch({ type: 'goto', step: 'welcome' })}
            onConfirmClicked={() => {
              queryClient.invalidateQueries({ queryKey: userProfileQueryKey(session?.user.id) });
            }}
            onAutoForwardCompleted={async () => {
              await markAutoForwardSetupComplete(session!.user.id);
              analytics.track('onboarding_auto_refresh_setup_completed', {
                is_returning_user: !!profile?.pan,
              });
              await queryClient.invalidateQueries({ queryKey: userProfileQueryKey(session?.user.id) });
            }}
            onSkip={() => dispatch({ type: 'goto', step: 'done' })}
            styles={styles}
            cl={cl}
          />
        )}
        {draft.step === 'done' && (
          <DoneStep
            draft={draft}
            onFinish={handleFinish}
            onSetupAutoRefresh={() => dispatch({ type: 'goto', step: 'import' })}
            hasInboxToken={!!profile?.cas_inbox_token}
            autoForwardCompletedAt={profile?.cas_auto_forward_setup_completed_at ?? null}
            styles={styles}
            cl={cl}
            tokens={tokens}
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
      {[0, 1, 2].map((idx) => (
        <View
          key={idx}
          style={[
            styles.pill,
            idx <= currentIndex ? styles.pillActive : styles.pillInactive,
          ]}
        />
      ))}
    </View>
  );
}

// ─── A1 · Welcome with drop-zone ───────────────────────────────────────────

function WelcomeStep({
  onPickPdf,
  onPickerDismissed,
  onRequestCas,
  uploading,
  uploadError,
  styles,
  cl,
}: {
  onPickPdf: (asset: DocumentPicker.DocumentPickerAsset) => Promise<void> | void;
  /** Fires when the user opened the OS file picker and backed out without
   *  picking anything. Used as a funnel-drop signal — "users see the
   *  drop-zone but bail" is a very different problem from "users never
   *  reach the drop-zone". */
  onPickerDismissed: () => void;
  onRequestCas: () => void;
  uploading: boolean;
  uploadError: string | null;
  styles: WizardStyles;
  cl: Cl;
}) {
  async function handlePickPress() {
    if (uploading) return;
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
      onPickerDismissed();
      return;
    }
    await onPickPdf(picked.assets[0]);
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={styles.brandRow}>
        <FolioLensLogo size={28} showWordmark />
      </View>

      <View style={styles.welcomeCopy}>
        <Text style={styles.eyebrow}>Welcome</Text>
        <Text style={styles.welcomeHeadline}>Let&apos;s find your{'\n'}mutual funds.</Text>
        <Text style={styles.welcomeBody}>
          We just need <Text style={styles.bold}>one document</Text> — your
          portfolio statement. It&apos;s a free, official PDF that lists every
          fund you own.
        </Text>
      </View>

      <Pressable
        onPress={handlePickPress}
        disabled={uploading}
        style={({ pressed }) => [
          styles.dropzone,
          pressed && styles.dropzonePressed,
          uploading && styles.dropzoneDisabled,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Upload your portfolio statement PDF"
      >
        <View style={styles.dropzoneGlyph}>
          {uploading ? (
            <ActivityIndicator color={cl.emeraldDeep} />
          ) : (
            <Ionicons name="arrow-up" size={22} color={cl.emeraldDeep} />
          )}
        </View>
        <Text style={styles.dropzoneTitle}>
          {uploading ? 'Importing your statement…' : 'Drop your statement here'}
        </Text>
        <Text style={styles.dropzoneHint}>
          {uploading ? 'This takes about 10 seconds.' : 'PDF · or tap to browse'}
        </Text>
      </Pressable>

      {uploadError ? (
        <View style={styles.errorBox}>
          <Ionicons name="warning-outline" size={16} color={cl.negative} />
          <Text style={styles.errorBoxText}>{uploadError}</Text>
        </View>
      ) : null}

      <View style={styles.welcomeAside}>
        <Text style={styles.welcomeAsideMuted}>Don&apos;t have one yet?</Text>
        <TouchableOpacity onPress={onRequestCas} hitSlop={4} activeOpacity={0.7}>
          <Text style={styles.welcomeAsideLink}>Get it in 2 mins →</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.flex} />

      <View style={styles.privacyFooter}>
        <Ionicons name="lock-closed" size={14} color={cl.emeraldDeep} />
        <Text style={styles.privacyFooterText}>Read-only · Encrypted · Never shared</Text>
      </View>

      <PortfolioDisclaimer />
    </ScrollView>
  );
}

// ─── A3 · Unlock screen (PAN + DOB + custom password reveal) ───────────────

function IdentityStep({
  draft,
  dispatch,
  session,
  hasPickedAsset,
  useCustomPassword,
  customPassword,
  onToggleCustomPassword,
  onChangeCustomPassword,
  uploading,
  uploadError,
  onUnlock,
  lockedPan,
  lockedDob,
  onDone,
  styles,
  cl,
  tokens,
}: {
  draft: OnboardingDraft;
  dispatch: React.Dispatch<
    | { type: 'set_pan'; pan: string }
    | { type: 'set_dob'; dob: string | null }
    | { type: 'goto'; step: OnboardingStep }
  >;
  session: ReturnType<typeof useSession>['session'];
  hasPickedAsset: boolean;
  useCustomPassword: boolean;
  customPassword: string;
  onToggleCustomPassword: () => void;
  onChangeCustomPassword: (value: string) => void;
  uploading: boolean;
  uploadError: string | null;
  onUnlock: () => void;
  lockedPan: string | null;
  lockedDob: string | null;
  onDone: () => void;
  styles: WizardStyles;
  cl: Cl;
  tokens: ClearLensTokens;
}) {
  const [dobText, setDobText] = useState(draft.dob ? formatDobDisplay(draft.dob) : '');
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

  // In review mode (no PDF picked — user came from Settings → Edit identity)
  // there's nothing to unlock, so the action becomes a simple "Done" exit.
  // In upload mode, the action is the actual PAN-as-password unlock.
  const reviewMode = !hasPickedAsset;
  const canSubmit = reviewMode
    ? true
    : panValid && dobValid && !uploading && !!session?.user.id;

  function handleDobChange(value: string) {
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
  }

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.stepHeader}>
        <Text style={styles.eyebrow}>{reviewMode ? 'Your details' : 'Almost there'}</Text>
        <Text style={styles.stepTitle}>
          {reviewMode
            ? 'PAN and date of birth on file.'
            : 'One last detail to unlock your statement.'}
        </Text>
        {!reviewMode ? (
          <Text style={styles.stepBody}>
            We&apos;ll try your <Text style={styles.bold}>PAN</Text> as the
            password first — that works <Text style={styles.bold}>99% of the time</Text>.
          </Text>
        ) : (
          <Text style={styles.stepBody}>
            These are saved permanently. If anything is wrong, tap “Request
            correction” next to the field and our team will fix it for you.
          </Text>
        )}
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
            <Text style={styles.correctionLink} onPress={() => setCorrectionField('pan')}>
              Wrong PAN? Request correction
            </Text>
          </View>
        ) : draft.pan.length > 0 && !panValid ? (
          <Text style={styles.fieldError}>
            PAN should look like ABCPE1234F (5 letters, 4 digits, 1 letter).
          </Text>
        ) : (
          <Text style={styles.fieldHint}>10 characters · used to unlock the PDF.</Text>
        )}
      </View>

      <View style={styles.field}>
        <View style={styles.fieldLabelRow}>
          <Text style={styles.fieldLabel}>
            Date of birth{' '}
            <Text style={styles.fieldLabelOptional}>· optional</Text>
          </Text>
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
            onChangeText={handleDobChange}
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
            <Text style={styles.fieldHint}>
              Date of birth is saved and cannot be changed in-app.
            </Text>
            <Text style={styles.correctionLink} onPress={() => setCorrectionField('dob')}>
              Wrong date? Request correction
            </Text>
          </View>
        ) : dobText.length > 0 && !dobValid ? (
          <Text style={styles.fieldError}>Use DD-MM-YYYY format, e.g. 12-05-1990.</Text>
        ) : (
          <Text style={styles.fieldHint}>Some demat statements need this too.</Text>
        )}
      </View>

      {!reviewMode ? (
        <View style={styles.passwordRevealCard}>
          <Pressable
            onPress={onToggleCustomPassword}
            style={styles.passwordRevealRow}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: useCustomPassword }}
          >
            <View style={[styles.passwordCheck, useCustomPassword && styles.passwordCheckOn]}>
              {useCustomPassword ? (
                <Ionicons name="checkmark" size={12} color={cl.textOnDark} />
              ) : null}
            </View>
            <View style={styles.passwordRevealCopy}>
              <Text style={styles.passwordRevealTitle}>My PDF uses a different password</Text>
              <Text style={styles.passwordRevealBody}>
                If you set a custom one while requesting it (CAMS / KFintech allow this).
              </Text>
            </View>
          </Pressable>
          {useCustomPassword ? (
            <TextInput
              value={customPassword}
              onChangeText={onChangeCustomPassword}
              placeholder="Custom PDF password"
              placeholderTextColor={cl.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={[styles.input, styles.passwordInput]}
            />
          ) : null}
        </View>
      ) : null}

      <View style={styles.privacyInlineRow}>
        <Ionicons name="lock-closed" size={14} color={cl.emeraldDeep} />
        <Text style={styles.privacyInlineText}>
          Encrypted at rest. Never shared with third parties.
        </Text>
      </View>

      {uploadError ? (
        <View style={styles.errorBox}>
          <Ionicons
            name="warning-outline"
            size={16}
            color={tokens.semantic.sentiment.negativeText}
          />
          <Text style={styles.errorBoxText}>{uploadError}</Text>
        </View>
      ) : null}

      <View style={styles.footerSpace} />
      {reviewMode ? (
        <PrimaryButton label="Done" onPress={onDone} styles={styles} cl={cl} />
      ) : (
        <PrimaryButton
          label={uploading ? 'Unlocking…' : 'Unlock my statement'}
          onPress={onUnlock}
          disabled={!canSubmit}
          loading={uploading}
          styles={styles}
          cl={cl}
        />
      )}

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

// ─── A2 · Get-a-statement flow ─────────────────────────────────────────────

type ImportSubScreen = 'apps' | 'portal' | 'autoRefresh';

function ImportStep({
  session,
  inboxToken,
  pendingConfirmationUrl,
  autoForwardCompletedAt,
  initialSub,
  onUploadInstead,
  onConfirmClicked,
  onAutoForwardCompleted,
  onSkip,
  styles,
  cl,
}: {
  session: ReturnType<typeof useSession>['session'];
  inboxToken: string | null;
  pendingConfirmationUrl: string | null;
  autoForwardCompletedAt: string | null;
  initialSub: ImportSubScreen;
  onUploadInstead: () => void;
  onConfirmClicked: () => void;
  onAutoForwardCompleted: () => Promise<void>;
  onSkip: () => void;
  styles: WizardStyles;
  cl: Cl;
}) {
  const [sub, setSub] = useState<ImportSubScreen>(initialSub);
  // Default to demat — broker apps (Zerodha, Angel, ICICI Direct) cover the
  // majority of Indian retail mutual-fund investors. The user can switch to
  // non-demat or "both" in one tap if the default doesn't match.
  const [appFamily, setAppFamily] = useState<AppFamily>('demat');
  const showAlert = useAlertDialog();
  const [browserVisited, setBrowserVisited] = useState(false);
  const appState = useRef<AppStateStatus>(AppState.currentState);

  // Reset transient state when sub changes so flags from one sub-screen
  // don't leak into another.
  useEffect(() => {
    setBrowserVisited(false);
  }, [sub]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (appState.current === 'background' && next === 'active' && browserVisited) {
        console.log('[onboarding:portal] returned_to_foreground_after_browser');
      }
      appState.current = next;
    });
    return () => subscription.remove();
  }, [browserVisited]);

  async function handleOpenPortal(url: string) {
    const portalId =
      [...PORTAL_OPTIONS, ...DEPOSITORY_OPTIONS].find((p) => p.url === url)?.id ?? 'unknown';
    console.log('[onboarding:portal] open', {
      portal_id: portalId,
      platform: Platform.OS,
      mode: Platform.OS === 'web' ? 'new_tab' : 'in_app_browser',
    });
    const portalKind: 'rta' | 'depository' = DEPOSITORY_OPTIONS.some(
      (p) => p.url === url,
    )
      ? 'depository'
      : 'rta';
    analytics.track('onboarding_portal_opened', {
      portal_id: portalId,
      portal_kind: portalKind,
      app_family: appFamily,
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
      showAlert({
        title: 'Could not open portal',
        body: err instanceof Error ? err.message : 'Try again.',
      });
    }
  }

  if (sub === 'autoRefresh' && inboxToken) {
    return (
      <View style={styles.flex}>
        <View style={styles.subBackBar}>
          <Pressable onPress={() => setSub('apps')} style={styles.miniBack} hitSlop={6}>
            <Ionicons name="chevron-back" size={18} color={cl.emeraldDeep} />
            <Text style={styles.miniBackText}>Back</Text>
          </Pressable>
        </View>
        <AutoRefreshSetup
          inboxToken={inboxToken}
          pendingConfirmationUrl={pendingConfirmationUrl}
          autoForwardCompletedAt={autoForwardCompletedAt}
          onConfirmClicked={onConfirmClicked}
          onAutoForwardCompleted={onAutoForwardCompleted}
          onContinue={onSkip}
        />
      </View>
    );
  }

  if (sub === 'portal') {
    const portalOptions =
      appFamily === 'demat'
        ? DEPOSITORY_OPTIONS
        : appFamily === 'nonDemat'
          ? PORTAL_OPTIONS
          : [...PORTAL_OPTIONS, ...DEPOSITORY_OPTIONS];
    const title =
      appFamily === 'demat'
        ? 'Get a depository statement'
        : appFamily === 'nonDemat'
          ? 'Get a fresh statement'
          : 'Pick the form that fits';
    const body =
      appFamily === 'demat'
        ? 'Use a Detailed CAS PDF from your depository. It includes your transaction history, not just the current balance.'
        : appFamily === 'nonDemat'
          ? 'Either portal returns the same combined statement — pick one, fill the short form, and it lands in your email in 1–2 minutes.'
          : 'Try the top one first. If a statement is missing fund houses you expected, request the other one too.';
    return (
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.stepHeader}>
          <Pressable onPress={() => setSub('apps')} style={styles.miniBack} hitSlop={6}>
            <Ionicons name="chevron-back" size={18} color={cl.emeraldDeep} />
            <Text style={styles.miniBackText}>Change selection</Text>
          </Pressable>
          <Text style={styles.stepTitle}>{title}</Text>
          <Text style={styles.stepBody}>{body}</Text>
        </View>

        <View style={styles.calloutCard}>
          <Ionicons name="time-outline" size={18} color={cl.emeraldDeep} />
          <Text style={styles.calloutText}>
            <Text style={styles.bold}>Pick a Detailed statement, not a summary.</Text>{' '}
            Set the date range to start before your first purchase (when in
            doubt, use <Text style={styles.bold}>01/01/2000</Text>) so transaction
            history comes through.
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
                    <Text style={styles.badgeText}>START HERE</Text>
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
          <Text style={styles.tipsLine}>3. Come back here and drop it on the welcome screen.</Text>
        </View>

        {browserVisited || Platform.OS === 'web' ? (
          <View style={styles.banner}>
            <Ionicons name="checkmark-circle" size={18} color={cl.emeraldDeep} />
            <Text style={styles.bannerText}>Got the email? Upload your statement now.</Text>
          </View>
        ) : null}

        <View style={styles.footerSpace} />

        <PrimaryButton
          label="I'll upload one I already have"
          onPress={onUploadInstead}
          styles={styles}
          cl={cl}
        />
        <SecondaryButton label="I'll do this later" onPress={onSkip} styles={styles} />
      </ScrollView>
    );
  }

  // A2 default: tile selector. `appFamily` is always set (defaults to demat),
  // so the soft callout always renders alongside the selected tile.
  const selected = APP_TILES.find((t) => t.id === appFamily)!;

  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={styles.stepHeader}>
        <Text style={styles.stepTitle}>Get your statement</Text>
        <Text style={styles.stepBody}>
          One question, then we&apos;ll send you to the right form.
        </Text>
      </View>

      <View style={styles.tilesCol}>
        <Text style={styles.eyebrow}>Which apps do you use?</Text>
        {APP_TILES.map((tile) => {
          const isSelected = appFamily === tile.id;
          return (
            <Pressable
              key={tile.id}
              onPress={() => setAppFamily(tile.id)}
              style={[
                styles.appTile,
                tile.id === 'both' && styles.appTileDashed,
                isSelected && styles.appTileSelected,
              ]}
              accessibilityRole="radio"
              accessibilityState={{ checked: isSelected }}
            >
              <View
                style={[
                  styles.appTileIc,
                  tile.id === 'both' && styles.appTileIcDashed,
                  isSelected && styles.appTileIcSelected,
                ]}
              >
                <Text
                  style={[
                    styles.appTileIcText,
                    isSelected && styles.appTileIcTextSelected,
                  ]}
                >
                  {tile.id === 'demat' ? 'A' : tile.id === 'nonDemat' ? 'B' : '+'}
                </Text>
              </View>
              <View style={styles.appTileCopy}>
                <Text style={styles.appTileTitle}>{tile.title}</Text>
                <Text style={styles.appTileDetail}>{tile.detail}</Text>
              </View>
              {isSelected ? (
                <View style={styles.appTileCheck}>
                  <Ionicons name="checkmark" size={14} color={cl.textOnDark} />
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <View style={styles.softCallout}>
        <Text style={styles.softCalloutText}>
          Got it — your funds are in{' '}
          <Text style={styles.softCalloutBold}>{selected.inferred}</Text>. We&apos;ll
          open the right form for you next.
        </Text>
      </View>

      {/* Quietly link to auto-refresh setup so users who already have an
          inbox token (i.e. came back from the success screen) can jump
          straight there without having to traverse the portal sub-screen. */}
      {inboxToken && session ? (
        <Pressable
          onPress={() => setSub('autoRefresh')}
          style={({ pressed }) => [styles.altLinkRow, pressed && styles.altLinkRowPressed]}
        >
          <Ionicons name="mail-unread-outline" size={16} color={cl.emeraldDeep} />
          <View style={styles.altLinkCopy}>
            <Text style={styles.altLinkTitle}>Or set up email auto-forward</Text>
            <Text style={styles.altLinkBody}>
              Forward future statements once — and we&apos;ll handle the rest.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={cl.textTertiary} />
        </Pressable>
      ) : null}

      <View style={styles.footerSpace} />

      <PrimaryButton
        label="Open the form ↗"
        onPress={() => {
          // `was_default` tells us how often demat (the pre-selected tile)
          // is actually what the user picks vs. what they switch off of —
          // critical for validating the default-selection decision.
          analytics.track('onboarding_app_family_selected', {
            family: appFamily,
            was_default: appFamily === 'demat',
          });
          setSub('portal');
        }}
        styles={styles}
        cl={cl}
      />
      <SecondaryButton
        label="I'll upload one I already have"
        onPress={onUploadInstead}
        styles={styles}
      />
    </ScrollView>
  );
}

// ─── A4 · Done ─────────────────────────────────────────────────────────────

// Top-N funds we surface in the success-screen preview. Matches the
// wireframe (4 rows + "+ N more") and keeps the screen tight on small
// phones.
const DONE_PREVIEW_FUND_COUNT = 4;

function DoneStep({
  draft,
  onFinish,
  onSetupAutoRefresh,
  hasInboxToken,
  autoForwardCompletedAt,
  styles,
  cl,
  tokens,
}: {
  draft: OnboardingDraft;
  onFinish: () => void;
  onSetupAutoRefresh: () => void;
  hasInboxToken: boolean;
  autoForwardCompletedAt: string | null;
  styles: WizardStyles;
  cl: Cl;
  tokens: ClearLensTokens;
}) {
  const result = draft.importResult;
  const imported = !!result;
  const autoRefreshReady = !!autoForwardCompletedAt;
  const showAutoRefreshNudge = imported && hasInboxToken && !autoRefreshReady;

  // Fetches against the just-imported funds — the cache was invalidated in
  // runUpload() right before the wizard advanced here, so this returns the
  // fresh portfolio. The same fetch warms the dashboard's cache, so the
  // "See my dashboard" transition reads from memory.
  const { data: portfolio } = usePortfolio();
  const previewFunds = useMemo(() => {
    if (!portfolio?.fundCards?.length) return [];
    return [...portfolio.fundCards]
      .filter((f) => (f.currentValue ?? 0) > 0)
      .sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0))
      .slice(0, DONE_PREVIEW_FUND_COUNT);
  }, [portfolio]);
  const extraFundCount = portfolio?.fundCards
    ? Math.max(0, portfolio.fundCards.length - previewFunds.length)
    : 0;

  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={styles.successHero}>
        <View style={styles.successIcon}>
          <Ionicons name="checkmark" size={36} color={cl.emeraldDeep} />
        </View>
        <Text style={styles.successTitle}>
          {imported
            ? "You're in."
            : autoRefreshReady
              ? 'Auto-refresh is ready'
              : "We'll be here when you're ready"}
        </Text>
        {imported ? (
          <Text style={styles.successBody}>
            We pulled in{' '}
            <Text style={styles.bold}>
              {result!.funds} fund{result!.funds === 1 ? '' : 's'}
            </Text>{' '}
            across{' '}
            <Text style={styles.bold}>
              {result!.transactions} transaction{result!.transactions === 1 ? '' : 's'}
            </Text>
            .
          </Text>
        ) : autoRefreshReady ? (
          <Text style={styles.successBody}>
            FolioLens will import the next forwarded statement automatically.
            To see your portfolio right now, manually forward your latest
            statement email to your private address.
          </Text>
        ) : (
          <Text style={styles.successBody}>
            No statement imported yet — your home screen will be empty until you
            upload one. Come back any time via{' '}
            <Text style={styles.bold}>Settings → Refresh portfolio</Text>.
          </Text>
        )}
      </View>

      {imported && previewFunds.length > 0 ? (
        <View style={styles.fundsPreview}>
          {previewFunds.map((fund, idx) => (
            <FundPreviewRow
              key={fund.id}
              fund={fund}
              color={tokens.semantic.fundAllocation[idx % tokens.semantic.fundAllocation.length]}
              showDivider={idx < previewFunds.length - 1}
              styles={styles}
              tokens={tokens}
            />
          ))}
          {extraFundCount > 0 ? (
            <Text style={styles.fundsPreviewMore}>+ {extraFundCount} more</Text>
          ) : null}
        </View>
      ) : null}

      {showAutoRefreshNudge ? (
        <Pressable
          onPress={() => {
            analytics.track('onboarding_done_nudge_clicked');
            onSetupAutoRefresh();
          }}
          style={({ pressed }) => [styles.nudgeCard, pressed && styles.nudgeCardPressed]}
        >
          <View style={styles.nudgeIconWrap}>
            <Ionicons name="mail-unread-outline" size={20} color={cl.emeraldDeep} />
          </View>
          <View style={styles.nudgeBody}>
            <Text style={styles.nudgeTitle}>Skip the upload next time</Text>
            <Text style={styles.nudgeText}>
              Every time a new statement lands in your email, forward it to your
              private FolioLens address — we&apos;ll pull in the new transactions
              automatically.
            </Text>
            <Text style={styles.nudgeLink}>Set it up →</Text>
          </View>
        </Pressable>
      ) : null}

      <View style={styles.tipsCard}>
        <Text style={styles.tipsHeading}>
          {imported || autoRefreshReady ? "What's next" : 'When you have a statement'}
        </Text>
        {imported ? (
          <>
            <Text style={styles.tipsLine}>• Glance at the home screen for your XIRR vs Nifty 50.</Text>
            <Text style={styles.tipsLine}>• Open Money Trail to inspect every transaction.</Text>
            <Text style={styles.tipsLine}>
              • {autoRefreshReady
                ? 'Future statements should import automatically.'
                : 'Set up auto-refresh later so you never have to re-upload.'}
            </Text>
          </>
        ) : autoRefreshReady ? (
          <>
            <Text style={styles.tipsLine}>• Keep your Gmail / Outlook filter enabled for CAMS / KFintech.</Text>
            <Text style={styles.tipsLine}>• Forward your latest statement manually if you want data immediately.</Text>
            <Text style={styles.tipsLine}>• If a monthly statement doesn&apos;t appear, upload the PDF from Settings.</Text>
          </>
        ) : (
          <>
            <Text style={styles.tipsLine}>• Request one from CAMS or KFintech (no login needed).</Text>
            <Text style={styles.tipsLine}>• Save the PDF the portal emails you to this device.</Text>
            <Text style={styles.tipsLine}>• Reopen the wizard and drop the PDF on the welcome screen.</Text>
          </>
        )}
      </View>

      <View style={styles.footerSpace} />
      <PrimaryButton
        label={imported ? 'See my dashboard' : 'Open FolioLens'}
        onPress={onFinish}
        styles={styles}
        cl={cl}
      />
    </ScrollView>
  );
}

function FundPreviewRow({
  fund,
  color,
  showDivider,
  styles,
  tokens,
}: {
  fund: FundCardData;
  color: string;
  showDivider: boolean;
  styles: WizardStyles;
  tokens: ClearLensTokens;
}) {
  // Per-fund returnXirr is decimal (0.18 = +18%). Show as a signed arrow
  // delta the way the rest of Clear Lens does — never colour-only.
  const xirrPct = fund.returnXirr * 100;
  const sign = xirrPct > 0 ? '▲ +' : xirrPct < 0 ? '▼ ' : '';
  const xirrText = `${sign}${xirrPct.toFixed(0)}%`;
  const xirrColor =
    xirrPct > 0
      ? tokens.semantic.sentiment.positiveText
      : xirrPct < 0
        ? tokens.semantic.sentiment.negativeText
        : tokens.colors.textTertiary;
  return (
    <View style={[styles.fundRow, showDivider && styles.fundRowDivider]}>
      <View style={[styles.fundChip, { backgroundColor: color }]} />
      <Text style={styles.fundName} numberOfLines={1}>
        {fund.schemeName}
      </Text>
      <Text style={[styles.fundXirr, { color: xirrColor }]}>{xirrText}</Text>
    </View>
  );
}

// ─── Buttons ───────────────────────────────────────────────────────────────

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

// ─── Styles ────────────────────────────────────────────────────────────────

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
    skipButton: {
      height: 36,
      paddingHorizontal: 6,
      alignItems: 'center',
      justifyContent: 'center',
    },
    skipText: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      fontFamily: ClearLensFonts.semiBold,
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
      flexGrow: 1,
    },
    brandRow: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    eyebrow: {
      ...ClearLensTypography.label,
      color: cl.emerald,
      textTransform: 'uppercase',
    },
    welcomeCopy: {
      gap: 8,
      paddingTop: ClearLensSpacing.sm,
    },
    welcomeHeadline: {
      ...ClearLensTypography.hero,
      color: cl.navy,
      fontSize: 32,
      lineHeight: 36,
    },
    welcomeBody: {
      ...ClearLensTypography.body,
      color: cl.textSecondary,
    },
    dropzone: {
      borderWidth: 2,
      borderStyle: 'dashed',
      borderColor: cl.border,
      borderRadius: ClearLensRadii.lg,
      paddingHorizontal: ClearLensSpacing.md,
      paddingVertical: ClearLensSpacing.lg,
      backgroundColor: cl.surfaceSoft,
      alignItems: 'center',
      gap: 6,
    },
    dropzonePressed: {
      backgroundColor: cl.mint50,
      borderColor: cl.mint,
    },
    dropzoneDisabled: {
      opacity: 0.7,
    },
    dropzoneGlyph: {
      width: 44,
      height: 44,
      borderRadius: ClearLensRadii.full,
      borderWidth: 1.5,
      borderColor: cl.emeraldDeep,
      backgroundColor: cl.mint50,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 4,
    },
    dropzoneTitle: {
      ...ClearLensTypography.h3,
      color: cl.navy,
    },
    dropzoneHint: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
    },
    welcomeAside: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 4,
    },
    welcomeAsideMuted: {
      ...ClearLensTypography.bodySmall,
      color: cl.textTertiary,
    },
    welcomeAsideLink: {
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
      fontFamily: ClearLensFonts.semiBold,
      textDecorationLine: 'underline',
    },
    privacyFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingTop: ClearLensSpacing.sm,
    },
    privacyFooterText: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
    },
    privacyInlineRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    privacyInlineText: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      flex: 1,
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
      alignSelf: 'flex-start',
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
    fieldLabelOptional: {
      fontFamily: ClearLensFonts.regular,
      color: cl.textTertiary,
      textTransform: 'none',
      letterSpacing: 0,
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
    passwordRevealCard: {
      borderWidth: 1,
      borderColor: cl.border,
      borderStyle: 'dashed',
      borderRadius: ClearLensRadii.md,
      padding: ClearLensSpacing.sm,
      gap: ClearLensSpacing.sm,
      backgroundColor: cl.surfaceSoft,
    },
    passwordRevealRow: {
      flexDirection: 'row',
      gap: ClearLensSpacing.sm,
      alignItems: 'flex-start',
    },
    passwordCheck: {
      width: 18,
      height: 18,
      borderWidth: 1.5,
      borderColor: cl.border,
      borderRadius: 4,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: cl.surface,
      marginTop: 1,
    },
    passwordCheckOn: {
      backgroundColor: cl.emeraldDeep,
      borderColor: cl.emeraldDeep,
    },
    passwordRevealCopy: {
      flex: 1,
      gap: 2,
    },
    passwordRevealTitle: {
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
      fontFamily: ClearLensFonts.bold,
    },
    passwordRevealBody: {
      ...ClearLensTypography.caption,
      color: cl.textSecondary,
      lineHeight: 16,
    },
    passwordInput: {
      backgroundColor: cl.surface,
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
    tilesCol: {
      gap: ClearLensSpacing.sm,
    },
    appTile: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.md,
      borderWidth: 1,
      borderColor: cl.border,
      backgroundColor: cl.surface,
      ...ClearLensShadow,
    },
    appTileDashed: {
      borderStyle: 'dashed',
      backgroundColor: cl.surfaceSoft,
    },
    appTileSelected: {
      borderColor: cl.emeraldDeep,
      backgroundColor: cl.positiveBg,
    },
    appTileIc: {
      width: 36,
      height: 36,
      borderRadius: ClearLensRadii.full,
      borderWidth: 1.5,
      borderColor: cl.border,
      backgroundColor: cl.surface,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    appTileIcDashed: {
      borderStyle: 'dashed',
    },
    appTileIcSelected: {
      backgroundColor: cl.mint50,
      borderColor: cl.emeraldDeep,
    },
    appTileIcText: {
      ...ClearLensTypography.body,
      fontFamily: ClearLensFonts.bold,
      color: cl.textSecondary,
    },
    appTileIcTextSelected: {
      color: cl.emeraldDeep,
    },
    appTileCopy: {
      flex: 1,
      gap: 2,
    },
    appTileTitle: {
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
      fontFamily: ClearLensFonts.bold,
      lineHeight: 18,
    },
    appTileDetail: {
      ...ClearLensTypography.caption,
      color: cl.textSecondary,
      lineHeight: 16,
    },
    appTileCheck: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: cl.emeraldDeep,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    softCallout: {
      padding: ClearLensSpacing.sm,
      borderRadius: ClearLensRadii.md,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: cl.mint,
      backgroundColor: cl.positiveBg,
    },
    softCalloutText: {
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
      lineHeight: 19,
    },
    softCalloutBold: {
      fontFamily: ClearLensFonts.bold,
      backgroundColor: cl.mint50,
    },
    altLinkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      padding: ClearLensSpacing.md,
      borderRadius: ClearLensRadii.md,
      backgroundColor: cl.surface,
      borderWidth: 1,
      borderColor: cl.border,
    },
    altLinkRowPressed: {
      backgroundColor: cl.surfaceSoft,
    },
    altLinkCopy: {
      flex: 1,
      gap: 2,
    },
    altLinkTitle: {
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
      fontFamily: ClearLensFonts.bold,
    },
    altLinkBody: {
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
    nudgeCardPressed: {
      backgroundColor: cl.mint50,
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
    nudgeLink: {
      ...ClearLensTypography.bodySmall,
      color: cl.emeraldDeep,
      fontFamily: ClearLensFonts.bold,
      textDecorationLine: 'underline',
      marginTop: 4,
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
    successHero: {
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      paddingTop: ClearLensSpacing.lg,
    },
    successIcon: {
      width: 72,
      height: 72,
      borderRadius: ClearLensRadii.full,
      borderWidth: 2,
      borderColor: cl.emeraldDeep,
      backgroundColor: cl.positiveBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    successTitle: {
      ...ClearLensTypography.h1,
      color: cl.navy,
      textAlign: 'center',
    },
    successBody: {
      ...ClearLensTypography.bodySmall,
      color: cl.textSecondary,
      textAlign: 'center',
      maxWidth: 280,
    },
    fundsPreview: {
      backgroundColor: cl.surface,
      borderRadius: ClearLensRadii.md,
      borderWidth: 1,
      borderColor: cl.border,
      paddingVertical: 4,
      paddingHorizontal: ClearLensSpacing.sm,
    },
    fundRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ClearLensSpacing.sm,
      paddingVertical: 10,
    },
    fundRowDivider: {
      borderBottomWidth: 1,
      borderBottomColor: cl.borderLight,
      borderStyle: 'dashed',
    },
    fundChip: {
      width: 22,
      height: 22,
      borderRadius: ClearLensRadii.sm,
      flexShrink: 0,
    },
    fundName: {
      flex: 1,
      ...ClearLensTypography.bodySmall,
      color: cl.navy,
      fontFamily: ClearLensFonts.semiBold,
    },
    fundXirr: {
      ...ClearLensTypography.bodySmall,
      fontFamily: ClearLensFonts.bold,
      fontVariant: ['tabular-nums'],
    },
    fundsPreviewMore: {
      ...ClearLensTypography.caption,
      color: cl.textTertiary,
      textAlign: 'center',
      paddingVertical: 6,
    },
    bold: {
      fontFamily: ClearLensFonts.bold,
      color: cl.navy,
    },
    footerSpace: {
      flex: 1,
      minHeight: ClearLensSpacing.md,
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
