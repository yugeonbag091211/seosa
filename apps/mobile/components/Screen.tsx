import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { space, type as t, useTheme } from '../lib/theme';
import { AppText } from './AppText';

/** Tab screen chrome: safe area + an iOS-style large title. No toolbar clutter. */
export function ScreenHeader({ title, right }: { title: string; right?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  return (
    <View style={[styles.head, { paddingTop: insets.top + space.sm, backgroundColor: theme.bg }]}>
      <AppText style={t.largeTitle} accessibilityRole="header">{title}</AppText>
      {right}
    </View>
  );
}

/** The SEOSA wordmark (web .logo: weight 800, tracking .2em). */
export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <AppText accessibilityRole="header" accessibilityLabel="SEOSA" style={{ fontSize: size, lineHeight: size * 1.2, fontWeight: '800', letterSpacing: size * 0.2 }}>
      SEOSA
    </AppText>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.gutter, paddingBottom: space.md },
});
