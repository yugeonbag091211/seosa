import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '../../components/AppText';
import { BuyButton } from '../../components/BuyButton';
import { Icon } from '../../components/Icon';
import { DropLabel, Price } from '../../components/Price';
import { PriceChart } from '../../components/PriceChart';
import { Thumb } from '../../components/Thumb';
import { AffiliateNote, EmptyState, ErrorState, Hairline, Loading } from '../../components/ui';
import { setAiContext } from '../../lib/aiContext';
import { rangeSummary } from '../../lib/chart';
import { digits, observedLabel } from '../../lib/format';
import { parseProductKey, sameProduct } from '../../lib/identity';
import { useLocalData } from '../../lib/local';
import { recallProduct } from '../../lib/productCache';
import { useCatalogProduct, usePriceHistory } from '../../lib/queries';
import { mallColor, radius, space, type as t, useTheme } from '../../lib/theme';
import type { Product } from '../../lib/types';

/**
 * Product detail — the web's price modal as a screen.
 *
 * Identity: the route carries productId|mall|vendorItemId. The row the user tapped travels
 * with it (lib/productCache). Opened cold (deep link, restored state) the catalog row is used
 * only if it is the same option; otherwise no price is shown for it.
 *
 * Headline price follows the web modal (Modal.open → AppState.modalPrice): the latest recorded
 * point for this option once history arrives, the row's own price until then — always with
 * the date it was observed.
 */
