import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TimeWindow } from '@/src/utils/navUtils';
import type { MoneyTrailSortOption } from '@/src/utils/moneyTrail';

export type WealthJourneyReturnPreset = 'cautious' | 'balanced' | 'growth' | 'custom';
export type AppColorScheme = 'light' | 'dark' | 'system';
export type GoalReturnPreset = 'cautious' | 'balanced' | 'growth';

const VALID_COLOR_SCHEMES: readonly AppColorScheme[] = ['light', 'dark', 'system'];

function sanitizeColorScheme(value: unknown, fallback: AppColorScheme = 'system'): AppColorScheme {
  return VALID_COLOR_SCHEMES.includes(value as AppColorScheme) ? (value as AppColorScheme) : fallback;
}

// ---------------------------------------------------------------------------
// Tools flags
// ---------------------------------------------------------------------------

export interface ToolsFlags {
  goalPlanner: boolean;
  pastSipCheck: boolean;
  compareFunds: boolean;
  directVsRegular: boolean;
}

const DEFAULT_TOOLS_FLAGS: ToolsFlags = {
  goalPlanner: true,
  pastSipCheck: true,
  compareFunds: true,
  directVsRegular: true,
};

// ---------------------------------------------------------------------------
// Return assumptions (shared across all tools)
// ---------------------------------------------------------------------------

export interface ReturnAssumptions {
  cautious: number; // annual %, e.g. 8
  balanced: number;
  growth: number;
}

export const DEFAULT_RETURN_ASSUMPTIONS: ReturnAssumptions = {
  cautious: 8,
  balanced: 12,
  growth: 12,
};

function sanitizeReturnAssumptions(raw: unknown): ReturnAssumptions {
  if (!raw || typeof raw !== 'object') return DEFAULT_RETURN_ASSUMPTIONS;
  const s = raw as Partial<ReturnAssumptions>;
  return {
    cautious: clampReturn(s.cautious, DEFAULT_RETURN_ASSUMPTIONS.cautious),
    balanced: clampReturn(s.balanced, DEFAULT_RETURN_ASSUMPTIONS.balanced),
    growth: clampReturn(s.growth, DEFAULT_RETURN_ASSUMPTIONS.growth),
  };
}

function clampReturn(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(30, Math.max(1, n));
}

// ---------------------------------------------------------------------------
// Saved goals
// ---------------------------------------------------------------------------

export interface SavedGoal {
  id: string;
  name: string;
  targetAmount: number;
  targetDate: string; // 'YYYY-MM-DD'
  lumpSum: number;
  currentMonthly: number;
  returnPreset: GoalReturnPreset;
  createdAt: string;
}

