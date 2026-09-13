import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { BrandMark, ErrorState, formatPrice, LoadingState, ProductImage, Screen, Text, VerdictBadge } from '../../components/ui';
import { PriceChart } from '../../components/PriceChart';
import { api, ApiError, type ProductDetail, userMessage } from '../../lib/api';
import { useTheme } from '../../lib/theme';

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value || '').trim();
}

export default function ProductPage() {
  const params = useLocalSearchParams<{ id: string; mall?: string }>();
  const id = firstParam(params.id);
  const mall = firstParam(params.mall) || undefined;
  const [loadedDetail, setDetail] = useState<ProductDetail | null>(null);
  const [failure, setFailure] = useState<{ message: string; retryable: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const theme = useTheme();
  const { width } = useWindowDimensions();
  useEffect(() => {
    const controller = new AbortController();
    if (!id) return () => controller.abort();
    api.product(id, mall, controller.signal).then(setDetail).catch(err => {
      if (controller.signal.aborted) return;
      // A missing product will not appear by retrying; everything else (timeout, outage, network) might.
      setFailure({ message: userMessage(err), retryable: !(err instanceof ApiError && err.kind === 'not_found') });
    });
    return () => controller.abort();
  }, [id, mall, attempt]);

  const detail = loadedDetail?.product.productId === id ? loadedDetail : null;
  const visibleFailure = !id ? { message: '상품 식별자가 없어요.', retryable: false } : failure;
  const observations = detail?.points.slice(-5).reverse() || [];
  const deal = detail?.deal || null;
  const hasVerdict = !!detail && detail.points.length > 0 && !!deal && deal.verdict !== 'UNKNOWN';
  return <Screen>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: theme.border }}>
      <Pressable accessibilityRole="button" accessibilityLabel="뒤로 가기" hitSlop={8} onPress={() => router.canGoBack() ? router.back() : router.replace('/')} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}><Text style={{ fontSize: 26 }} maxFontSizeMultiplier={1}>‹</Text></Pressable>
      <Text accessibilityRole="header" style={{ fontSize: 15, fontWeight: '700' }}>상품 상세</Text>
      <View style={{ minWidth: 44, alignItems: 'flex-end' }}><BrandMark size={24} decorative /></View>
    </View>
    {visibleFailure ? <ErrorState message={visibleFailure.message} onRetry={visibleFailure.retryable ? () => { setFailure(null); setDetail(null); setAttempt(x => x + 1); } : undefined} /> : null}
    {!visibleFailure && !detail ? <LoadingState label="상품 정보를 불러오는 중…" /> : null}
    {detail ? <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 28, paddingTop: 20, paddingBottom: 44 }}>
      <View style={{ height: Math.max(180, Math.min(width - 48, 310)), backgroundColor: theme.surface, borderRadius: 8, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <ProductImage uri={detail.product.image} fallbackSize={54} style={{ width: '92%', height: '92%' }} />
      </View>
      <View style={{ gap: 8 }}>
        <Text muted style={{ fontSize: 13 }}>{detail.product.mallLabel || detail.product.mall}</Text>
        <Text accessibilityRole="header" style={{ fontSize: 24, lineHeight: 33, fontWeight: '700', letterSpacing: -0.5 }}>{detail.product.title}</Text>
        <Text maxFontSizeMultiplier={1.3} style={{ fontSize: 28, lineHeight: 36, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{formatPrice(detail.product.lprice)}원</Text>
        <Text muted style={{ fontSize: 12 }}>현재 표시 가격 · 구매처 가격은 달라질 수 있어요.</Text>
      </View>
      <View style={{ gap: 14, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 22 }}>
        <Text accessibilityRole="header" style={{ fontSize: 18, fontWeight: '700' }}>SEOSA 가격 판단</Text>
        {hasVerdict && deal ? <View style={{ gap: 10 }}>
          <VerdictBadge verdict={deal.verdict} />
          <Text style={{ fontSize: 20, fontWeight: '700' }}>{deal.label}</Text>
          {deal.reasons.slice(0, 3).map((reason, i) => <Text key={`reason-${i}`} muted>• {reason}</Text>)}
          {deal.cautions.slice(0, 3).map((caution, i) => <Text key={`caution-${i}`} style={{ color: theme.warning }}>• {caution}</Text>)}
        </View> : <View style={{ gap: 8 }}>
          <Text muted>판단을 위해 더 많은 가격 기록이 필요해요.</Text>
          {/* The server still explains why it held back (e.g. too few observations); show that instead of hiding it. */}
          {deal?.reasons.slice(0, 2).map((reason, i) => <Text key={`hold-${i}`} muted style={{ fontSize: 13 }}>• {reason}</Text>)}
        </View>}
      </View>
      <View style={{ gap: 16, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 22 }}>
        <View style={{ gap: 4 }}><Text accessibilityRole="header" style={{ fontSize: 18, fontWeight: '700' }}>최근 가격 추이</Text><Text muted style={{ fontSize: 12 }}>최근 최대 30개 관측일 · 가격 기록 기준</Text></View>
        <PriceChart points={detail.points} />
      </View>
      <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 22 }}>
        <Text accessibilityRole="header" style={{ fontSize: 18, fontWeight: '700', paddingBottom: 4 }}>최근 관측 데이터</Text>
        {observations.length === 0 ? <Text muted>아직 기록이 없어요.</Text> : observations.map((point, i) => <View key={`${point.date}-${i}`} accessible accessibilityLabel={`${point.date} ${formatPrice(point.price)}원`} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border }}><Text muted style={{ fontSize: 13 }}>{point.date}</Text><Text style={{ fontWeight: '600', fontVariant: ['tabular-nums'] }}>{formatPrice(point.price)}원</Text></View>)}
      </View>
    </ScrollView> : null}
  </Screen>;
}
