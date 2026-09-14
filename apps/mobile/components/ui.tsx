import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import type { ImageStyle, StyleProp, TextProps, TextStyle } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import type { Product, Trust } from '../lib/api';
import { asOfLabel, formatPrice, mallColor, type PriceStats, type TrendSummary, type VerdictView } from '../lib/format';
import { radius, space, typography, useTheme, type Theme } from '../lib/theme';
import { AppText as NativeText, useTypeface } from './AppText';

/*
 * Shared building blocks, each modeled on a specific element of seosa.ai.kr at a 390px viewport
 * (the web class is named in each comment). Values come from lib/theme.ts.
 */

/**
 * Dynamic Type / Android font size caps. Rows grow with their text (min heights only, no fixed heights),
 * so these only keep the largest accessibility sizes from turning a 2-column card into one word per line.
 */
export const FONT_SCALE = { body: 2, title: 1.6, control: 1.8 } as const;
const TABULAR: TextStyle['fontVariant'] = ['tabular-nums'];

export { formatPrice };

export function Screen({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  const theme = useTheme();
  return <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: theme.background }]}>
    <View style={[styles.screen, padded && { paddingHorizontal: space.page }]}>{children}</View>
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

/** brand-mark.png's S is 59% of the image tall; the web's Georgia bold 34 S is about 38% of its 64 box. */
const S_MARK_SCALE = 0.645;

/**
 * .logo-mark — the web's S (Georgia bold). Drawn from the rasterized glyph in assets/brand-mark.png, tinted to
 * the ink color, instead of asking each platform for a Georgia it may not have (Android has none).
 */
export function SMark({ size = 34, decorative = false }: { size?: number; decorative?: boolean }) {
  const theme = useTheme();
  const glyph = Math.round(size * S_MARK_SCALE);
  return <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    {...(decorative
      ? { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const }
      : { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel: 'SEOSA' })}>
    <Image source={require('../assets/brand-mark.png')} accessible={false} resizeMode="contain"
      style={{ width: glyph, height: glyph, tintColor: theme.text }} />
  </View>;
}

/** Remote product image; falls back to a faint S for missing, non-https, or failed images. */
export function ProductImage({ uri, fallbackSize, style }: { uri?: string; fallbackSize: number; style: StyleProp<ImageStyle> }) {
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const usable = uri && /^https:\/\//.test(uri) && failedUri !== uri ? uri : null;
  if (!usable) return <View style={{ opacity: 0.25 }}><SMark size={fallbackSize} decorative /></View>;
  return <Image source={{ uri: usable }} resizeMode="contain" accessible={false} accessibilityElementsHidden
    importantForAccessibility="no" onError={() => setFailedUri(usable)} style={style} />;
}

/** header .bar — 50px row + 1px rule, 14px side padding. */
export function AppHeader({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <View style={[styles.header, { backgroundColor: theme.background, borderBottomColor: theme.border }]}>{children}</View>;
}

export function BackButton() {
  const theme = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel="뒤로 가기" hitSlop={6}
    onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} style={styles.back}>
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Path d="M15 5 L8 12 L15 19" stroke={theme.text} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  </Pressable>;
}

/** .search-go icon (stroke 1.8). */
function SearchGlyph({ color }: { color: string }) {
  return <Svg width={18} height={18} viewBox="0 0 24 24">
    <Circle cx={11} cy={11} r={7} stroke={color} strokeWidth={1.8} fill="none" />
    <Line x1={16.2} y1={16.2} x2={21} y2={21} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
  </Svg>;
}