function makeGoalId(): string {
  return `g-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function sanitizeGoal(raw: unknown): SavedGoal | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Partial<SavedGoal>;
  if (typeof g.id !== 'string' || !g.id) return null;
  if (typeof g.name !== 'string') return null;
  const preset: GoalReturnPreset =
    g.returnPreset === 'cautious' || g.returnPreset === 'growth' ? g.returnPreset : 'balanced';
  return {
    id: g.id,
    name: g.name,
    targetAmount: clampReturn(g.targetAmount, 0),
    targetDate: typeof g.targetDate === 'string' ? g.targetDate : '',
    lumpSum: clampReturn(g.lumpSum, 0),
    currentMonthly: clampReturn(g.currentMonthly, 0),
    returnPreset: preset,
    createdAt: typeof g.createdAt === 'string' ? g.createdAt : new Date().toISOString(),
  };
}

function sanitizeGoals(raw: unknown): SavedGoal[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeGoal).filter((g): g is SavedGoal => g !== null);
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

export interface BenchmarkOption {
  symbol: string;
  label: string;
}

// Phase 8 — total-return variants. Mutual fund NAVs are inherently
// total-return; we now compare against TRI, the same series every SEBI fund
// factsheet uses. BSE Sensex is dropped (no free TRI source); legacy
// preferences for ^BSESN are migrated to ^NSEITRI in `migratePersistedAppState`
// (Sensex's 30 large caps are closest in profile to Nifty 50's 50 large caps).
export const BENCHMARK_OPTIONS: BenchmarkOption[] = [
  { symbol: '^NSEITRI',     label: 'Nifty 50 TRI' },
  { symbol: '^NIFTY100TRI', label: 'Nifty 100 TRI' },
  { symbol: '^NIFTY500TRI', label: 'Nifty 500 TRI' },
];

// ---------------------------------------------------------------------------
// Wealth Journey
// ---------------------------------------------------------------------------

export interface WealthJourneyState {
  hasOpened: boolean;
  hasSavedPlan: boolean;
  currentSipOverride: number | null;
  futureSipTarget: number | null;
  monthlySipIncrease: number;
  additionalTopUp: number;
  yearsToRetirement: number;
  expectedReturn: number | null;
  expectedReturnPreset: WealthJourneyReturnPreset | null;
  retirementDurationYears: number;
  withdrawalRate: number;
  postRetirementReturn: number | null;
}

const WEALTH_JOURNEY_LIMITS = {
  maxSip: 25_00_000,
  maxTopUp: 10_00_00_000,
  maxYears: 40,
  maxExpectedReturn: 30,
  maxPostRetirementReturn: 20,
  maxWithdrawalRate: 12,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNumber(value, min, max, fallback));
}

function clampNullableNumber(value: unknown, min: number, max: number): number | null {
  if (value == null) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(max, Math.max(min, numeric));
}

function sanitizeWealthJourneyState(state: Partial<WealthJourneyState>): WealthJourneyState {
  const expectedReturnPreset: WealthJourneyReturnPreset | null =
    state.expectedReturnPreset === 'cautious' ||
    state.expectedReturnPreset === 'balanced' ||
    state.expectedReturnPreset === 'growth' ||
    state.expectedReturnPreset === 'custom'
      ? state.expectedReturnPreset
      : null;

  return {
    hasOpened: state.hasOpened === true,
    hasSavedPlan: state.hasSavedPlan === true,
    currentSipOverride: clampNullableNumber(
      state.currentSipOverride,
      0,
      WEALTH_JOURNEY_LIMITS.maxSip,
    ),
    futureSipTarget: clampNullableNumber(
      state.futureSipTarget,
      0,
      WEALTH_JOURNEY_LIMITS.maxSip,
    ),
    monthlySipIncrease: clampInteger(
      state.monthlySipIncrease,
      -WEALTH_JOURNEY_LIMITS.maxSip,
      WEALTH_JOURNEY_LIMITS.maxSip,
      DEFAULT_WEALTH_JOURNEY_STATE.monthlySipIncrease,
    ),
    additionalTopUp: clampInteger(
      state.additionalTopUp,
      0,
      WEALTH_JOURNEY_LIMITS.maxTopUp,
      DEFAULT_WEALTH_JOURNEY_STATE.additionalTopUp,
    ),
    yearsToRetirement: clampInteger(
      state.yearsToRetirement,
      1,
      WEALTH_JOURNEY_LIMITS.maxYears,
      DEFAULT_WEALTH_JOURNEY_STATE.yearsToRetirement,
    ),
    expectedReturn: clampNullableNumber(
      state.expectedReturn,
      0,
      WEALTH_JOURNEY_LIMITS.maxExpectedReturn,
    ),
    expectedReturnPreset,
    retirementDurationYears: clampInteger(
      state.retirementDurationYears,
      1,
      WEALTH_JOURNEY_LIMITS.maxYears,
      DEFAULT_WEALTH_JOURNEY_STATE.retirementDurationYears,
    ),
    withdrawalRate: clampNumber(
      state.withdrawalRate,
      1,
      WEALTH_JOURNEY_LIMITS.maxWithdrawalRate,
      DEFAULT_WEALTH_JOURNEY_STATE.withdrawalRate,
    ),
    postRetirementReturn: clampNullableNumber(
      state.postRetirementReturn,
      0,
      WEALTH_JOURNEY_LIMITS.maxPostRetirementReturn,
    ),
  };
}

function applyWealthJourneyPatch(
  state: WealthJourneyState,
  patch: Partial<WealthJourneyState>,
): WealthJourneyState {
  let changed = false;
  const next = sanitizeWealthJourneyState({ ...state, ...patch });

  for (const key of Object.keys(next) as (keyof WealthJourneyState)[]) {
    if (state[key] !== next[key]) {
      changed = true;
      break;
    }
  }

  return changed ? next : state;
}

const DEFAULT_WEALTH_JOURNEY_STATE: WealthJourneyState = {
  hasOpened: false,
  hasSavedPlan: false,
  currentSipOverride: null,
  futureSipTarget: null,
  monthlySipIncrease: 0,
  additionalTopUp: 0,
  yearsToRetirement: 15,
  expectedReturn: null,
  expectedReturnPreset: null,
  retirementDurationYears: 25,
  withdrawalRate: 4,
  postRetirementReturn: null,
};

// ---------------------------------------------------------------------------
// Screen UI preferences
// ---------------------------------------------------------------------------
// User-controlled UI choices (sort orders, time windows, search input) that
// must survive a desktop ↔ mobile resize. Funds and Portfolio render via
// separate desktop/mobile component variants — when the breakpoint flips,
// the inner React component swaps wholesale, wiping any local useState. By
// holding these values in the Zustand store both variants read/write the
// same source of truth, and the user's selections survive every resize and
// the next app launch (except searchQuery — see partialize below).

export type FundsSortOption =
  | 'currentValue'
  | 'invested'
  | 'xirr'
  | 'benchmarkLead'
  | 'dailyChange'
  | 'alphabetical';

export type PortfolioChartWindow = TimeWindow;

export type MoneyTrailSortKey = MoneyTrailSortOption;

const VALID_FUNDS_SORT: readonly FundsSortOption[] = [
  'currentValue', 'invested', 'xirr', 'benchmarkLead', 'dailyChange', 'alphabetical',
];
const VALID_CHART_WINDOWS: readonly PortfolioChartWindow[] = [
  '1M', '3M', '6M', '1Y', '3Y', '5Y', '10Y', '15Y', 'All',
];
const VALID_MONEY_TRAIL_SORT: readonly MoneyTrailSortKey[] = [
  'newest', 'oldest', 'amount_desc', 'amount_asc', 'fund_asc', 'fund_desc',
];

function sanitizeFundsSort(raw: unknown): FundsSortOption {
  return VALID_FUNDS_SORT.includes(raw as FundsSortOption)
    ? (raw as FundsSortOption)
    : 'currentValue';
}

function sanitizeChartWindow(raw: unknown): PortfolioChartWindow {
  return VALID_CHART_WINDOWS.includes(raw as PortfolioChartWindow)
    ? (raw as PortfolioChartWindow)
    : '1Y';
}

function sanitizeMoneyTrailSort(raw: unknown): MoneyTrailSortKey {
  return VALID_MONEY_TRAIL_SORT.includes(raw as MoneyTrailSortKey)
    ? (raw as MoneyTrailSortKey)
    : 'newest';
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface AppStore {
  defaultBenchmarkSymbol: string;
  setDefaultBenchmarkSymbol: (symbol: string) => void;
  appColorScheme: AppColorScheme;
  setAppColorScheme: (scheme: AppColorScheme) => void;
  wealthJourney: WealthJourneyState;
  updateWealthJourney: (patch: Partial<WealthJourneyState>) => void;
  resetWealthJourney: () => void;
  toolsFlags: ToolsFlags;
  returnAssumptions: ReturnAssumptions;
  setReturnAssumption: (key: keyof ReturnAssumptions, value: number) => void;
  goals: SavedGoal[];
  addGoal: (goal: Omit<SavedGoal, 'id' | 'createdAt'>) => void;
  updateGoal: (id: string, updates: Partial<Omit<SavedGoal, 'id' | 'createdAt'>>) => void;
  deleteGoal: (id: string) => void;
  // Screen UI preferences — see comment block above.
  fundsSortBy: FundsSortOption;
  setFundsSortBy: (sort: FundsSortOption) => void;
  fundsSearchQuery: string;
  setFundsSearchQuery: (query: string) => void;
  portfolioChartWindow: PortfolioChartWindow;
  setPortfolioChartWindow: (window: PortfolioChartWindow) => void;
  moneyTrailSortBy: MoneyTrailSortKey;
  setMoneyTrailSortBy: (sort: MoneyTrailSortKey) => void;
  // Preview ("try the app without signing up") mode. Intentionally NOT
  // persisted — every cold start drops back to /auth so previewers don't
  // drift permanently into demo data. Consumed by AuthGate (treated as
  // "logged in") and by data hooks that swap real Supabase queries for
  // the fixtures in `src/lib/previewData.ts`.
  previewMode: boolean;
  enterPreviewMode: () => void;
  exitPreviewMode: () => void;
}

// Phase 8 — when migrating persisted preferences, route legacy PR symbols
// to their TRI counterparts so the user's saved benchmark choice still
// resolves to a valid option after the cutover. BSE Sensex maps to Nifty 50
// TRI (closest large-cap match — Sensex 30, Nifty 50 has 50).
const LEGACY_BENCHMARK_TO_TRI: Record<string, string> = {
  '^NSEI':              '^NSEITRI',
  '^NIFTY100':          '^NIFTY100TRI',
  '^NIFTY500':          '^NIFTY500TRI',
  '^BSESN':             '^NSEITRI',
  '^CNX100':            '^NIFTY100TRI',
};

function migrateBenchmarkSymbol(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '^NSEITRI';
  if (raw in LEGACY_BENCHMARK_TO_TRI) return LEGACY_BENCHMARK_TO_TRI[raw];
  return raw;
}

// Merge persisted state into the runtime store on rehydration. Splits out from
// the inline Zustand `persist` arg so we can unit-test it. `merge` runs after
// `migrate` has already cleaned the state shape, but the second arg
// (currentState) carries the runtime defaults, so we still defensively
// sanitize each field rather than trusting the persisted blob.
export function mergePersistedAppState(
  persistedState: unknown,
  currentState: AppStore,
): AppStore {
  const state =
    persistedState && typeof persistedState === 'object'
      ? (persistedState as Partial<AppStore>)
      : {};
  return {
    ...currentState,
    defaultBenchmarkSymbol: migrateBenchmarkSymbol(
      state.defaultBenchmarkSymbol ?? currentState.defaultBenchmarkSymbol,
    ),
    appColorScheme: sanitizeColorScheme(state.appColorScheme, currentState.appColorScheme),
    wealthJourney: sanitizeWealthJourneyState({
      ...DEFAULT_WEALTH_JOURNEY_STATE,
      ...(state.wealthJourney ?? {}),
    }),
    returnAssumptions: sanitizeReturnAssumptions(state.returnAssumptions),
    goals: sanitizeGoals(state.goals),
    fundsSortBy: sanitizeFundsSort(state.fundsSortBy ?? currentState.fundsSortBy),
    portfolioChartWindow: sanitizeChartWindow(
      state.portfolioChartWindow ?? currentState.portfolioChartWindow,
    ),
    moneyTrailSortBy: sanitizeMoneyTrailSort(
      state.moneyTrailSortBy ?? currentState.moneyTrailSortBy,
    ),
    // fundsSearchQuery is intentionally not restored from disk — see partialize.
  };
}

export function migratePersistedAppState(persistedState: unknown): Partial<AppStore> {
  if (!persistedState || typeof persistedState !== 'object') {
    return {
      appColorScheme: 'system',
      wealthJourney: DEFAULT_WEALTH_JOURNEY_STATE,
      returnAssumptions: DEFAULT_RETURN_ASSUMPTIONS,
      goals: [],
      fundsSortBy: 'currentValue',
      portfolioChartWindow: '1Y',
      moneyTrailSortBy: 'newest',
    };
  }

  const state = persistedState as Partial<AppStore>;

  return {
    defaultBenchmarkSymbol: migrateBenchmarkSymbol(state.defaultBenchmarkSymbol),
    appColorScheme: sanitizeColorScheme(state.appColorScheme),
    wealthJourney: sanitizeWealthJourneyState({
      ...DEFAULT_WEALTH_JOURNEY_STATE,
      ...(state.wealthJourney ?? {}),
    }),
    returnAssumptions: sanitizeReturnAssumptions(state.returnAssumptions),
    goals: sanitizeGoals(state.goals),
    fundsSortBy: sanitizeFundsSort(state.fundsSortBy),
    portfolioChartWindow: sanitizeChartWindow(state.portfolioChartWindow),
    moneyTrailSortBy: sanitizeMoneyTrailSort(state.moneyTrailSortBy),
    // fundsSearchQuery deliberately not migrated — it's transient input,
    // always start fresh on app launch (still survives resize via in-memory store).
  };
}

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      defaultBenchmarkSymbol: '^NSEITRI',
      setDefaultBenchmarkSymbol: (symbol) => set({ defaultBenchmarkSymbol: symbol }),
      appColorScheme: 'system' as AppColorScheme,
      setAppColorScheme: (scheme) => set({ appColorScheme: sanitizeColorScheme(scheme) }),
      wealthJourney: DEFAULT_WEALTH_JOURNEY_STATE,
      updateWealthJourney: (patch) =>
        set((state) => {
          const wealthJourney = applyWealthJourneyPatch(state.wealthJourney, patch);
          return wealthJourney === state.wealthJourney ? state : { wealthJourney };
        }),
      resetWealthJourney: () => set({ wealthJourney: DEFAULT_WEALTH_JOURNEY_STATE }),
      toolsFlags: DEFAULT_TOOLS_FLAGS,
      returnAssumptions: DEFAULT_RETURN_ASSUMPTIONS,
      setReturnAssumption: (key, value) =>
        set((state) => ({
          returnAssumptions: {
            ...state.returnAssumptions,
            [key]: clampReturn(value, DEFAULT_RETURN_ASSUMPTIONS[key]),
          },
        })),
      goals: [],
      addGoal: (goal) =>
        set((state) => ({
          goals: [
            ...state.goals,
            { ...goal, id: makeGoalId(), createdAt: new Date().toISOString() },
          ],
        })),
      updateGoal: (id, updates) =>
        set((state) => ({
          goals: state.goals.map((g) => (g.id === id ? { ...g, ...updates } : g)),
        })),
      deleteGoal: (id) =>
        set((state) => ({ goals: state.goals.filter((g) => g.id !== id) })),
      // Screen UI preferences (Funds, Portfolio chart, Money Trail).
      fundsSortBy: 'currentValue' as FundsSortOption,
      setFundsSortBy: (sort) => set({ fundsSortBy: sanitizeFundsSort(sort) }),
      fundsSearchQuery: '',
      setFundsSearchQuery: (query) => set({ fundsSearchQuery: query }),
      portfolioChartWindow: '1Y' as PortfolioChartWindow,
      setPortfolioChartWindow: (window) =>
        set({ portfolioChartWindow: sanitizeChartWindow(window) }),
      moneyTrailSortBy: 'newest' as MoneyTrailSortKey,
      setMoneyTrailSortBy: (sort) =>
        set({ moneyTrailSortBy: sanitizeMoneyTrailSort(sort) }),
      previewMode: false,
      enterPreviewMode: () => set({ previewMode: true }),
      exitPreviewMode: () => set({ previewMode: false }),
    }),
    {
      name: 'foliolens-app-store',
      storage: createJSONStorage(() => AsyncStorage),
      version: 7,
      migrate: migratePersistedAppState,
      merge: mergePersistedAppState,
      partialize: (state) => ({
        defaultBenchmarkSymbol: state.defaultBenchmarkSymbol,
        appColorScheme: state.appColorScheme,
        wealthJourney: state.wealthJourney,
        returnAssumptions: state.returnAssumptions,
        goals: state.goals,
        fundsSortBy: state.fundsSortBy,
        portfolioChartWindow: state.portfolioChartWindow,
        moneyTrailSortBy: state.moneyTrailSortBy,
        // Deliberately NOT persisted: fundsSearchQuery — transient input
        // shouldn't follow the user across sessions. It still survives resize
        // via the in-memory store (partialize only affects AsyncStorage).
      }),
    },
  ),
);
