import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import {
  HERO_SLIDES, PAGER_START, heroArtBox, heroMetrics, pagerStep,
  type HeroAction, type HeroMetrics, type HeroSlide, type PagerEvent,
} from '../lib/home';
import { pushOnce } from '../lib/navigation';
import { layout, radius, space, type as t, useTheme, type Theme } from '../lib/theme';
import { AppText } from './AppText';
import { HeroArt } from './HeroArt';
import { AffiliateNote } from './ui';

/** Where each banner button goes (lib/home.ts HERO_SLIDES lists the web counterpart of each). */
export function runHeroAction(action: HeroAction): void {
  switch (action) {
    case 'concierge': pushOnce('/concierge'); return;
    case 'drops': router.navigate('/drops'); return;
    case 'pledge': pushOnce('/pledge'); return;
  }
}

/**
 * The web's hero carousel (public/index.html #heroCarousel), as a native paging scroller.
 *
 *   · Swipe or tap a dot. No auto-advance: a moving banner above the list the user is reading
 *     costs attention and a timer, and the web itself stops for reduced motion. The four slides
 *     are all reachable without it.
 *   · The band is as tall as the tallest slide, so swiping never changes the page height
 *     (the web stacks its slides for the same reason).
 *   · Slides out of view are hidden from screen readers (the web's inert fix, #89); the dots say
 *     which slide is showing and move between them.
 *   · A dot tap lights its dot at once and keeps it lit while the scroll passes the pages in
 *     between (lib/home.ts pagerStep); a finger swipe follows the visible page.
 *   · Phones: a compact band — the drawing is a vignette at the bottom right and the dots sit
 *     beside it (lib/home.ts heroMetrics). Wide columns keep copy and drawing side by side.
 */
