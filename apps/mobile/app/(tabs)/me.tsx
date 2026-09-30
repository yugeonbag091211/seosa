import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { AppText } from '../../components/AppText';
import { Icon } from '../../components/Icon';
import { ScreenHeader } from '../../components/Screen';
import { Hairline } from '../../components/ui';
import { AFFILIATE_NOTE, COUPANG_PARTNERS_NOTE } from '../../lib/affiliate';
import { APP_VERSION, LINKS } from '../../lib/config';
import { useLocalData } from '../../lib/local';
import { useSession } from '../../lib/session';
import { maskEmail } from '../../lib/sessionModel';
import { space, type as t, useTheme } from '../../lib/theme';

function Row({ label, value, onPress, danger }: { label: string; value?: string; onPress?: () => void; danger?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]} accessibilityRole={onPress ? 'button' : 'text'}>
      <AppText style={[t.body, { flex: 1, color: danger ? theme.up : theme.ink }]}>{label}</AppText>
      {value ? <AppText tone="faint" style={t.callout}>{value}</AppText> : null}
      {onPress ? <Icon name="chevronRight" size={16} color={theme.faint} /> : null}
    </Pressable>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.group}>
      <AppText tone="faint" style={[t.footnote, styles.groupTitle]}>{title}</AppText>
      {children}
    </View>
  );
}

const openLink = (url: string) => { if (url) Linking.openURL(url).catch(() => {}); };

export default function Me() {
  const theme = useTheme();
  const { status, session, signOut } = useSession();
  const { saved, recent, clearRecent } = useLocalData();

  const confirmSignOut = () => Alert.alert('로그아웃할까요?', '이 기기에 저장된 로그인 정보가 삭제돼요.', [
    { text: '취소', style: 'cancel' },
    { text: '로그아웃', style: 'destructive', onPress: () => { signOut(); } },
  ]);

  const deletion = () => Alert.alert(
    '계정 삭제',
    '앱은 로그인 토큰만 이 기기에 보관하고, 로그아웃하면 지워져요.\n\n서버에 저장된 데이터(찜 동기화·취향·가격 알림)를 지우는 기능은 아직 준비 중이에요.',
  );

  return (
    <ScrollView style={{ backgroundColor: theme.bg }} contentContainerStyle={{ paddingBottom: space.section }}>
      <ScreenHeader title="마이" />

      <Group title="계정">
        {status === 'signedIn' && session ? (
          <>
            <Row label="로그인됨" value={maskEmail(session.email)} />
            <Hairline inset={space.gutter} />
            <Row label="로그아웃" onPress={confirmSignOut} />
            <Hairline inset={space.gutter} />
            <Row label="계정 삭제" onPress={deletion} danger />
          </>
        ) : (
          <Row label={status === 'loading' ? '확인 중…' : '이메일로 로그인'} onPress={status === 'loading' ? undefined : () => router.push('/login')} />
        )}
      </Group>

      <Group title="이 기기">
        <Row label="저장한 상품" value={`${saved.length}개`} onPress={() => router.navigate('/saved')} />
        <Hairline inset={space.gutter} />
        <Row label="최근 검색 지우기" value={recent.length ? `${recent.length}개` : '없음'} onPress={recent.length ? clearRecent : undefined} />
      </Group>

      <Group title="정보">
        <Row label="SEOSA 웹사이트" onPress={() => openLink(LINKS.site)} />
        <Hairline inset={space.gutter} />
        <Row label="개인정보처리방침" value={LINKS.privacy ? undefined : '준비 중'} onPress={LINKS.privacy ? () => openLink(LINKS.privacy) : undefined} />
        <Hairline inset={space.gutter} />
        <Row label="이용약관" value={LINKS.terms ? undefined : '준비 중'} onPress={LINKS.terms ? () => openLink(LINKS.terms) : undefined} />
        <Hairline inset={space.gutter} />
        <Row label="고객지원" value={LINKS.support ? undefined : '준비 중'} onPress={LINKS.support ? () => openLink(LINKS.support) : undefined} />
        <Hairline inset={space.gutter} />
        <Row label="앱 버전" value={APP_VERSION} />
      </Group>

      <View style={styles.legal}>
        <AppText tone="faint" style={t.caption}>{AFFILIATE_NOTE}</AppText>
        <AppText tone="faint" style={[t.caption, { marginTop: 6 }]}>{COUPANG_PARTNERS_NOTE}</AppText>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  group: { marginTop: space.xl },
  groupTitle: { paddingHorizontal: space.gutter, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.gutter, minHeight: 52 },
  legal: { paddingHorizontal: space.gutter, marginTop: space.xxl },
});
