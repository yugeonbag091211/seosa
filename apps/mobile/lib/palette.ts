/*
 * Design tokens copied from the public web site (public/index.html :root and
 * html[data-theme="dark"]). Names follow the app; the web variable is noted beside each.
 * Chart colors come from the web's Theme.chartColors().
 * Pure data, no React Native import, so node tests can check token contrast directly.
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
    chartLine: '#101010', chartGrid: '#EFEFEA', chartTick: '#6E6E65', // darkened from web's #A6A69E for 4.5:1 label contrast
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
    chartLine: '#F0F0EE', chartGrid: '#2A2A2E', chartTick: '#8A8A90', // lightened from web's #65656A for 4.5:1 label contrast
    chartFill: 'rgba(240,240,238,0.14)', chartPoint: '#151517', chartLast: '#E5695E',
    trustMedium: '#D9AC26', trustLow: '#E08B3E', trustLowLabel: '#E08B3E',
    fieldBg: '#1B1E23', // html[data-theme="dark"] .search-field uses --card-bg, not --surface
  },
} as const;

export type Theme = (typeof palette)['light'] | (typeof palette)['dark'];
