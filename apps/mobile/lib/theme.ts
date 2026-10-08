import { useColorScheme } from 'react-native';

/*
 * Design tokens, taken from the web's CSS variables (public/index.html :root and
 * html[data-theme="dark"]); the web name is noted beside each.
 *
 * The web's rule applies here too: structure comes from hairlines and spacing, not cards
 * and shadows (":root — 카드가 아니라 선이 구조를 만든다"). Brand gold marks SEOSA's own
 * record/verification only and is never used for controls.
 */
export const palette = {
  light: {
    bg: '#FFFFFF',          // --bg
    page: '#F4F5F7',        // --page
    surface: '#F4F5F7',     // --surface
    surface2: '#E8EAEE',    // --surface-2
    ink: '#15171B',         // --ink
    soft: '#585E68',        // --soft
    faint: '#68707A',       // --faint (5.05:1 on white)
    line: '#E2E5E9',        // --line
    line2: '#C7CCD3',       // --line-2
    down: '#0A7A46',        // --down  price went down
    downBg: '#E9F5EF',      // --down-bg
    up: '#C0392B',          // --up    price went up
    upBg: '#FBECEA',        // --up-bg
    brand: '#8A6D1C',       // --brand
    brandBg: '#FAF5E7',     // --brand-bg
    coupang: '#C81B25', adpick: '#3D6BE0', ali: '#E0560C',
    control: '#15171B',     // primary button (ink, like the web .buy)
    onControl: '#FFFFFF',
    chartLine: '#15171B',
    chartFill: 'rgba(21,23,27,0.06)',
  },
  dark: {
    bg: '#16181C', page: '#0F1114', surface: '#1E2127', surface2: '#282C33',
    ink: '#EAEDF1', soft: '#98A0AB', faint: '#848B96',
    line: '#292E35', line2: '#3B414B',
    down: '#3ECF8E', downBg: '#0F2A1E', up: '#F0685B', upBg: '#2B1512',
    brand: '#CBAA4B', brandBg: '#251F10',
    coupang: '#E8555F', adpick: '#6E8EF0', ali: '#F0803C',
    control: '#EAEDF1', onControl: '#16181C',
    chartLine: '#EAEDF1',
    chartFill: 'rgba(234,237,241,0.08)',
  },
} as const;

export type Theme = { [K in keyof (typeof palette)['light']]: string };

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? palette.dark : palette.light;
}

/** 4-pt spacing. Generous by default — the web's 5th pass widened every gap for the same reason. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, section: 40, gutter: 20 } as const;

export const radius = { sm: 4, md: 8, lg: 12, pill: 999 } as const;

/** Type scale (dp). Weights resolve to Pretendard files in components/AppText. */
export const type = {
  largeTitle: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.6 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.4 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.3 },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400', letterSpacing: -0.2 },
  callout: { fontSize: 14, lineHeight: 20, fontWeight: '400', letterSpacing: -0.15 },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400', letterSpacing: -0.1 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
  price: { fontSize: 17, lineHeight: 22, fontWeight: '700', letterSpacing: -0.3 },
  heroPrice: { fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.8 },
} as const;

/** Display colour per backend mall id (the web's Fmt.mall classes). */
export function mallColor(theme: Theme, mall: string): string {
  if (mall === '쿠팡') return theme.coupang;
  if (mall === 'ADPICK') return theme.adpick;
  if (mall === '알리익스프레스') return theme.ali;
  return theme.soft;
}
