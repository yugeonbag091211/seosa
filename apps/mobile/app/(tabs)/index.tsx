import { router } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '../../components/AppText';
import { DropRow } from '../../components/DropRow';
import { CommunityDealRow } from '../../components/CommunityDealRow';
import { HeroCarousel } from '../../components/HeroCarousel';
import { Icon } from '../../components/Icon';
import { MonthlyPicks } from '../../components/MonthlyPicks';
import { ProductRow, Separator } from '../../components/ProductRow';
import { Wordmark } from '../../components/Screen';
import { AffiliateNote, Chip, EmptyState, ErrorState, Loading, SectionHeader } from '../../components/ui';
import { recordStamp } from '../../lib/home';
import { pushOnce } from '../../lib/navigation';
import { useCommunityDeals, useHomeFeed, useTodayDrops } from '../../lib/queries';
import { radius, space, type as t, useTheme } from '../../lib/theme';

const QUICK_SEARCHES = ['무선 이어폰', '노트북', '마우스', '아이폰', '포터블 모니터', '키보드'] as const;
const HOME_COMMUNITY = 5;
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
  const community = useCommunityDeals();
  const home = useHomeFeed();

  const refreshing = drops.isRefetching || home.isRefetching || community.isRefetching;
  const refresh = () => { drops.refetch(); home.refetch(); community.refetch(); };
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
        <AppText tone="faint" style={[t.body, { flexShrink: 1 }]}>상품을 검색하세요</AppText>
      </Pressable>

      <View style={styles.siteNav}>
        <Pressable onPress={() => goSearch()} accessibilityRole="button" style={styles.navItem}>
          <AppText style={t.footnote}>카테고리</AppText>
        </Pressable>
        <Pressable onPress={() => pushOnce('/community')} accessibilityRole="button" style={styles.navItem}>
          <AppText style={t.footnote}>핫딜</AppText>
        </Pressable>
        <Pressable onPress={() => pushOnce('/concierge')} accessibilityRole="button" style={styles.navItem}>
          <AppText style={t.footnote}>AI 쇼핑</AppText>
        </Pressable>
      </View>

      <View style={styles.hero}>
        <HeroCarousel stamp={stamp} />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {QUICK_SEARCHES.map(k => <Chip key={k} label={k} onPress={() => goSearch(k)} />)}
      </ScrollView>

      <Pressable onPress={() => pushOnce('/concierge')} accessibilityRole="button" style={styles.aiLink}>
        <Icon name="sparkle" size={16} color={theme.soft} />
        <AppText tone="soft" style={t.footnote}>조건으로 찾고 싶다면 · </AppText>
        <AppText style={[t.footnote, { fontWeight: '700', flexShrink: 1 }]}>서사 AI에게 물어보기</AppText>
        <Icon name="chevronRight" size={15} color={theme.soft} />
      </Pressable>

      <View style={styles.communitySection}>
        <SectionHeader
          title={`실시간 핫딜${community.data?.length ? ' · ' + community.data.length + '개' : ''}`}
          sub="커뮤니티에서 발견한 핫딜을 모아 보여드려요. 가격 검증 여부를 구분합니다."
          action={community.data?.length ? '모두 보기' : undefined}
          onAction={() => pushOnce('/community')}
        />
        {community.isPending ? <Loading /> : community.isError ? (
          <ErrorState error={community.error} onRetry={() => community.refetch()} />
        ) : community.data.length === 0 ? (
          <EmptyState title="표시할 커뮤니티 핫딜이 없어요" detail="새 글이 확인되면 여기에 표시됩니다." />
        ) : (
          community.data.slice(0, HOME_COMMUNITY).map((deal, i) => (
            <View key={deal.id}>
              {i > 0 ? <Separator /> : null}
              <CommunityDealRow deal={deal} />
            </View>
          ))
        )}
      </View>

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
  siteNav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.gutter, gap: space.xl, marginTop: space.md, paddingBottom: space.sm },
  navItem: { paddingVertical: 5, minHeight: 30, justifyContent: 'center' },
  hero: { marginTop: space.sm },
  chips: { gap: 8, paddingHorizontal: space.gutter, paddingTop: space.md },
  aiLink: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 3, paddingHorizontal: space.gutter, paddingTop: space.lg, paddingBottom: space.md },
  communitySection: { marginTop: space.lg },
  section: { marginTop: space.section },
  firstSection: { marginTop: space.section },
});
