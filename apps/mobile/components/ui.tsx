import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text as NativeText, TextInput, View } from 'react-native';
import type { TextProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Product } from '../lib/api';
import { useTheme } from '../lib/theme';

/**
 * Dynamic Type stays on, but capped: past these multipliers the fixed-height rows (search field,
 * pill buttons, 92pt thumbnails) clip text instead of growing.
 */
export const FONT_SCALE = { body: 1.6, title: 1.3, control: 1.4 } as const;

export function Screen({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
    <View style={styles.content}>{children}</View>
  </SafeAreaView>;
}

export function Text({ children, muted, title, style, ...rest }: TextProps & { muted?: boolean; title?: boolean }) {
  const theme = useTheme();
  return <NativeText maxFontSizeMultiplier={title ? FONT_SCALE.title : FONT_SCALE.body} {...rest} style={[{
    color: muted ? theme.muted : theme.text,
    fontSize: title ? 32 : 15,
    lineHeight: title ? 39 : 23,
    fontWeight: title ? '800' : '400',
    letterSpacing: title ? -1.1 : -0.15,
  }, style]}>{children}</NativeText>;
}

/** `decorative` hides the mark from screen readers where it only fills space or sits next to the word SEOSA. */
export function BrandMark({ size = 36, decorative = false }: { size?: number; decorative?: boolean }) {
  const theme = useTheme();
  return <Image source={require('../assets/brand-mark.png')} resizeMode="contain"
    {...(decorative
      ? { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no' as const }
      : { accessibilityLabel: 'SEOSA' })}
    style={{ width: size, height: size, tintColor: theme.text }} />;
}

/** Remote product image; falls back to the brand mark for missing, non-https, or failed images. */
export function ProductImage({ uri, fallbackSize, style }: { uri?: string; fallbackSize: number; style: object }) {
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const usable = uri && /^https:\/\//.test(uri) && failedUri !== uri ? uri : null;
  if (!usable) return <BrandMark size={fallbackSize} decorative />;
  return <Image source={{ uri: usable }} resizeMode="contain" accessible={false} accessibilityElementsHidden
    importantForAccessibility="no" onError={() => setFailedUri(usable)} style={style} />;
}

export function Button({ label, onPress, secondary = false, disabled = false }: {
  label: string; onPress: () => void; secondary?: boolean; disabled?: boolean;
}) {
  const theme = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, {
      backgroundColor: secondary ? theme.background : theme.text,
      borderColor: secondary ? theme.border : theme.text,
      opacity: disabled ? 0.45 : pressed ? 0.76 : 1,
    }]}>
    <NativeText maxFontSizeMultiplier={FONT_SCALE.control} style={{ color: secondary ? theme.text : theme.background, fontWeight: '700', fontSize: 15 }}>
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

/**
 * `onSubmit` receives the text the keyboard submitted. With Korean IME composition the last
 * syllable can still be uncommitted in React state when the return key is pressed, so the native
 * event text is the reliable value.
 */
export function SearchField({ value, onChangeText, onSubmit, autoFocus = false }: {
  value: string; onChangeText: (text: string) => void; onSubmit: (text: string) => void; autoFocus?: boolean;
}) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  return <View style={[styles.fieldShell, {
    backgroundColor: focused ? theme.background : theme.surface,
    borderColor: focused ? theme.borderStrong : 'transparent',
  }]}>
    <TextInput accessibilityLabel="상품 검색어" autoCapitalize="none" autoCorrect={false} maxLength={80}
      autoFocus={autoFocus} returnKeyType="search" enablesReturnKeyAutomatically clearButtonMode="while-editing"
      placeholder="상품을 검색하세요" placeholderTextColor={theme.faint} maxFontSizeMultiplier={FONT_SCALE.control}
      value={value} onChangeText={onChangeText} onSubmitEditing={event => onSubmit(event.nativeEvent.text)}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={[styles.field, { color: theme.text }]} />
    <SearchIcon color={theme.muted} />
  </View>;
}

