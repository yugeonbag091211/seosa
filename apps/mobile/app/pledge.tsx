import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '../components/AppText';
import { VETERAN_PLEDGE } from '../lib/home';
import { radius, space, type as t, useTheme } from '../lib/theme';

/**
 * «취지 보기» from the 4th hero banner — the web's #veteranOverlay, word for word
 * (lib/home.ts VETERAN_PLEDGE; tests compare it with public/index.html).
 * A statement only: nothing to sign up for, pay or share.
 */
export default function Pledge() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.section }]}
    >
      <AppText accessibilityRole="header" style={t.title}>{VETERAN_PLEDGE.title}</AppText>
      <AppText tone="faint" style={[t.footnote, { marginTop: space.xs }]}>{VETERAN_PLEDGE.lead}</AppText>

      {VETERAN_PLEDGE.paragraphs.map((segments, i) => (
        <AppText key={i} tone="soft" style={[t.body, styles.paragraph]}>
          {segments.map((s, j) => (s.strong
            ? <AppText key={j} style={{ color: theme.ink, fontWeight: '700' }}>{s.text}</AppText>
            : s.text))}
        </AppText>
      ))}

      <View style={[styles.rule, { backgroundColor: theme.line }]} />
      <AppText tone="faint" style={[t.footnote, { lineHeight: 21 }]}>{VETERAN_PLEDGE.footnote}</AppText>

      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        style={({ pressed }) => [styles.close, { borderColor: theme.line2, opacity: pressed ? 0.6 : 1 }]}
      >
        <AppText style={[t.callout, { fontWeight: '600' }]}>닫기</AppText>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.gutter, paddingTop: space.xl },
  paragraph: { lineHeight: 25, marginTop: space.lg },
  rule: { height: StyleSheet.hairlineWidth, marginTop: space.xl, marginBottom: space.lg },
  close: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', minHeight: 48, marginTop: space.xxl, borderRadius: radius.pill, borderWidth: 1 },
});
