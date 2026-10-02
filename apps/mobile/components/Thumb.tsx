import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { radius, useTheme } from '../lib/theme';
import { AppText } from './AppText';

/*
 * Product image. expo-image caches on disk and in memory and decodes off the JS thread.
 * ADPICK photo URLs are temporary and 404 after some hours (2026-09-26 finding), so a failed
 * image falls back to the product's first letter on a plain surface — never a stock photo.
 */
export function Thumb({ uri, title, size }: { uri: string; title: string; size: number }) {
  const theme = useTheme();
  const [failed, setFailed] = useState(false);
  const glyph = glyphOf(title);
  return (
    <View style={[styles.box, { width: size, height: size, backgroundColor: theme.surface }]}>
      {uri && !failed ? (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={120}
          recyclingKey={uri}
          cachePolicy="memory-disk"
          onError={() => setFailed(true)}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <AppText tone="faint" style={{ fontSize: size * 0.34, fontWeight: '600' }}>{glyph}</AppText>
      )}
    </View>
  );
}

/** First letter of the name itself, skipping tags like "[해외]" or "(정품)". */
export function glyphOf(title: string): string {
  const name = String(title || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
  const m = /[0-9A-Za-z가-힣]/.exec(name) || /[0-9A-Za-z가-힣]/.exec(String(title || ''));
  return m ? m[0].toUpperCase() : '·';
}

const styles = StyleSheet.create({
  box: { borderRadius: radius.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
});
