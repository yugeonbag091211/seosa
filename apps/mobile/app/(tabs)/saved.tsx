import { router } from 'expo-router';
import { useMemo, useState } from 'react';
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
import { savedAsProduct } from '../../lib/products';
import { useLatestPrices } from '../../lib/queries';
import { arrangeSaved, savedKey, savedStatus, type SavedSort } from '../../lib/savedModel';
import { mallColor, space, type as t, useTheme } from '../../lib/theme';

const SORTS: readonly { value: SavedSort; label: string }[] = [
  { value: 'recent', label: '최근 저장' },
  { value: 'drop', label: '많이 내린 순' },
  { value: 'price', label: '낮은 가격 순' },
];

/**
 * Saved products, kept on this device. The newest recorded price per option comes from
 * /api/history-batch (the web's wish refresh); without a server record the saved price is
 * shown and labelled as such.
 */
export default function Saved() {
  const theme = useTheme();
  const { saved, removeSaved } = useLocalData();
  const latest = useLatestPrices(saved.map(savedKey));
  const [sort, setSort] = useState<SavedSort>('recent');
  const [onlyDropped, setOnlyDropped] = useState(false);
  const visible = useMemo(
    () => arrangeSaved(saved, latest.data, sort, onlyDropped),
    [saved, latest.data, sort, onlyDropped],
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="저장" />
      <FlatList
        data={visible}
        keyExtractor={savedKey}
        ItemSeparatorComponent={Separator}
        refreshControl={<RefreshControl refreshing={latest.isRefetching} onRefresh={() => latest.refetch()} tintColor={theme.faint} />}
        ListHeaderComponent={saved.length ? (
          <View style={[styles.filters, { borderBottomColor: theme.line }]}>
            <View style={styles.chips}>
              {SORTS.map(option => {
                const active = sort === option.value;
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => setSort(option.value)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`저장 상품 ${option.label} 정렬`}
                    style={({ pressed }) => [
                      styles.chip,
                      {
                        borderColor: active ? theme.control : theme.line2,
                        backgroundColor: active ? theme.control : theme.bg,
                        opacity: pressed ? 0.6 : 1,
                      },
                    ]}
                  >
                    <AppText style={[t.caption, { color: active ? theme.onControl : theme.ink, fontWeight: '600' }]}>{option.label}</AppText>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.filterLine}>
              <Pressable
                onPress={() => setOnlyDropped(v => !v)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: onlyDropped }}
                accessibilityLabel="가격 내려간 상품만 보기"
                style={({ pressed }) => [
                  styles.dropFilter,
                  {
                    borderColor: onlyDropped ? theme.down : theme.line2,
                    backgroundColor: onlyDropped ? theme.downBg : theme.bg,
                    opacity: pressed ? 0.6 : 1,
                  },
                ]}
              >
                <AppText style={[t.caption, { color: onlyDropped ? theme.down : theme.ink, fontWeight: '600' }]}>가격 내려간 상품만</AppText>
              </Pressable>
              <AppText tone="faint" style={t.caption}>{visible.length}/{saved.length}개</AppText>
            </View>
          </View>
        ) : null}
        renderItem={({ item }) => {
          const status = savedStatus(item, latest.data?.[savedKey(item)]);
          const price = status.latest ? status.latest.price : item.savedPrice;
          return (
            <Pressable onPress={() => openProduct(savedAsProduct(item, status.latest))} accessibilityRole="button" style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}>
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
        ListEmptyComponent={saved.length ? (
          <EmptyState title="가격이 내려간 저장 상품이 없어요" detail="최신 가격이 저장할 때보다 낮아지면 여기에 모아 보여드려요.">
            <Pressable onPress={() => setOnlyDropped(false)} accessibilityRole="button" style={({ pressed }) => [styles.cta, { borderColor: theme.line2, opacity: pressed ? 0.6 : 1 }]}>
              <AppText style={[t.footnote, { fontWeight: '600' }]}>전체 저장 상품 보기</AppText>
            </Pressable>
          </EmptyState>
        ) : (
          <EmptyState title="저장한 상품이 없어요" detail="상품 화면에서 저장하면 가격 변화를 여기서 볼 수 있어요.">
            <Pressable onPress={() => router.navigate({ pathname: '/search', params: { focus: '1' } })} accessibilityRole="button" style={({ pressed }) => [styles.cta, { borderColor: theme.line2, opacity: pressed ? 0.6 : 1 }]}>
              <AppText style={[t.footnote, { fontWeight: '600' }]}>상품 찾아보기</AppText>
            </Pressable>
          </EmptyState>
        )}
        ListFooterComponent={saved.length ? (
          <View>
            <AppText tone="faint" style={[t.caption, { paddingHorizontal: space.gutter, paddingTop: space.lg }]}>저장 목록은 이 기기에만 보관돼요.</AppText>
            <AffiliateNote />
          </View>
        ) : null}
        contentContainerStyle={{ paddingBottom: space.section, flexGrow: visible.length ? 0 : 1 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  filters: { gap: space.sm, paddingHorizontal: space.gutter, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 999, borderWidth: 1 },
  filterLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  dropFilter: { minHeight: 30, justifyContent: 'center', paddingHorizontal: 11, borderRadius: 999, borderWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingHorizontal: space.gutter, paddingVertical: space.md },
  body: { flex: 1, gap: 3 },
  cta: { marginTop: space.lg, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 999, borderWidth: 1 },
});
