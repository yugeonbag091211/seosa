import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Keyboard, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText, useFontsReady } from '../../components/AppText';
import { Icon } from '../../components/Icon';
import { ProductRow, Separator } from '../../components/ProductRow';
import { AffiliateNote, Chip, EmptyState, ErrorState, Loading, SectionHeader } from '../../components/ui';
import { setAiContext } from '../../lib/aiContext';
import { productKey } from '../../lib/identity';
import { useLocalData } from '../../lib/local';
import { useHomeFeed, useSearch } from '../../lib/queries';
import { suggestions } from '../../lib/suggest';
import { radius, space, type as t, useTheme } from '../../lib/theme';
import type { Product } from '../../lib/types';

/**
 * Search. Results come from /api/search unchanged — same ranking, same 10-item cap as the web
 * (Coupang's search limit), so the web and the app show the same products for the same words.
 */
export default function Search() {
  const theme = useTheme();
  const fontsReady = useFontsReady();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ q?: string; focus?: string }>();
  const input = useRef<TextInput>(null);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const { recent, addRecent, clearRecent } = useLocalData();
  const home = useHomeFeed();
  const search = useSearch(query);

  const submit = (value: string) => {
    const q = value.trim();
    if (!q) return;
    setText(q);
    setQuery(q);
    Keyboard.dismiss();
  };

  // A keyword handed over from another tab (home chip, «더 보기») starts a search once.
  const [handedOver, setHandedOver] = useState<string | undefined>(undefined);
  const incoming = params.q ? String(params.q).trim() : '';
  if (incoming && incoming !== handedOver) {
    setHandedOver(incoming);
    setText(incoming);
    setQuery(incoming);
  }

  useEffect(() => { if (query) addRecent(query); }, [query, addRecent]);

  useEffect(() => {
    if (!params.focus || params.q) return;
    const timer = setTimeout(() => input.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, [params.focus, params.q]);

  const popular = useMemo(() => home.data?.popular || [], [home.data]);
  const suggest = useMemo(() => (focused && text.trim() && text.trim() !== query ? suggestions(text, recent, popular) : []), [focused, text, query, recent, popular]);

  const askAi = (items: Product[]) => {
    setAiContext({ source: 'search', keyword: query, products: items });
    router.push('/concierge');
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top + space.sm }}>
      <View style={styles.bar}>
        <View style={[styles.field, { backgroundColor: theme.surface }]}>
          <Icon name="search" size={20} color={theme.faint} />
          <TextInput
            ref={input}
            value={text}
            onChangeText={setText}
            onSubmitEditing={() => submit(text)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="상품명, 모델명"
            placeholderTextColor={theme.faint}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            maxLength={80}
            accessibilityLabel="검색어"
            style={[styles.input, { color: theme.ink, fontFamily: fontsReady ? 'Pretendard-Regular' : undefined }]}
          />
          {text ? (
            <Pressable onPress={() => { setText(''); input.current?.focus(); }} hitSlop={10} accessibilityLabel="검색어 지우기">
              <Icon name="close" size={18} color={theme.faint} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {suggest.length ? (
        <View>
          {suggest.map(s => (
            <Pressable key={s.keyword} onPress={() => submit(s.keyword)} accessibilityRole="button" style={({ pressed }) => [styles.suggest, { opacity: pressed ? 0.6 : 1 }]}>
              <Icon name={s.kind === 'recent' ? 'clock' : 'search'} size={18} color={theme.faint} />
              <AppText style={t.body}>{s.keyword}</AppText>
            </Pressable>
          ))}
        </View>
      ) : !query ? (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: space.section }}>
          {recent.length ? (
            <View style={styles.block}>
              <SectionHeader title="최근 검색" action="모두 지우기" onAction={clearRecent} />
              <View style={styles.chips}>{recent.map(k => <Chip key={k} label={k} onPress={() => submit(k)} />)}</View>
            </View>
          ) : null}
          {popular.length ? (
            <View style={styles.block}>
              <SectionHeader title="많이 찾는 검색어" />
              {popular.slice(0, 10).map((k, i) => (
                <Pressable key={k} onPress={() => submit(k)} accessibilityRole="button" style={({ pressed }) => [styles.rankRow, { opacity: pressed ? 0.6 : 1 }]}>
                  <AppText mono tone="faint" style={styles.rankNo}>{i + 1}</AppText>
                  <AppText style={t.body}>{k}</AppText>
                </Pressable>
              ))}
            </View>
          ) : null}
        </ScrollView>
      ) : search.isPending ? (
        <Loading label="판매처 가격을 확인하고 있어요" />
      ) : search.isError ? (
        <ErrorState error={search.error} onRetry={() => search.refetch()} />
      ) : search.data.items.length === 0 ? (
        <EmptyState title={`'${query}' 검색 결과가 없어요`} detail="띄어쓰기나 모델명을 바꿔 보세요.">
          <View style={[styles.chips, { marginTop: space.lg, justifyContent: 'center' }]}>
            {search.data.corrected ? <Chip label={`${search.data.corrected} 검색`} onPress={() => submit(search.data.corrected)} selected /> : null}
            {search.data.suggestions.map(s => <Chip key={s} label={s} onPress={() => submit(s)} />)}
          </View>
        </EmptyState>
      ) : (
        <FlatList
          data={search.data.items}
          keyExtractor={p => productKey(p)}
          renderItem={({ item }) => <ProductRow product={item} />}
          ItemSeparatorComponent={Separator}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ListHeaderComponent={
            <View>
              {search.data.source === 'stale-cache' || search.data.blocked ? (
                <View style={[styles.notice, { backgroundColor: theme.surface }]}>
                  <AppText tone="soft" style={t.footnote}>판매처 응답이 늦어 저장된 가격을 보여 드려요. 실제 가격과 다를 수 있어요.</AppText>
                </View>
              ) : null}
              <AppText tone="faint" style={[t.footnote, styles.count]}>{search.data.items.length}개 상품 · 관련도순</AppText>
            </View>
          }
          ListFooterComponent={
            <View>
              <Pressable onPress={() => askAi(search.data.items)} accessibilityRole="button" style={({ pressed }) => [styles.askAi, { borderColor: theme.line, opacity: pressed ? 0.6 : 1 }]}>
                <Icon name="sparkle" size={18} color={theme.ink} />
                <AppText style={[t.callout, { fontWeight: '600' }]}>이 중에서 AI에게 골라 달라고 하기</AppText>
              </Pressable>
              <AffiliateNote />
            </View>
          }
          contentContainerStyle={{ paddingBottom: space.section }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: space.gutter, paddingBottom: space.sm },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 48, borderRadius: radius.lg, paddingHorizontal: 14 },
  input: { flex: 1, fontSize: 16, paddingVertical: 0 },
  suggest: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.gutter, paddingVertical: 13 },
  block: { marginTop: space.xl },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: space.gutter },
  rankRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.gutter, paddingVertical: 11 },
  rankNo: { width: 20, fontSize: 13 },
  notice: { marginHorizontal: space.gutter, marginTop: space.sm, padding: space.md, borderRadius: radius.md },
  count: { paddingHorizontal: space.gutter, paddingTop: space.md },
  askAi: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginHorizontal: space.gutter, marginTop: space.lg, paddingVertical: 14, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth * 2 },
});
