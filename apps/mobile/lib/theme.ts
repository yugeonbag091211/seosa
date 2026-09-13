import { useColorScheme } from 'react-native';

// The public web site's neutral palette, expressed as native UI colors.
export const palette = {
  light: {
    background: '#FFFFFF', page: '#F4F5F7', surface: '#F4F5F7', surface2: '#E8EAEE', card: '#FFFFFF',
    text: '#15171B', muted: '#585E68', faint: '#68707A', border: '#E2E5E9', borderStrong: '#C7CCD3',
    positive: '#0A7A46', positiveSurface: '#E9F5EF', warning: '#C0392B', warningSurface: '#FBECEA',
    brand: '#8A6D1C', brandSurface: '#FAF5E7',
  },
  dark: {
    background: '#16181C', page: '#0F1114', surface: '#1E2127', surface2: '#282C33', card: '#1B1E23',
    text: '#EAEDF1', muted: '#98A0AB', faint: '#848B96', border: '#292E35', borderStrong: '#3B414B',
    positive: '#3ECF8E', positiveSurface: '#0F2A1E', warning: '#F0685B', warningSurface: '#2B1512',
    brand: '#CBAA4B', brandSurface: '#251F10',
  },
} as const;

export function useTheme() {
  return palette[useColorScheme() === 'dark' ? 'dark' : 'light'];
}
