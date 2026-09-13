import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text as NativeText, TextInput, View } from 'react-native';
import type { TextProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Product } from '../lib/api';
import { useTheme } from '../lib/theme';

export function Screen({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
    <View style={styles.content}>{children}</View>
  </SafeAreaView>;
}

export function Text({ children, muted, title, style, ...rest }: TextProps & { muted?: boolean; title?: boolean }) {
  const theme = useTheme();
  return <NativeText {...rest} style={[{
    color: muted ? theme.muted : theme.text,
    fontSize: title ? 32 : 15,
    lineHeight: title ? 39 : 23,
    fontWeight: title ? '800' : '400',
    letterSpacing: title ? -1.1 : -0.15,
  }, style]}>{children}</NativeText>;
}

export function BrandMark({ size = 36 }: { size?: number }) {
  const theme = useTheme();
  return <Image accessibilityLabel="SEOSA" source={require('../assets/brand-mark.png')}
    resizeMode="contain" style={{ width: size, height: size, tintColor: theme.text }} />;
}

export function Button({ label, onPress, secondary = false, disabled = false }: {
  label: string; onPress: () => void; secondary?: boolean; disabled?: boolean;
}) {
  const theme = useTheme();
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, {
      backgroundColor: secondary ? theme.background : theme.text,
      borderColor: secondary ? theme.border : theme.text,
      opacity: disabled ? 0.45 : pressed ? 0.76 : 1,
    }]}>
    <NativeText style={{ color: secondary ? theme.text : theme.background, fontWeight: '700', fontSize: 15 }}>
      {label}
    </NativeText>
  </Pressable>;
}

function SearchIcon({ color }: { color: string }) {
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.searchIcon}>
    <View style={[styles.searchLens, { borderColor: color }]} />
    <View style={[styles.searchHandle, { backgroundColor: color }]} />
  </View>;
}

export function SearchField({ value, onChangeText, onSubmit }: {
  value: string; onChangeText: (text: string) => void; onSubmit: () => void;
}) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  return <View style={[styles.fieldShell, {
    backgroundColor: focused ? theme.background : theme.surface,
    borderColor: focused ? theme.borderStrong : 'transparent',
  }]}>
    <TextInput accessibilityLabel="상품 검색어" autoCapitalize="none" autoCorrect={false} maxLength={80}
      returnKeyType="search" placeholder="상품을 검색하세요" placeholderTextColor={theme.faint}
      value={value} onChangeText={onChangeText} onSubmitEditing={onSubmit}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={[styles.field, { color: theme.text }]} />
    <SearchIcon color={theme.muted} />
  </View>;
}

export function SearchEntry({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel="상품 검색하기" onPress={onPress}
    style={({ pressed }) => [styles.searchEntry, { backgroundColor: theme.background, borderColor: theme.border, opacity: pressed ? 0.72 : 1 }]}>
    <NativeText style={{ color: theme.faint, fontSize: 16, fontWeight: '500' }}>상품을 검색하세요</NativeText>
    <SearchIcon color={theme.muted} />
  </Pressable>;
}

export function LoadingState({ label = '불러오는 중…' }: { label?: string }) {
  const theme = useTheme();
  return <View style={styles.state}><ActivityIndicator color={theme.text} /><Text muted>{label}</Text></View>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const theme = useTheme();
  return <View style={styles.state}>
    <NativeText style={[styles.errorMessage, { color: theme.warning }]}>{message}</NativeText>
    {onRetry ? <Button label="다시 시도" secondary onPress={onRetry} /> : null}
  </View>;
}

export function VerdictBadge({ verdict }: { verdict: string }) {
  const theme = useTheme();
  const label = verdict.trim().toUpperCase();
  const isBuy = label === 'BUY' || label === 'GOOD_BUY';
  const isWait = label === 'WAIT' || label === 'DONT_BUY';
  return <View accessibilityLabel={`구매 시점 판정 ${label}`} style={[styles.badge, {
    backgroundColor: isBuy ? theme.positiveSurface : isWait ? theme.warningSurface : theme.surface,
  }]}>
    <NativeText style={[styles.badgeText, {
      color: isBuy ? theme.positive : isWait ? theme.warning : theme.muted,
    }]}>{label}</NativeText>
  </View>;
}

export function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  const theme = useTheme();
  return <View style={styles.sectionHeader}>
    <NativeText style={[styles.sectionTitle, { color: theme.text }]}>{title}</NativeText>
    {subtitle ? <NativeText style={[styles.sectionSubtitle, { color: theme.muted }]}>{subtitle}</NativeText> : null}
  </View>;
}

