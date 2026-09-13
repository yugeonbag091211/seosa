import { useCallback, useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { AccessibilityInfo, FlatList, Keyboard, useWindowDimensions, View } from 'react-native';
import {
  AppHeader, BackButton, Button, ErrorState, GridCard, LoadingState, ResultBanner, Screen, SearchField, SectionHead,
} from '../components/ui';
import { api, ApiError, type Product, userMessage } from '../lib/api';
import { resultSummary } from '../lib/format';
import { createSearchSession, type SearchOutcome } from '../lib/searchSession';
import { space } from '../lib/theme';

type SearchState = 'idle' | 'loading' | 'success' | 'error';

function errorTitle(error: unknown): string {
  const kind = error instanceof ApiError ? error.kind : null;
  if (kind === 'timeout') return '검색 시간이 길어졌어요';
  if (kind === 'unavailable') return '검색 서비스가 잠시 불안정해요';
  if (kind === 'network') return '네트워크를 확인해 주세요';
  return '검색을 완료하지 못했어요';
}

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value || '').trim();
}

export default function Search() {
  const params = useLocalSearchParams<{ q?: string }>();
  const initialKeyword = firstParam(params.q);
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState(initialKeyword);
  // Opened from a home keyword chip (?q=…): start in the loading state for that keyword.
  const [state, setState] = useState<SearchState>(initialKeyword ? 'loading' : 'idle');
  const [items, setItems] = useState<Product[]>([]);
  const [resultKeyword, setResultKeyword] = useState('');
  const [runningKeyword, setRunningKeyword] = useState(initialKeyword);
  const [failure, setFailure] = useState<{ keyword: string; title: string; message: string } | null>(null);
  const [slow, setSlow] = useState(false);
  const [session] = useState(() => createSearchSession({
    search: (keyword, signal) => api.search(keyword, signal),
    onSlow: () => setSlow(true),
  }));
  // Leaving the screen aborts the running search; its late response is dropped by the session.
  useEffect(() => () => session.cancel(), [session]);

  const show = useCallback((outcome: SearchOutcome) => {
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
  }, []);

  function run(keyword: string) {
    if (session.runningKeyword === keyword) return;
    setSlow(false);
    setRunningKeyword(keyword);
    setState('loading');
    void session.run(keyword).then(show);
  }

  // A keyword chip on the home screen opens this screen with ?q=… and searches it once
  // (the loading state was already set from the param).
  useEffect(() => {
    if (initialKeyword) void session.run(initialKeyword).then(show);
  }, [initialKeyword, session, show]);

  function submit(submitted?: string) {
    const text = submitted ?? query;
    const keyword = text.trim();
    if (!keyword) return;
    if (text !== query) setQuery(text);
    Keyboard.dismiss();
    run(keyword);
  }

  function cancel() {
    session.cancel();
    setSlow(false);
    // Cancelling a new search brings back the results that were on screen before it.
    setState(resultKeyword ? 'success' : 'idle');
  }

  const cardWidth = Math.floor((width - space.page * 2 - space.grid) / 2);
  return <Screen padded={false}>
    <AppHeader>
      <BackButton />
      <SearchField value={query} onChangeText={setQuery} onSubmit={submit} autoFocus={!initialKeyword} />
    </AppHeader>
    {state === 'idle' ? <View style={{ paddingHorizontal: space.page, paddingTop: 28 }}>
      <SectionHead title="무엇을 찾고 계신가요?" sub="상품 이름을 입력하면 현재 가격과 가격 기록을 함께 보여드려요." />
    </View> : null}
    {state === 'loading' ? <View style={{ paddingHorizontal: space.page, paddingTop: 24 }}>
      <LoadingState label={slow ? '조금 오래 걸리고 있어요. 상품 정보를 확인하는 중입니다.' : `‘${runningKeyword}’ 상품을 찾고 있어요…`} />
      <Button label="검색 취소" variant="link" onPress={cancel} />
    </View> : null}
    {state === 'error' && failure ? <View style={{ paddingHorizontal: space.page, paddingTop: 28 }}>
      <SectionHead title={failure.title} />
      <ErrorState message={failure.message} onRetry={() => submit(failure.keyword)} />
    </View> : null}
    {state === 'success' && items.length === 0 ? <View style={{ paddingHorizontal: space.page, paddingTop: 28 }}>
      <SectionHead title="찾은 상품이 없어요" sub="다른 이름이나 더 짧은 검색어를 입력해 보세요." />
    </View> : null}
    {state === 'success' && items.length > 0 ? <FlatList data={items} numColumns={2}
      keyExtractor={(item, index) => `${item.productId || item.title}-${index}`}
      columnWrapperStyle={{ gap: space.grid }}
      ListHeaderComponent={<ResultBanner keyword={resultKeyword} summary={resultSummary(items.map(item => item.lprice))} />}
      renderItem={({ item }) => <GridCard product={item} width={cardWidth}
        onPress={item.productId ? () => router.push({ pathname: '/product/[id]', params: { id: item.productId!, mall: item.mall } }) : undefined} />}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingHorizontal: space.page, paddingBottom: 28 }} /> : null}
  </Screen>;
}