export function SearchEntry({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel="상품 검색하기" onPress={onPress}
    style={({ pressed }) => [styles.searchEntry, { backgroundColor: theme.background, borderColor: theme.border, opacity: pressed ? 0.72 : 1 }]}>
    <NativeText maxFontSizeMultiplier={FONT_SCALE.control} style={{ color: theme.faint, fontSize: 16, fontWeight: '500' }}>상품을 검색하세요</NativeText>
    <SearchIcon color={theme.muted} />
  </Pressable>;
}

export function LoadingState({ label = '불러오는 중…' }: { label?: string }) {
  const theme = useTheme();
  return <View accessible accessibilityRole="progressbar" accessibilityLabel={label} style={styles.state}>
    <ActivityIndicator color={theme.text} />
    <Text muted style={{ textAlign: 'center' }}>{label}</Text>
  </View>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const theme = useTheme();
  return <View style={styles.state}>
    <NativeText accessibilityRole="alert" maxFontSizeMultiplier={FONT_SCALE.body} style={[styles.errorMessage, { color: theme.warning }]}>{message}</NativeText>
    {onRetry ? <Button label="다시 시도" secondary onPress={onRetry} /> : null}
  </View>;
}

/** Server verdict codes → badge text. Unknown codes are shown as-is rather than hidden. */
const VERDICT_TEXT: Record<string, string> = {
  BUY: 'BUY', GOOD_BUY: 'GOOD BUY', NORMAL: 'NORMAL', WATCH: 'WATCH', WAIT: 'WAIT', DONT_BUY: "DON'T BUY",
};
const VERDICT_SPOKEN: Record<string, string> = {
  BUY: '지금 사도 좋음', GOOD_BUY: '싼 편', NORMAL: '평범한 가격', WATCH: '지켜볼 만함', WAIT: '기다리는 편이 나음', DONT_BUY: '지금은 비쌈',
};

export function VerdictBadge({ verdict }: { verdict: string }) {
  const theme = useTheme();
  const code = verdict.trim().toUpperCase();
  const text = VERDICT_TEXT[code] || code.replace(/_/g, ' ');
  const isBuy = code === 'BUY' || code === 'GOOD_BUY';
  const isWait = code === 'WAIT' || code === 'DONT_BUY';
  return <View accessible accessibilityLabel={`가격 판정 ${VERDICT_SPOKEN[code] || text}`} style={[styles.badge, {
    backgroundColor: isBuy ? theme.positiveSurface : isWait ? theme.warningSurface : theme.surface,
  }]}>
    <NativeText maxFontSizeMultiplier={FONT_SCALE.control} style={[styles.badgeText, {
      color: isBuy ? theme.positive : isWait ? theme.warning : theme.muted,
    }]}>{text}</NativeText>
  </View>;
}

export function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  const theme = useTheme();
  return <View style={styles.sectionHeader}>
    <NativeText accessibilityRole="header" maxFontSizeMultiplier={FONT_SCALE.title} style={[styles.sectionTitle, { color: theme.text }]}>{title}</NativeText>
    {subtitle ? <NativeText maxFontSizeMultiplier={FONT_SCALE.body} style={[styles.sectionSubtitle, { color: theme.muted }]}>{subtitle}</NativeText> : null}
  </View>;
}

export function formatPrice(price: number): string {
  return Number.isFinite(price) ? Math.round(price).toLocaleString('ko-KR') : '-';
}

export function ProductCard({ product, onPress, badge, note }: {
  product: Product; onPress?: () => void; badge?: string; note?: string;
}) {
  const theme = useTheme();
  const mall = product.mallLabel || product.mall;
  const price = formatPrice(product.lprice);
  const spoken = [product.title, `${price}원`, mall, note, onPress ? null : '상세 정보 준비 중'].filter(Boolean).join(', ');
  return <Pressable accessibilityRole="button" accessibilityLabel={spoken} accessibilityHint={onPress ? '상품 상세를 엽니다' : undefined}
    accessibilityState={{ disabled: !onPress }} disabled={!onPress}
    onPress={onPress} style={({ pressed }) => [styles.card, {
      borderBottomColor: theme.border,
      opacity: pressed ? 0.68 : 1,
    }]}>
    <View style={[styles.thumbnail, { backgroundColor: theme.surface }]}>
      <ProductImage uri={product.image} fallbackSize={25} style={styles.image} />
    </View>
    <View style={styles.cardCopy}>
      <NativeText numberOfLines={2} ellipsizeMode="tail" maxFontSizeMultiplier={FONT_SCALE.control} style={[styles.productTitle, { color: theme.text }]}>
        {product.title}
      </NativeText>
      <NativeText numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} maxFontSizeMultiplier={FONT_SCALE.control} style={[styles.productPrice, { color: theme.text }]}>
        {price}<NativeText style={[styles.won, { color: theme.muted }]}> 원</NativeText>
      </NativeText>
      <NativeText numberOfLines={1} maxFontSizeMultiplier={FONT_SCALE.control} style={[styles.productMall, { color: theme.muted }]}>{mall}</NativeText>
      {badge || note ? <View style={styles.cardMeta}>
        {badge ? <VerdictBadge verdict={badge} /> : null}
        {note ? <NativeText numberOfLines={1} maxFontSizeMultiplier={FONT_SCALE.control} style={[styles.productNote, { color: theme.faint }]}>{note}</NativeText> : null}
      </View> : null}
      {!onPress ? <NativeText maxFontSizeMultiplier={FONT_SCALE.control} style={[styles.productNote, { color: theme.faint }]}>상세 정보 준비 중</NativeText> : null}
    </View>
  </Pressable>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 20, paddingTop: 12 },
  button: { minHeight: 50, borderRadius: 25, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  fieldShell: { minHeight: 48, borderRadius: 24, borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingLeft: 18, paddingRight: 15 },
  field: { flex: 1, minHeight: 46, fontSize: 16, paddingVertical: 0, paddingHorizontal: 0, letterSpacing: -0.2 },
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
