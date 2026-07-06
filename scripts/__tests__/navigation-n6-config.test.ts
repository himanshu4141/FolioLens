import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

describe('N6 Fund Detail transition configuration', () => {
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

    expect(contents).toContain('onPressIn');
    expect(contents.match(/prefetchFundDetail\(/g)).toHaveLength(2);
    expect(contents.indexOf('prefetchFundDetail(fund);')).toBeLessThan(
      contents.indexOf('router.push(\`/fund/'),
    );
  });

  it('keeps the back affordance in both cold and warm route shells', () => {
    const route = source('app/fund/[id].tsx');

    expect(route.match(/<ClearLensHeader onPressBack=\{\(\) => router\.back\(\)\} \/>/g))
      .toHaveLength(3);
  });
});
