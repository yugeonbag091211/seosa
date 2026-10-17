import { FlatList, RefreshControl, View } from 'react-native';
import { CommunityDealRow } from '../components/CommunityDealRow';
import { AppText } from '../components/AppText';
import { AffiliateNote, EmptyState, ErrorState, Loading } from '../components/ui';
import { useCommunityDeals } from '../lib/queries';
import { space, type as t, useTheme } from '../lib/theme';

/** Full native page for the exact feed used by the website's "실시간 핫딜" section. */
export default function CommunityDealsScreen() {
  const theme = useTheme();
  const feed = useCommunityDeals();
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      {feed.isPending ? <Loading label="커뮤니티 핫딜을 불러오고 있어요" /> : feed.isError ? (
        <ErrorState error={feed.error} onRetry={() => feed.refetch()} />
      ) : (
        <FlatList
          data={feed.data}
          keyExtractor={d => d.id}
          renderItem={({ item }) => <CommunityDealRow deal={item} />}
          refreshControl={<RefreshControl refreshing={feed.isRefetching} onRefresh={() => feed.refetch()} tintColor={theme.faint} />}
          ListHeaderComponent={
            <View style={{ paddingHorizontal: space.gutter, paddingTop: space.lg, paddingBottom: space.sm }}>
              <AppText style={t.title}>실시간 핫딜 · {feed.data.length}개</AppText>
              <AppText tone="faint" style={[t.footnote, { marginTop: space.xs }]}>
                커뮤니티에서 발견한 상품입니다. SEOSA 가격 이력과 확인된 경우만 검증 배지를 표시합니다.
              </AppText>
              <AffiliateNote style={{ paddingHorizontal: 0, paddingBottom: 0 }} />
            </View>
          }
          ListEmptyComponent={<EmptyState title="지금 표시할 커뮤니티 핫딜이 없어요" detail="새 글이 수집되면 이곳에 표시됩니다." />}
          contentContainerStyle={{ paddingBottom: space.section }}
        />
      )}
    </View>
  );
}
