import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

function tabScreenBlock(layout: string, name: string): string {
  const marker = `name="${name}"`;
  const start = layout.indexOf(marker);
  if (start < 0) throw new Error(`Missing tab screen ${name}`);
  const next = layout.indexOf('<Tabs.Screen', start + marker.length);
  return layout.slice(start, next < 0 ? layout.length : next);
}

describe('N3 navigation configuration', () => {
  it.each(['index', 'funds', 'wealth-journey', 'settings'])(
    'freezes the %s tab on blur',
    (name) => {
      const layout = source('app/(tabs)/_layout.tsx');
      expect(tabScreenBlock(layout, name)).toContain('freezeOnBlur: true');
    },
  );

  it('keeps native inactive-screen detachment and freezes Settings stack screens', () => {
    expect(source('app/(tabs)/_layout.tsx')).toContain(
      "detachInactiveScreens={Platform.OS === 'web' ? undefined : true}",
    );
    expect(source('app/(tabs)/settings/_layout.tsx')).toContain(
      'screenOptions={{ headerShown: false, freezeOnBlur: true }}',
    );
  });

  it('requires an explicit portfolio benchmark and uses the stored TRI choice in Wealth Journey', () => {
    const portfolioHook = source('src/hooks/usePortfolio.ts');
    const wealthJourney = source(
      'src/components/clearLens/screens/ClearLensWealthJourneyScreen.tsx',
    );
    const onboarding = source('app/onboarding/index.tsx');

    expect(portfolioHook).not.toContain("benchmarkSymbol: string = '^NSEI'");
    expect(wealthJourney).toContain('usePortfolio(\n    defaultBenchmarkSymbol,');
    expect(onboarding).toContain('usePortfolio(defaultBenchmarkSymbol)');
    expect(wealthJourney).not.toMatch(/usePortfolio\(\s*\)/);
    expect(onboarding).not.toMatch(/usePortfolio\(\s*\)/);
  });

  it('focus-gates the four heavy screen families', () => {
    const files = [
      'src/components/clearLens/screens/ClearLensPortfolioScreen.tsx',
      'src/components/clearLens/screens/desktop/ClearLensPortfolioScreenDesktop.tsx',
      'src/components/clearLens/screens/ClearLensFundsScreen.tsx',
      'src/components/clearLens/screens/desktop/ClearLensFundsScreenDesktop.tsx',
      'src/components/clearLens/screens/ClearLensWealthJourneyScreen.tsx',
      'app/(tabs)/settings/index.tsx',
      'app/(tabs)/settings/account.tsx',
      'app/(tabs)/settings/cache-debug.tsx',
      'app/(tabs)/settings/data-sync.tsx',
      'app/(tabs)/settings/portfolio-import.tsx',
      'app/fund/[id].tsx',
    ];

    for (const file of files) {
      const contents = source(file);
      expect(contents).toContain('useIsFocused');
      expect(contents).toContain('isFocused');
    }
  });
});
