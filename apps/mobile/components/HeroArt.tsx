import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Ellipse, G, Line, LinearGradient, Path, Pattern, RadialGradient, Rect, Stop, Use } from 'react-native-svg';
import { HERO_DEMO, type HeroArtKind } from '../lib/home';
import { palette, radius, space, type as t, useTheme, type Theme } from '../lib/theme';
import { AppText } from './AppText';

/*
 * The drawings on the right of the web's hero banners (public/index.html .hero-art), redrawn for
 * react-native-svg. All decorative: hidden from screen readers, nothing here is pressable, and no
 * drawing opens a link — on the web the books and the headphones are partner links; in the app a
 * purchase only starts from a product screen's buy button.
 *
 * Static shapes only (no filters, no animation): the web's blurred floor shadows become soft
 * radial gradients, which draw in one pass on every platform.
 *
 * `compact` (phones): the drawing is a small vignette in a fixed box at the bottom right of the
 * slide (lib/home.ts heroArtBox). The example screens switch to a one-card layout that stays
 * legible in ~200 dp. Their words are part of the picture — fixed size, hidden from screen
 * readers — so they do not grow with the system text size; the slide's real text does.
 */
export const HeroArt = memo(function HeroArt({ kind, height, width, compact = false }: { kind: HeroArtKind; height: number; width?: number; compact?: boolean }) {
  const theme = useTheme();
  const align = compact ? 'xMaxYMax meet' : 'xMidYMid meet';
  return (
    <View style={[styles.frame, compact ? { width, height, alignItems: 'flex-end', justifyContent: 'flex-end' } : { height }]} aria-hidden>
      {kind === 'shelf' ? <Shelf height={height} align={align} /> : null}
      {kind === 'ai' ? (compact ? <AiDemoCompact theme={theme} /> : <AiDemo theme={theme} />) : null}
      {kind === 'price' ? <PriceDemo theme={theme} height={height} compact={compact} /> : null}
      {kind === 'memorial' ? <Memorial height={height} align={align} /> : null}
    </View>
  );
});

/** Words inside a drawing: drawn at a fixed size, like text in an image. */
const PICTURE_TEXT = { maxFontSizeMultiplier: 1 } as const;

/* ── 1 · 책장 ──────────────────────────────────────────────────────── */

/**
 * The web's eleven spines: same positions, proportions, colours and slight end-of-row lean.
 * The printed titles become quiet glyph marks — the shape reads as a shelf without shipping the
 * books' names, which on the web exist to link to those books.
 */
type Book = { x: number; y: number; w: number; h: number; fill: string; ink: string; lean?: number; stripes?: string[]; band?: { y: number; h: number; fill: string }; accent?: string };

const BOOKS: Book[] = [
  { x: 56.3, y: 22.2, w: 52.6, h: 273.8, fill: '#0A0A0E', ink: '#EDEAE3', accent: '#C8A951' },
  { x: 108.9, y: 32.8, w: 44.5, h: 263.3, fill: '#0B0B0B', ink: '#F2F0EB', lean: -0.2, stripes: ['#E2342B', '#F08A1D', '#F5C518', '#2E9E52', '#2C6FBF', '#7A4B9E'] },
  { x: 153.4, y: 32.8, w: 35.1, h: 263.3, fill: '#F3F0E9', ink: '#1F2A44', accent: '#B08D57' },
  { x: 188.5, y: 32.8, w: 31.6, h: 263.3, fill: '#14543F', ink: '#F1EFE7' },
  { x: 220.1, y: 32.8, w: 29.3, h: 263.3, fill: '#EDEAE4', ink: '#2B2926', accent: '#B08A4C' },
  { x: 249.3, y: 32.8, w: 25.7, h: 263.3, fill: '#121316', ink: '#F1F1EF', lean: 0.25 },
  { x: 275.0, y: 50.3, w: 30.4, h: 245.7, fill: '#1E3A52', ink: '#EDEBE3', band: { y: 270.3, h: 25.7, fill: '#F2ECC0' } },
  { x: 305.5, y: 67.9, w: 28.1, h: 228.1, fill: '#DEE9F1', ink: '#2C4A66', lean: -0.3 },
  { x: 333.5, y: 73.7, w: 25.7, h: 222.3, fill: '#F2EFE9', ink: '#1C2733', lean: -0.55 },
  { x: 359.3, y: 76.0, w: 23.4, h: 220.0, fill: '#BFE0F0', ink: '#123A5C', lean: -0.4, band: { y: 265.6, h: 30.4, fill: '#4E8FBF' } },
  { x: 382.7, y: 76.0, w: 21.1, h: 220.0, fill: '#8E1B2E', ink: '#F3EAE7', lean: -0.8 },
];

