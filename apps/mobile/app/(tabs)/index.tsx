import { router } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '../../components/AppText';
import { DropRow } from '../../components/DropRow';
import { Icon } from '../../components/Icon';
import { ProductRow, Separator } from '../../components/ProductRow';
import { Wordmark } from '../../components/Screen';
import { AffiliateNote, Chip, EmptyState, ErrorState, Loading, SectionHeader } from '../../components/ui';
import { useHomeFeed, useTodayDrops } from '../../lib/queries';
import { radius, space, type as t, useTheme } from '../../lib/theme';

const HOME_DROPS = 5;
const HOME_PICKS = 4;

/**
 * Home: search first, then what moved today. No hero copy — the web's banner and
 * explanations stay on the web.
 */
export default function Home() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const drops = useTodayDrops();
  const home = useHomeFeed();

  const refreshing = drops.isRefetching || home.isRefetching;
  const refresh = () => { drops.refetch(); home.refetch(); };
  const goSearch = (q?: string) => router.navigate({ pathname: '/search', params: q ? { q } : { focus: '1' } });

  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={{ paddingTop: insets.top + space.sm, paddingBottom: space.section }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.faint} />}
    >
      <View style={styles.top}>
        <Wordmark />
        <Pressable onPress={() => router.push('/concierge')} hitSlop={10} accessibilityRole="button" accessibilityLabel="AI 컨시어지 열기">
          <Icon name="sparkle" size={24} color={theme.ink} />
        </Pressable>
      </View>

      <Pressable
        onPress={() => goSearch()}
        accessibilityRole="search"
        accessibilityLabel="상품 검색"
        style={({ pressed }) => [styles.search, { backgroundColor: theme.surface, opacity: pressed ? 0.7 : 1 }]}
      >
        <Icon name="search" size={20} color={theme.faint} />
        <AppText tone="faint" style={t.body}>어떤 상품의 최저가가 궁금하세요?</AppText>
      </Pressable>

      {home.data?.popular.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {home.data.popular.slice(0, 8).map(k => <Chip key={k} label={k} onPress={() => goSearch(k)} />)}
        </ScrollView>
      ) : null}

      <View style={styles.section}>
        <SectionHeader
          title="오늘 가격 하락"
          sub="직전 기록보다 실제로 내려간 상품"
          action={drops.data && drops.data.length > HOME_DROPS ? `${drops.data.length}개 모두 보기` : undefined}
          onAction={() => router.navigate('/drops')}
        />
        {drops.isPending ? <Loading /> : drops.isError ? (
          <ErrorState error={drops.error} onRetry={() => drops.refetch()} />
        ) : drops.data.length === 0 ? (
          <EmptyState title="오늘은 아직 내려간 상품이 없어요" detail="가격이 새로 확인되면 여기에 표시돼요." />
        ) : (
          drops.data.slice(0, HOME_DROPS).map((d, i) => (
            <View key={d.id}>
              {i > 0 ? <Separator /> : null}
              <DropRow drop={d} />
            </View>
          ))
        )}
      </View>

      <Pressable
        onPress={() => router.push('/concierge')}
        accessibilityRole="button"
        style={({ pressed }) => [styles.ai, { borderColor: theme.line, opacity: pressed ? 0.7 : 1 }]}
      >
        <Icon name="sparkle" size={22} color={theme.ink} />
        <View style={{ flex: 1 }}>
          <AppText style={t.headline}>AI에게 물어보기</AppText>
          <AppText tone="soft" style={t.footnote}>예산과 용도를 말하면 가격 기록으로 골라 드려요</AppText>
        </View>
        <Icon name="chevronRight" size={18} color={theme.faint} />
      </Pressable>

      {home.data?.daily && home.data.daily.products.length ? (
        <View style={styles.section}>
          <SectionHeader title="오늘의 셀렉션" sub={home.data.daily.keyword} action="더 보기" onAction={() => goSearch(home.data!.daily!.keyword)} />
          {home.data.daily.products.slice(0, HOME_PICKS).map((p, i) => (
            <View key={`${p.productId}|${p.mall}|${p.vendorItemId}`}>
              {i > 0 ? <Separator /> : null}
              <ProductRow product={p} />
            </View>
          ))}
        </View>
      ) : null}

      <AffiliateNote style={{ marginTop: space.xl }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.gutter, height: 44 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: space.gutter, marginTop: space.md, height: 48, borderRadius: radius.lg, paddingHorizontal: 14 },
  chips: { gap: 8, paddingHorizontal: space.gutter, paddingTop: space.md },
  section: { marginTop: space.section },
  ai: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginHorizontal: space.gutter, marginTop: space.xxl, padding: space.lg, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth * 2 },
});
