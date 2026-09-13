import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { FlatList, View } from 'react-native';
import { Button, ErrorState, LoadingState, ProductCard, Screen, SearchField, Text } from '../components/ui';
import { api, type Product, userMessage } from '../lib/api';

type SearchState = 'idle' | 'loading' | 'success' | 'error';

export default function Search() {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>('idle');
  const [items, setItems] = useState<Product[]>([]);
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function submit() {
    const keyword = query.trim();
    if (!keyword) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setState('loading');
    try {
      const results = await api.search(keyword, request.signal);
      if (request.signal.aborted) return;
      setItems(results);
      setState('success');
    } catch (error) {
      if (request.signal.aborted) return;
      setMessage(userMessage(error));
      setState('error');
    }
  }

  return <Screen>
    <View style={{ gap: 16, paddingBottom: 14 }}>
      <Text title>검색</Text>
      <SearchField value={query} onChangeText={setQuery} onSubmit={submit} />
      <Button label="검색" onPress={submit} disabled={!query.trim() || state === 'loading'} />
    </View>
    {state === 'idle' ? <Text muted>찾고 싶은 상품을 입력해 주세요.</Text> : null}
    {state === 'loading' ? <LoadingState label="상품을 찾고 있어요…" /> : null}
    {state === 'error' ? <ErrorState message={message} onRetry={submit} /> : null}
    {state === 'success' && items.length === 0 ? <Text muted>검색 결과가 없어요. 다른 검색어를 입력해 보세요.</Text> : null}
    {state === 'success' && items.length > 0 ? <FlatList data={items} keyExtractor={(item, index) => `${item.productId || item.title}-${index}`} renderItem={({ item }) => <ProductCard product={item} onPress={item.productId ? () => router.push({ pathname: '/product/[id]', params: { id: item.productId!, mall: item.mall } }) : undefined} />} keyboardShouldPersistTaps="handled" /> : null}
  </Screen>;
}
