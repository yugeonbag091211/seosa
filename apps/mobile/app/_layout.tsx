import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme';

export default function RootLayout() {
  const theme = useTheme();
  return <>
    {/* "auto" follows the system color scheme — the same source useTheme() reads. */}
    <StatusBar style="auto" />
    <SafeAreaProvider><Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.background } }} /></SafeAreaProvider>
  </>;
}