/** header .search-field as a button (home): 44 tall, radius 26, surface fill. */
export function SearchPill({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel="상품 검색하기" onPress={onPress}
    style={({ pressed }) => [styles.field, { backgroundColor: theme.fieldBg, borderColor: 'transparent', opacity: pressed ? 0.75 : 1 }]}>
    <NativeText numberOfLines={1} maxFontSizeMultiplier={FONT_SCALE.control} style={[styles.fieldText, { color: theme.faint }]}>상품을 검색하세요</NativeText>
    <View style={styles.fieldIcon}><SearchGlyph color={theme.muted} /></View>
  </Pressable>;
}

/**
 * header .search-field (search screen). `onSubmit` receives the text the keyboard submitted: with Korean
 * IME composition the last syllable can still be uncommitted in React state when return is pressed.
 */
export function SearchField({ value, onChangeText, onSubmit, autoFocus = false }: {
  value: string; onChangeText: (text: string) => void; onSubmit: (text: string) => void; autoFocus?: boolean;
}) {
  const theme = useTheme();
  const typeface = useTypeface();
  const [focused, setFocused] = useState(false);
  return <View style={[styles.field, { backgroundColor: theme.fieldBg, borderColor: focused ? theme.text : 'transparent' }]}>
    <TextInput accessibilityLabel="상품 검색어" autoCapitalize="none" autoCorrect={false} maxLength={80}
      autoFocus={autoFocus} returnKeyType="search" enablesReturnKeyAutomatically clearButtonMode="while-editing"
      placeholder="상품을 검색하세요" placeholderTextColor={theme.faint} maxFontSizeMultiplier={FONT_SCALE.control}
      value={value} onChangeText={onChangeText} onSubmitEditing={event => onSubmit(event.nativeEvent.text)}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={[styles.fieldText, styles.fieldInput, { color: theme.text, fontFamily: typeface.body('400') }]} />
    <Pressable accessibilityRole="button" accessibilityLabel="검색" hitSlop={7} onPress={() => onSubmit(value)} style={styles.fieldIcon}>
      <SearchGlyph color={theme.muted} />
    </Pressable>
  </View>;
}

/** .hero-cta (primary pill) or the web's underlined text action (.buy / .lact.dark). */
export function Button({ label, onPress, variant = 'primary', disabled = false }: {
  label: string; onPress: () => void; variant?: 'primary' | 'link'; disabled?: boolean;
}) {
  const theme = useTheme();
  if (variant === 'link') {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      hitSlop={4} style={({ pressed }) => [styles.link, { opacity: disabled ? 0.45 : pressed ? 0.6 : 1 }]}>
      <NativeText maxFontSizeMultiplier={FONT_SCALE.control} style={[styles.linkText, { color: theme.text, borderBottomColor: theme.text }]}>{label}</NativeText>
    </Pressable>;
  }
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.pill, { backgroundColor: theme.text, opacity: disabled ? 0.45 : pressed ? 0.86 : 1 }]}>
    <NativeText maxFontSizeMultiplier={FONT_SCALE.control} style={{ color: theme.background, fontWeight: '600', fontSize: 14 }}>{label}</NativeText>
  </Pressable>;
}

export function LoadingState({ label = '불러오는 중…' }: { label?: string }) {
  const theme = useTheme();
  return <View accessible accessibilityRole="progressbar" accessibilityLabel={label} style={styles.state}>
    <ActivityIndicator color={theme.muted} />
    <NativeText maxFontSizeMultiplier={FONT_SCALE.body} style={[typography.sectionSub, { color: theme.muted, textAlign: 'center' }]}>{label}</NativeText>
  </View>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const theme = useTheme();
  return <View style={styles.state}>
    <NativeText accessibilityRole="alert" maxFontSizeMultiplier={FONT_SCALE.body} style={[styles.errorMessage, { color: theme.warning }]}>{message}</NativeText>
    {onRetry ? <Button label="다시 시도" variant="link" onPress={onRetry} /> : null}
  </View>;
}

/** .sec-head — .sec-title (+ .sec-count) and .sec-sub (with a bold part). */
export function SectionHead({ title, count, sub, strong }: { title: string; count?: string; sub?: string; strong?: string }) {
  const theme = useTheme();
  return <View style={{ marginBottom: space.sectionHead }}>
    <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap' }}>
      <NativeText accessibilityRole="header" maxFontSizeMultiplier={FONT_SCALE.title} style={[typography.sectionTitle, { color: theme.text }]}>{title}</NativeText>
      {count ? <NativeText maxFontSizeMultiplier={FONT_SCALE.title} style={{ marginLeft: 10, fontSize: 14.4, fontWeight: '500', color: theme.faint, fontVariant: TABULAR }}>{count}</NativeText> : null}
    </View>
    {sub ? <NativeText maxFontSizeMultiplier={FONT_SCALE.body} style={[typography.sectionSub, { color: theme.muted, marginTop: 4 }]}>
      {sub}{strong ? <NativeText style={{ color: theme.text, fontWeight: '600' }}>{strong}</NativeText> : null}
    </NativeText> : null}
  </View>;
}

