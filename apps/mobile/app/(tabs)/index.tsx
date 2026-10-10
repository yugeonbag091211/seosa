import { router } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '../../components/AppText';
import { DropRow } from '../../components/DropRow';
import { HeroCarousel } from '../../components/HeroCarousel';
import { Icon } from '../../components/Icon';
import { MonthlyPicks } from '../../components/MonthlyPicks';
import { ProductRow, Separator } from '../../components/ProductRow';
import { Wordmark } from '../../components/Screen';
import { AffiliateNote, Chip, EmptyState, ErrorState, Loading, SectionHeader } from '../../components/ui';
import { recordStamp } from '../../lib/home';
import { pushOnce } from '../../lib/navigation';
import { useHomeFeed, useTodayDrops } from '../../lib/queries';
import { radius, space, type as t, useTheme } from '../../lib/theme';

const HOME_DROPS = 5;
const HOME_PICKS = 4;

/**
 * Home, in the web home's order (public/index.html):
 *   header (wordmark · search) → hero banners → popular keywords → 오늘 가격 하락 → AI →
 *   오늘의 셀렉션 → 이달의 추천 → affiliate notice.
 *
 * Every product number comes from two calls the web also makes: /api/hotdeals today-drop for the
 * drops, /api/init for keywords, the selection and the monthly curation. The hero's words are the
 * web's (lib/home.ts); the «MM.DD 수집» stamp is the newest collection date among those products.
 */
export default function Home() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const drops = useTodayDrops();
  const home = useHomeFeed();

  const refreshing = drops.isRefetching || home.isRefetching;
  const refresh = () => { drops.refetch(); home.refetch(); };
  const goSearch = (q?: string) => router.navigate({ pathname: '/search', params: q ? { q } : { focus: '1' } });
  const stamp = recordStamp([home.data?.daily?.products, home.data?.monthly?.products]);

  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={{ paddingTop: insets.top + space.sm, paddingBottom: space.section }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.faint} />}
    >
      <View style={styles.top}>
        <Wordmark />
        <Pressable onPress={() => pushOnce('/concierge')} hitSlop={10} accessibilityRole="button" accessibilityLabel="AI 컨시어지 열기">
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
        <AppText tone="faint" style={[t.body, { flexShrink: 1 }]}>어떤 상품의 최저가가 궁금하세요?</AppText>
      </Pressable>

      <View style={styles.hero}>
        <HeroCarousel stamp={stamp} />
      </View>

      {home.data?.popular.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {home.data.popular.slice(0, 8).map(k => <Chip key={k} label={k} onPress={() => goSearch(k)} />)}
        </ScrollView>
      ) : null}

      <View style={styles.firstSection}>
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
        onPress={() => pushOnce('/concierge')}
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

      <MonthlyPicks
        monthly={home.data?.monthly}
        pending={home.isPending}
        error={home.isError ? home.error : null}
        onRetry={() => home.refetch()}
        onKeyword={goSearch}
      />

      <AffiliateNote style={{ marginTop: space.xl }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.gutter, height: 44 },
  // minHeight, not height: at large text sizes the hint wraps inside the box instead of spilling out of it.
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: space.gutter, marginTop: space.md, minHeight: 48, paddingVertical: 12, borderRadius: radius.lg, paddingHorizontal: 14 },
  hero: { marginTop: space.md },
  chips: { gap: 8, paddingHorizontal: space.gutter, paddingTop: space.md },
  section: { marginTop: space.section },
  // The first list sits closer to the hero so its prices start inside the first screen.
  firstSection: { marginTop: space.xxl },
  ai: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginHorizontal: space.gutter, marginTop: space.xxl, padding: space.lg, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth * 2 },
});
