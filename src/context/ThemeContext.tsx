import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import {
  getClearLensTokens,
  ClearLensLightTokens,
  type ClearLensColorScheme,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { useAppStore, type AppColorScheme } from '@/src/store/appStore';

interface ThemeContextValue {
  /** Active Clear Lens tokens for this render — read via {@link useClearLensTokens}. */
  clearLens: ClearLensTokens;
  /** What the user selected (light / dark / system). */
  colorScheme: AppColorScheme;
  /** What we actually rendered with this turn (light / dark) — system resolved. */
  resolvedScheme: ClearLensColorScheme;
  setColorScheme: (scheme: AppColorScheme) => void;
}

const defaultValue: ThemeContextValue = {
  clearLens: ClearLensLightTokens,
  colorScheme: 'system',
  resolvedScheme: 'light',
  setColorScheme: () => {},
};

const ThemeContext = createContext<ThemeContextValue>(defaultValue);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const appColorScheme = useAppStore((state) => state.appColorScheme);
  const setColorScheme = useAppStore((state) => state.setAppColorScheme);
  const systemScheme = useColorScheme();

  const resolvedScheme: ClearLensColorScheme =
    appColorScheme === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : appColorScheme;

  const clearLens = useMemo(() => getClearLensTokens(resolvedScheme), [resolvedScheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      clearLens,
      colorScheme: appColorScheme,
      resolvedScheme,
      setColorScheme,
    }),
    [clearLens, appColorScheme, resolvedScheme, setColorScheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Returns the colour-scheme controls (selected, resolved, setter). For tokens,
 * use {@link useClearLensTokens} — that hook is the canonical entry point for
 * any colour, spacing, or typography read.
 */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** Returns the full Clear Lens token set for the active scheme. */
export function useClearLensTokens(): ClearLensTokens {
  return useContext(ThemeContext).clearLens;
}