/** .catnav .chip — popular keywords under the hero, underlined row. */
export function KeywordChips({ keywords, onPress }: { keywords: string[]; onPress: (keyword: string) => void }) {
  const theme = useTheme();
  return <View style={{ borderBottomWidth: 1, borderBottomColor: theme.border }}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.page }}>
      {keywords.map((keyword, index) => <Pressable key={keyword} accessibilityRole="button" accessibilityLabel={`${keyword} 검색`}
        onPress={() => onPress(keyword)} style={({ pressed }) => [styles.chip, index === 0 && { paddingLeft: 0 }, { opacity: pressed ? 0.6 : 1 }]}>
        <NativeText maxFontSizeMultiplier={FONT_SCALE.control} style={[typography.chip, { color: theme.muted }]}>{keyword}</NativeText>
      </Pressable>)}
    </ScrollView>
  </View>;
}

export function mallDotColor(theme: Theme, label: string | undefined): string | null {
  const color = mallColor(label);
  if (!color) return null;
  return 'token' in color ? theme[color.token] : color.hex;
}

/** .mall-line — brand dot + mall name, observation stamp (.as-of) on the right. */
export function MallLine({ product, large = false }: { product: Product; large?: boolean }) {
  const theme = useTheme();
  const label = product.mallLabel || product.mall;
  const dot = mallDotColor(theme, label);
  const asOf = asOfLabel(product.collectedAt);
  const { mono } = useTypeface();
  const scale = large ? 1.2 : 1;
  // Wraps the stamp under the mall name at large text sizes instead of pushing it out of a narrow card.
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, minWidth: 0 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot || theme.faint }} />
      <NativeText numberOfLines={1} maxFontSizeMultiplier={FONT_SCALE.control}
        style={[typography.mall, { fontSize: typography.mall.fontSize * scale, color: dot ? theme.text : theme.muted, flexShrink: 1 }]}>{label}</NativeText>
    </View>
    {asOf ? <NativeText maxFontSizeMultiplier={FONT_SCALE.control}
      style={[typography.stamp, { fontSize: typography.stamp.fontSize * scale, fontFamily: mono, color: theme.faint, marginLeft: 'auto' }]}>{asOf}</NativeText> : null}
  </View>;
}

function Price({ value, size, wonSize }: { value: number; size: object; wonSize: number }) {
  const theme = useTheme();
  return <NativeText numberOfLines={1} maxFontSizeMultiplier={FONT_SCALE.control} style={[size, { color: theme.text, fontVariant: TABULAR }]}>
    {formatPrice(value)}<NativeText style={{ fontSize: wonSize, fontWeight: '500', letterSpacing: 0, color: theme.muted }}>원</NativeText>
  </NativeText>;
}

function spoken(product: Product, extra: (string | null | undefined)[] = []): string {
  return [product.title, `${formatPrice(product.lprice)}원`, ...extra, product.mallLabel || product.mall].filter(Boolean).join(', ');
}

