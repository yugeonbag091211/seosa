import { ScrollView, StyleSheet, View } from 'react-native';
import { MONTHLY_CARDS, MONTHLY_CHIPS, monthlyHeading, monthlyState, monthlySubline } from '../lib/home';
import { space, useTheme } from '../lib/theme';
import type { MonthlyCuration } from '../lib/types';
import { AppText } from './AppText';
import { ProductTile } from './ProductTile';
import { Chip, EmptyState, ErrorState, Loading, SectionHeader } from './ui';

/**
 * «10월 추천 상품» — the web home's 이달의 추천 (public/index.html #monthly, Monthly.show).
 *
 * Data: /api/init `monthly`, the monthly_curation row for the current KST month plus up to eight
 * products the server picked for its keywords. Nothing is curated in the app; the operator edits
 * the row once and the web and the app both change.
 *
 * States (lib/home.ts monthlyState):
 *   loading → a neutral heading and a spinner
 *   error   → a neutral heading and a retry (only when no earlier row is on screen)
 *   hidden  → nothing: this month has no curation
 *   empty   → the heading, the keywords to search, and the web's «준비 중» line
 *   cards   → keywords and a rail of product cards
 *
 * Keyword chips open the search tab, like the home's popular keywords; product cards open the
 * product screen, like every list in the app.
 */
export function MonthlyPicks({ monthly, pending, error, onRetry, onKeyword }: {
  monthly: MonthlyCuration | null | undefined;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  onKeyword: (keyword: string) => void;
}) {
  const theme = useTheme();
  const state = monthlyState(monthly, pending, !!error);
  if (state === 'hidden') return null;
  const sub = monthlySubline(monthly);
  const keywords = monthly?.keywords.slice(0, MONTHLY_CHIPS) || [];
  const products = monthly?.products.slice(0, MONTHLY_CARDS) || [];

  return (
    <View style={styles.section}>
      <AppText style={[styles.eyebrow, { color: theme.faint }]}>MONTHLY CURATION</AppText>
      <SectionHeader title={monthlyHeading(monthly)} sub={sub || undefined} />
      {state === 'loading' ? <Loading style={styles.state} /> : null}
      {state === 'error' ? <ErrorState error={error} onRetry={onRetry} style={styles.state} /> : null}
      {keywords.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {keywords.map(k => <Chip key={k} label={k} onPress={() => onKeyword(k)} />)}
        </ScrollView>
      ) : null}
      {state === 'cards' ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
          {products.map(p => <ProductTile key={`${p.productId}|${p.mall}|${p.vendorItemId}`} product={p} />)}
        </ScrollView>
      ) : null}
      {state === 'empty' ? (
        <EmptyState
          title="이달의 키워드 상품을 준비 중이에요."
          detail={keywords.length ? '위 키워드로 바로 검색해 볼 수 있어요.' : undefined}
          style={styles.state}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: space.section },
  eyebrow: { fontSize: 11, lineHeight: 14, fontWeight: '700', letterSpacing: 1.4, paddingHorizontal: space.gutter, marginBottom: 6 },
  chips: { gap: 8, paddingHorizontal: space.gutter, paddingTop: space.xs, paddingBottom: space.lg },
  rail: { gap: space.md, paddingHorizontal: space.gutter, paddingBottom: space.xs },
  state: { paddingVertical: space.xxl },
});
