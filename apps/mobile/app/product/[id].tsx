import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Image, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { BrandMark, ErrorState, LoadingState, Screen, Text, VerdictBadge } from '../../components/ui';
import { PriceChart } from '../../components/PriceChart';
import { api, type ProductDetail, userMessage } from '../../lib/api';
import { useTheme } from '../../lib/theme';

export default function ProductPage() {
  const { id, mall } = useLocalSearchParams<{ id: string; mall?: string }>();
  const [loadedDetail, setDetail] = useState<ProductDetail | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const theme = useTheme();
  const { width } = useWindowDimensions();
  useEffect(() => {
    const controller = new AbortController();
    if (!id) return () => controller.abort();
    api.product(id, mall, controller.signal).then(setDetail).catch(err => { if (!controller.signal.aborted) setError(userMessage(err)); });
    return () => controller.abort();
  }, [id, mall, attempt]);

  const detail = loadedDetail?.product.productId === id ? loadedDetail : null;
  const visibleError = !id ? '상품 식별자가 없어요.' : error;
  const observations = detail?.points.slice(-5).reverse() || [];
  return <Screen>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: theme.border }}>
      <Pressable accessibilityRole="button" accessibilityLabel="뒤로 가기" onPress={() => router.canGoBack() ? router.back() : router.replace('/')} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}><Text style={{ fontSize: 26 }}>‹</Text></Pressable>
      <Text style={{ fontSize: 15, fontWeight: '700' }}>상품 상세</Text>
      <BrandMark size={24} />
    </View>
    {visibleError ? <ErrorState message={visibleError} onRetry={() => { setError(''); setDetail(null); setAttempt(x => x + 1); }} /> : null}
    {!visibleError && !detail ? <LoadingState /> : null}
    {detail ? <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 28, paddingTop: 20, paddingBottom: 44 }}>
      <View style={{ height: Math.min(width - 48, 310), backgroundColor: theme.surface, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }}>
        {detail.product.image && /^https:\/\//.test(detail.product.image) ? <Image source={{ uri: detail.product.image }} resizeMode="contain" style={{ width: '92%', height: '92%' }} /> : <BrandMark size={54} />}
      </View>
      <View style={{ gap: 8 }}>
        <Text muted style={{ fontSize: 13 }}>{detail.product.mallLabel || detail.product.mall}</Text>
        <Text style={{ fontSize: 24, lineHeight: 33, fontWeight: '700', letterSpacing: -0.5 }}>{detail.product.title}</Text>
        <Text style={{ fontSize: 28, lineHeight: 36, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{Number(detail.product.lprice).toLocaleString('ko-KR')}원</Text>
        <Text muted style={{ fontSize: 12 }}>현재 표시 가격 · 구매처 가격은 달라질 수 있어요.</Text>
      </View>
      <View style={{ gap: 14, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 22 }}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>SEOSA 가격 판단</Text>
        {detail.points.length > 0 && detail.deal && detail.deal.verdict !== 'UNKNOWN' ? <View style={{ gap: 10 }}>
          <VerdictBadge verdict={detail.deal.verdict} />
          <Text style={{ fontSize: 20, fontWeight: '700' }}>{detail.deal.label}</Text>
          {detail.deal.reasons.slice(0, 3).map((reason, i) => <Text key={`reason-${i}`} muted>• {reason}</Text>)}
          {detail.deal.cautions.slice(0, 3).map((caution, i) => <Text key={`caution-${i}`} style={{ color: theme.warning }}>• {caution}</Text>)}
        </View> : <Text muted>판단을 위해 더 많은 가격 기록이 필요해요.</Text>}
      </View>
      <View style={{ gap: 16, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 22 }}>
        <View style={{ gap: 4 }}><Text style={{ fontSize: 18, fontWeight: '700' }}>최근 가격 추이</Text><Text muted style={{ fontSize: 12 }}>최근 최대 30개 관측일 · 가격 기록 기준</Text></View>
        <PriceChart points={detail.points} />
      </View>
      <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 22 }}>
        <Text style={{ fontSize: 18, fontWeight: '700', paddingBottom: 4 }}>최근 관측 데이터</Text>
        {observations.length === 0 ? <Text muted>아직 기록이 없어요.</Text> : observations.map(point => <View key={point.date} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border }}><Text muted style={{ fontSize: 13 }}>{point.date}</Text><Text style={{ fontWeight: '600', fontVariant: ['tabular-nums'] }}>{point.price.toLocaleString('ko-KR')}원</Text></View>)}
      </View>
    </ScrollView> : null}
  </Screen>;
}