/** .card — square surface thumbnail, title (2 lines), price, mall line. Flat: no border, no shadow. */
export function GridCard({ product, width, onPress }: { product: Product; width: number; onPress?: () => void }) {
  const theme = useTheme();
  // Reserve two title lines at the current text size so cards in a row keep their prices aligned.
  const { fontScale } = useWindowDimensions();
  const titleMinHeight = Math.ceil(typography.cardTitle.lineHeight * 2 * Math.min(Math.max(fontScale, 1), FONT_SCALE.control));
  return <Pressable accessibilityRole="button" accessibilityLabel={spoken(product, [product.isRocket ? '로켓배송' : null, onPress ? null : '상세 정보 준비 중'])}
    accessibilityHint={onPress ? '가격 기록을 엽니다' : undefined} accessibilityState={{ disabled: !onPress }} disabled={!onPress} onPress={onPress}
    style={({ pressed }) => [{ width, marginBottom: 26, opacity: pressed ? 0.72 : 1 }]}>
    <View style={[styles.thumb, { width, height: width, backgroundColor: theme.surface }]}>
      <ProductImage uri={product.image} fallbackSize={Math.round(width * 0.22)} style={{ width: '82%', height: '82%' }} />
    </View>
    <View style={{ paddingTop: 13 }}>
      {product.isRocket ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 }}>
        <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: theme.coupang }} />
        <NativeText maxFontSizeMultiplier={FONT_SCALE.control} style={{ fontSize: 11.52, fontWeight: '600', color: theme.coupang }}>로켓배송</NativeText>
      </View> : null}
      <NativeText numberOfLines={2} maxFontSizeMultiplier={FONT_SCALE.control} style={[typography.cardTitle, { color: theme.text, minHeight: titleMinHeight, marginBottom: 6 }]}>{product.title}</NativeText>
      <Price value={product.lprice} size={typography.cardPrice} wonSize={typography.won.fontSize} />
      <View style={{ marginTop: 6 }}><MallLine product={product} /></View>
      {!onPress ? <NativeText maxFontSizeMultiplier={FONT_SCALE.control} style={[typography.stamp, { color: theme.faint, marginTop: 4 }]}>상세 정보 준비 중</NativeText> : null}
    </View>
  </Pressable>;
}

/** .grid — two flat columns, 10px gap. */
export function ProductGrid({ products, cardWidth, onOpen }: { products: Product[]; cardWidth: number; onOpen: (product: Product) => (() => void) | undefined }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: space.grid }}>
    {products.map((product, index) => <GridCard key={`${product.productId || product.title}-${index}`} product={product} width={cardWidth} onPress={onOpen(product)} />)}
  </View>;
}

/** .dcard — 핫딜 row: surface card, 56px white thumbnail, name, price with ↓%, mall and 수집 이후 최저. */
export function DropRow({ product, onPress }: { product: Product; onPress?: () => void }) {
  const theme = useTheme();
  const pct = product.savePct && product.savePct > 0 ? product.savePct : null;
  return <Pressable accessibilityRole="button"
    accessibilityLabel={spoken(product, [pct ? `직전 기록보다 ${pct}% 하락` : null, product.isAllTimeLow ? '수집 이후 최저' : null])}
    accessibilityHint={onPress ? '가격 기록을 엽니다' : undefined} accessibilityState={{ disabled: !onPress }} disabled={!onPress} onPress={onPress}
    style={({ pressed }) => [styles.dropCard, { backgroundColor: pressed ? theme.background : theme.surface, borderColor: pressed ? theme.border : 'transparent' }]}>
    <View style={[styles.dropThumb, { backgroundColor: theme.background }]}>
      <ProductImage uri={product.image} fallbackSize={20} style={{ width: '100%', height: '100%' }} />
    </View>
    <View style={{ flex: 1, minWidth: 0 }}>
      <NativeText numberOfLines={2} maxFontSizeMultiplier={FONT_SCALE.control} style={[typography.dropName, { color: theme.text }]}>{product.title}</NativeText>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 5, marginTop: 5, flexWrap: 'wrap' }}>
        <Price value={product.lprice} size={typography.dropPrice} wonSize={10.88} />
        {pct ? <NativeText maxFontSizeMultiplier={FONT_SCALE.control} style={{ fontSize: 11.52, fontWeight: '700', letterSpacing: -0.12, color: theme.positive }}>↓{pct}%</NativeText> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, minWidth: 0 }}>
        <NativeText numberOfLines={1} maxFontSizeMultiplier={FONT_SCALE.control} style={[typography.dropMeta, { color: theme.faint, flexShrink: 1 }]}>{product.mallLabel || product.mall}</NativeText>
        {product.isAllTimeLow ? <NativeText numberOfLines={1} maxFontSizeMultiplier={FONT_SCALE.control} style={[typography.dropMeta, { color: theme.muted, fontWeight: '600' }]}>수집 이후 최저</NativeText> : null}
      </View>
    </View>
  </Pressable>;
}