function Spine({ b }: { b: Book }) {
  const cx = b.x + b.w / 2;
  const glyph = Math.min(13, Math.max(5, b.w * 0.27));
  const titleMarks = b.h > 240 ? 4 : 3;
  const small = Math.max(2.6, glyph * 0.36);
  return (
    <G transform={b.lean ? `rotate(${b.lean} ${cx} 296)` : undefined}>
      <Rect x={b.x} y={b.y} width={b.w} height={b.h} rx={1.2} fill={b.fill} />
      {b.stripes?.map((c, i) => <Rect key={c} x={b.x + 29.3 + i * 2.5} y={b.y} width={2.8} height={b.h} fill={c} />)}
      {b.band ? <Rect x={b.x} y={b.band.y} width={b.w} height={b.band.h} rx={1.2} fill={b.band.fill} /> : null}
      {Array.from({ length: titleMarks }, (_, i) => (
        <Rect key={`t${i}`} x={cx - glyph / 2} y={b.y + 13 + i * glyph * 1.22} width={glyph} height={glyph} rx={glyph * 0.18} fill={b.ink} opacity={0.88} />
      ))}
      {b.accent ? <Rect x={cx - 0.6} y={b.y + 22 + titleMarks * glyph * 1.22} width={1.2} height={30} fill={b.accent} opacity={0.9} /> : null}
      {Array.from({ length: 3 }, (_, i) => (
        <Rect key={`a${i}`} x={cx - small / 2} y={b.y + b.h - 56 + i * small * 1.3} width={small} height={small} rx={0.5} fill={b.ink} opacity={0.62} />
      ))}
      {/* Light falls from the upper left: a cylinder across, brighter at the top, a bounce at the foot. */}
      <Rect x={b.x} y={b.y} width={b.w} height={b.h} rx={1.2} fill="url(#bsCurve)" />
      <Rect x={b.x} y={b.y} width={b.w} height={b.h} rx={1.2} fill="url(#bsVert)" />
    </G>
  );
}

function Shelf({ height, align }: { height: number; align: string }) {
  return (
    <Svg width="100%" height={height} viewBox="36 8 388 322" preserveAspectRatio={align}>
      <Defs>
        <LinearGradient id="bsCurve" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#000" stopOpacity={0.34} />
          <Stop offset="0.04" stopColor="#000" stopOpacity={0.14} />
          <Stop offset="0.13" stopColor="#000" stopOpacity={0.04} />
          <Stop offset="0.27" stopColor="#fff" stopOpacity={0.15} />
          <Stop offset="0.40" stopColor="#fff" stopOpacity={0.08} />
          <Stop offset="0.52" stopColor="#fff" stopOpacity={0.02} />
          <Stop offset="0.68" stopColor="#000" stopOpacity={0.05} />
          <Stop offset="0.86" stopColor="#000" stopOpacity={0.13} />
          <Stop offset="0.975" stopColor="#fff" stopOpacity={0.07} />
          <Stop offset="1" stopColor="#000" stopOpacity={0.28} />
        </LinearGradient>
        <LinearGradient id="bsVert" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#fff" stopOpacity={0.09} />
          <Stop offset="0.12" stopColor="#fff" stopOpacity={0.03} />
          <Stop offset="0.46" stopColor="#000" stopOpacity={0} />
          <Stop offset="0.82" stopColor="#000" stopOpacity={0.06} />
          <Stop offset="0.91" stopColor="#fff" stopOpacity={0.03} />
          <Stop offset="1" stopColor="#000" stopOpacity={0.26} />
        </LinearGradient>
        <RadialGradient id="bsShadow" cx="50%" cy="50%" rx="50%" ry="50%">
          <Stop offset="0" stopColor="#544F44" stopOpacity={0.36} />
          <Stop offset="0.6" stopColor="#6B6558" stopOpacity={0.14} />
          <Stop offset="1" stopColor="#8A8375" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Ellipse cx={230} cy={301} rx={214} ry={22} fill="url(#bsShadow)" />
      <Ellipse cx={228} cy={297} rx={176} ry={6} fill="url(#bsShadow)" />
      {BOOKS.map(b => <Spine key={b.x} b={b} />)}
    </Svg>
  );
}

