import { View } from 'react-native';
import { digits, percent } from '../lib/format';
import { type as t, useTheme } from '../lib/theme';
import { AppText } from './AppText';

/** "15,900원" with the unit set smaller, like the web's .price / .won. */
export function Price({ value, size = 'row' }: { value: number; size?: 'row' | 'hero' }) {
  const text = digits(value);
  if (!text) return null;
  const base = size === 'hero' ? t.heroPrice : t.price;
  return (
    <AppText style={base} accessibilityLabel={`${text}원`}>
      {text}
      <AppText style={{ fontSize: base.fontSize * 0.62, fontWeight: '600' }}>원</AppText>
    </AppText>
  );
}

/** "▼ 1,000원 · 10%" in the web's --down colour. Only rendered from server numbers. */
export function DropLabel({ amount, pct }: { amount: number; pct: number }) {
  const theme = useTheme();
  if (!(amount > 0) || !(pct > 0)) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <AppText style={[t.footnote, { color: theme.down, fontWeight: '600' }]} accessibilityLabel={`${digits(amount)}원, ${percent(pct)} 내림`}>
        ▼ {digits(amount)}원 · {percent(pct)}
      </AppText>
    </View>
  );
}
