import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { AppText, useFontsReady } from '../components/AppText';
import { userMessage } from '../lib/api';
import { api } from '../lib/config';
import { isEmail } from '../lib/format';
import { useSession } from '../lib/session';
import { radius, space, type as t, useTheme } from '../lib/theme';

/**
 * E-mail sign-in, the web's Auth flow (public/index.html [5-b] → /api/auth):
 *   1. e-mail → the server mails a 6-digit code (valid 10 minutes)
 *   2. code → the server returns its signed token (30 days)
 * No password, no Supabase Auth session, no account form. The token goes to SecureStore.
 */
export default function Login() {
  const theme = useTheme();
  const fontsReady = useFontsReady();
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const fieldStyle = [styles.field, { color: theme.ink, backgroundColor: theme.surface, fontFamily: fontsReady ? 'Pretendard-Regular' : undefined }];

  const submit = async () => {
    setMessage('');
    if (phase === 'email') {
      if (!isEmail(email)) { setMessage('이메일 주소를 확인해 주세요.'); return; }
      setBusy(true);
      try {
        await api.requestCode(email.trim());
        setPhase('code');
      } catch (e) {
        setMessage(userMessage(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!/^\d{6}$/.test(code)) { setMessage('6자리 숫자 코드를 입력해 주세요.'); return; }
    setBusy(true);
    try {
      const session = await api.verifyCode(email.trim(), code);
      await signIn(session);
      router.back();
    } catch (e) {
      setMessage(userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.body}>
        <AppText style={t.title}>{phase === 'email' ? '이메일로 로그인' : '인증 코드 입력'}</AppText>
        <AppText tone="soft" style={[t.callout, { marginTop: 6 }]}>
          {phase === 'email'
            ? '비밀번호 없이, 메일로 받은 코드로 로그인해요.'
            : `${email.trim()} 으로 6자리 코드를 보냈어요. 10분 안에 입력해 주세요.`}
        </AppText>

        {phase === 'email' ? (
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="name@example.com"
            placeholderTextColor={theme.faint}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            returnKeyType="next"
            onSubmitEditing={submit}
            maxLength={254}
            style={fieldStyle}
            accessibilityLabel="이메일"
          />
        ) : (
          <TextInput
            value={code}
            onChangeText={v => setCode(v.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            placeholderTextColor={theme.faint}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            onSubmitEditing={submit}
            maxLength={6}
            style={[fieldStyle, styles.code]}
            accessibilityLabel="인증 코드"
            autoFocus
          />
        )}

        {message ? <AppText style={[t.footnote, { color: theme.up, marginTop: space.sm }]} accessibilityLiveRegion="polite">{message}</AppText> : null}

        <Pressable onPress={submit} disabled={busy} accessibilityRole="button" style={({ pressed }) => [styles.primary, { backgroundColor: theme.control, opacity: busy || pressed ? 0.7 : 1 }]}>
          {busy ? <ActivityIndicator color={theme.onControl} /> : (
            <AppText style={[t.headline, { color: theme.onControl }]}>{phase === 'email' ? '인증 코드 받기' : '로그인'}</AppText>
          )}
        </Pressable>

        {phase === 'code' ? (
          <Pressable onPress={() => { setPhase('email'); setCode(''); setMessage(''); }} style={styles.secondary} hitSlop={8}>
            <AppText tone="soft" style={t.footnote}>이메일 다시 입력</AppText>
          </Pressable>
        ) : null}

        <AppText tone="faint" style={[t.caption, { marginTop: space.xxl }]}>
          로그인하면 AI 답변에 취향과 대화 맥락이 반영돼요. 로그인 정보는 이 기기의 보안 저장소에만 보관돼요.
        </AppText>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.gutter, paddingTop: space.xxl },
  field: { marginTop: space.xl, height: 52, borderRadius: radius.lg, paddingHorizontal: 16, fontSize: 17 },
  code: { letterSpacing: 8, fontSize: 22, textAlign: 'center' },
  primary: { marginTop: space.lg, height: 52, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  secondary: { alignSelf: 'center', marginTop: space.lg },
});
