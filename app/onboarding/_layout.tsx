import { Stack } from 'expo-router';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import { useResponsiveLayout } from '@/src/components/responsive';
import { ClearLensFonts } from '@/src/constants/clearLensTheme';

export default function OnboardingLayout() {
  const cl = useClearLensTokens().colors;
  const { layout } = useResponsiveLayout();
  const isDesktop = layout === 'desktop';

  // On desktop the sidebar provides nav and each onboarding screen renders
  // its own hero block ("Upload a CAS PDF", "Import your portfolio"). Showing
  // the Stack's "Upload PDF" / "Import CAS" header on top of that creates a
  // duplicate-title row, so suppress it.
  return (
    <Stack
      screenOptions={
        isDesktop
          ? {
              headerShown: false,
              // Paint the screen container background so dark mode propagates
              // into the wizard. Without this the nested Stack falls back to
              // React Navigation's default white container.
              contentStyle: { backgroundColor: cl.background },
            }
          : {
              headerStyle: { backgroundColor: cl.background },
              headerShadowVisible: false,
              headerTintColor: cl.navy,
              headerTitleStyle: {
                color: cl.navy,
                fontFamily: ClearLensFonts.bold,
                fontWeight: '700',
              },
              contentStyle: { backgroundColor: cl.background },
            }
      }
    >
      <Stack.Screen name="index" options={{ title: 'Import CAS' }} />
      <Stack.Screen name="pdf" options={{ title: 'Upload PDF' }} />
    </Stack>
  );
}
