import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '../components/AppText';
import { Icon } from '../components/Icon';
import { useHomeFeed } from '../lib/queries';
import { space, type as t, useTheme } from '../lib/theme';

const QUICK_CATEGORIES = [
  { title: '무선 이어폰', subtitle: '이어폰 · 오디오' },
  { title: '노트북', subtitle: '노트북 · 컴퓨터' },
  { title: '마우스', subtitle: 'PC 액세서리' },
  { title: '아이폰', subtitle: '스마트폰' },
  { title: '포터블 모니터', subtitle: '모니터 · 디스플레이' },
  { title: '키보드', subtitle: 'PC 액세서리' },
] as const;

/** Native navigation for the six product entry points displayed on the web homepage.
 * These are search suggestions, NOT claims of the server supporting category filters.
 */
export default function Categories() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const popular = useHomeFeed();
  const search = (q: string) => router.navigate({ pathname: '/search', params: { q } });

  return (
    <ScrollView style={{ backgroundColor: theme.bg }} contentContainerStyle={{ paddingTop: space.md, paddingBottom: insets.bottom + space.section }}>
      <View style={styles.intro}>
        <AppText style={t.largeTitle}>어떤 상품을 찾으세요?</AppText>
        <AppText tone="soft" style={[t.callout, { marginTop: space.sm }]}>카테고리를 누르면 서사에서 상품과 가격을 검색합니다.</AppText>
      </View>
      {QUICK_CATEGORIES.map((item, i) => (
        <Pressable key={item.title} onPress={() => search(item.title)} accessibilityRole="button"
          accessibilityLabel={`${item.title} 검색`}
          style={({ pressed }) => [styles.item, { borderTopColor: theme.line, opacity: pressed ? .65 : 1, borderBottomColor: theme.line, borderBottomWidth: i === QUICK_CATEGORIES.length - 1 ? StyleSheet.hairlineWidth : 0 }]}>
          <View style={{ flex: 1 }}>
            <AppText style={[t.headline, { fontWeight: '600' }]}>{item.title}</AppText>
            <AppText tone="faint" style={[t.footnote, { marginTop: 3 }]}>{item.subtitle}</AppText>
          </View>
          <Icon name="chevronRight" size={18} color={theme.soft} />
        </Pressable>
      ))}
      {popular.data?.popular?.length ? (
        <View style={{ marginTop: space.section }}>
          <AppText style={[t.title, styles.pad]}>지금 많이 찾는 검색어</AppText>
          {popular.data.popular.slice(0, 6).map((q, index) => (
            <Pressable key={q} onPress={() => search(q)} accessibilityRole="button" style={styles.popular}>
              <AppText tone="faint" mono style={[t.caption, { width: 22 }]}>{index + 1}</AppText>
              <AppText style={t.body}>{q}</AppText>
            </Pressable>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  intro: { paddingHorizontal: space.gutter, paddingBottom: space.xl },
  pad: { paddingHorizontal: space.gutter, marginBottom: space.md },
  item: { flexDirection: 'row', alignItems: 'center', minHeight: 68, paddingVertical: space.md, paddingHorizontal: space.gutter, borderTopWidth: StyleSheet.hairlineWidth },
  popular: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.gutter, minHeight: 46 },
});
