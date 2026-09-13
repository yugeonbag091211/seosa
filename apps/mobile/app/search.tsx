import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { FlatList, Keyboard, Pressable, View } from 'react-native';
import { Button, ErrorState, LoadingState, ProductCard, Screen, SearchField, Text } from '../components/ui';
import { api, ApiError, type Product, userMessage } from '../lib/api';
import { useTheme } from '../lib/theme';

type SearchState = 'idle' | 'loading' | 'success' | 'error';

export default function Search() {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>('idle');
  const [items, setItems] = useState<Product[]>([]);
  const [message, setMessage] = useState('');
  const [errorTitle, setErrorTitle] = useState('');
  const [slow, setSlow] = useState(false);
  const [lastKeyword, setLastKeyword] = useState('');
  const theme = useTheme();
  const controller = useRef<AbortController | null>(null);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  useEffect(() => () => {
    controller.current?.abort();
    if (slowTimer.current) clearTimeout(slowTimer.current);
  }, []);

  function cancel() {
    controller.current?.abort();
    controller.current = null;
    inFlight.current = false;
    if (slowTimer.current) clearTimeout(slowTimer.current);
    setSlow(false);
    setState('idle');
  }

  async function submit() {
    const keyword = query.trim();
    if (!keyword || inFlight.current) return;
    Keyboard.dismiss();
    const request = new AbortController();
    controller.current = request;
    inFlight.current = true;
    setSlow(false);
    setState('loading');
    slowTimer.current = setTimeout(() => { if (!request.signal.aborted) setSlow(true); }, 8_000);
    try {
      const results = await api.search(keyword, request.signal);
      if (request.signal.aborted) return;
      setItems(results);
      setLastKeyword(keyword);
      setState('success');
    } catch (error) {
      if (request.signal.aborted) return;
      setMessage(userMessage(error));
      setErrorTitle(error instanceof ApiError && error.kind === 'timeout' ? '검색 시간이 길어졌어요' :
        error instanceof ApiError && error.kind === 'unavailable' ? '검색 서비스가 잠시 불안정해요' :
          error instanceof ApiError && error.kind === 'network' ? '네트워크를 확인해 주세요' : '검색을 완료하지 못했어요');
      setState('error');
    } finally {
      if (controller.current === request) {
        controller.current = null;
        inFlight.current = false;
        if (slowTimer.current) clearTimeout(slowTimer.current);
      }
    }
  }

  return <Screen>
    <View style={{ gap: 16, paddingBottom: 18, borderBottomWidth: 1, borderBottomColor: theme.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="뒤로 가기" onPress={() => router.canGoBack() ? router.back() : router.replace('/')} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}><Text style={{ fontSize: 26 }}>‹</Text></Pressable>
        <View><Text title>상품 검색</Text><Text muted style={{ fontSize: 13 }}>가격 기록까지 함께 살펴보세요.</Text></View>
      </View>
      <SearchField value={query} onChangeText={setQuery} onSubmit={submit} />
      <Button label="검색" onPress={submit} disabled={!query.trim() || state === 'loading'} />
    </View>
    {state === 'idle' ? <View style={{ paddingTop: 34, gap: 7 }}><Text style={{ fontWeight: '700' }}>무엇을 찾고 계신가요?</Text><Text muted>상품 이름을 입력하면 현재 가격을 확인해 드려요.</Text></View> : null}
    {state === 'loading' ? <View style={{ paddingTop: 32, gap: 8 }}><LoadingState label={slow ? '조금 오래 걸리고 있어요. 상품 정보를 확인하는 중입니다.' : '상품을 찾고 있어요…'} /><Button label="검색 취소" secondary onPress={cancel} /></View> : null}
    {state === 'error' ? <View style={{ paddingTop: 30, gap: 5 }}><Text style={{ fontSize: 20, fontWeight: '700' }}>{errorTitle}</Text><ErrorState message={message} onRetry={submit} /></View> : null}
    {state === 'success' && items.length === 0 ? <View style={{ paddingTop: 36, gap: 8 }}><Text style={{ fontSize: 20, fontWeight: '700' }}>찾은 상품이 없어요</Text><Text muted>다른 이름이나 더 짧은 검색어를 입력해 보세요.</Text></View> : null}
    {state === 'success' && items.length > 0 ? <FlatList data={items} keyExtractor={(item, index) => `${item.productId || item.title}-${index}`} ListHeaderComponent={<Text muted style={{ paddingTop: 16, paddingBottom: 4, fontSize: 13 }}>{lastKeyword} · {items.length}개 상품</Text>} renderItem={({ item }) => <ProductCard product={item} onPress={item.productId ? () => router.push({ pathname: '/product/[id]', params: { id: item.productId!, mall: item.mall } }) : undefined} />} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: 28 }} /> : null}
  </Screen>;
}
