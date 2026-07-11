/* eslint-disable @typescript-eslint/no-require-imports -- Jest mock factories need local requires after hoisting. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ClearLensLightTokens } from '@/src/constants/clearLensTheme';
import FundDetailScreen from '@/app/fund/[id]';
import { FundListItem } from '@/src/components/clearLens/screens/ClearLensFundsScreen';
import type { FundDetailData } from '@/src/hooks/useFundDetail';
import type { FundCardData } from '@/src/hooks/usePortfolio';

type NativeProps = Record<string, unknown> & { children?: React.ReactNode };

jest.mock('react-native', () => {
  const ReactMock = require('react') as typeof React;
  const component = (name: string) => function MockNativeComponent({
    children,
    ...props
  }: NativeProps) {
    return ReactMock.createElement(name, props, children);
  };

  return {
    ActivityIndicator: component('ActivityIndicator'),
    FlatList: function MockFlatList({
      data = [],
      renderItem,
      ListHeaderComponent,
      ListEmptyComponent,
      ...props
    }: NativeProps & {
      data?: unknown[];
      renderItem?: (input: { item: unknown; index: number }) => React.ReactNode;
      ListHeaderComponent?: React.ComponentType | React.ReactNode;
      ListEmptyComponent?: React.ComponentType | React.ReactNode;
    }) {
      const header = typeof ListHeaderComponent === 'function'
        ? ReactMock.createElement(ListHeaderComponent)
        : ListHeaderComponent;
      const empty = data.length === 0
        ? (typeof ListEmptyComponent === 'function'
          ? ReactMock.createElement(ListEmptyComponent)
          : ListEmptyComponent)
        : null;
      return ReactMock.createElement(
        'FlatList',
        props,
        header,
        ...data.map((item, index) => renderItem?.({ item, index })),
        empty,
      );
    },
    Modal: component('Modal'),
    Platform: { OS: 'ios' },
    Pressable: component('Pressable'),
    ScrollView: component('ScrollView'),
    StyleSheet: {
      create: <T extends object>(styles: T) => styles,
      flatten: (style: unknown) => style,
    },
    Text: component('Text'),
    TextInput: component('TextInput'),
    TouchableOpacity: component('TouchableOpacity'),
    View: component('View'),
    useColorScheme: () => 'light',
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    InteractionManager: {
      runAfterInteractions: (callback: () => void) => {
        callback();
        return { cancel: jest.fn() };
      },
    },
  };
});

jest.mock('react-native-safe-area-context', () => {
  const ReactMock = require('react') as typeof React;
  return {
    SafeAreaView: ({ children, ...props }: NativeProps) =>
      ReactMock.createElement('SafeAreaView', props, children),
  };
});

jest.mock('@expo/vector-icons', () => {
  const ReactMock = require('react') as typeof React;
  return {
    Ionicons: (props: NativeProps) => ReactMock.createElement('Ionicons', props),
  };
});

jest.mock('react-native-svg', () => {
  const ReactMock = require('react') as typeof React;
  const component = (name: string) => ({ children, ...props }: NativeProps) =>
    ReactMock.createElement(name, props, children);
  return {
    __esModule: true,
    default: component('Svg'),
    G: component('G'),
    Line: component('Line'),
    Polygon: component('Polygon'),
    Polyline: component('Polyline'),
    Rect: component('Rect'),
    Text: component('SvgText'),
  };
});

const mockRouter = {
  back: jest.fn(),
  push: jest.fn(),
};
let mockFocused = true;
let mockRestoring = false;
let mockRouteParams: { id?: string } = { id: 'fund-1' };
let mockFundDetailResult: {
  data: FundDetailData | null;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
} = {
  data: null,
  isLoading: true,
  isError: false,
  isSuccess: false,
};
let mockCachedFund: FundCardData | null = null;
let mockNavHistory: { date: string; value: number }[] | undefined;

jest.mock('expo-router', () => {
  const ReactMock = require('react') as typeof React;
  return {
    Stack: {
      Screen: (props: NativeProps) => ReactMock.createElement('StackScreen', props),
    },
    useIsFocused: () => mockFocused,
    useLocalSearchParams: () => mockRouteParams,
    useRouter: () => mockRouter,
  };
});

jest.mock('@tanstack/react-query', () => ({
  keepPreviousData: undefined,
  useIsRestoring: () => mockRestoring,
  useQueryClient: () => ({ getQueryData: jest.fn(), prefetchQuery: jest.fn() }),
}));

jest.mock('@/src/context/ThemeContext', () => {
  const ReactMock = require('react') as typeof React;
  const { ClearLensLightTokens: tokens } = require('@/src/constants/clearLensTheme') as {
    ClearLensLightTokens: unknown;
  };
  return {
    ThemeProvider: ({ children }: { children: React.ReactNode }) =>
      ReactMock.createElement(ReactMock.Fragment, null, children),
    useClearLensTokens: () => tokens,
    useTheme: () => ({
      clearLens: tokens,
      colorScheme: 'light',
      resolvedScheme: 'light',
      setColorScheme: jest.fn(),
    }),
  };
});

jest.mock('@/src/components/responsive', () => {
  const ReactMock = require('react') as typeof React;
  return {
    DESKTOP_MIN_WIDTH: 1024,
    MaxContentWidth: 1200,
    SidebarWidth: 280,
    DesktopFormFrame: ({ children }: { children: React.ReactNode }) =>
      ReactMock.createElement('DesktopFormFrame', null, children),
    DesktopSidebar: () => ReactMock.createElement('DesktopSidebar'),
    ResponsiveRouteFrame: ({ children }: { children: React.ReactNode }) =>
      ReactMock.createElement('ResponsiveRouteFrame', null, children),
    useIsDesktop: () => false,
    useResponsiveLayout: () => ({ layout: 'mobile', width: 390 }),
  };
});

jest.mock('@/src/components/responsive/useResponsiveLayout', () => ({
  useIsDesktop: () => false,
  useResponsiveLayout: () => ({ layout: 'mobile', width: 390 }),
}));

jest.mock('@/src/components/clearLens/FolioLensLogo', () => {
  const ReactMock = require('react') as typeof React;
  return {
    FolioLensLogo: () => ReactMock.createElement('FolioLensLogo'),
  };
});

jest.mock('@/src/components/AppOverflowMenu', () => {
  const ReactMock = require('react') as typeof React;
  return {
    AppOverflowMenu: () => ReactMock.createElement('AppOverflowMenu'),
  };
});

jest.mock('@/src/components/clearLens/PortfolioDisclaimer', () => {
  const ReactMock = require('react') as typeof React;
  return {
    PortfolioDisclaimer: () => ReactMock.createElement('Text', null, 'Portfolio disclaimer'),
  };
});

jest.mock('@/src/components/clearLens/screens/desktop/ClearLensFundsScreenDesktop', () => {
  const ReactMock = require('react') as typeof React;
  return {
    ClearLensFundsScreenDesktop: () => ReactMock.createElement('ClearLensFundsScreenDesktop'),
  };
});

jest.mock('@/src/components/clearLens/fund-detail/FundDetailPerformanceContent', () => {
  const ReactMock = require('react') as typeof React;
  return {
    __esModule: true,
    default: () => ReactMock.createElement('Text', { testID: 'performance-content' }, 'Performance content'),
  };
});

jest.mock('@/src/components/clearLens/fund-detail/FundDetailNavContent', () => {
  const ReactMock = require('react') as typeof React;
  return {
    __esModule: true,
    default: () => ReactMock.createElement('Text', { testID: 'nav-content' }, 'NAV content'),
  };
});

jest.mock('@/src/components/clearLens/fund-detail/FundDetailCompositionContent', () => {
  const ReactMock = require('react') as typeof React;
  return {
    __esModule: true,
    default: () => ReactMock.createElement('Text', { testID: 'composition-content' }, 'Composition content'),
  };
});

jest.mock('@/src/hooks/useFundDetail', () => ({
  useFundDetail: () => mockFundDetailResult,
  useFundNavHistory: () => ({ data: mockNavHistory }),
  useFundDetailTransitionPrefetch: () => jest.fn(),
}));

jest.mock('@/src/hooks/usePortfolio', () => ({
  useCachedFundCard: () => mockCachedFund,
  usePortfolio: () => ({ data: { fundCards: [], summary: null }, isLoading: false }),
}));

jest.mock('@/src/hooks/usePortfolioInsights', () => ({
  usePortfolioInsights: () => ({ insights: null }),
}));

jest.mock('@/src/hooks/useSession', () => ({
  useSession: () => ({ session: { user: { id: 'user-1' } } }),
}));

jest.mock('@/src/hooks/useTrackInsightViewed', () => ({
  useTrackInsightViewed: jest.fn(),
}));

jest.mock('@/src/hooks/useImportPortfolioPress', () => ({
  useImportPortfolioPress: () => jest.fn(),
}));

jest.mock('@/src/lib/listRenderDiagnostics', () => ({
  useVirtualizedRowMount: jest.fn(),
}));

jest.mock('@/src/lib/navigationPerformance', () => ({
  getNavigationCacheContext: () => ({ source: 'test' }),
  startNavigationMeasurement: jest.fn(),
}));

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

function sourceBlock(contents: string, startMarker: string, endMarker: string): string {
  const start = contents.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing start marker ${startMarker}`);
  const end = contents.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Missing end marker ${endMarker}`);
  return contents.slice(start, end);
}

function hostType(node: TestRenderer.ReactTestInstance): string {
  return node.type as unknown as string;
}

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.findAll((child) => hostType(child) === 'Text')
    .flatMap((textNode) => textNode.children)
    .filter((child): child is string => typeof child === 'string')
    .join(' ');
}

function touchableByText(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): TestRenderer.ReactTestInstance {
  const touchable = renderer.root.findAll((node) => hostType(node) === 'TouchableOpacity')
    .find((node) => textContent(node).includes(label));
  if (!touchable) throw new Error(`Missing touchable ${label}`);
  return touchable;
}

function expectText(renderer: TestRenderer.ReactTestRenderer, label: string) {
  expect(renderer.root.findAll((node) => hostType(node) === 'Text').some((node) => textContent(node).includes(label)))
    .toBe(true);
}

function expectNoText(renderer: TestRenderer.ReactTestRenderer, label: string) {
  expect(renderer.root.findAll((node) => hostType(node) === 'Text').some((node) => textContent(node).includes(label)))
    .toBe(false);
}

function makeFund(overrides: Partial<FundCardData> = {}): FundCardData {
  return {
    id: 'fund-1',
    schemeName: 'Alpha Opportunities Direct Growth',
    schemeCategory: 'Flexi Cap',
    schemeCode: 12345,
    currentNav: 125,
    previousNav: 123,
    currentNavDate: new Date().toISOString().split('T')[0],
    currentUnits: 100,
    currentValue: 12500,
    investedAmount: 10000,
    dailyChangeAmount: 200,
    dailyChangePct: 1.6,
    returnXirr: 12.4,
    realizedGain: 0,
    realizedAmount: 0,
    redeemedUnits: 0,
    navHistory30d: [
      { date: '2026-07-08', value: 123 },
      { date: '2026-07-09', value: 125 },
    ],
    schemeActive: true,
    ...overrides,
  };
}

function makeFundDetail(overrides: Partial<FundDetailData> = {}): FundDetailData {
  return {
    ...makeFund(),
    benchmarkIndex: 'Nifty 500 TRI',
    benchmarkSymbol: '^NSE500TRI',
    fundXirr: 12.4,
    navHistory: [
      { date: '2026-07-08', value: 123 },
      { date: '2026-07-09', value: 125 },
    ],
    isin: 'INF000000000',
    expenseRatio: 0.7,
    aumCr: 1200,
    minSipAmount: 500,
    fundMetaSyncedAt: '2026-07-09T00:00:00Z',
    launchDate: '2020-01-01',
    exitLoad: null,
    minLumpsum: 1000,
    minAdditional: 1000,
    planType: 'direct',
    amcName: 'Alpha AMC',
    familyName: 'Alpha',
    riskLabel: 'Very High',
    periodReturns: null,
    riskRatios: null,
    declaredBenchmarkName: 'Nifty 500 TRI',
    fundManager: 'Manager',
    portfolioTurnover: null,
    terDate: null,
    ...overrides,
  };
}

function renderFundDetail() {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(React.createElement(FundDetailScreen));
  });
  if (!renderer) throw new Error('Renderer was not created');
  return renderer;
}

async function flushLazyModules() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('N6 Fund Detail transition configuration', () => {
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    const originalConsoleError = console.error;
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation((...args) => {
      const [message] = args;
      if (
        typeof message === 'string' &&
        message.includes('react-test-renderer is deprecated')
      ) {
        return;
      }
      originalConsoleError(...args);
    });
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFocused = true;
    mockRestoring = false;
    mockRouteParams = { id: 'fund-1' };
    mockFundDetailResult = {
      data: null,
      isLoading: true,
      isError: false,
      isSuccess: false,
    };
    mockCachedFund = null;
    mockNavHistory = undefined;
  });

  it('keeps chart libraries out of the route and lazy-loads isolated tab modules', () => {
    const route = source('app/fund/[id].tsx');

    expect(route).not.toContain('react-native-gifted-charts');
    expect(route).not.toContain('react-native-svg');
    expect(route).toContain("lazy(\n  () => import('@/src/components/clearLens/fund-detail/FundDetailPerformanceContent')");
    expect(route).toContain("lazy(\n  () => import('@/src/components/clearLens/fund-detail/FundDetailNavContent')");
    expect(route).toContain("lazy(\n  () => import('@/src/components/clearLens/fund-detail/FundDetailCompositionContent')");
  });

  it.each([
    'src/components/clearLens/screens/ClearLensFundsScreen.tsx',
    'src/components/clearLens/screens/desktop/ClearLensFundsScreenDesktop.tsx',
  ])('prefetches on touch-down and immediately before push in %s', (file) => {
    const contents = source(file);
    const openFundDetail = sourceBlock(
      contents,
      'const openFundDetail = useCallback',
      'const prefetchFund = useCallback',
    );
    const prefetchIdx = openFundDetail.indexOf('prefetchFundDetail({ id: fund.id');
    const pushIdx = openFundDetail.indexOf('router.push(`/fund/');

    expect(contents).toContain('onPressIn');
    expect(contents.match(/prefetchFundDetail\(/g)).toHaveLength(2);
    expect(prefetchIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(prefetchIdx).toBeLessThan(pushIdx);
  });

  it('renders the fund row event path and fires prefetch before navigation', () => {
    const fund = makeFund();
    const events: string[] = [];
    const styles = new Proxy({}, { get: () => ({}) }) as never;
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    act(() => {
      renderer = TestRenderer.create(
        React.createElement(FundListItem, {
          fund,
          portfolioPct: 50,
          expanded: false,
          onToggle: jest.fn(),
          onOpen: (nextFund) => events.push(`open:${nextFund.id}`),
          onPrefetch: (nextFund) => events.push(`prefetch:${nextFund.id}`),
          onOpenTransactions: jest.fn(),
          latestNavDate: fund.currentNavDate,
          styles,
          tokens: ClearLensLightTokens,
        }),
      );
    });
    if (!renderer) throw new Error('Renderer was not created');

    const mainTap = renderer.root.findAll((node) => hostType(node) === 'TouchableOpacity')
      .find((node) => typeof node.props.onPressIn === 'function' && typeof node.props.onPress === 'function');
    expect(mainTap).toBeDefined();

    act(() => {
      mainTap?.props.onPressIn();
      mainTap?.props.onPress();
    });

    expect(events).toEqual(['prefetch:fund-1', 'open:fund-1']);
    act(() => renderer?.unmount());
  });

  it('renders a warm cached hero before metadata/history settle', () => {
    mockCachedFund = makeFund();
    mockFundDetailResult = {
      data: null,
      isLoading: true,
      isError: false,
      isSuccess: false,
    };

    const renderer = renderFundDetail();

    expectText(renderer, 'Alpha Opportunities');
    expectText(renderer, 'Loading performance');
    act(() => renderer.unmount());
  });

  it('keeps cold deep links in loading, preserves back, and exposes terminal errors', () => {
    const loading = renderFundDetail();
    const loadingBack = loading.root.findByProps({ accessibilityLabel: 'Go back' });

    act(() => loadingBack.props.onPress());
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(loading.root.findAll((node) => hostType(node) === 'ActivityIndicator').length)
      .toBeGreaterThan(0);
    act(() => loading.unmount());

    mockFundDetailResult = {
      data: null,
      isLoading: false,
      isError: true,
      isSuccess: false,
    };

    const error = renderFundDetail();
    expectText(error, "Couldn't load fund data");
    act(() => error.unmount());
  });

  it('switches tab content by rendered events and mounts only the selected tab', async () => {
    mockFundDetailResult = {
      data: makeFundDetail(),
      isLoading: false,
      isError: false,
      isSuccess: true,
    };
    mockNavHistory = [
      { date: '2026-07-08', value: 123 },
      { date: '2026-07-09', value: 125 },
    ];

    const renderer = renderFundDetail();
    await flushLazyModules();
    expectText(renderer, 'Performance content');
    expectNoText(renderer, 'NAV content');
    expectNoText(renderer, 'Composition content');

    act(() => touchableByText(renderer, 'NAV & Facts').props.onPress());
    await flushLazyModules();
    expectNoText(renderer, 'Performance content');
    expectText(renderer, 'NAV content');
    expectNoText(renderer, 'Composition content');

    act(() => touchableByText(renderer, 'Mix & Weight').props.onPress());
    await flushLazyModules();
    expectNoText(renderer, 'Performance content');
    expectNoText(renderer, 'NAV content');
    expectText(renderer, 'Composition content');

    act(() => renderer.unmount());
  });

  it('keeps immediate back responsive while full NAV history is in flight', () => {
    mockFundDetailResult = {
      data: makeFundDetail(),
      isLoading: false,
      isError: false,
      isSuccess: true,
    };
    mockNavHistory = undefined;

    const renderer = renderFundDetail();
    const back = renderer.root.findByProps({ accessibilityLabel: 'Go back' });

    act(() => back.props.onPress());

    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('keeps the back affordance in both cold and warm route shells', () => {
    const route = source('app/fund/[id].tsx');

    expect(route.match(/<ClearLensHeader onPressBack=\{\(\) => router\.back\(\)\} \/>/g))
      .toHaveLength(3);
  });
});
