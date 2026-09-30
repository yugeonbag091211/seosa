import * as Linking from 'expo-linking';
import { Alert, Pressable, StyleSheet } from 'react-native';
import { purchaseTarget } from '../lib/affiliate';
import { radius, type as t, useTheme } from '../lib/theme';
import { AppText } from './AppText';
import { Icon } from './Icon';

/**
 * Opens the server's affiliate URL with the OS, unchanged (lib/affiliate.ts explains why).
 * Without a usable link the button is not rendered at all — the web hides it the same way
 * (Modal.open: «누를 수 없는 버튼을 띄워 놓고 … 처음부터 없는 편이 정직하다»).
 */
export function BuyButton({ link, mallLabel }: { link: string; mallLabel: string }) {
  const theme = useTheme();
  const target = purchaseTarget(link, mallLabel);
  if (!target) return null;
  const open = async () => {
    try {
      await Linking.openURL(target.url);
    } catch {
      Alert.alert('판매처를 열지 못했어요', '잠시 후 다시 시도해 주세요.');
    }
  };
  return (
    <Pressable
      onPress={open}
      accessibilityRole="link"
      accessibilityHint="판매처 페이지가 열립니다. 제휴 링크입니다."
      style={({ pressed }) => [styles.btn, { backgroundColor: theme.control, opacity: pressed ? 0.8 : 1 }]}
    >
      <AppText style={[t.headline, { color: theme.onControl }]}>{target.label}</AppText>
      <Icon name="external" size={18} color={theme.onControl} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { height: 52, borderRadius: radius.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, flex: 1 },
});
