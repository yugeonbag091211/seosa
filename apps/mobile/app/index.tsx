import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { ScrollView, useWindowDimensions, View } from 'react-native';
import { HeroShelf } from '../components/HeroShelf';
import {
  AppHeader, DropRow, ErrorState, KeywordChips, LoadingState, MonthBanner, ProductGrid, Screen, SearchPill, SectionHead, SiteFooter, SMark, Text,
} from '../components/ui';
import { api, type HomeFeed, type Product, userMessage } from '../lib/api';
import { space, typography, useTheme } from '../lib/theme';

type LoadState = 'loading' | 'success' | 'error';

function openProduct(product: Product): (() => void) | undefined {
  if (!product.productId) return undefined;
  const id = product.productId;
  // Carries the exact card data (including vendorItemId) forward — see lib/api.ts productFromParam.
  return () => router.push({ pathname: '/product/[id]', params: { id, mall: product.mall, product: JSON.stringify(product) } });
}

/**
 * Same structure as the seosa.ai.kr home: header (S + search) → gray hero band with the bookshelf →
 * popular keyword row → 핫딜 → 오늘의 셀렉션 → 이달의 추천 → footer. Data is the web's own /api/init.
 * Web-only features (AI Concierge, wish list, alerts, buy links) are intentionally not shown.
 */
export default function Home() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [feed, setFeed] = useState<HomeFeed | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.home(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setFeed(result);
      setLoadState('success');
    }).catch(cause => {
      if (controller.signal.aborted) return;
      setError(userMessage(cause));
      setLoadState('error');
    });
    return () => controller.abort();
  }, [attempt]);

  function retry() {
    setLoadState('loading');
    setError('');
    setAttempt(value => value + 1);
  }

  const cardWidth = Math.floor((width - space.page * 2 - space.grid) / 2);
  const daily = feed?.daily && feed.daily.products.length > 0 ? feed.daily : null;
  const monthly = feed?.monthly && feed.monthly.products.length > 0 ? feed.monthly : null;
  const empty = loadState === 'success' && !!feed && feed.drops.length === 0 && !daily && !monthly;

  return <Screen padded={false}>
    <AppHeader>
      <SMark size={34} />
      <SearchPill onPress={() => router.push('/search')} />
    </AppHeader>
    <ScrollView showsVerticalScrollIndicator={false}>
      <View style={{ backgroundColor: theme.surface }}>
        <View style={{ paddingHorizontal: space.heroX, paddingTop: 40, paddingBottom: 8 }}>
          <Text accessibilityRole="header" maxFontSizeMultiplier={1.25} style={[typography.heroTitle, { color: theme.text }]}>최저가도,{'\n'}고급지게.</Text>
          <Text maxFontSizeMultiplier={1.4} style={[typography.heroSub, { color: theme.muted, marginTop: 18 }]}>AI가 찾아주는 최적의 쇼핑 경험</Text>
        </View>
        <View style={{ paddingTop: 20, paddingBottom: 32, paddingHorizontal: space.heroX }}>
          <HeroShelf width={width - space.heroX * 2} />
        </View>
      </View>

      {feed && feed.keywords.length > 0
        ? <KeywordChips keywords={feed.keywords} onPress={keyword => router.push({ pathname: '/search', params: { q: keyword } })} />
        : null}

      <View style={{ paddingHorizontal: space.page }}>
        {loadState === 'loading' ? <View style={{ marginTop: space.section }}><LoadingState label="가격 기록을 불러오는 중…" /></View> : null}
        {loadState === 'error' ? <View style={{ marginTop: space.section }}><ErrorState message={error} onRetry={retry} /></View> : null}
        {empty ? <View style={{ marginTop: space.section }}><SectionHead title="지금 표시할 상품이 없어요" sub="수집된 가격이 쌓이면 여기에 나타납니다." /></View> : null}

        {feed && feed.drops.length > 0 ? <View style={{ marginTop: space.section }}>
          <SectionHead title="핫딜" count={`${feed.drops.length}개`} sub="오늘 확인한 가격이 직전 기록보다 내려간 상품이에요." />
          <View style={{ gap: space.grid }}>
            {feed.drops.map((product, index) => <DropRow key={`${product.productId || product.title}-${index}`} product={product} onPress={openProduct(product)} />)}
          </View>
        </View> : null}

        {daily ? <View style={{ marginTop: space.section }}>
          <SectionHead title="오늘의 셀렉션" sub="현재 키워드 · " strong={daily.keyword} />
          <ProductGrid products={daily.products} cardWidth={cardWidth} onOpen={openProduct} />
        </View> : null}

        {monthly ? <View style={{ marginTop: space.section - 26 }}>
          <MonthBanner month={monthly.month} title={monthly.title} subtitle={monthly.subtitle} />
          <ProductGrid products={monthly.products} cardWidth={cardWidth} onOpen={openProduct} />
        </View> : null}
      </View>

      <SiteFooter />
    </ScrollView>
  </Screen>;
}
