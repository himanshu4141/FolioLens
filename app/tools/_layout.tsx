import { Stack } from 'expo-router';

export default function ToolsLayout() {
  return <Stack screenOptions={{ headerShown: false, freezeOnBlur: true }} />;
}
