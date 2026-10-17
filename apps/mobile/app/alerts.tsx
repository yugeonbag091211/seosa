import { useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { AppText, useFontsReady } from '../components/AppText';
import { Icon } from '../components/Icon';
import { Price } from '../components/Price';
import { EmptyState, ErrorState, Hairline, Loading } from '../components/ui';
import { TARGET_PRESETS, presetTargetPrice } from '../lib/alertTarget';
import { userMessage } from '../lib/api';
import { alertsApi } from '../lib/config';
import { digits } from '../lib/format';
import { pushOnce } from '../lib/navigation';
import { recallProduct } from '../lib/productCache';
import { useSession } from '../lib/session';
import { radius, space, type as t, useTheme } from '../lib/theme';

export default function PriceAlertsScreen() {
  const theme = useTheme();
  const fontsReady = useFontsReady();
  const params = useLocalSearchParams<{ key?: string }>();
  const product = useMemo(() => recallProduct(String(params.key || '')), [params.key]);
  const { status, session } = useSession();
  const client = useQueryClient();
  const [target, setTarget] = useState('');

  const list = useQuery({
    queryKey: ['priceAlerts', session?.email || ''],
    queryFn: () => alertsApi.list(session!.email, session!.token),
    enabled: status === 'signedIn' && !!session,
    staleTime: 60_000,
    retry: false,
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!session || !product) return;
      await alertsApi.save({
        email: session.email,
        token: session.token,
        product,
        currentPrice: product.price,
        targetPrice: Number(target),
      });
    },
    onSuccess: async () => {
      setTarget('');
      await client.invalidateQueries({ queryKey: ['priceAlerts', session?.email || ''] });
      Alert.alert('가격 알림을 설정했어요', '이 옵션이 목표 가격 이하로 내려가면 이메일로 알려드려요.');
    },
  });

  const remove = useMutation({
    mutationFn: async (title: string) => {
      if (!session) return;
      await alertsApi.remove(session.email, session.token, title);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['priceAlerts', session?.email || ''] }),
  });

  const confirmRemove = (title: string) => {
    Alert.alert('가격 알림을 삭제할까요?', title, [
      { text: '취소', style: 'cancel' },
      { text: '삭제', style: 'destructive', onPress: () => remove.mutate(title) },
    ]);
  };

  if (status === 'loading') return <Loading />;

  if (status !== 'signedIn' || !session) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <EmptyState title="로그인이 필요해요" detail="알림을 보낼 이메일을 확인하기 위해 로그인해 주세요.">
          <Pressable onPress={() => pushOnce('/login')} accessibilityRole="button" style={({ pressed }) => [styles.primary, { backgroundColor: theme.control, opacity: pressed ? 0.65 : 1 }]}>
            <AppText style={[t.callout, { color: theme.onControl, fontWeight: '700' }]}>이메일로 로그인</AppText>
          </Pressable>
        </EmptyState>
      </View>
    );
  }

  const alerts = list.data || [];
  const targetPrice = Number(target);
  const canSave = !!product?.vendorItemId && Number.isFinite(targetPrice) && targetPrice > 0 && !save.isPending;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      {list.isPending ? <Loading /> : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <FlatList
          data={alerts}
          keyExtractor={item => item.title}
          ItemSeparatorComponent={() => <Hairline inset={space.gutter} />}
          contentContainerStyle={{ paddingBottom: space.section, flexGrow: 1 }}
          ListHeaderComponent={product ? (
            <View style={[styles.create, { borderBottomColor: theme.line }]}>
              <AppText tone="faint" style={t.footnote}>새 알림</AppText>
              <AppText style={[t.callout, { fontWeight: '700' }]} numberOfLines={2}>{product.title}</AppText>
              <View style={styles.current}>
                <AppText tone="soft" style={t.footnote}>현재 표시 가격</AppText>
                <Price value={product.price} />
              </View>

              {product.vendorItemId ? (
                <>
                  <View style={styles.presets}>
                    {TARGET_PRESETS.map(percent => {
                      const suggested = presetTargetPrice(product.price, percent);
                      const selected = suggested > 0 && targetPrice === suggested;
                      return (
                        <Pressable
                          key={percent}
                          onPress={() => { if (suggested > 0) setTarget(String(suggested)); }}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          accessibilityLabel={`현재가보다 ${percent}% 낮은 목표가 설정`}
                          style={({ pressed }) => [
                            styles.preset,
                            {
                              borderColor: selected ? theme.control : theme.line2,
                              backgroundColor: selected ? theme.control : theme.bg,
                              opacity: pressed ? 0.6 : 1,
                            },
                          ]}
                        >
                          <AppText style={[t.caption, { color: selected ? theme.onControl : theme.ink, fontWeight: '600' }]}>{percent}% 낮게</AppText>
                        </Pressable>
                      );
                    })}
                  </View>
                  <View style={[styles.inputWrap, { borderColor: theme.line2, backgroundColor: theme.surface }]}>
                    <TextInput
                      value={target}
                      onChangeText={value => setTarget(value.replace(/[^0-9]/g, '').slice(0, 10))}
                      placeholder="목표 가격"
                      placeholderTextColor={theme.faint}
                      keyboardType="number-pad"
                      returnKeyType="done"
                      accessibilityLabel="목표 가격"
                      style={[styles.input, { color: theme.ink, fontFamily: fontsReady ? 'Pretendard-Regular' : undefined }]}
                    />
                    <AppText tone="soft" style={t.callout}>원</AppText>
                  </View>
                  {targetPrice > 0 ? <AppText tone="faint" style={t.footnote}>{digits(targetPrice)}원 이하가 되면 알려드려요.</AppText> : null}
                  <Pressable
                    onPress={() => save.mutate()}
                    disabled={!canSave}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !canSave }}
                    style={({ pressed }) => [styles.primary, { backgroundColor: theme.control, opacity: !canSave ? 0.35 : pressed ? 0.65 : 1 }]}
                  >
                    <Icon name="bell" size={18} color={theme.onControl} />
                    <AppText style={[t.callout, { color: theme.onControl, fontWeight: '700' }]}>{save.isPending ? '설정 중…' : '목표가 알림 설정'}</AppText>
                  </Pressable>
                  {save.isError ? <AppText style={[t.footnote, { color: theme.up }]}>{userMessage(save.error)}</AppText> : null}
                  <AppText tone="faint" style={t.caption}>선택한 상품 옵션의 가격만 확인하며 다른 옵션 가격으로 대체하지 않아요.</AppText>
                </>
              ) : (
                <AppText tone="soft" style={t.footnote}>이 상품은 정확한 옵션 식별값이 없어 아직 앱 가격 알림을 설정할 수 없어요.</AppText>
              )}
            </View>
          ) : null}
          ListEmptyComponent={
            <EmptyState
              title={product ? '설정된 알림이 아직 없어요' : '가격 알림이 없어요'}
              detail={product ? '위에서 목표 가격을 정해 보세요.' : '상품 화면에서 가격 알림을 설정할 수 있어요.'}
            />
          }
          ListHeaderComponentStyle={{ marginBottom: alerts.length ? space.md : 0 }}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={{ flex: 1, gap: 3 }}>
                <AppText style={[t.callout, { fontWeight: '600' }]} numberOfLines={2}>{item.title}</AppText>
                <AppText tone="soft" style={t.footnote}>{item.mall || '판매처'} · 목표 {digits(item.targetPrice)}원</AppText>
                <AppText tone="faint" style={t.caption}>{item.sent ? '알림 발송 완료' : '가격 확인 중'}</AppText>
              </View>
              <Pressable onPress={() => confirmRemove(item.title)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`${item.title} 가격 알림 삭제`} disabled={remove.isPending}>
                <Icon name="close" size={19} color={theme.faint} />
              </Pressable>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  create: { gap: space.sm, paddingHorizontal: space.gutter, paddingTop: space.md, paddingBottom: space.xl, borderBottomWidth: StyleSheet.hairlineWidth },
  current: { gap: 2, marginTop: 2 },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs },
  preset: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 999, borderWidth: 1 },
  inputWrap: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth * 2 },
  input: { flex: 1, fontSize: 17, paddingVertical: 0 },
  primary: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 18, borderRadius: radius.lg },
  row: { minHeight: 82, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.gutter, paddingVertical: space.md },
});