/** .month-banner — "9月" beside the monthly title and subtitle. */
export function MonthBanner({ month, title, subtitle }: { month: number | null; title: string; subtitle: string }) {
  const theme = useTheme();
  return <View style={{ flexDirection: 'row', gap: 8, marginBottom: space.sectionHead }}>
    {month ? <NativeText maxFontSizeMultiplier={FONT_SCALE.title} style={{ fontSize: 16, lineHeight: 20.8, fontWeight: '800', letterSpacing: -0.4, color: theme.text }}>{month}月</NativeText> : null}
    <View style={{ flex: 1 }}>
      <NativeText accessibilityRole="header" maxFontSizeMultiplier={FONT_SCALE.title} style={{ fontSize: 16, lineHeight: 20.8, fontWeight: '700', letterSpacing: -0.4, color: theme.text }}>{title}</NativeText>
      {subtitle ? <NativeText maxFontSizeMultiplier={FONT_SCALE.body} style={[typography.sectionSub, { color: theme.muted, marginTop: 5 }]}>{subtitle}</NativeText> : null}
    </View>
  </View>;
}

/** .result-banner — "키워드" 큐레이션 완료 with lowest price, count, and price range. */
export function ResultBanner({ keyword, summary }: { keyword: string; summary: { min: number; max: number; count: number } | null }) {
  const theme = useTheme();
  const meta = (label: string, value: string) => <View key={label} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 5 }}>
    <NativeText maxFontSizeMultiplier={FONT_SCALE.control} style={{ fontSize: 11.2, color: theme.muted }}>{label}</NativeText>
    <NativeText maxFontSizeMultiplier={FONT_SCALE.control} style={{ fontSize: 13.44, fontWeight: '700', color: theme.text, fontVariant: TABULAR }}>{value}</NativeText>
  </View>;
  return <View style={{ paddingTop: 18, paddingBottom: 12, marginBottom: 18, gap: 6, borderBottomWidth: 1, borderBottomColor: theme.border }}>
    <NativeText accessibilityRole="header" maxFontSizeMultiplier={FONT_SCALE.title} style={{ fontSize: 16, fontWeight: '700', letterSpacing: -0.4, color: theme.text }}>
      <NativeText style={{ fontWeight: '800' }}>&quot;{keyword}&quot;</NativeText> 큐레이션 완료
    </NativeText>
    {summary ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 2 }}>
      {meta('결과 중 최저', `${formatPrice(summary.min)}원`)}
      {meta('비교 상품', `${summary.count}개`)}
      {summary.max > summary.min ? meta('가격대', `${formatPrice(summary.min)}~${formatPrice(summary.max)}원`) : null}
    </View> : null}
  </View>;
}

/** .verdict — surface box (green for buy, red for wait) with icon, heading, and one server line. */
export function VerdictBox({ view }: { view: VerdictView }) {
  const theme = useTheme();
  const tone = view.tone === 'buy'
    ? { bg: theme.positiveSurface, border: theme.positiveBorder }
    : view.tone === 'wait' ? { bg: theme.warningSurface, border: theme.warningBorder } : { bg: theme.surface, border: theme.border };
  return <View accessible accessibilityLabel={`가격 판단: ${view.head}. ${view.line}`}
    style={[styles.verdict, { backgroundColor: tone.bg, borderColor: tone.border }]}>
    <NativeText style={{ fontSize: 19.2 }}>{view.icon}</NativeText>
    <View style={{ flex: 1, minWidth: 0 }}>
      <NativeText maxFontSizeMultiplier={FONT_SCALE.body} style={[typography.verdictHead, { color: theme.text }]}>{view.head}</NativeText>
      {view.line ? <NativeText maxFontSizeMultiplier={FONT_SCALE.body} style={[typography.verdictLine, { color: theme.muted }]}>{view.line}</NativeText> : null}
    </View>
  </View>;
}