/* ── 2 · AI 쇼핑 (예시 화면) ─────────────────────────────────────────── */

function DemoTag({ theme, small }: { theme: Theme; small?: boolean }) {
  return (
    <View style={[styles.demoTag, small && styles.demoTagSmall, { borderColor: theme.line }]}>
      <View style={[styles.demoDot, { backgroundColor: theme.line2 }]} />
      <AppText {...PICTURE_TEXT} tone="faint" style={[styles.demoTagText, small && styles.demoTagTextSmall]}>{HERO_DEMO.tag}</AppText>
    </View>
  );
}

function AiDemo({ theme }: { theme: Theme }) {
  const card = { backgroundColor: theme.bg, borderColor: theme.line2 };
  return (
    <View style={styles.aiStage}>
      <View style={[styles.card, styles.ask, card]}>
        <AppText {...PICTURE_TEXT} style={[t.footnote, { lineHeight: 19 }]}>{HERO_DEMO.ask.join('\n')}</AppText>
      </View>
      <View style={[styles.card, styles.answer, card]}>
        <DemoTag theme={theme} />
        <View style={styles.answerRow}>
          <View style={[styles.rank, { backgroundColor: theme.ink }]}>
            <AppText {...PICTURE_TEXT} style={[styles.rankText, { color: theme.bg }]}>{HERO_DEMO.rank}</AppText>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText {...PICTURE_TEXT} style={[t.footnote, { fontWeight: '600' }]} numberOfLines={1}>{HERO_DEMO.answerTitle}</AppText>
            <View style={styles.answerMeta}>
              <AppText {...PICTURE_TEXT} style={[t.callout, { fontWeight: '700' }]}>{HERO_DEMO.answerPrice}</AppText>
              <AppText {...PICTURE_TEXT} style={[t.caption, { color: theme.down, fontWeight: '600' }]}>{HERO_DEMO.answerFit}</AppText>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

/** Phone vignette: question and answer on one card, 84 dp tall. */
function AiDemoCompact({ theme }: { theme: Theme }) {
  return (
      <View style={[styles.card, styles.miniCard, { backgroundColor: theme.bg, borderColor: theme.line2 }]}>
      <DemoTag theme={theme} small />
      <View style={[styles.miniAsk, { backgroundColor: theme.surface }]}>
        <AppText {...PICTURE_TEXT} style={styles.miniAskText} numberOfLines={2}>{HERO_DEMO.ask.join('\n')}</AppText>
      </View>
      <View style={styles.miniAnswer}>
        <View style={styles.miniAnswerMain}>
          <View style={[styles.rank, styles.miniRank, { backgroundColor: theme.ink }]}>
            <AppText {...PICTURE_TEXT} style={[styles.miniRankText, { color: theme.bg }]}>{HERO_DEMO.rank}</AppText>
          </View>
          <AppText {...PICTURE_TEXT} style={styles.miniPrice} numberOfLines={1}>{HERO_DEMO.answerPrice}</AppText>
        </View>
        <AppText {...PICTURE_TEXT} style={[styles.miniFit, { color: theme.down }]} numberOfLines={1}>{HERO_DEMO.answerFit}</AppText>
      </View>
    </View>
  );
}

/* ── 3 · 구매 시점 판단 (예시 화면) ───────────────────────────────────── */

/** The web's example curve (.hc-chart): a fall that settles. Not any product's history. */
const DEMO_PATH = 'M4 26 L14 28 L24 25 L34 30 L44 29 L54 32 L64 27 L74 28 L84 24 L94 29 L104 39 L114 36 L124 52 L134 50 L144 57 L154 55 L164 62 L174 60 L184 63 L194 58 L204 58 L214 60 L224 57 L234 59 L244 60 L254 58 L264 60 L276 59';

function PriceDemo({ theme, height, compact }: { theme: Theme; height: number; compact: boolean }) {
  // The phone card has a shallow but still visible chart, followed by its explicit example verdict.
  const chartHeight = compact ? Math.max(18, Math.min(24, height - 60)) : Math.max(52, Math.min(96, height - 92));
  const dark = theme === palette.dark;
  const badge = dark
    ? { color: '#C2D2BD', backgroundColor: '#344539', borderColor: '#667761' }
    : { color: '#46624D', backgroundColor: '#E2E8DD', borderColor: '#B7C5B4' };
  return (
    <View style={[styles.card, compact ? styles.priceMiniCard : styles.priceCard, { backgroundColor: theme.bg, borderColor: theme.line2, borderBottomColor: theme.line2 }]}>
      <DemoTag theme={theme} small={compact} />
      <Svg width="100%" height={chartHeight} viewBox="0 0 280 96" preserveAspectRatio="none" style={{ marginTop: compact ? 2 : 6 }}>
        <Line x1={0} y1={88} x2={280} y2={88} stroke={theme.line} strokeWidth={1} />
        <Path d={DEMO_PATH} fill="none" stroke={theme.ink} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <Circle cx={276} cy={59} r={7} fill={theme.downBg} />
        <Circle cx={276} cy={59} r={3.4} fill={theme.down} />
      </Svg>
      <View style={[styles.verdict, compact && { marginTop: 2, gap: 4 }]}>
        <View style={[styles.badge, compact && styles.miniBadge, { backgroundColor: badge.backgroundColor, borderColor: badge.borderColor }]}>
          <AppText {...PICTURE_TEXT} style={[styles.badgeText, compact && styles.miniBadgeText, { color: badge.color }]}>{HERO_DEMO.verdictBadge}</AppText>
        </View>
        <AppText {...PICTURE_TEXT} tone="soft" style={compact ? styles.miniVerdictText : t.footnote}>{HERO_DEMO.verdictText}</AppText>
      </View>
    </View>
  );
}

/* ── 4 · 참전용사 지원 ─────────────────────────────────────────────── */

/**
 * The web's memorial still life (.hc-memorial), unchanged: a stone plaque, a woven ribbon, a
 * bronze medal and laurel. No battle scene, weapon or flag.
 */
function Memorial({ height, align }: { height: number; align: string }) {
  return (
    <Svg width="100%" height={height} viewBox="0 0 370 300" preserveAspectRatio={align}>
      <Defs>
        <LinearGradient id="hcBronze" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#d6c7a6" /><Stop offset="0.35" stopColor="#b09b70" /><Stop offset="0.72" stopColor="#8b7754" /><Stop offset="1" stopColor="#65553c" />
        </LinearGradient>
        <LinearGradient id="hcStone" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#efebe1" /><Stop offset="1" stopColor="#b8b2a5" />
        </LinearGradient>
        <LinearGradient id="hcFabric" x1="0" y1="0" x2="1" y2="0.4">
          <Stop offset="0" stopColor="#ffffff" stopOpacity={0.19} /><Stop offset="0.4" stopColor="#ffffff" stopOpacity={0} /><Stop offset="1" stopColor="#000000" stopOpacity={0.3} />
        </LinearGradient>
        <Pattern id="hcWeave" width={3} height={3} patternUnits="userSpaceOnUse">
          <Path d="M0 0H3M0 0V3" fill="none" stroke="#efe7d6" strokeOpacity={0.17} strokeWidth={0.5} />
        </Pattern>
        <Pattern id="hcGrain" width={17} height={13} patternUnits="userSpaceOnUse">
          <Circle cx={3} cy={7} r={0.6} fill="#797061" opacity={0.19} /><Circle cx={12} cy={2} r={0.4} fill="#fff" opacity={0.4} />
        </Pattern>
        <Path id="hcLeaf" d="M0 0C-11-3-15-13-12-22C-2-20 4-10 0 0Z" />
      </Defs>
      <Ellipse cx={202} cy={266} rx={124} ry={12} fill="#312b22" opacity={0.07} />
      <Ellipse cx={199} cy={263} rx={102} ry={5} fill="#312b22" opacity={0.12} />
      <G transform="rotate(-2 185 150)">
        <Path d="M81 62L279 62L287 70V255L279 263H81Z" fill="#9d9789" />
        <Rect x={77} y={58} width={202} height={201} rx={4} fill="url(#hcStone)" stroke="#e2dccf" />
        <Rect x={78} y={59} width={200} height={199} rx={4} fill="url(#hcGrain)" />
        <Path d="M81 60H275M79 63V254" fill="none" stroke="#fff" opacity={0.6} />
        <Path d="M155 72H205L200 119L181 140L161 120Z" fill="#514942" opacity={0.18} transform="translate(3 4)" />
        <Path d="M152 69H202L197 116L177 137L158 116Z" fill="#d4cbbb" stroke="#b3a793" />
        <Path d="M154 70H166L171 123L159 115Z" fill="#884f4c" />
        <Path d="M187 70H200L196 115L183 129Z" fill="#44576c" />
        <Path d="M152 69H202L197 116L177 137L158 116Z" fill="url(#hcFabric)" />
        <Path d="M152 69H202L197 116L177 137L158 116Z" fill="url(#hcWeave)" />
        <Path d="M155 72L161 115L177 132L194 114L199 72" fill="none" stroke="#e4d9c2" strokeOpacity={0.55} strokeDasharray="1 2" />
        <Path d="M159 116L177 123L196 115L177 137Z" fill="#35312e" opacity={0.15} />
        <Rect x={150} y={66} width={54} height={6} rx={2} fill="url(#hcBronze)" stroke="#998563" />
        <Ellipse cx={178} cy={138} rx={6} ry={9} fill="none" stroke="#7d6949" strokeWidth={3} />
        <Ellipse cx={177} cy={137} rx={5} ry={8} fill="none" stroke="#c2ae83" strokeWidth={2} />
        <Circle cx={181} cy={181} r={39} fill="#514633" opacity={0.15} />
        <Circle cx={179} cy={177} r={38} fill="#736045" />
        <Circle cx={176} cy={174} r={38} fill="url(#hcBronze)" stroke="#cbbb98" strokeWidth={1.4} />
        <Circle cx={176} cy={174} r={32} fill="none" stroke="#746343" strokeWidth={1} />
        <Circle cx={175.5} cy={173.5} r={30.5} fill="none" stroke="#e0d1af" strokeOpacity={0.5} />
        <Circle cx={176} cy={174} r={28} fill="url(#hcGrain)" />
        <Path d="M176 158C165 150 160 163 169 170C155 172 160 183 171 180C168 193 181 194 184 181C197 184 199 170 185 168C193 157 182 151 176 158Z" fill="#796746" stroke="#caba92" strokeWidth={0.7} />
        <Circle cx={177} cy={173} r={4} fill="#bba67b" stroke="#746243" />
        <G fill="url(#hcBronze)" stroke="#857553" strokeWidth={0.5}>
          <Path d="M153 221C115 207 100 179 106 146M200 221C235 207 248 178 243 150" fill="none" strokeWidth={2} />
          <Use href="#hcLeaf" transform="translate(110 168) rotate(-25)" />
          <Use href="#hcLeaf" transform="translate(115 184) rotate(-41)" />
          <Use href="#hcLeaf" transform="translate(125 201) rotate(-55)" />
          <Use href="#hcLeaf" transform="translate(140 214) rotate(-68)" />
          <Use href="#hcLeaf" transform="translate(239 170) scale(-1 1) rotate(-20)" />
          <Use href="#hcLeaf" transform="translate(234 188) scale(-1 1) rotate(-38)" />
          <Use href="#hcLeaf" transform="translate(223 203) scale(-1 1) rotate(-57)" />
          <Use href="#hcLeaf" transform="translate(210 214) scale(-1 1) rotate(-64)" />
        </G>
        <Path d="M137 239H218" stroke="#a39a86" />
        <Path d="M137 240H218" stroke="#fff" opacity={0.45} />
      </G>
    </Svg>
  );
}

const shadow = {
  boxShadow: '4px 8px 14px rgba(36,39,33,0.12)',
} as const;

const styles = StyleSheet.create({
  frame: { width: '100%', alignItems: 'center', justifyContent: 'center' },
  card: { borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: radius.lg, ...shadow },
  aiStage: { width: '100%', maxWidth: 330, height: '100%' },
  ask: { position: 'absolute', top: 4, left: 0, width: '64%', paddingHorizontal: space.md, paddingVertical: 10, transform: [{ rotate: '-2deg' }] },
  answer: { position: 'absolute', bottom: 6, left: '6%', right: 0, padding: space.md, transform: [{ rotate: '-1.5deg' }] },
  answerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: space.sm },
  answerMeta: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm, marginTop: 2 },
  rank: { paddingHorizontal: 7, paddingVertical: 4, borderRadius: radius.sm },
  rankText: { fontSize: 10, lineHeight: 13, fontWeight: '700' },
  priceCard: { width: '92%', maxWidth: 320, padding: space.md, borderBottomWidth: 3, transform: [{ rotate: '-2deg' }] },
  verdict: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: space.sm },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.sm, borderWidth: 1 },
  badgeText: { fontSize: 11, lineHeight: 15, fontWeight: '800' },
  demoTag: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 5, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  demoTagSmall: { paddingHorizontal: 6, paddingVertical: 1, gap: 4 },
  demoDot: { width: 4, height: 4, borderRadius: 2 },
  demoTagText: { fontSize: 10, lineHeight: 14, fontWeight: '700' },
  demoTagTextSmall: { fontSize: 9, lineHeight: 12 },
  // Phone vignettes (≈200 × 84 dp).
  miniCard: { width: '100%', height: '100%', paddingHorizontal: 9, paddingVertical: 3, borderRadius: 10, borderBottomWidth: StyleSheet.hairlineWidth * 2 },
  priceMiniCard: { width: '100%', height: '100%', paddingHorizontal: 9, paddingVertical: 2, borderRadius: 10, borderBottomWidth: StyleSheet.hairlineWidth * 2 },
  miniAsk: { marginTop: 2, paddingHorizontal: 7, paddingVertical: 0, borderRadius: 6 },
  miniAskText: { fontSize: 10.5, lineHeight: 13 },
  miniAnswer: { gap: 0, marginTop: 1 },
  miniAnswerMain: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  miniRank: { paddingHorizontal: 5, paddingVertical: 2 },
  miniRankText: { fontSize: 9, lineHeight: 11, fontWeight: '700' },
  miniPrice: { fontSize: 12, lineHeight: 15, fontWeight: '700' },
  miniFit: { alignSelf: 'flex-end', flexShrink: 1, fontSize: 9.5, lineHeight: 12, fontWeight: '600' },
  miniBadge: { paddingHorizontal: 5, paddingVertical: 1 },
  miniBadgeText: { fontSize: 9.5, lineHeight: 12 },
  miniVerdictText: { fontSize: 10.5, lineHeight: 14 },
});
