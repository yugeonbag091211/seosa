import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { HERO_SLIDES, heroMetrics, pageIndex, type HeroAction, type HeroMetrics, type HeroSlide } from '../lib/home';
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
 */
export function HeroCarousel({ stamp }: { stamp: string }) {
  const theme = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  // Pages are as wide as the band. The first frame uses the column width the app lays out (window,
  // capped at layout.maxWidth — app/_layout.tsx) so nothing jumps on a phone; onLayout then corrects
  // it wherever the band is narrower (a scrollbar in the web build, for one).
  const [measured, setMeasured] = useState(0);
  const width = measured || Math.round(Math.min(windowWidth, layout.maxWidth));
  const metrics = heroMetrics(width);
  const [index, setIndex] = useState(0);
  const current = useRef(0);
  const scroller = useRef<ScrollView>(null);
  const count = HERO_SLIDES.length;

  // Rotation or unfolding changes the page width; keep the same slide in view.
  useEffect(() => {
    scroller.current?.scrollTo({ x: current.current * width, animated: false });
  }, [width]);

  const settle = (i: number) => {
    if (i === current.current) return;
    current.current = i;
    setIndex(i);
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => settle(pageIndex(e.nativeEvent.contentOffset.x, width, count));
  const goTo = (i: number) => {
    scroller.current?.scrollTo({ x: i * width, animated: true });
    settle(i);
  };

  return (
    <View style={{ backgroundColor: theme.surface }} onLayout={e => setMeasured(Math.round(e.nativeEvent.layout.width))}>
      <ScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
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

      <View style={styles.dots}>
        {HERO_SLIDES.map((slide, i) => {
          const on = i === index;
          return (
            <Pressable
              key={slide.id}
              onPress={() => goTo(i)}
              hitSlop={{ top: 8, bottom: 8 }}
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
    </View>
  );
}

function Slide({ slide, metrics, stamp, theme }: { slide: HeroSlide; metrics: HeroMetrics; stamp: string; theme: Theme }) {
  const { wide, titleSize, titleLine, artHeight } = metrics;
  return (
    <View style={[styles.slide, wide ? styles.slideWide : styles.slideStacked]}>
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
          style={({ pressed }) => [styles.cta, { backgroundColor: theme.control, opacity: pressed ? 0.85 : 1 }]}
        >
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
      <View style={wide ? styles.artWide : styles.artStacked}>
        <HeroArt kind={slide.art} height={artHeight} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  slide: { flex: 1, paddingHorizontal: space.gutter },
  // Phones: copy first, drawing under it (the web below 860 px does the same).
  slideStacked: { justifyContent: 'space-between', paddingTop: space.xl },
  // Wide columns: copy beside the drawing, both centred in the band.
  slideWide: { flexDirection: 'row', alignItems: 'center', gap: space.xxl, paddingVertical: space.xxl },
  copyWide: { flex: 1.1 },
  artStacked: { marginTop: space.md },
  artWide: { flex: 1 },
  tag: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3, marginBottom: space.md },
  tagText: { fontSize: 11, lineHeight: 15, fontWeight: '700' },
  sub: { marginTop: space.md },
  cta: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: space.sm, minHeight: 46, marginTop: space.xl, paddingHorizontal: 22, borderRadius: radius.pill },
  ctaText: { fontWeight: '600' },
  // The disclosure sits inside the band, so it drops the list padding AffiliateNote uses elsewhere.
  note: { paddingHorizontal: 0, paddingVertical: 0, marginTop: space.md },
  textNote: { marginTop: space.md },
  stamp: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.md },
  stampMark: { width: 3, height: 11 },
  stampText: { fontSize: 11, lineHeight: 14, letterSpacing: 0.4 },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingBottom: space.sm },
  dotHit: { paddingHorizontal: 7, paddingVertical: 9, alignItems: 'center', justifyContent: 'center' },
  dot: { height: 7, borderRadius: 4 },
});
