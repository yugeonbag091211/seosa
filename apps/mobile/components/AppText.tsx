import { createContext, useContext, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, type TextProps, type TextStyle } from 'react-native';
import { bodyFamily, PLEX_MONO, resolveTypeface } from '../lib/typeface';

/** True once the bundled fonts are registered; false while loading, after a failure, or after the launch wait gave up. */
const FontsReady = createContext(false);
/** True inside another AppText, so a child without its own weight inherits the parent's face. */
const InsideText = createContext(false);

const SYSTEM_MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

export function TypefaceProvider({ ready, children }: { ready: boolean; children: ReactNode }) {
  return <FontsReady.Provider value={ready}>{children}</FontsReady.Provider>;
}

/** Families for places AppText cannot reach (TextInput, SVG text). `body` is undefined when the system font should be used. */
export function useTypeface() {
  const ready = useContext(FontsReady);
  return {
    ready,
    mono: ready ? PLEX_MONO : SYSTEM_MONO,
    body: (weight?: TextStyle['fontWeight']) => (ready ? bodyFamily(weight) : undefined),
  };
}

/** React Native Text with the web's typefaces applied from `fontWeight` (see lib/typeface.ts). */
export function AppText({ style, children, ...rest }: TextProps) {
  const ready = useContext(FontsReady);
  const nested = useContext(InsideText);
  const flat: TextStyle = StyleSheet.flatten(style) || {};
  const face = resolveTypeface(flat, ready, nested);
  let resolved = style;
  if (face) {
    const next: TextStyle = { ...flat, fontFamily: face.fontFamily };
    delete next.fontWeight;
    resolved = next;
  }
  return <Text {...rest} style={resolved}>
    <InsideText.Provider value>{children}</InsideText.Provider>
  </Text>;
}
