import { router } from 'expo-router';
import { View } from 'react-native';
import { Button, Screen, Text } from '../components/ui';

export default function Home() {
  return <Screen>
    <View style={{ flex: 1, justifyContent: 'space-between', paddingBottom: 36 }}>
      <View style={{ gap: 20, paddingTop: 44 }}>
        <Text style={{ fontSize: 42, fontWeight: '800', letterSpacing: -2 }}>S</Text>
        <Text title>SEOSA</Text>
        <Text muted>가격을 보고, 더 나은 선택을 하세요.</Text>
      </View>
      <View style={{ gap: 18 }}>
        <Button label="상품 검색" onPress={() => router.push('/search')} />
        <View style={{ gap: 4 }}>
          <Text muted style={{ fontSize: 13 }}>API 연결: 검색할 때 확인합니다</Text>
        </View>
      </View>
    </View>
  </Screen>;
}
