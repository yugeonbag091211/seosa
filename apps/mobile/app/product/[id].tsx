import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Image, Pressable, ScrollView, View } from 'react-native';
import { ErrorState, LoadingState, Screen, Text } from '../../components/ui';
import { api, type ProductDetail, userMessage } from '../../lib/api';
import { useTheme } from '../../lib/theme';

export default function ProductPage() {
  const { id, mall } = useLocalSearchParams<{ id: string; mall?: string }>();
  const [loadedDetail, setDetail] = useState<ProductDetail | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const theme = useTheme();
  useEffect(() => {
    const controller = new AbortController();
    if (!id) return () => controller.abort();
    api.product(id, mall, controller.signal).then(setDetail).catch(err => { if (!controller.signal.aborted) setError(userMessage(err)); });
    return () => controller.abort();
  }, [id, mall, attempt]);

  const detail = loadedDetail?.product.productId === id ? loadedDetail : null;
  const visibleError = !id ? '상품 식별자가 없어요.' : error;
  return <Screen>
    <Pressable accessibilityRole="button" onPress={() => router.canGoBack() ? router.back() : router.replace('/')} style={{ paddingVertical: 12 }}><Text>← 뒤로</Text></Pressable>
    {visibleError ? <ErrorState message={visibleError} onRetry={() => { setError(''); setDetail(null); setAttempt(x => x + 1); }} /> : null}
    {!visibleError && !detail ? <LoadingState /> : null}
    {detail ? <ScrollView contentContainerStyle={{ gap: 24, paddingBottom: 40 }}>
      {detail.product.image && /^https:\/\//.test(detail.product.image) ? <Image source={{ uri: detail.product.image }} resizeMode="contain" style={{ width: '100%', height: 260, backgroundColor: theme.surface, borderRadius: 12 }} /> : null}
      <View style={{ gap: 8 }}>
        <Text muted>{detail.product.mallLabel || detail.product.mall}</Text>
        <Text title style={{ fontSize: 24, lineHeight: 32 }}>{detail.product.title}</Text>
        <Text style={{ fontSize: 26, fontWeight: '700' }}>{Number(detail.product.lprice).toLocaleString('ko-KR')}원</Text>
        <Text muted style={{ fontSize: 12 }}>상품의 표시 가격입니다. 구매처 가격은 달라질 수 있어요.</Text>
      </View>
      {detail.points.length > 0 && detail.deal && detail.deal.verdict !== 'UNKNOWN' ? <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 20 }}>
        <Text muted style={{ fontSize: 12 }}>SEOSA 판단 · {detail.deal.verdict}</Text>
        <Text style={{ fontSize: 18, fontWeight: '700', color: detail.deal.verdict === 'DONT_BUY' ? theme.warning : theme.text }}>{detail.deal.label}</Text>
        {detail.deal.reasons.map((reason, i) => <Text key={`reason-${i}`} muted>{reason}</Text>)}
        {detail.deal.cautions.map((caution, i) => <Text key={`caution-${i}`} style={{ color: theme.warning }}>{caution}</Text>)}
      </View> : null}
      <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 20 }}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>가격 기록</Text>
        {detail.points.length === 0 ? <Text muted>아직 관측된 가격 기록이 없어요.</Text> : detail.points.slice(-5).reverse().map(point => <View key={point.date} style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text muted>{point.date}</Text><Text>{Number(point.price).toLocaleString('ko-KR')}원</Text></View>)}
        <Text muted style={{ fontSize: 12 }}>최근 5개 관측일 · 그래프는 다음 단계에서 제공</Text>
      </View>
    </ScrollView> : null}
  </Screen>;
}
