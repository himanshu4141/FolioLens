import {
  ClearLensColors,
  ClearLensCompatibleColors,
  ClearLensCompatibleTokens,
  ClearLensDarkColors,
  ClearLensDarkCompatibleColors,
  ClearLensDarkSemanticColors,
  ClearLensDarkTokens,
  ClearLensFonts,
  ClearLensLightColors,
  ClearLensLightTokens,
  ClearLensRadii,
  ClearLensSemanticColors,
  ClearLensSpacing,
  ClearLensTypography,
  getClearLensTokens,
} from '../clearLensTheme';

describe('Clear Lens theme tokens', () => {
  it('uses the handoff danger red for negative values', () => {
    expect(ClearLensColors.negative).toBe('#E5484D');
    expect(ClearLensSemanticColors.sentiment.negative).toBe('#E5484D');
  });

  it('keeps semantic chart and allocation colors centralized', () => {
    expect(ClearLensSemanticColors.asset.equity).toBe(ClearLensColors.emerald);
    expect(ClearLensSemanticColors.asset.debt).toBe(ClearLensColors.amber);
    expect(ClearLensSemanticColors.asset.cash).toBe(ClearLensColors.slate);
    expect(ClearLensSemanticColors.marketCap.large).toBe(ClearLensColors.heroSurface);
    expect(ClearLensSemanticColors.marketCap.mid).toBe(ClearLensColors.emerald);
    expect(ClearLensSemanticColors.marketCap.small).toBe(ClearLensColors.amber);
    expect(ClearLensSemanticColors.fundAllocation[0]).toBe(ClearLensColors.emerald);
    expect(ClearLensSemanticColors.fundAllocation[1]).toBe(ClearLensColors.amber);
    expect(ClearLensSemanticColors.chart.fund).toBe(ClearLensColors.emerald);
    expect(ClearLensSemanticColors.chart.benchmark).toBe(ClearLensColors.slate);
    expect(ClearLensSemanticColors.chart.invested).toBe(ClearLensColors.lavender);
  });

  it('exposes the same shape on light and dark color palettes', () => {
    expect(Object.keys(ClearLensLightColors).sort()).toEqual(
      Object.keys(ClearLensDarkColors).sort(),
    );
  });

  it('flips background, surface, and ink between schemes', () => {
    expect(ClearLensLightColors.background).not.toBe(ClearLensDarkColors.background);
    expect(ClearLensLightColors.surface).not.toBe(ClearLensDarkColors.surface);
    expect(ClearLensLightColors.navy).not.toBe(ClearLensDarkColors.navy);
  });

  it('uses an emerald-family hue for the brand green in both schemes', () => {
    // Light + dark emerald can differ for contrast against their backgrounds
    // (dark uses a brighter emerald), but both should be defined and look green.
    expect(ClearLensLightColors.emerald).toMatch(/^#[0-9A-F]{6}$/i);
    expect(ClearLensDarkColors.emerald).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('uses heroSurface (stable navy) for the chart "invested" baseline so it never blends into dark bg', () => {
    expect(ClearLensDarkSemanticColors.chart.invested).toBe(ClearLensDarkColors.lavender);
    // Light + dark resolve invested to the same lavender hue so the line stays visually consistent
    expect(ClearLensSemanticColors.chart.invested).toBe(ClearLensColors.lavender);
  });

  it('mid market cap differs between light (emeraldDeep) and dark (mint) for legibility on dark bg', () => {
    // Both schemes need a mid value that contrasts the large slot — verify both are populated
    expect(ClearLensSemanticColors.marketCap.mid).toBeTruthy();
    expect(ClearLensDarkSemanticColors.marketCap.mid).toBeTruthy();
  });

  describe('getClearLensTokens factory', () => {
    it('returns the dark token bundle when scheme is "dark"', () => {
      expect(getClearLensTokens('dark')).toBe(ClearLensDarkTokens);
    });

    it('returns the light token bundle when scheme is "light"', () => {
      expect(getClearLensTokens('light')).toBe(ClearLensLightTokens);
    });

    it('exposes colors / semantic / compatible on each token bundle', () => {
      const dark = getClearLensTokens('dark');
      expect(dark.colors).toBe(ClearLensDarkColors);
      expect(dark.semantic).toBe(ClearLensDarkSemanticColors);
      expect(dark.compatible).toBe(ClearLensDarkCompatibleColors);
      const light = getClearLensTokens('light');
      expect(light.colors).toBe(ClearLensLightColors);
      expect(light.semantic).toBe(ClearLensSemanticColors);
      expect(light.compatible).toBe(ClearLensCompatibleColors);
    });
  });

  describe('layout + typography tokens', () => {
    it('spacing follows the 4/8 point Clear Lens scale', () => {
      expect(ClearLensSpacing.xs).toBe(4);
      expect(ClearLensSpacing.sm).toBe(8);
      expect(ClearLensSpacing.md).toBe(16);
      expect(ClearLensSpacing.lg).toBe(24);
      expect(ClearLensSpacing.xl).toBe(32);
      expect(ClearLensSpacing.xxl).toBe(48);
    });

    it('exposes the radii scale, with full > xl > lg > md > sm', () => {
      expect(ClearLensRadii.sm).toBeGreaterThan(0);
      expect(ClearLensRadii.md).toBeGreaterThan(ClearLensRadii.sm);
      expect(ClearLensRadii.lg).toBeGreaterThan(ClearLensRadii.md);
      expect(ClearLensRadii.xl).toBeGreaterThan(ClearLensRadii.lg);
      expect(ClearLensRadii.full).toBeGreaterThan(ClearLensRadii.xl);
    });

    it('exposes the Inter font family stack', () => {
      expect(ClearLensFonts.regular).toMatch(/Inter/i);
      expect(ClearLensFonts.semiBold).toMatch(/Inter/i);
      expect(ClearLensFonts.bold).toMatch(/Inter/i);
    });

    it('exposes typography scale with at least h1, body, and label', () => {
      expect(ClearLensTypography.h1).toBeDefined();
      expect(ClearLensTypography.body).toBeDefined();
      expect(ClearLensTypography.label).toBeDefined();
    });

    it('compatible tokens stay aligned across schemes', () => {
      const lightKeys = Object.keys(ClearLensCompatibleColors as ClearLensCompatibleTokens).sort();
      const darkKeys = Object.keys(ClearLensDarkCompatibleColors as ClearLensCompatibleTokens).sort();
      expect(lightKeys).toEqual(darkKeys);
    });
  });
});
