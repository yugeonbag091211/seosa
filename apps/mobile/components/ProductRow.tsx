import { router } from 'expo-router';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { rememberProduct } from '../lib/productCache';
import { mallColor, space, type as t, useTheme } from '../lib/theme';
import type { Product } from '../lib/types';
import { AppText } from './AppText';
import { DropLabel, Price } from './Price';
import { Thumb } from './Thumb';

export function openProduct(p: Product) {
  const key = rememberProduct(p);
  if (key) router.push({ pathname: '/product/[key]', params: { key } });
}

/**
 * One product in a list. Reading order follows the web card (5th pass):
 * price → change → name → seller. Rows are separated by hairlines, not boxed.
 */
export const ProductRow = memo(function ProductRow({ product, trailing }: { product: Product; trailing?: React.ReactNode }) {
  const theme = useTheme();
  const change = product.priceChange;
  return (
    <Pressable
      onPress={() => openProduct(product)}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
      accessibilityRole="button"
      accessibilityLabel={`${product.title}, ${product.mallLabel}, ${product.price.toLocaleString('ko-KR')}원`}
    >
      <Thumb uri={product.image} title={product.title} size={76} />
      <View style={styles.body}>
        <Price value={product.price} />
        {change ? <DropLabel amount={change.dropAmount} pct={change.dropPct} /> : null}
        <AppText style={[t.callout, styles.title]} numberOfLines={2}>{product.title}</AppText>
        <AppText style={[t.caption, { color: mallColor(theme, product.mall), fontWeight: '600' }]} numberOfLines={1}>
          {product.mallLabel}
          {product.isRocket ? <AppText tone="faint" style={t.caption}>  ·  로켓배송</AppText> : null}
        </AppText>
      </View>
      {trailing}
    </Pressable>
  );
});

export function Separator() {
  const theme = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.line, marginLeft: space.gutter + 76 + space.md }} />;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingHorizontal: space.gutter, paddingVertical: space.md },
  body: { flex: 1, gap: 3 },
  title: { marginTop: 2 },
});
