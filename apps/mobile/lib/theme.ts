import { useColorScheme } from 'react-native';

export const palette = {
  light: { background: '#FFFFFF', surface: '#F6F6F6', text: '#111111', muted: '#666666', border: '#E5E5E5', warning: '#B42332' },
  dark: { background: '#101010', surface: '#1B1B1B', text: '#F5F5F5', muted: '#AAAAAA', border: '#333333', warning: '#FF707A' },
} as const;

export function useTheme() {
  return palette[useColorScheme() === 'dark' ? 'dark' : 'light'];
}
