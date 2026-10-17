import { memo } from 'react';
import { Alert, Linking, Pressable, StyleSheet, View } from 'react-native';
import type { CommunityDeal } from '../lib/types';
import { radius, space, type as t, useTheme } from '../lib/theme';
import { AppText } from './AppText';
import { Icon } from './Icon';
import { Thumb } from './Thumb';

/** Community reports are NOT our verified price observations.
 * Open the original post, never a guessed merchant or product URL.
 */
export const CommunityDealRow = memo(function CommunityDealRow({ deal }: { deal: CommunityDeal }) {
  const theme = useTheme();
  const openSource = () => {
    void Linking.openURL(deal.sourceUrl).catch(() => Alert.alert('원문을 열 수 없어요', '연결 상태를 확인해 주세요.'));
  };
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${deal.title}, ${deal.price > 0 ? deal.price.toLocaleString('ko-KR') + '원' : '가격 확인 필요'}, ${deal.verified ? 'SEOSA 검증' : '가격 검증 전'}, 원문 보기`}
      onPress={openSource}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.65 : 1 }]}
    >
      <Thumb uri={deal.image} title={deal.title} size={88} />
      <View style={styles.body}>
        <View style={styles.badges}>
          <AppText style={[styles.badge, { backgroundColor: theme.surface, color: theme.soft }]}>커뮤니티 발견</AppText>
          <AppText style={[styles.badge, { backgroundColor: deal.verified ? theme.downBg : theme.surface, color: deal.verified ? theme.down : theme.faint }]}>
            {deal.verified ? 'SEOSA 검증' : '가격 검증 전'}
          </AppText>
        </View>
        <AppText style={t.callout} numberOfLines={2}>{deal.title}</AppText>
        <AppText style={[t.price, { marginTop: 2 }]}>{deal.price > 0 ? `${deal.price.toLocaleString('ko-KR')}원` : '가격 확인 필요'}</AppText>
        <View style={styles.foot}>
          <AppText tone="faint" style={t.caption} numberOfLines={1}>{deal.mall || deal.source || '커뮤니티'}</AppText>
          <Icon name="external" size={14} color={theme.faint} />
          <AppText tone="soft" style={t.caption}>원문</AppText>
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.gutter, paddingVertical: space.md },
  body: { flex: 1, gap: space.xs, justifyContent: 'center' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  badge: { borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 3, fontSize: 10, lineHeight: 14, fontWeight: '600' },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
});