export default function ProductDetail() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { key } = useLocalSearchParams<{ key: string }>();
  const id = useMemo(() => parseProductKey(String(key || '')), [key]);
  const tapped = useMemo(() => recallProduct(String(key || '')), [key]);

  const catalog = useCatalogProduct(id, !tapped && !!id);
  const catalogMatches = !!catalog.data && !!id && sameProduct(catalog.data.product, id);
  const product: Product | null = tapped || (catalogMatches ? catalog.data!.product : null);

  const history = usePriceHistory(product ? id : null);
  const { isSaved, toggleSaved } = useLocalData();

  if (!id) return <EmptyState title="상품을 찾을 수 없어요" />;
  if (!product) {
    if (catalog.isPending) return <Loading />;
    if (catalog.isError) return <ErrorState error={catalog.error} onRetry={() => catalog.refetch()} />;
    return (
      <EmptyState
        title={catalog.data ? '이 옵션의 가격 정보를 찾지 못했어요' : '상품을 찾을 수 없어요'}
        detail={catalog.data ? '같은 상품의 다른 옵션 가격은 보여 드리지 않아요. 검색에서 다시 찾아 주세요.' : undefined}
      />
    );
  }

  const points = history.data?.points || [];
  const last = points.length ? points[points.length - 1] : null;
  const headline = last ? last.price : product.price;
  const asOf = last ? `${observedLabel(last.date)} 기록` : product.collectedAt ? `${observedLabel(product.collectedAt)} 기준` : '';
  const deal = history.data?.deal || null;
  const summary = rangeSummary(points);
  const saved = isSaved(product);
  // The drop label belongs to the row's price; once history moves the headline, it no longer applies.
  const showDrop = !!product.priceChange && headline === product.price;

  const askAi = () => {
    setAiContext({ source: 'product', keyword: '', products: [product] });
    router.push('/concierge');
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => toggleSaved(product)} hitSlop={12} accessibilityRole="button" accessibilityLabel={saved ? '저장 해제' : '저장'} accessibilityState={{ selected: saved }}>
              <Icon name={saved ? 'bookmarkFill' : 'bookmark'} size={24} color={theme.ink} />
            </Pressable>
          ),
        }}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: 120 + insets.bottom }}>
        <View style={styles.hero}>
          <Thumb uri={product.image} title={product.title} size={Math.min(width - space.gutter * 2, 320)} />
        </View>

        <View style={styles.pad}>
          <AppText style={[t.caption, { color: mallColor(theme, product.mall), fontWeight: '600' }]}>{product.mallLabel}</AppText>
          <AppText style={[t.headline, { marginTop: 4 }]}>{product.title}</AppText>

          <View style={styles.priceBlock}>
            <Price value={headline} size="hero" />
            {asOf ? <AppText tone="faint" style={t.footnote}>{asOf}</AppText> : null}
            {showDrop ? <DropLabel amount={product.priceChange!.dropAmount} pct={product.priceChange!.dropPct} /> : null}
            {product.listPrice > headline && headline === product.price ? (
              <AppText tone="faint" style={t.footnote}>정가 <AppText tone="faint" style={[t.footnote, { textDecorationLine: 'line-through' }]}>{digits(product.listPrice)}원</AppText></AppText>
            ) : null}
          </View>

          {deal ? (
            <View style={[styles.verdict, { borderLeftColor: theme.ink }]}>
              <AppText style={[t.callout, { fontWeight: '700' }]}>{deal.label}</AppText>
              {deal.reasons.slice(0, 3).map(r => <AppText key={r} tone="soft" style={t.footnote}>{r}</AppText>)}
              {deal.cautions.slice(0, 2).map(c => <AppText key={c} tone="faint" style={t.footnote}>{c}</AppText>)}
            </View>
          ) : null}
        </View>

        <View style={[styles.pad, styles.section]}>
          <AppText style={t.title}>가격 기록</AppText>
          <View style={{ marginTop: space.md }}>
            {history.isPending ? <Loading style={{ paddingVertical: 60 }} /> : history.isError ? (
              <ErrorState error={history.error} onRetry={() => history.refetch()} />
            ) : points.length === 0 ? (
              <AppText tone="soft" style={[t.callout, { paddingVertical: space.lg }]}>아직 이 옵션의 가격 기록이 없어요.</AppText>
            ) : (
              <PriceChart points={points} />
            )}
          </View>
          {summary && summary.days > 1 ? (
            <View style={[styles.stats, { borderColor: theme.line }]}>
              <Stat label="최저" value={`${digits(summary.low)}원`} sub={observedLabel(summary.lowDate)} />
              <Stat label="최고" value={`${digits(summary.high)}원`} />
              <Stat label="관측" value={`${summary.days}회`} />
            </View>
          ) : null}
          {product.trust?.label ? (
            <AppText tone="faint" style={[t.footnote, { marginTop: space.md }]}>가격 신뢰도 · {product.trust.label}</AppText>
          ) : null}
        </View>

        <Pressable onPress={askAi} style={({ pressed }) => [styles.ai, { borderColor: theme.line, opacity: pressed ? 0.6 : 1 }]} accessibilityRole="button">
          <Icon name="sparkle" size={20} color={theme.ink} />
          <View style={{ flex: 1 }}>
            <AppText style={[t.callout, { fontWeight: '600' }]}>이 상품, 지금 사도 될까?</AppText>
            <AppText tone="soft" style={t.footnote}>AI가 가격 기록을 근거로 답해 드려요</AppText>
          </View>
          <Icon name="chevronRight" size={16} color={theme.faint} />
        </Pressable>

        <Hairline />
        <AffiliateNote />
      </ScrollView>

      {product.link ? (
        <View style={[styles.buyBar, { paddingBottom: insets.bottom + space.sm, backgroundColor: theme.bg, borderTopColor: theme.line }]}>
          <BuyButton link={product.link} mallLabel={product.mallLabel} />
        </View>
      ) : null}
    </View>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={{ flex: 1 }}>
      <AppText tone="faint" style={t.caption}>{label}</AppText>
      <AppText style={[t.callout, { fontWeight: '600', marginTop: 2 }]}>{value}</AppText>
      {sub ? <AppText tone="faint" style={t.caption}>{sub}</AppText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: space.md },
  pad: { paddingHorizontal: space.gutter },
  priceBlock: { marginTop: space.lg, gap: 4 },
  verdict: { marginTop: space.xl, paddingLeft: space.md, borderLeftWidth: 2, gap: 4 },
  section: { marginTop: space.section },
  stats: { flexDirection: 'row', marginTop: space.lg, paddingTop: space.md, borderTopWidth: StyleSheet.hairlineWidth },
  ai: { flexDirection: 'row', alignItems: 'center', gap: space.md, margin: space.gutter, marginTop: space.section, padding: space.lg, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth * 2 },
  buyBar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', paddingHorizontal: space.gutter, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
});
