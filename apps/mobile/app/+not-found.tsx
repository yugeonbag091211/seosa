import { Link, Stack } from 'expo-router';
import { View } from 'react-native';
import { AppText } from '../components/AppText';
import { EmptyState } from '../components/ui';
import { type as t, useTheme } from '../lib/theme';

export default function NotFound() {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, justifyContent: 'center' }}>
      <Stack.Screen options={{ title: '' }} />
      <EmptyState title="찾는 화면이 없어요">
        <Link href="/" style={{ marginTop: 16 }}>
          <AppText style={[t.callout, { fontWeight: '600', textDecorationLine: 'underline' }]}>홈으로</AppText>
        </Link>
      </EmptyState>
    </View>
  );
}
