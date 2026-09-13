import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { AccessibilityInfo, FlatList, Keyboard, Pressable, View } from 'react-native';
import { Button, ErrorState, LoadingState, ProductCard, Screen, SearchField, Text } from '../components/ui';
import { api, ApiError, type Product, userMessage } from '../lib/api';
import { createSearchSession } from '../lib/searchSession';
import { useTheme } from '../lib/theme';

type SearchState = 'idle' | 'loading' | 'success' | 'error';

function errorTitle(error: unknown): string {
  const kind = error instanceof ApiError ? error.kind : null;
  if (kind === 'timeout') return '검색 시간이 길어졌어요';
  if (kind === 'unavailable') return '검색 서비스가 잠시 불안정해요';
  if (kind === 'network') return '네트워크를 확인해 주세요';
  return '검색을 완료하지 못했어요';
}

export default function Search() {
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>('idle');
  const [items, setItems] = useState<Product[]>([]);
  const [resultKeyword, setResultKeyword] = useState('');
  const [runningKeyword, setRunningKeyword] = useState('');
  const [failure, setFailure] = useState<{ keyword: string; title: string; message: string } | null>(null);
  const [slow, setSlow] = useState(false);
  const [session] = useState(() => createSearchSession({
    search: (keyword, signal) => api.search(keyword, signal),
    onSlow: () => setSlow(true),
  }));
  // Leaving the screen aborts the running search; its late response is dropped by the session.
  useEffect(() => () => session.cancel(), [session]);

  async function submit(submitted?: string) {
    const text = submitted ?? query;
    const keyword = text.trim();
    if (!keyword) return;
    if (text !== query) setQuery(text);
    Keyboard.dismiss();
    if (session.runningKeyword === keyword) return;
    setSlow(false);
    setRunningKeyword(keyword);
    setState('loading');
    const outcome = await session.run(keyword);
    if (outcome.status === 'ignored') return;
    setSlow(false);
    if (outcome.status === 'success') {
      setItems(outcome.items);
      setResultKeyword(outcome.keyword);
      setFailure(null);
      setState('success');
      AccessibilityInfo.announceForAccessibility(outcome.items.length > 0 ? `${outcome.items.length}개 상품을 찾았어요.` : '찾은 상품이 없어요.');
    } else {
      const title = errorTitle(outcome.error);
      setFailure({ keyword: outcome.keyword, title, message: userMessage(outcome.error) });
      setState('error');
      AccessibilityInfo.announceForAccessibility(title);
    }
  }

  function cancel() {
    session.cancel();
    setSlow(false);
    // Cancelling a new search brings back the results that were on screen before it.
    setState(resultKeyword ? 'success' : 'idle');
  }

  const trimmed = query.trim();
  return <Screen>
    <View style={{ gap: 16, paddingBottom: 18, borderBottomWidth: 1, borderBottomColor: theme.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="뒤로 가기" hitSlop={8} onPress={() => router.canGoBack() ? router.back() : router.replace('/')} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}><Text style={{ fontSize: 26 }} maxFontSizeMultiplier={1}>‹</Text></Pressable>
        <View style={{ flex: 1 }}><Text title accessibilityRole="header">상품 검색</Text><Text muted style={{ fontSize: 13 }}>가격 기록까지 함께 살펴보세요.</Text></View>
      </View>
      <SearchField value={query} onChangeText={setQuery} onSubmit={text => { void submit(text); }} autoFocus />
      <Button label="검색" onPress={() => { void submit(); }} disabled={!trimmed || (state === 'loading' && runningKeyword === trimmed)} />
    </View>
    {state === 'idle' ? <View style={{ paddingTop: 34, gap: 7 }}><Text style={{ fontWeight: '700' }}>무엇을 찾고 계신가요?</Text><Text muted>상품 이름을 입력하면 현재 가격을 확인해 드려요.</Text></View> : null}
    {state === 'loading' ? <View style={{ paddingTop: 32, gap: 8 }}>
      <LoadingState label={slow ? '조금 오래 걸리고 있어요. 상품 정보를 확인하는 중입니다.' : `‘${runningKeyword}’ 상품을 찾고 있어요…`} />
      <Button label="검색 취소" secondary onPress={cancel} />
    </View> : null}
    {state === 'error' && failure ? <View style={{ paddingTop: 30, gap: 5 }}>
      <Text accessibilityRole="header" style={{ fontSize: 20, fontWeight: '700' }}>{failure.title}</Text>
      <ErrorState message={failure.message} onRetry={() => { void submit(failure.keyword); }} />
    </View> : null}
    {state === 'success' && items.length === 0 ? <View style={{ paddingTop: 36, gap: 8 }}><Text style={{ fontSize: 20, fontWeight: '700' }}>찾은 상품이 없어요</Text><Text muted>다른 이름이나 더 짧은 검색어를 입력해 보세요.</Text></View> : null}
    {state === 'success' && items.length > 0 ? <FlatList data={items}
      keyExtractor={(item, index) => `${item.productId || item.title}-${index}`}
      ListHeaderComponent={<Text muted numberOfLines={1} style={{ paddingTop: 16, paddingBottom: 4, fontSize: 13 }}>{resultKeyword} · {items.length}개 상품</Text>}
      renderItem={({ item }) => <ProductCard product={item} onPress={item.productId ? () => router.push({ pathname: '/product/[id]', params: { id: item.productId!, mall: item.mall } }) : undefined} />}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: 28 }} /> : null}
  </Screen>;
}
