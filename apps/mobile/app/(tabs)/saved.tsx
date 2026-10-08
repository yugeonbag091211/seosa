import { router } from 'expo-router';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { AppText } from '../../components/AppText';
import { Icon } from '../../components/Icon';
import { Price } from '../../components/Price';
import { openProduct, Separator } from '../../components/ProductRow';
import { ScreenHeader } from '../../components/Screen';
import { Thumb } from '../../components/Thumb';
import { AffiliateNote, EmptyState } from '../../components/ui';
import { digits, observedLabel } from '../../lib/format';
import { useLocalData } from '../../lib/local';
import { useLatestPrices } from '../../lib/queries';
import { savedKey, savedStatus, type SavedItem } from '../../lib/savedModel';
import { mallColor, space, type as t, useTheme } from '../../lib/theme';
import type { PricePoint, Product } from '../../lib/types';

function asProduct(item: SavedItem, latest: PricePoint | null): Product {
  return {
    productId: item.productId, mall: item.mall, vendorItemId: item.vendorItemId,
    title: item.title, mallLabel: item.mallLabel, image: item.image, link: item.link,
    // Until the detail screen loads history, it shows the newest price we can date.
    price: latest ? latest.price : item.savedPrice,
    collectedAt: latest ? latest.date : item.savedAt,
    listPrice: 0, savePct: 0, isRocket: null, trust: null, priceChange: null,
  };
}

/**
 * Saved products, kept on this device. The newest recorded price per option comes from
 * /api/history-batch (the web's wish refresh); without a server record the saved price is
 * shown and labelled as such.
 */
export default function Saved() {
  const theme = useTheme();
  const { saved, removeSaved } = useLocalData();
  const latest = useLatestPrices(saved.map(savedKey));

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="저장" />
      <FlatList
        data={saved}
        keyExtractor={savedKey}
        ItemSeparatorComponent={Separator}
        refreshControl={<RefreshControl refreshing={latest.isRefetching} onRefresh={() => latest.refetch()} tintColor={theme.faint} />}
        renderItem={({ item }) => {
          const status = savedStatus(item, latest.data?.[savedKey(item)]);
          const price = status.latest ? status.latest.price : item.savedPrice;
          return (
            <Pressable onPress={() => openProduct(asProduct(item, status.latest))} accessibilityRole="button" style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}>
              <Thumb uri={item.image} title={item.title} size={76} />
              <View style={styles.body}>
                <Price value={price} />
                <AppText tone="faint" style={t.caption}>
                  {status.latest ? `${observedLabel(status.latest.date)} 기록` : `저장할 때 가격 · ${observedLabel(item.savedAt)}`}
                </AppText>
                {status.change ? (
                  <AppText style={[t.footnote, { color: status.change < 0 ? theme.down : theme.up, fontWeight: '600' }]}>
                    저장 후 {status.change < 0 ? '▼' : '▲'} {digits(Math.abs(status.change))}원
                  </AppText>
                ) : null}
                <AppText style={t.callout} numberOfLines={2}>{item.title}</AppText>
                <AppText style={[t.caption, { color: mallColor(theme, item.mall), fontWeight: '600' }]}>{item.mallLabel}</AppText>
              </View>
              <Pressable onPress={() => removeSaved(item)} hitSlop={12} accessibilityRole="button" accessibilityLabel={`${item.title} 저장 해제`}>
                <Icon name="bookmarkFill" size={22} color={theme.ink} />
              </Pressable>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <EmptyState title="저장한 상품이 없어요" detail="상품 화면에서 저장하면 가격 변화를 여기서 볼 수 있어요.">
            <Pressable onPress={() => router.navigate({ pathname: '/search', params: { focus: '1' } })} accessibilityRole="button" style={({ pressed }) => [styles.cta, { borderColor: theme.line2, opacity: pressed ? 0.6 : 1 }]}>
              <AppText style={[t.footnote, { fontWeight: '600' }]}>상품 찾아보기</AppText>
            </Pressable>
          </EmptyState>
        }
        ListFooterComponent={saved.length ? (
          <View>
            <AppText tone="faint" style={[t.caption, { paddingHorizontal: space.gutter, paddingTop: space.lg }]}>저장 목록은 이 기기에만 보관돼요.</AppText>
            <AffiliateNote />
          </View>
        ) : null}
        contentContainerStyle={{ paddingBottom: space.section, flexGrow: saved.length ? 0 : 1 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingHorizontal: space.gutter, paddingVertical: space.md },
  body: { flex: 1, gap: 3 },
  cta: { marginTop: space.lg, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 999, borderWidth: 1 },
});
