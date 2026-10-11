import { FlatList, RefreshControl, View } from 'react-native';
import { AppText } from '../../components/AppText';
import { DropRow } from '../../components/DropRow';
import { Separator } from '../../components/ProductRow';
import { ScreenHeader } from '../../components/Screen';
import { AffiliateNote, EmptyState, ErrorState, Loading } from '../../components/ui';
import { useTodayDrops } from '../../lib/queries';
import { space, type as t, useTheme } from '../../lib/theme';

/**
 * Every «오늘 가격 하락» card — the same list the web home shows (/api/hotdeals?view=today-drop).
 * The rule is the server's (api/_todaydrop.js): same product and option, compared with its
 * previous observation, down by 5% or 1,000원. Verified deals come first with a badge.
 */
export default function Drops() {
  const theme = useTheme();
  const drops = useTodayDrops();
  const verified = drops.data?.filter(d => d.verified).length || 0;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScreenHeader title="가격하락" />
      {drops.isPending ? <Loading /> : drops.isError ? (
        <ErrorState error={drops.error} onRetry={() => drops.refetch()} />
      ) : (
        <FlatList
          data={drops.data}
          keyExtractor={d => d.id}
          renderItem={({ item, index }) => <DropRow drop={item} rank={index + 1} />}
          ItemSeparatorComponent={Separator}
          refreshControl={<RefreshControl refreshing={drops.isRefetching} onRefresh={() => drops.refetch()} tintColor={theme.faint} />}
          initialNumToRender={10}
          windowSize={7}
          ListHeaderComponent={drops.data.length ? (
            <AppText tone="soft" style={[t.footnote, { paddingHorizontal: space.gutter, paddingBottom: space.sm }]}>
              오늘 {drops.data.length}개{verified ? ` · SEOSA 검증 ${verified}개` : ''} · 직전 기록보다 5% 또는 1,000원 이상 내린 상품
            </AppText>
          ) : null}
          ListEmptyComponent={<EmptyState title="오늘은 아직 내려간 상품이 없어요" detail="가격이 새로 확인되면 여기에 표시돼요." />}
          ListFooterComponent={drops.data.length ? <AffiliateNote /> : null}
          contentContainerStyle={{ paddingBottom: space.section }}
        />
      )}
    </View>
  );
}
