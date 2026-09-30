import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { TypefaceProvider } from '../components/AppText';
import { FONT_ASSETS } from '../lib/fontAssets';
import { LocalDataProvider } from '../lib/local';
import { queryClient } from '../lib/queries';
import { SessionProvider } from '../lib/session';
import { palette } from '../lib/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

/** Longest the splash waits for fonts; after that the system font is used (text never waits on a font). */
const FONT_WAIT_MS = 1500;

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(FONT_ASSETS);
  const [gaveUp, setGaveUp] = useState(false);
  const scheme = useColorScheme();
  const theme = scheme === 'dark' ? palette.dark : palette.light;

  useEffect(() => {
    const timer = setTimeout(() => setGaveUp(true), FONT_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  const settled = fontsLoaded || !!fontError || gaveUp;
  useEffect(() => {
    if (settled) SplashScreen.hideAsync().catch(() => {});
  }, [settled]);

  if (!settled) return null;

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <LocalDataProvider>
            <TypefaceProvider ready={fontsLoaded && !fontError}>
              <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
              <Stack
                screenOptions={{
                  headerShadowVisible: false,
                  headerStyle: { backgroundColor: theme.bg },
                  headerTintColor: theme.ink,
                  headerTitleStyle: { fontFamily: fontsLoaded && !fontError ? 'Pretendard-SemiBold' : undefined, fontSize: 17 },
                  headerBackButtonDisplayMode: 'minimal',
                  contentStyle: { backgroundColor: theme.bg },
                }}
              >
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="product/[key]" options={{ title: '' }} />
                <Stack.Screen name="concierge" options={{ presentation: 'modal', title: 'AI 컨시어지' }} />
                <Stack.Screen name="login" options={{ presentation: 'modal', title: '로그인' }} />
              </Stack>
            </TypefaceProvider>
          </LocalDataProvider>
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
