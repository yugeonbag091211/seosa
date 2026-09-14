import { useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ScrollView, useWindowDimensions, View } from 'react-native';
import { PriceChart } from '../../components/PriceChart';
import {
  AppHeader, BackButton, ErrorState, FONT_SCALE, formatPrice, LedgerRow, LoadingState, MallLine, ProductImage, Screen, SectionHead, StatRow, Text,
  TrendBox, TrustPanel, VerdictBox,
} from '../../components/ui';
import { api, ApiError, productFromParam, type ProductDetail, userMessage } from '../../lib/api';
import { productDetailView } from '../../lib/format';
import { typography, useTheme } from '../../lib/theme';

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value || '').trim();
}

const SIDE = 18; // .modal-body side padding on mobile

/**
 * The web opens a product as the «가격의 서사» modal: verdict → trust → chart → PRICE TREND → 최저/평균/최고.
 * The app shows the same blocks in that order, preceded by the product itself (image, name, price, mall —
 * as on the web /p/ page) and followed by the recent observations and the full server reasons.
 */
export default function ProductPage() {
  const params = useLocalSearchParams<{ id: string; mall?: string; product?: string }>();
  const id = firstParam(params.id);
  const mall = firstParam(params.mall) || undefined;
  // The card that was tapped already carries the exact option (vendorItemId included); re-resolving
  // by productId+mall alone can land on a different option sharing that id, so it is used as-is.
  const passedProduct = useMemo(() => {
    const parsed = productFromParam(firstParam(params.product) || undefined);
    return parsed && parsed.productId === id ? parsed : null;
  }, [params.product, id]);
  const [loadedDetail, setDetail] = useState<ProductDetail | null>(null);
  const [failure, setFailure] = useState<{ message: string; retryable: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const theme = useTheme();
  const { width } = useWindowDimensions();
  useEffect(() => {
    const controller = new AbortController();
    if (!id) return () => controller.abort();
    const onError = (err: unknown) => {
      if (controller.signal.aborted) return;
      // A missing product will not appear by retrying; everything else (timeout, outage, network) might.
      setFailure({ message: userMessage(err), retryable: !(err instanceof ApiError && err.kind === 'not_found') });
    };
    if (passedProduct) {
      api.history(passedProduct, controller.signal).then(result => {
        setDetail({ product: passedProduct, points: result.points, deal: result.deal });
      }).catch(onError);
    } else {
      api.product(id, mall, controller.signal).then(setDetail).catch(onError);
    }
    return () => controller.abort();
  }, [id, mall, attempt, passedProduct]);

  const detail = loadedDetail?.product.productId === id ? loadedDetail : null;
  const visibleFailure = !id ? { message: '상품 식별자가 없어요.', retryable: false } : failure;
  const derived = useMemo(() => (detail ? productDetailView(detail.points, detail.deal) : null), [detail]);
  const deal = detail?.deal || null;
  const product = detail?.product;

  return <Screen padded={false}>
    <AppHeader>
      <BackButton />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text accessibilityRole="header" maxFontSizeMultiplier={FONT_SCALE.title} style={[typography.modalTitle, { color: theme.text }]}>가격의 서사</Text>
        {product ? <Text numberOfLines={1} maxFontSizeMultiplier={FONT_SCALE.title} style={[typography.modalSub, { color: theme.faint }]}>
          {product.title} · {product.mallLabel || product.mall}
        </Text> : null}
      </View>
    </AppHeader>
    {visibleFailure ? <View style={{ paddingHorizontal: SIDE }}>
      <ErrorState message={visibleFailure.message} onRetry={visibleFailure.retryable ? () => { setFailure(null); setDetail(null); setAttempt(x => x + 1); } : undefined} />
    </View> : null}
    {!visibleFailure && !detail ? <LoadingState label="가격 기록을 불러오는 중…" /> : null}
    {detail && product && derived ? <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: SIDE, paddingTop: 16, paddingBottom: 48 }}>
      <View style={{ height: Math.max(180, Math.min(width - SIDE * 2, 300)), borderRadius: 8, backgroundColor: theme.surface, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <ProductImage uri={product.image} fallbackSize={54} style={{ width: '82%', height: '82%' }} />
      </View>

      <View style={{ marginTop: 18, gap: 6 }}>
        <Text accessibilityRole="header" style={{ fontSize: 20, lineHeight: 28, fontWeight: '700', letterSpacing: -0.2, color: theme.text }}>{product.title}</Text>
        <Text maxFontSizeMultiplier={FONT_SCALE.title} style={{ fontSize: 32, lineHeight: 40, fontWeight: '800', letterSpacing: -0.64, color: theme.text, fontVariant: ['tabular-nums'] }}>
          {formatPrice(product.lprice)}<Text style={{ fontSize: 16, fontWeight: '400', color: theme.muted }}> 원</Text>
        </Text>
        <MallLine product={product} large />
      </View>

      {derived.verdict ? <View style={{ marginTop: 18 }}><VerdictBox view={derived.verdict} /></View> : null}
      {product.trust ? <View style={{ marginTop: 16 }}><TrustPanel trust={product.trust} /></View> : null}

      <View style={{ marginTop: 20 }}><PriceChart points={detail.points} average={derived.stats?.avg} initialWidth={width - SIDE * 2} /></View>
      {derived.trend ? <View style={{ marginTop: 14 }}><TrendBox trend={derived.trend} /></View> : null}
      {derived.stats && derived.count >= 2 ? <View style={{ marginTop: 16 }}><StatRow stats={derived.stats} /></View> : null}

      <View style={{ marginTop: 36 }}>
        <SectionHead title="최근 관측" sub="가격 기록 기준 · 최근 5일" />
        {derived.observations.length === 0
          ? <Text muted style={{ fontSize: 13 }}>아직 가격 기록이 없어요. 내일부터 쌓입니다.</Text>
          : derived.observations.map(point => <LedgerRow key={point.date} date={point.date} price={point.price} />)}
      </View>

      {deal && (deal.reasons.length > 0 || deal.cautions.length > 0) ? <View style={{ marginTop: 36 }}>
        <SectionHead title="판단 근거" sub="가격·구매 시점 판정은 SEOSA 서버가 수집한 기록으로 계산합니다." />
        <View style={{ gap: 6 }}>
          {deal.reasons.map((reason, i) => <Text key={`r-${i}`} style={{ fontSize: 12.5, lineHeight: 19, color: theme.muted }}>· {reason}</Text>)}
          {deal.cautions.map((caution, i) => <Text key={`c-${i}`} style={{ fontSize: 12.5, lineHeight: 19, color: theme.warning }}>· {caution}</Text>)}
        </View>
      </View> : null}
    </ScrollView> : null}
  </Screen>;
}