/** .trust-panel — server trust level and its reasons (✓ / ! / ×). */
export function TrustPanel({ trust }: { trust: Trust }) {
  const theme = useTheme();
  const { mono } = useTypeface();
  const dot = { high: theme.positive, medium: theme.trustMedium, low: theme.trustLow, stale: theme.warning }[trust.level] || theme.faint;
  const labelColor = trust.level === 'low' ? theme.trustLowLabel : trust.level === 'stale' ? theme.warning : theme.muted;
  const mark = (kind: string) => (kind === 'good' ? { t: '✓', c: theme.positive } : kind === 'bad' ? { t: '×', c: theme.warning } : { t: '!', c: theme.trustMedium });
  return <View accessible accessibilityLabel={`가격 신뢰도 ${trust.label}. ${trust.reasons.map(r => r.text).join('. ')}`}
    style={[styles.panel, { backgroundColor: theme.surface, borderColor: theme.border }]}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: trust.reasons.length ? 9 : 0 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot }} />
      <NativeText maxFontSizeMultiplier={FONT_SCALE.body} style={{ fontSize: 10.88, fontWeight: '700', color: labelColor }}>가격 신뢰도 · {trust.label}</NativeText>
    </View>
    <View style={{ gap: 5 }}>
      {trust.reasons.map((reason, index) => {
        const m = mark(reason.kind);
        return <View key={`${index}-${reason.text}`} style={{ flexDirection: 'row', gap: 6 }}>
          <NativeText maxFontSizeMultiplier={FONT_SCALE.body} style={{ fontFamily: mono, fontSize: 11.2, fontWeight: '600', color: m.c, lineHeight: 18 }}>{m.t}</NativeText>
          <NativeText maxFontSizeMultiplier={FONT_SCALE.body} style={{ flex: 1, fontSize: 11.84, lineHeight: 18, color: theme.muted }}>{reason.text}</NativeText>
        </View>;
      })}
    </View>
  </View>;
}

/** .trend-summary — PRICE TREND box. */
export function TrendBox({ trend }: { trend: TrendSummary }) {
  const theme = useTheme();
  const toneColor = trend.tone === 'down' ? theme.positive : trend.tone === 'up' ? theme.warning : theme.muted;
  return <View style={[styles.boxed, { backgroundColor: theme.surface, borderColor: theme.border }]}>
    <NativeText maxFontSizeMultiplier={FONT_SCALE.control} style={{ fontSize: 9, letterSpacing: 0.4, color: theme.faint, marginBottom: 5 }}>PRICE TREND</NativeText>
    <NativeText maxFontSizeMultiplier={FONT_SCALE.body} style={{ fontSize: 12.48, lineHeight: 20, color: theme.text }}>
      📊 {trend.days}일간 <NativeText style={{ fontWeight: '700', color: toneColor }}>{trend.label}</NativeText>
      {trend.recent ? <NativeText style={{ color: theme.faint }}>{'  ·  '}</NativeText> : null}{trend.recent}
      {trend.position ? <NativeText style={{ color: theme.faint }}>{'  ·  '}</NativeText> : null}
      {trend.position ? <NativeText style={{ fontWeight: '700' }}>{trend.position}</NativeText> : null}
    </NativeText>
  </View>;
}

/** .stat-row — 최저 (green) · 평균 · 최고 (red). */
export function StatRow({ stats }: { stats: PriceStats }) {
  const theme = useTheme();
  const cell = (label: string, value: number, color: string) => <View key={label} accessible accessibilityLabel={`${label} ${formatPrice(value)}원`}
    style={[styles.stat, { backgroundColor: theme.surface, borderColor: theme.border }]}>
    <NativeText maxFontSizeMultiplier={FONT_SCALE.control} style={{ fontSize: 9, color: theme.faint, marginBottom: 4 }}>{label}</NativeText>
    <NativeText numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} maxFontSizeMultiplier={FONT_SCALE.control}
      style={{ fontSize: 14.72, fontWeight: '800', letterSpacing: -0.29, color, fontVariant: TABULAR }}>{formatPrice(value)}</NativeText>
  </View>;
  return <View style={{ flexDirection: 'row', gap: 8 }}>
    {cell('최저', stats.min, theme.positive)}
    {cell('평균', stats.avg, theme.text)}
    {cell('최고', stats.max, theme.warning)}
  </View>;
}

