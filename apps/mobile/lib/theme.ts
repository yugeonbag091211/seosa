import { Platform, useColorScheme } from 'react-native';

/*
 * Design tokens copied from the public web site (public/index.html :root and
 * html[data-theme="dark"]). Names follow the app; the web variable is noted beside each.
 * Chart colors come from the web's Theme.chartColors().
 */
export const palette = {
  light: {
    background: '#FFFFFF',   // --bg
    page: '#F4F5F7',         // --page
    surface: '#F4F5F7',      // --surface
    surface2: '#E8EAEE',     // --surface-2
    card: '#FFFFFF',         // --card-bg
    text: '#15171B',         // --ink
    muted: '#585E68',        // --soft
    faint: '#68707A',        // --faint
    border: '#E2E5E9',       // --line
    borderStrong: '#C7CCD3', // --line-2
    positive: '#0A7A46', positiveSurface: '#E9F5EF', positiveBorder: 'rgba(10,122,70,0.28)',  // --down
    warning: '#C0392B', warningSurface: '#FBECEA', warningBorder: 'rgba(192,57,43,0.24)',     // --up
    brand: '#8A6D1C', brandSurface: '#FAF5E7',                                                // --brand
    coupang: '#C81B25', ali: '#E0560C', naver: '#03A95C', adpick: '#3D6BE0',
    chartLine: '#101010', chartGrid: '#EFEFEA', chartTick: '#A6A69E',
    chartFill: 'rgba(16,16,16,0.10)', chartPoint: '#FFFFFF', chartLast: '#C9362B',
    trustMedium: '#B08900', trustLow: '#C2701C', trustLowLabel: '#95530F',                    // .t-medium / .t-low
    fieldBg: '#F4F5F7',                                                                        // header .search-field
  },
  dark: {
    background: '#16181C', page: '#0F1114', surface: '#1E2127', surface2: '#282C33', card: '#1B1E23',
    text: '#EAEDF1', muted: '#98A0AB', faint: '#848B96', border: '#292E35', borderStrong: '#3B414B',
    positive: '#3ECF8E', positiveSurface: '#0F2A1E', positiveBorder: 'rgba(62,207,142,0.28)',
    warning: '#F0685B', warningSurface: '#2B1512', warningBorder: 'rgba(240,104,91,0.24)',
    brand: '#CBAA4B', brandSurface: '#251F10',
    coupang: '#E8555F', ali: '#F0803C', naver: '#2FC97D', adpick: '#6E8EF0',
    chartLine: '#F0F0EE', chartGrid: '#2A2A2E', chartTick: '#65656A',
    chartFill: 'rgba(240,240,238,0.14)', chartPoint: '#151517', chartLast: '#E5695E',
    trustMedium: '#D9AC26', trustLow: '#E08B3E', trustLowLabel: '#E08B3E',
    fieldBg: '#1B1E23', // html[data-theme="dark"] .search-field uses --card-bg, not --surface
  },
} as const;

export type Theme = (typeof palette)['light'] | (typeof palette)['dark'];

/** --r 4 / --r-sm 3 / --r-lg 8, plus the fixed radii the web uses on mobile. */
export const radius = { r: 4, sm: 3, lg: 8, panel: 10, dropCard: 14, field: 26 } as const;

/** Measured on seosa.ai.kr at a 390px viewport (the ≤480px breakpoint). */
export const space = {
  page: 14,       // .wrap padding
  heroX: 28,      // .hero-band .hero-inner padding
  section: 56,    // section.block margin-top
  sectionHead: 14, // .sec-head margin-bottom
  grid: 10,       // .grid / .drop-cards gap
  header: 50,     // .bar height (plus a 1px rule)
} as const;

/** Web type scale at 390px, in px (= dp). */
export const typography = {
  heroTitle: { fontSize: 38.4, lineHeight: 44.5, fontWeight: '800', letterSpacing: -1.73 },
  heroSub: { fontSize: 15, lineHeight: 23.3, letterSpacing: -0.15 },
  sectionTitle: { fontSize: 16, lineHeight: 19.2, fontWeight: '700', letterSpacing: -0.45 },
  sectionSub: { fontSize: 11.84, lineHeight: 18.35 },
  chip: { fontSize: 12.8, fontWeight: '500' },
  cardTitle: { fontSize: 11.52, lineHeight: 16.1 },
  cardPrice: { fontSize: 16.32, lineHeight: 19.6, fontWeight: '700', letterSpacing: -0.41 },
  won: { fontSize: 10.56, fontWeight: '500' },
  mall: { fontSize: 10.56, lineHeight: 16.4, fontWeight: '600' },
  stamp: { fontSize: 9.28, lineHeight: 14.4, letterSpacing: 0.28 },
  dropName: { fontSize: 11.84, lineHeight: 16 },
  dropPrice: { fontSize: 14.72, lineHeight: 22.8, fontWeight: '700', letterSpacing: -0.29 },
  dropMeta: { fontSize: 10.88, lineHeight: 16.9 },
  modalTitle: { fontSize: 16, lineHeight: 22, fontWeight: '700', letterSpacing: -0.32 },
  modalSub: { fontSize: 11.84, lineHeight: 17.8 },
  verdictHead: { fontSize: 13.44, lineHeight: 19, fontWeight: '700' },
  verdictLine: { fontSize: 11.52, lineHeight: 17.9 },
} as const;

/** Web: the S mark is Georgia bold; stamps use IBM Plex Mono (platform monospace here). */
export const fonts = {
  serif: Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia, serif' }),
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, monospace' }),
} as const;

export function useTheme(): Theme {
  return palette[useColorScheme() === 'dark' ? 'dark' : 'light'];
}
