import { useEffect, useState } from 'react';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { TypefaceProvider } from '../components/AppText';
import { FONT_ASSETS } from '../lib/fontAssets';
import { useTheme } from '../lib/theme';

// The native launch screen (light/dark, app.json) stays up until the web typefaces are ready, so text does not
// reflow from the system font to Pretendard on the first frame.
SplashScreen.preventAutoHideAsync().catch(() => {});

/** Never hold the launch screen longer than this for fonts; the app then renders in the system font. */
const FONT_WAIT_MS = 2500;

export default function RootLayout() {
  const theme = useTheme();
  const [fontsLoaded, fontError] = useFonts(FONT_ASSETS);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setGaveUp(true), FONT_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  const ready = fontsLoaded || !!fontError || gaveUp;
  useEffect(() => {
    if (fontError && __DEV__) console.warn('[seosa fonts] falling back to the system font');
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready, fontError]);

  if (!ready) return null;
  return <TypefaceProvider ready={fontsLoaded}>
    {/* "auto" follows the system color scheme — the same source useTheme() reads. */}
    <StatusBar style="auto" />
    <SafeAreaProvider><Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.background } }} /></SafeAreaProvider>
  </TypefaceProvider>;
}
