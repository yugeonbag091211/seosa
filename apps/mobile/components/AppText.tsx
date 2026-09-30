import { createContext, useContext, type ReactNode } from 'react';
import { StyleSheet, Text, type TextProps, type TextStyle } from 'react-native';
import { bodyFamily, PLEX_MONO } from '../lib/typeface';
import { useTheme } from '../lib/theme';

/** True once the bundled fonts are registered; false while loading or after a failure (system font then). */
const FontsReady = createContext(false);
/** Inside another AppText: a child without its own weight inherits the parent's face. */
const Nested = createContext(false);

export function TypefaceProvider({ ready, children }: { ready: boolean; children: ReactNode }) {
  return <FontsReady.Provider value={ready}>{children}</FontsReady.Provider>;
}

export function useFontsReady() {
  return useContext(FontsReady);
}

type Props = TextProps & { mono?: boolean; tone?: 'ink' | 'soft' | 'faint' };

/** Text in the web's typefaces, default ink colour. */
export function AppText({ style, children, mono, tone = 'ink', ...rest }: Props) {
  const ready = useContext(FontsReady);
  const nested = useContext(Nested);
  const theme = useTheme();
  const flat: TextStyle = StyleSheet.flatten([nested ? null : { color: theme[tone] }, style]) || {};
  let resolved: TextStyle = flat;
  if (ready) {
    if (mono) {
      resolved = { ...flat, fontFamily: PLEX_MONO };
      delete resolved.fontWeight;
    } else if (!flat.fontFamily && !(nested && flat.fontWeight === undefined)) {
      resolved = { ...flat, fontFamily: bodyFamily(flat.fontWeight) };
      delete resolved.fontWeight;
    }
  } else if (mono) {
    resolved = { ...flat, fontVariant: ['tabular-nums'] };
  }
  return (
    <Text {...rest} style={resolved}>
      <Nested.Provider value>{children}</Nested.Provider>
    </Text>
  );
}
