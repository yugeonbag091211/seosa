import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText, useFontsReady } from '../components/AppText';
import { Icon } from '../components/Icon';
import { ProductRow, Separator } from '../components/ProductRow';
import { Thumb } from '../components/Thumb';
import { AffiliateNote, Chip } from '../components/ui';
import { buildAiRequest, MAX_QUESTION } from '../lib/ai';
import { takeAiContext } from '../lib/aiContext';
import { formatAiText } from '../lib/aiText';
import { ApiError, userMessage } from '../lib/api';
import { api } from '../lib/config';
import { useSession } from '../lib/session';
import { radius, space, type as t, useTheme } from '../lib/theme';
import type { AiAnswer, AiTurn } from '../lib/types';

type Message =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'ai'; answer: AiAnswer }
  | { id: string; role: 'error'; text: string; needsLogin?: boolean };

let seq = 0;
const nextId = () => `m${++seq}`;

/**
 * AI concierge. Same endpoint and same safeguards as the web chat:
 *   · product context goes out as selectors only; the server re-verifies each against its catalog
 *   · prices on screen come only from the answer's server items
 *   · past answers are replayed with the server's signature; the previous pick only via its signed ref
 *   · signed out → the server's guest mode (no login wall, like the web since 2026-09-02)
 */
export default function Concierge() {
  const theme = useTheme();
  const fontsReady = useFontsReady();
  const insets = useSafeAreaInsets();
  const { token, status, signOut } = useSession();
  const [ctx] = useState(takeAiContext);
  const [messages, setMessages] = useState<Message[]>([]);
  const [history, setHistory] = useState<AiTurn[]>([]);
  const [prevTop, setPrevTop] = useState({ id: '', ref: '' });
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const list = useRef<FlatList<Message>>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const starters = ctx.source === 'product'
    ? ['지금 사도 될까?', '가격이 더 내려갈까?', '비슷한 다른 상품도 있어?']
    : ctx.source === 'search'
      ? ['이 중에서 가성비 좋은 건?', '가장 믿을 만한 가격은?']
      : ['30만원 이하 무선 이어폰 추천해줘', '요즘 가격이 내려간 노트북 있어?', '자취생 필수템 골라줘'];

  const send = async (raw: string) => {
    const question = raw.trim().slice(0, MAX_QUESTION);
    if (!question || sending) return;
    setText('');
    setSending(true);
    setMessages(m => [...m, { id: nextId(), role: 'user', text: question }]);
    const body = buildAiRequest({
      question,
      context: ctx.products,
      history,
      prevTopProductId: prevTop.id,
      prevTopRef: prevTop.ref,
      view: { source: ctx.source === 'none' ? 'app' : `app-${ctx.source}`, keyword: ctx.keyword },
    });
    abort.current = new AbortController();
    try {
      const answer = await api.ask(body, token(), abort.current.signal);
      setMessages(m => [...m, { id: nextId(), role: 'ai', answer }]);
      setHistory(h => [...h, { role: 'user', text: question }, answer.turnSig ? { role: 'assistant', text: answer.text, sig: answer.turnSig } : { role: 'assistant', text: answer.text }]);
      setPrevTop({ id: answer.topProductId || prevTop.id, ref: answer.topRecommendationRef });
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'aborted') return;
      const expired = error instanceof ApiError && error.kind === 'unauthorized';
      if (expired) await signOut();
      setMessages(m => [...m, { id: nextId(), role: 'error', text: expired ? '로그인이 만료됐어요. 다시 로그인하거나, 로그인 없이 다시 물어볼 수 있어요.' : userMessage(error), needsLogin: expired }]);
    } finally {
      setSending(false);
      setTimeout(() => list.current?.scrollToEnd({ animated: true }), 50);
    }
  };

  const reset = () => { abort.current?.abort(); setMessages([]); setHistory([]); setPrevTop({ id: '', ref: '' }); setSending(false); };

  const lastAi = [...messages].reverse().find((m): m is Extract<Message, { role: 'ai' }> => m.role === 'ai');
  const followups = lastAi?.answer.followups.length ? lastAi.answer.followups : messages.length ? [] : starters;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 56 : 0}>
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={m => m.id}
        contentContainerStyle={{ paddingVertical: space.lg, flexGrow: 1 }}
        keyboardDismissMode="interactive"
        ListHeaderComponent={
          <View style={styles.pad}>
            {ctx.products.length ? (
              <View style={[styles.ctx, { backgroundColor: theme.surface }]}>
                <View style={{ flexDirection: 'row' }}>
                  {ctx.products.slice(0, 4).map(p => <View key={`${p.productId}|${p.vendorItemId}`} style={{ marginRight: 4 }}><Thumb uri={p.image} title={p.title} size={28} /></View>)}
                </View>
                <AppText tone="soft" style={[t.footnote, { flex: 1 }]} numberOfLines={2}>
                  {ctx.source === 'product' ? ctx.products[0].title : `'${ctx.keyword}' 검색 결과 ${ctx.products.length}개`}를 보고 답해요
                </AppText>
              </View>
            ) : null}
            {!messages.length ? (
              <View style={{ marginTop: space.xl }}>
                <AppText style={t.title}>무엇을 찾고 계세요?</AppText>
                <AppText tone="soft" style={[t.callout, { marginTop: 6 }]}>SEOSA가 기록한 가격을 근거로 답해요.</AppText>
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          if (item.role === 'user') {
            return (
              <View style={[styles.user, { backgroundColor: theme.ink }]}>
                <AppText style={[t.body, { color: theme.bg }]}>{item.text}</AppText>
              </View>
            );
          }
          if (item.role === 'error') {
            return (
              <View style={styles.pad}>
                <AppText tone="soft" style={[t.callout, { marginVertical: space.md }]}>{item.text}</AppText>
                {item.needsLogin ? <Chip label="로그인" onPress={() => router.push('/login')} /> : null}
              </View>
            );
          }
          const a = item.answer;
          return (
            <View style={{ marginVertical: space.md }}>
              <View style={styles.pad}>
                {a.recommendationChanged !== null ? (
                  <AppText style={[t.footnote, { color: theme.brand, fontWeight: '600', marginBottom: 6 }]}>
                    추천이 바뀌었어요{a.recommendationChanged ? ` · ${a.recommendationChanged}` : ''}
                  </AppText>
                ) : null}
                {formatAiText(a.text).map((b, i) => (
                  <AppText key={i} style={[t.body, b.kind === 'item' && { paddingLeft: 14 }]}>
                    {b.kind === 'item' ? '•  ' : ''}
                    {b.spans.map((s, j) => <AppText key={j} style={s.bold ? { fontWeight: '700' } : undefined}>{s.text}</AppText>)}
                  </AppText>
                ))}
              </View>
              {a.items.length ? (
                <View style={{ marginTop: space.sm }}>
                  <AffiliateNote />
                  {a.items.map((p, i) => (
                    <View key={`${p.productId}|${p.mall}|${p.vendorItemId}`}>
                      {i > 0 ? <Separator /> : null}
                      <ProductRow product={p} />
                    </View>
                  ))}
                </View>
              ) : null}
              {a.guest ? (
                <View style={[styles.pad, { marginTop: space.sm }]}>
                  <AppText tone="faint" style={t.footnote}>무료 AI 답변이에요. 로그인하면 저장한 취향과 대화 맥락도 반영할 수 있어요.</AppText>
                  {status !== 'signedIn' ? <Pressable onPress={() => router.push('/login')} hitSlop={8}><AppText style={[t.footnote, { fontWeight: '600', marginTop: 4, textDecorationLine: 'underline' }]}>로그인</AppText></Pressable> : null}
                </View>
              ) : null}
            </View>
          );
        }}
        ListFooterComponent={sending ? <View style={[styles.pad, { paddingVertical: space.md }]}><ActivityIndicator color={theme.faint} /></View> : null}
      />

      {followups.length && !sending ? (
        <View style={styles.followups}>
          {followups.map(f => <Chip key={f} label={f} onPress={() => send(f)} />)}
          {messages.length ? <Chip label="새 대화" onPress={reset} /> : null}
        </View>
      ) : null}

      <View style={[styles.composer, { paddingBottom: insets.bottom + space.sm, borderTopColor: theme.line, backgroundColor: theme.bg }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="예) 20만원 이하 로봇청소기"
          placeholderTextColor={theme.faint}
          multiline
          maxLength={MAX_QUESTION}
          style={[styles.input, { color: theme.ink, backgroundColor: theme.surface, fontFamily: fontsReady ? 'Pretendard-Regular' : undefined }]}
          accessibilityLabel="질문 입력"
        />
        <Pressable
          onPress={() => send(text)}
          disabled={!text.trim() || sending}
          accessibilityRole="button"
          accessibilityLabel="보내기"
          style={[styles.send, { backgroundColor: text.trim() && !sending ? theme.ink : theme.surface2 }]}
        >
          <Icon name="send" size={20} color={theme.bg} strokeWidth={2} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: space.gutter },
  ctx: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, borderRadius: radius.lg },
  user: { alignSelf: 'flex-end', maxWidth: '82%', marginHorizontal: space.gutter, marginVertical: space.sm, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18, borderBottomRightRadius: 6 },
  followups: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: space.gutter, paddingBottom: space.sm },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, paddingHorizontal: space.gutter, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minHeight: 44, maxHeight: 120, borderRadius: 22, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12, fontSize: 16 },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
