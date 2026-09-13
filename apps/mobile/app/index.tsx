import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { BrandMark, ErrorState, LoadingState, ProductCard, Screen, SearchEntry, SectionHeader, Text, VerdictBadge } from '../components/ui';
import { api, type HomeDeal, type Product, userMessage } from '../lib/api';
import { useTheme } from '../lib/theme';

type LoadState = 'loading' | 'success' | 'error';

const dealLabel: Record<string, string> = {
  VERIFIED_HOT: '검증된 핫딜',
  GOOD_DEAL: '좋은 가격',
  POTENTIAL_DEAL: '관심 가격',
};

/** The verdict codes the detail screen actually shows (server Deal Engine), grouped the way the badges color them. */
const signals: [string, string][] = [
  ['BUY', '지금 사도 좋은 가격'],
  ['NORMAL', '평범한 가격'],
  ['WAIT', '기다리는 편이 나은 가격'],
];

export default function Home() {
  const theme = useTheme();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [deals, setDeals] = useState<HomeDeal[]>([]);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api.homeDeals(controller.signal).then(items => {
      if (controller.signal.aborted) return;
      setDeals(items.slice(0, 3));
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

  return <Screen>
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <View accessible accessibilityRole="header" accessibilityLabel="SEOSA" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 4, paddingBottom: 26 }}>
        <BrandMark size={29} decorative />
        <Text style={{ fontSize: 17, fontWeight: '700', letterSpacing: 2.4 }}>SEOSA</Text>
      </View>

      <View style={{ backgroundColor: theme.surface, paddingHorizontal: 24, paddingTop: 28, paddingBottom: 24, borderRadius: 10, gap: 20 }}>
        <View style={{ gap: 10 }}>
          <Text maxFontSizeMultiplier={1.3} style={{ fontSize: 34, lineHeight: 43, fontWeight: '800', letterSpacing: -1.3 }}>최저가도,{"\n"}고급지게.</Text>
          <Text muted>가격 기록을 보고, 지금의 선택을 더 선명하게.</Text>
        </View>
        <SearchEntry onPress={() => router.push('/search')} />
      </View>

      <View style={{ marginTop: 36, gap: 10 }}>
        <SectionHeader title="가격 기록에서 찾은 딜" subtitle="SEOSA 내부 관측 데이터 기반" />
        {loadState === 'loading' ? <LoadingState label="확인된 가격을 불러오는 중…" /> : null}
        {loadState === 'error' ? <ErrorState message={error} onRetry={retry} /> : null}
        {loadState === 'success' && deals.length === 0 ? <View style={{ paddingVertical: 26, borderTopWidth: 1, borderTopColor: theme.border }}><Text muted>지금 표시할 딜이 없어요. 수집된 가격이 쌓이면 여기에 나타납니다.</Text></View> : null}
        {loadState === 'success' ? deals.map((deal, index) => {
          const product: Product = { title: deal.title, lprice: deal.price, mall: deal.mall, image: deal.image, productId: deal.productId };
          const note = `${dealLabel[deal.status] || deal.status}${deal.reason ? ` · ${deal.reason}` : ''}`;
          return <ProductCard key={`${deal.productId || deal.title}-${index}`} product={product} note={note} onPress={deal.productId ? () => router.push({ pathname: '/product/[id]', params: { id: deal.productId!, mall: deal.mall } }) : undefined} />;
        }) : null}
      </View>

      <View style={{ marginTop: 36, paddingTop: 22, borderTopWidth: 1, borderTopColor: theme.border, gap: 14 }}>
        <SectionHeader title="SEOSA의 가격 신호" subtitle="상품 상세에서 가격 기록이 충분할 때 표시합니다" />
        <View style={{ gap: 12 }}>
          {signals.map(([code, detail]) =>
            <View key={code} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ minWidth: 72 }}><VerdictBadge verdict={code} /></View>
              <Text muted style={{ flex: 1, fontSize: 13, lineHeight: 19 }}>{detail}</Text>
            </View>
          )}
        </View>
      </View>
    </ScrollView>
  </Screen>;
}
