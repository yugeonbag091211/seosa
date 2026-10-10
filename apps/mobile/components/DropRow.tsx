import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { digits, observedLabel } from '../lib/format';
import { mallColor, radius, space, type as t, useTheme } from '../lib/theme';
import { dropAsProduct } from '../lib/products';
import type { TodayDrop } from '../lib/types';
import { AppText } from './AppText';
import { DropLabel, Price } from './Price';
import { openProduct } from './ProductRow';
import { Thumb } from './Thumb';

/**
 * «오늘 가격 하락» row: previous → current, amount and percent, and when the previous price was seen.
 * All four numbers are the server's (api/_todaydrop.js); nothing is computed here.
 */
export const DropRow = memo(function DropRow({ drop, rank }: { drop: TodayDrop; rank?: number }) {
  const theme = useTheme();
  const since = observedLabel(drop.previousAt);
  return (
    <Pressable
      onPress={() => openProduct(dropAsProduct(drop))}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
      accessibilityRole="button"
      accessibilityLabel={`${drop.title}, ${digits(drop.previousPrice)}원에서 ${digits(drop.currentPrice)}원으로 내림`}
    >
      {rank ? <AppText mono tone="faint" style={styles.rank}>{String(rank).padStart(2, '0')}</AppText> : null}
      <Thumb uri={drop.image} title={drop.title} size={68} />
      <View style={styles.body}>
        <View style={styles.priceLine}>
          <Price value={drop.currentPrice} />
          <AppText tone="faint" style={[t.footnote, styles.prev]}>{digits(drop.previousPrice)}원</AppText>
        </View>
        <DropLabel amount={drop.dropAmount} pct={drop.dropPct} />
        <AppText style={t.callout} numberOfLines={2}>{drop.title}</AppText>
        <View style={styles.meta}>
          <AppText style={[t.caption, { color: mallColor(theme, drop.mall), fontWeight: '600' }]} numberOfLines={1}>{drop.mallLabel}</AppText>
          {since ? <AppText tone="faint" style={t.caption}>· {since} 대비</AppText> : null}
          {drop.verified ? (
            <View style={[styles.badge, { backgroundColor: theme.brandBg }]}>
              <AppText style={[t.caption, { color: theme.brand, fontWeight: '600' }]}>SEOSA 검증</AppText>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingHorizontal: space.gutter, paddingVertical: space.md },
  rank: { width: 20, fontSize: 12, marginTop: 4 },
  body: { flex: 1, gap: 3 },
  // Wraps instead of overflowing when both prices are long (eight-digit won on a 320 dp phone).
  priceLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: space.sm },
  prev: { textDecorationLine: 'line-through' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  badge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.sm },
});
