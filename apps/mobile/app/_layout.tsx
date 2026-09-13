import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme';

export default function RootLayout() {
  const theme = useTheme();
  return <>
    <StatusBar style={theme.background === '#FFFFFF' ? 'dark' : 'light'} />
    <SafeAreaProvider><Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.background } }} /></SafeAreaProvider>
  </>;
}
