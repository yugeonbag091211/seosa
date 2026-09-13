import type { ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text as NativeText, TextInput, View } from 'react-native';
import type { TextProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Product } from '../lib/api';
import { useTheme } from '../lib/theme';

export function Screen({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}><View style={styles.content}>{children}</View></SafeAreaView>;
}

export function Text({ children, muted, title, style, ...rest }: TextProps & { muted?: boolean; title?: boolean }) {
  const theme = useTheme();
  return <NativeText {...rest} style={[{ color: muted ? theme.muted : theme.text, fontSize: title ? 28 : 15, lineHeight: title ? 36 : 23, fontWeight: title ? '700' : '400' }, style]}>{children}</NativeText>;
}

export function Button({ label, onPress, secondary = false, disabled = false }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  const theme = useTheme();
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, { backgroundColor: secondary ? theme.surface : theme.text, borderColor: theme.border, opacity: disabled ? 0.45 : pressed ? 0.75 : 1 }]}>
    <NativeText style={{ color: secondary ? theme.text : theme.background, fontWeight: '600', fontSize: 16 }}>{label}</NativeText>
  </Pressable>;
}

export function SearchField({ value, onChangeText, onSubmit }: { value: string; onChangeText: (text: string) => void; onSubmit: () => void }) {
  const theme = useTheme();
  return <TextInput accessibilityLabel="상품 검색어" autoCapitalize="none" autoCorrect={false} maxLength={80} returnKeyType="search" placeholder="상품을 검색하세요" placeholderTextColor={theme.muted} value={value} onChangeText={onChangeText} onSubmitEditing={onSubmit} style={[styles.field, { backgroundColor: theme.surface, color: theme.text, borderColor: theme.border }]} />;
}

export function LoadingState({ label = '불러오는 중…' }: { label?: string }) {
  const theme = useTheme();
  return <View style={styles.state}><ActivityIndicator color={theme.text} /><Text muted>{label}</Text></View>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <View style={styles.state}><Text>{message}</Text>{onRetry ? <Button label="다시 시도" secondary onPress={onRetry} /> : null}</View>;
}

export function ProductCard({ product, onPress }: { product: Product; onPress?: () => void }) {
  const theme = useTheme();
  const image = product.image && /^https:\/\//.test(product.image) ? product.image : null;
  return <Pressable accessibilityRole="button" disabled={!onPress} onPress={onPress} style={({ pressed }) => [styles.card, { borderBottomColor: theme.border, opacity: pressed ? 0.6 : 1 }]}>
    <View style={[styles.thumbnail, { backgroundColor: theme.surface }]}>{image ? <Image source={{ uri: image }} resizeMode="contain" style={styles.image} /> : <Text muted>SEOSA</Text>}</View>
    <View style={styles.cardCopy}>
      <Text numberOfLines={2} style={{ fontWeight: '600' }}>{product.title}</Text>
      <Text muted>{product.mallLabel || product.mall}</Text>
      <Text style={{ fontWeight: '700', fontSize: 18 }}>{Number(product.lprice).toLocaleString('ko-KR')}원</Text>
      {!onPress ? <Text muted style={{ fontSize: 12 }}>상세 정보 준비 중</Text> : null}
    </View>
  </Pressable>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 24, paddingTop: 18 },
  button: { minHeight: 50, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  field: { height: 54, borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, fontSize: 16 },
  state: { alignItems: 'center', justifyContent: 'center', gap: 16, paddingVertical: 32 },
  card: { flexDirection: 'row', gap: 16, paddingVertical: 16, borderBottomWidth: 1 },
  thumbnail: { width: 96, height: 96, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  image: { width: 90, height: 90 },
  cardCopy: { flex: 1, justifyContent: 'center', gap: 4 },
});
