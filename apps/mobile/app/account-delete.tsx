import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { AppText } from '../components/AppText';
import { deleteAccountFlow, DELETED_ON_SERVER, RETAINED_ON_SERVER, type DeletionResult } from '../lib/accountDeletion';
import { api } from '../lib/config';
import { useLocalData } from '../lib/local';
import { useSession } from '../lib/session';
import { maskEmail } from '../lib/sessionModel';
import { radius, space, type as t, useTheme } from '../lib/theme';

/**
 * Account deletion, started inside the app (Apple 5.1.1(v)).
 * Two deliberate steps: tick that the list was read, then press the destructive button.
 * The server decides whose account from the token alone (api/_account.js).
 */
export default function AccountDelete() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const { session, token, signOut } = useSession();
  const { clearAll } = useLocalData();
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeletionResult | null>(null);

  const run = async () => {
    if (!acknowledged || busy) return;
    setBusy(true);
    const r = await deleteAccountFlow({
      token,
      requestDeletion: tk => api.deleteAccount(tk),
      clearSession: signOut,
      clearCache: () => queryClient.clear(),
      clearLocalData: clearAll,
    });
    setBusy(false);
    setResult(r);
  };

  if (result?.status === 'deleted') {
    return (
      <View style={[styles.done, { backgroundColor: theme.bg }]}>
        <AppText style={t.title}>계정을 삭제했어요</AppText>
        <AppText tone="soft" style={[t.callout, styles.center]}>
          이 기기의 로그인 정보, 저장 목록, 최근 검색도 지웠어요.{'\n'}결제 기록은 법에 따라 5년간 보관돼요.
        </AppText>
        {!result.tokenRemoved ? (
          <AppText style={[t.footnote, styles.center, { color: theme.up }]}>기기 보안 저장소에서 로그인 정보를 지우지 못했어요. 앱을 삭제하면 함께 지워져요.</AppText>
        ) : null}
        <Pressable onPress={() => router.dismissTo('/')} accessibilityRole="button" style={[styles.primary, { backgroundColor: theme.control, alignSelf: 'stretch' }]}>
          <AppText style={[t.headline, { color: theme.onControl }]}>확인</AppText>
        </Pressable>
      </View>
    );
  }

  if (!session || result?.status === 'needs_login') {
    return (
      <View style={[styles.done, { backgroundColor: theme.bg }]}>
        <AppText style={t.headline}>로그인이 필요해요</AppText>
        <AppText tone="soft" style={[t.callout, styles.center]}>계정을 삭제하려면 삭제할 이메일로 다시 로그인해 주세요.</AppText>
        <Pressable onPress={() => router.replace('/login')} accessibilityRole="button" style={[styles.primary, { backgroundColor: theme.control, alignSelf: 'stretch' }]}>
          <AppText style={[t.headline, { color: theme.onControl }]}>로그인</AppText>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView style={{ backgroundColor: theme.bg }} contentContainerStyle={styles.body}>
      <AppText style={t.title}>계정을 삭제할까요?</AppText>
      <AppText tone="soft" style={[t.callout, { marginTop: 6 }]}>{maskEmail(session.email)} 계정이 삭제되며 되돌릴 수 없어요.</AppText>

      <AppText style={[t.footnote, styles.label]} tone="faint">SEOSA 서버에서 지워지는 것</AppText>
      {DELETED_ON_SERVER.map(x => <AppText key={x} style={t.body}>•  {x}</AppText>)}

      <AppText style={[t.footnote, styles.label]} tone="faint">이 기기에서 지워지는 것</AppText>
      <AppText style={t.body}>•  로그인 정보, 저장한 상품, 최근 검색</AppText>

      <AppText style={[t.footnote, styles.label]} tone="faint">남는 것</AppText>
      <AppText style={t.body}>•  {RETAINED_ON_SERVER}</AppText>
      <AppText tone="soft" style={[t.footnote, { marginTop: space.sm }]}>PRO 자동결제를 쓰고 있다면 먼저 해지해야 삭제할 수 있어요.</AppText>

      <Pressable
        onPress={() => setAcknowledged(v => !v)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: acknowledged }}
        style={[styles.ack, { borderColor: acknowledged ? theme.ink : theme.line2 }]}
      >
        <View style={[styles.box, { borderColor: theme.ink, backgroundColor: acknowledged ? theme.ink : 'transparent' }]}>
          {acknowledged ? <AppText style={{ color: theme.bg, fontSize: 13, fontWeight: '700' }}>✓</AppText> : null}
        </View>
        <AppText style={[t.callout, { flex: 1 }]}>위 내용을 확인했고, 계정을 삭제합니다.</AppText>
      </Pressable>

      {result && (result.status === 'blocked' || result.status === 'failed') ? (
        <AppText style={[t.footnote, { color: theme.up, marginTop: space.md }]} accessibilityLiveRegion="polite">{result.message}</AppText>
      ) : null}

      <Pressable
        onPress={run}
        disabled={!acknowledged || busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: !acknowledged || busy }}
        style={[styles.primary, { backgroundColor: acknowledged ? theme.up : theme.surface2 }]}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <AppText style={[t.headline, { color: acknowledged ? '#FFFFFF' : theme.faint }]}>계정 삭제</AppText>}
      </Pressable>
      <Pressable onPress={() => router.back()} style={styles.cancel} hitSlop={8} accessibilityRole="button">
        <AppText tone="soft" style={t.callout}>취소</AppText>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.gutter, paddingTop: space.xxl, paddingBottom: space.section },
  label: { marginTop: space.xl, marginBottom: 4 },
  ack: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.xxl, padding: space.lg, borderRadius: radius.lg, borderWidth: 1 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  primary: { marginTop: space.lg, height: 52, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  cancel: { alignSelf: 'center', marginTop: space.lg },
  done: { flex: 1, padding: space.gutter, justifyContent: 'center', alignItems: 'center', gap: space.md },
  center: { textAlign: 'center' },
});
