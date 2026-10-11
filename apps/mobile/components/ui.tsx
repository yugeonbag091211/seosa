import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { AFFILIATE_NOTE } from '../lib/affiliate';
import { userMessage } from '../lib/api';
import { radius, space, type as t, useTheme } from '../lib/theme';
import { AppText } from './AppText';
import { Icon } from './Icon';

/** Section title with an optional trailing action ("전체 보기"). */
export function SectionHeader({ title, sub, action, onAction }: { title: string; sub?: string; action?: string; onAction?: () => void }) {
  const theme = useTheme();
  return (
    <View style={styles.sectionHead}>
      <View style={{ flex: 1 }}>
        <AppText style={t.title}>{title}</AppText>
        {sub ? <AppText tone="faint" style={[t.footnote, { marginTop: 2 }]}>{sub}</AppText> : null}
      </View>
      {action && onAction ? (
        <Pressable onPress={onAction} hitSlop={10} accessibilityRole="button" style={styles.action}>
          <AppText tone="soft" style={t.footnote}>{action}</AppText>
          <Icon name="chevronRight" size={14} color={theme.soft} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function Chip({ label, onPress, selected }: { label: string; onPress: () => void; selected?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.chip, {
        borderColor: selected ? theme.ink : theme.line2,
        backgroundColor: selected ? theme.ink : 'transparent',
        opacity: pressed ? 0.6 : 1,
      }]}
    >
      <AppText style={[t.footnote, { color: selected ? theme.bg : theme.ink, fontWeight: '500' }]}>{label}</AppText>
    </Pressable>
  );
}

export function Loading({ label, style }: { label?: string; style?: ViewStyle }) {
  const theme = useTheme();
  return (
    <View style={[styles.state, style]} accessibilityLiveRegion="polite">
      <ActivityIndicator color={theme.faint} />
      {label ? <AppText tone="faint" style={[t.footnote, { marginTop: space.sm }]}>{label}</AppText> : null}
    </View>
  );
}

export function EmptyState({ title, detail, children, style }: { title: string; detail?: string; children?: React.ReactNode; style?: ViewStyle }) {
  return (
    <View style={[styles.state, style]}>
      <AppText style={[t.headline, { textAlign: 'center' }]}>{title}</AppText>
      {detail ? <AppText tone="soft" style={[t.callout, styles.detail]}>{detail}</AppText> : null}
      {children}
    </View>
  );
}

export function ErrorState({ error, onRetry, style }: { error: unknown; onRetry?: () => void; style?: ViewStyle }) {
  const theme = useTheme();
  return (
    <View style={[styles.state, style]} accessibilityLiveRegion="polite">
      <AppText tone="soft" style={[t.callout, styles.detail]}>{userMessage(error) || '다시 시도해 주세요.'}</AppText>
      {onRetry ? (
        <Pressable onPress={onRetry} accessibilityRole="button" style={({ pressed }) => [styles.retry, { borderColor: theme.line2, opacity: pressed ? 0.6 : 1 }]}>
          <AppText style={[t.footnote, { fontWeight: '600' }]}>다시 시도</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Required wherever a purchase link is reachable (web .aff-note — ADPICK approval, 공정위 표시). */
export function AffiliateNote({ style }: { style?: ViewStyle }) {
  return (
    <View style={[styles.note, style]}>
      <AppText tone="faint" style={t.caption}>
        <AppText tone="soft" style={[t.caption, { fontWeight: '600' }]}>제휴 안내  </AppText>
        {AFFILIATE_NOTE}
      </AppText>
    </View>
  );
}

export function Hairline({ inset = 0 }: { inset?: number }) {
  const theme = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.line, marginLeft: inset }} />;
}

const styles = StyleSheet.create({
  sectionHead: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: space.gutter, marginBottom: space.sm },
  action: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingBottom: 3 },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth * 2 },
  state: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, paddingHorizontal: space.xxl },
  detail: { textAlign: 'center', marginTop: space.sm },
  retry: { marginTop: space.lg, paddingHorizontal: 18, paddingVertical: 9, borderRadius: radius.pill, borderWidth: 1 },
  note: { paddingHorizontal: space.gutter, paddingVertical: space.md },
});