export function ProductCard({ product, onPress, badge, note }: {
  product: Product; onPress?: () => void; badge?: string; note?: string;
}) {
  const theme = useTheme();
  const image = product.image && /^https:\/\//.test(product.image) ? product.image : null;
  const mall = product.mallLabel || product.mall;
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !onPress }} disabled={!onPress}
    onPress={onPress} style={({ pressed }) => [styles.card, {
      borderBottomColor: theme.border,
      opacity: pressed ? 0.68 : 1,
    }]}>
    <View style={[styles.thumbnail, { backgroundColor: theme.surface }]}>
      {image ? <Image source={{ uri: image }} resizeMode="contain" style={styles.image} />
        : <BrandMark size={25} />}
    </View>
    <View style={styles.cardCopy}>
      <NativeText numberOfLines={2} ellipsizeMode="tail" style={[styles.productTitle, { color: theme.text }]}>
        {product.title}
      </NativeText>
      <NativeText style={[styles.productPrice, { color: theme.text }]}>
        {Number(product.lprice).toLocaleString('ko-KR')}<NativeText style={[styles.won, { color: theme.muted }]}> 원</NativeText>
      </NativeText>
      <NativeText numberOfLines={1} style={[styles.productMall, { color: theme.muted }]}>{mall}</NativeText>
      {badge || note ? <View style={styles.cardMeta}>
        {badge ? <VerdictBadge verdict={badge} /> : null}
        {note ? <NativeText numberOfLines={1} style={[styles.productNote, { color: theme.faint }]}>{note}</NativeText> : null}
      </View> : null}
      {!onPress ? <NativeText style={[styles.productNote, { color: theme.faint }]}>상세 정보 준비 중</NativeText> : null}
    </View>
  </Pressable>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 20, paddingTop: 12 },
  button: { minHeight: 50, borderRadius: 25, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  fieldShell: { height: 48, borderRadius: 24, borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingLeft: 18, paddingRight: 15 },
  field: { flex: 1, height: '100%', fontSize: 16, padding: 0, letterSpacing: -0.2 },
  searchEntry: { minHeight: 58, borderRadius: 29, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20 },
  searchIcon: { width: 21, height: 21, marginLeft: 10 },
  searchLens: { width: 14, height: 14, borderWidth: 1.8, borderRadius: 7, position: 'absolute', top: 1, left: 1 },
  searchHandle: { width: 9, height: 1.8, borderRadius: 1, position: 'absolute', top: 16, left: 12, transform: [{ rotate: '46deg' }] },
  state: { alignItems: 'center', justifyContent: 'center', gap: 16, paddingVertical: 36 },
  errorMessage: { fontSize: 14, lineHeight: 22, textAlign: 'center', paddingHorizontal: 16 },
  badge: { alignSelf: 'flex-start', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4 },
  badgeText: { fontSize: 11, lineHeight: 15, fontWeight: '700', letterSpacing: 0.25 },
  sectionHeader: { gap: 4 },
  sectionTitle: { fontSize: 23, lineHeight: 30, fontWeight: '800', letterSpacing: -0.8 },
  sectionSubtitle: { fontSize: 13, lineHeight: 19 },
  card: { minHeight: 120, flexDirection: 'row', gap: 14, paddingVertical: 15, borderBottomWidth: 1, alignItems: 'center' },
  thumbnail: { width: 92, height: 92, borderRadius: 8, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  image: { width: 84, height: 84 },
  cardCopy: { flex: 1, minWidth: 0, gap: 4, justifyContent: 'center' },
  productTitle: { fontSize: 14, lineHeight: 20, fontWeight: '600', letterSpacing: -0.25 },
  productPrice: { fontSize: 19, lineHeight: 24, fontWeight: '700', letterSpacing: -0.45, fontVariant: ['tabular-nums'] },
  won: { fontSize: 12, fontWeight: '500', letterSpacing: 0 },
  productMall: { fontSize: 12, lineHeight: 17, fontWeight: '600' },
  productNote: { fontSize: 11, lineHeight: 16, flexShrink: 1 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 },
});