/** Observation ledger row: mono date stamp, tabular price, hairline rule. */
export function LedgerRow({ date, price }: { date: string; price: number }) {
  const theme = useTheme();
  const { mono } = useTypeface();
  return <View accessible accessibilityLabel={`${date} ${formatPrice(price)}원`} style={[styles.ledger, { borderBottomColor: theme.border }]}>
    <NativeText maxFontSizeMultiplier={FONT_SCALE.control} style={{ fontFamily: mono, fontSize: 11, letterSpacing: 0.4, color: theme.faint }}>{date}</NativeText>
    <Price value={price} size={{ fontSize: 13.5, fontWeight: '600' }} wonSize={11} />
  </View>;
}

/** footer — wordmark, tagline, and the Coupang Partners disclosure the web shows. */
export function SiteFooter() {
  const theme = useTheme();
  return <View style={{ marginTop: 36, paddingTop: 32, paddingBottom: 40, backgroundColor: theme.page, borderTopWidth: 1, borderTopColor: theme.border }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: space.page }}>
      <NativeText maxFontSizeMultiplier={FONT_SCALE.title} style={{ fontSize: 17.6, fontWeight: '800', letterSpacing: 2.46, color: theme.text }}>SEOSA</NativeText>
      <NativeText maxFontSizeMultiplier={FONT_SCALE.body} style={{ fontSize: 11.52, color: theme.faint }}>최저가도 고급스럽게</NativeText>
    </View>
    <View style={{ marginTop: 14, paddingTop: 14, paddingHorizontal: space.page, borderTopWidth: 1, borderTopColor: theme.border }}>
      <NativeText maxFontSizeMultiplier={FONT_SCALE.body} style={{ fontSize: 11.2, lineHeight: 17.9, color: theme.faint }}>
        본 사이트는 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받을 수 있습니다.
        단, 상품 추천 및 검색 결과는 최저가 기준으로만 제공되며 파트너스 여부와 무관합니다.
      </NativeText>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // Minimum heights only: at the default text size these are exactly the web's 50+1 header and 44 field,
  // and at larger accessibility sizes they grow with the text instead of clipping it.
  header: { minHeight: space.header + 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: space.page, paddingVertical: 3, borderBottomWidth: 1 },
  back: { width: 36, height: 44, marginLeft: -6, alignItems: 'center', justifyContent: 'center' },
  field: { flex: 1, minHeight: 44, borderRadius: radius.field, borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingLeft: 10, paddingRight: 4 },
  fieldText: { flex: 1, fontSize: 14, paddingLeft: 11, paddingVertical: 8 },
  fieldInput: { alignSelf: 'stretch', paddingRight: 0 },
  fieldIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  pill: { minHeight: 49, borderRadius: 30, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 26 },
  link: { minHeight: 44, alignSelf: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  linkText: { fontSize: 13, fontWeight: '600', paddingBottom: 2, borderBottomWidth: 1 },
  state: { alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 32 },
  errorMessage: { fontSize: 13, lineHeight: 20, textAlign: 'center', paddingHorizontal: 16 },
  chip: { minHeight: 44, justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 10 },
  thumb: { borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  dropCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: radius.dropCard, borderWidth: 1 },
  dropThumb: { width: 56, height: 56, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  verdict: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: radius.r, borderWidth: 1 },
  panel: { paddingVertical: 13, paddingHorizontal: 15, borderRadius: radius.panel, borderWidth: 1 },
  boxed: { paddingVertical: 11, paddingHorizontal: 14, borderRadius: radius.r, borderWidth: 1 },
  stat: { flex: 1, minWidth: 0, paddingVertical: 11, paddingHorizontal: 8, borderRadius: radius.r, borderWidth: 1 },
  ledger: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1 },
});