export function HeroCarousel({ stamp }: { stamp: string }) {
  const theme = useTheme();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  // Pages are as wide as the band. The first frame uses the column width the app lays out (window,
  // capped at layout.maxWidth — app/_layout.tsx) so nothing jumps on a phone; onLayout then corrects
  // it wherever the band is narrower (a scrollbar in the web build, for one).
  const [measured, setMeasured] = useState(0);
  const width = measured || Math.round(Math.min(windowWidth, layout.maxWidth));
  const metrics = heroMetrics(width, fontScale);
  const [index, setIndex] = useState(PAGER_START.index);
  const pager = useRef(PAGER_START);
  const isProgrammaticScrolling = useRef(false);
  const scroller = useRef<ScrollView>(null);
  const count = HERO_SLIDES.length;

  const apply = (event: PagerEvent) => {
    if (event.type === 'dot') isProgrammaticScrolling.current = true;
    pager.current = pagerStep(pager.current, event, count);
    setIndex(pager.current.index); // same value → React skips the render
    if (event.type === 'drag' || ((event.type === 'settle' || event.type === 'scroll') && pager.current.target === null)) {
      isProgrammaticScrolling.current = false;
    }
  };

  // Rotation or unfolding changes the page width; keep the same slide in view.
  useEffect(() => {
    scroller.current?.scrollTo({ x: pager.current.index * width, animated: false });
  }, [width]);

  const offset = (e: NativeSyntheticEvent<NativeScrollEvent>) => e.nativeEvent.contentOffset.x;
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Dot taps keep their selected state while the native scroller crosses intermediate pages.
    // pagerStep releases the target at the target offset; a finger drag releases it immediately.
    const event: PagerEvent = { type: 'scroll', x: offset(e), width };
    if (isProgrammaticScrolling.current && pager.current.target !== null) {
      const next = pagerStep(pager.current, event, count);
      if (next.target === null) {
        pager.current = next;
        isProgrammaticScrolling.current = false;
      }
      return;
    }
    apply(event);
  };
  const goTo = (i: number) => {
    if (i === pager.current.index && pager.current.target === null) return;
    apply({ type: 'dot', index: i });
    scroller.current?.scrollTo({ x: i * width, animated: true });
  };

  const dots = (
    <View style={metrics.wide ? styles.dotsRow : styles.dotsInline}>
      {HERO_SLIDES.map((slide, i) => {
        const on = i === index;
        return (
          <Pressable
            key={slide.id}
            onPress={() => goTo(i)}
            hitSlop={{ top: 10, bottom: 10 }}
            style={styles.dotHit}
            accessibilityRole="button"
            accessibilityLabel={`배너 ${i + 1}/${count} ${slide.label}`}
            aria-selected={on}
          >
            {/* Which slide is current is told by shape (pill vs dot), not by colour alone. */}
            <View style={[styles.dot, { width: on ? 20 : 7, backgroundColor: on ? theme.ink : theme.faint }]} />
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <View style={{ backgroundColor: theme.surface }} onLayout={e => setMeasured(Math.round(e.nativeEvent.layout.width))}>
      <ScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        onScrollBeginDrag={() => apply({ type: 'drag' })}
        onMomentumScrollEnd={e => apply({ type: 'settle', x: offset(e), width })}
        scrollEventThrottle={32}
        decelerationRate="fast"
        accessibilityLabel="SEOSA 주요 안내"
      >
        {HERO_SLIDES.map((slide, i) => (
          // aria-hidden is React Native's cross-platform form: accessibilityElementsHidden on iOS,
          // no-hide-descendants on Android, aria-hidden on the web build.
          <View key={slide.id} style={{ width }} aria-hidden={i !== index}>
            <Slide slide={slide} metrics={metrics} stamp={slide.stamp ? stamp : ''} theme={theme} />
          </View>
        ))}
      </ScrollView>
      {dots}
    </View>
  );
}

function Slide({ slide, metrics, stamp, theme }: { slide: HeroSlide; metrics: HeroMetrics; stamp: string; theme: Theme }) {
  const { wide, titleSize, titleLine, artHeight } = metrics;
  const box = heroArtBox(slide.art, metrics);
  const copy = (
    <View style={wide ? styles.copyWide : null}>
      {slide.tag ? (
        <View style={[styles.tag, { borderColor: theme.line2 }]}>
          <AppText tone="soft" style={styles.tagText}>{slide.tag}</AppText>
        </View>
      ) : null}
      <AppText
        accessibilityRole="header"
        maxFontSizeMultiplier={1.3}
        style={{ fontSize: titleSize, lineHeight: titleLine, fontWeight: '800', letterSpacing: -titleSize * 0.04 }}
      >
        {slide.title.join('\n')}
      </AppText>
      <AppText tone="soft" style={[t.callout, styles.sub]}>{slide.sub}</AppText>
      <Pressable
        onPress={() => runHeroAction(slide.cta.action)}
        accessibilityRole="button"
        accessibilityLabel={slide.cta.label}
        style={({ pressed }) => [styles.cta, wide ? styles.ctaWide : null, { backgroundColor: theme.control, opacity: pressed ? 0.85 : 1 }]}
      >
        {/* flexShrink: at large text the label wraps inside the pill instead of running out of it. */}
        <AppText style={[t.callout, styles.ctaText, { color: theme.onControl }]}>{slide.cta.label}</AppText>
        <AppText style={[t.callout, { color: theme.onControl }]}>→</AppText>
      </Pressable>
      {slide.note?.kind === 'affiliate' ? <AffiliateNote style={styles.note} /> : null}
      {slide.note?.kind === 'text' ? <AppText tone="faint" style={[t.caption, styles.textNote]}>{slide.note.text}</AppText> : null}
      {stamp ? (
        <View style={styles.stamp}>
          {/* Brand gold marks SEOSA's own record (lib/theme.ts): this is the date it last collected. */}
          <View style={[styles.stampMark, { backgroundColor: theme.brand }]} />
          <AppText mono tone="faint" style={styles.stampText}>{stamp}</AppText>
        </View>
      ) : null}
    </View>
  );

  if (wide) {
    return (
      <View style={[styles.slide, styles.slideWide]}>
        {copy}
        <View style={styles.artWide}><HeroArt kind={slide.art} height={artHeight} /></View>
      </View>
    );
  }
  // Phones: the bottom row holds the drawing at the right; its left part is where the dots float.
  return (
    <View style={[styles.slide, styles.slideCompact]}>
      {copy}
      <View style={[styles.artRow, { height: metrics.showArt ? artHeight : DOTS_ONLY_ROW }]}>
        {metrics.showArt ? <HeroArt kind={slide.art} height={box.height} width={box.width} compact /> : null}
      </View>
    </View>
  );
}

/** Bottom row height when the drawing is left out (very large text): just room for the dots. */
const DOTS_ONLY_ROW = 24;

const styles = StyleSheet.create({
  slide: { flex: 1, paddingHorizontal: space.gutter },
  // Phones: copy, then the drawing row pinned to the bottom so every slide's row lines up with the dots.
  slideCompact: { justifyContent: 'space-between', paddingTop: space.lg, paddingBottom: space.md },
  // Wide columns: copy beside the drawing, both centred in the band.
  slideWide: { flexDirection: 'row', alignItems: 'center', gap: space.xxl, paddingVertical: space.xxl },
  copyWide: { flex: 1.1 },
  artWide: { flex: 1 },
  artRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'flex-end', marginTop: space.sm },
  tag: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3, marginBottom: 6 },
  tagText: { fontSize: 11, lineHeight: 15, fontWeight: '700' },
  sub: { marginTop: 6 },
  cta: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', maxWidth: '100%', gap: space.sm,
    minHeight: 44, marginTop: space.md, paddingHorizontal: 20, paddingVertical: 10, borderRadius: radius.pill,
  },
  ctaWide: { minHeight: 46, marginTop: space.xl, paddingHorizontal: 22 },
  ctaText: { flexShrink: 1, fontWeight: '600' },
  // The disclosure sits inside the band, so it drops the list padding AffiliateNote uses elsewhere.
  note: { paddingHorizontal: 0, paddingVertical: 0, marginTop: 10 },
  textNote: { marginTop: 10 },
  stamp: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.sm },
  stampMark: { width: 3, height: 11 },
  stampText: { fontSize: 11, lineHeight: 14, letterSpacing: 0.4 },
  // Wide: a centred row under the band. Phones: floating at the bottom left, beside the drawing.
  dotsRow: { pointerEvents: 'box-none', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingBottom: space.sm },
  dotsInline: { pointerEvents: 'box-none', position: 'absolute', left: space.gutter - 7, bottom: 4, flexDirection: 'row', alignItems: 'center' },
  dotHit: { paddingHorizontal: 7, paddingVertical: 9, alignItems: 'center', justifyContent: 'center' },
  dot: { height: 7, borderRadius: 4 },
});
