import { memo } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { tileWidth } from '../lib/home';
import { mallColor, space, type as t, useTheme } from '../lib/theme';
import type { Product } from '../lib/types';
import { AppText } from './AppText';
import { DropLabel, Price } from './Price';
import { openProduct } from './ProductRow';
import { Thumb } from './Thumb';

/**
 * A product as a card in a horizontal rail (the web's .grid card, narrowed to a column).
 * Same reading order and same tap as ProductRow: price → change → name → seller, and the tap
 * opens the product screen — never the purchase link directly. The card widens with the system
 * text size (lib/home.ts tileWidth) so a large price stays on one line.
 */
export const ProductTile = memo(function ProductTile({ product }: { product: Product }) {
  const theme = useTheme();
  const width = tileWidth(useWindowDimensions().fontScale);
  const change = product.priceChange;
  return (
    <Pressable
      onPress={() => openProduct(product)}
      style={({ pressed }) => [{ width, opacity: pressed ? 0.6 : 1 }]}
      accessibilityRole="button"
      accessibilityLabel={`${product.title}, ${product.mallLabel}, ${product.price.toLocaleString('ko-KR')}원`}
    >
      <Thumb uri={product.image} title={product.title} size={width} />
      <View style={styles.body}>
        <Price value={product.price} />
        {change ? <DropLabel amount={change.dropAmount} pct={change.dropPct} /> : null}
        <AppText style={t.footnote} numberOfLines={2}>{product.title}</AppText>
        <AppText style={[t.caption, { color: mallColor(theme, product.mall), fontWeight: '600' }]} numberOfLines={1}>{product.mallLabel}</AppText>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  body: { gap: 2, marginTop: space.sm },
});
