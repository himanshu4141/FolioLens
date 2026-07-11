import { useTrackInsightViewed } from '@/src/hooks/useTrackInsightViewed';
import { useResponsiveLayout } from '@/src/components/responsive';
import { ClearLensPortfolioScreenMobile } from '@/src/components/clearLens/screens/ClearLensPortfolioScreen';
import { ClearLensPortfolioScreenDesktop } from '@/src/components/clearLens/screens/desktop/ClearLensPortfolioScreenDesktop';

export function ClearLensPortfolioScreen() {
  useTrackInsightViewed('home');
  const { layout } = useResponsiveLayout();
  if (layout === 'desktop') return <ClearLensPortfolioScreenDesktop />;
  return <ClearLensPortfolioScreenMobile />;
}
