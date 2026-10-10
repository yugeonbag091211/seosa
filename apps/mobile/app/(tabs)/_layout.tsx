import { Tabs } from 'expo-router';
import { Platform, StyleSheet } from 'react-native';
import { Icon, type IconName } from '../../components/Icon';
import { AppText } from '../../components/AppText';
import { useLocalData } from '../../lib/local';
import { useTheme } from '../../lib/theme';

/*
 * Five tabs, each an existing SEOSA feature: 홈 · 검색 · 가격하락 · 저장 · 마이.
 * The AI concierge is not a tab — it opens from the home header and from a product,
 * where it has something to talk about.
 */
const TABS: { name: string; title: string; icon: IconName; iconOn?: IconName }[] = [
  { name: 'index', title: '홈', icon: 'home' },
  { name: 'search', title: '검색', icon: 'search' },
  { name: 'drops', title: '가격하락', icon: 'trendDown' },
  { name: 'saved', title: '저장', icon: 'bookmark', iconOn: 'bookmarkFill' },
  { name: 'me', title: '마이', icon: 'person' },
];

export default function TabLayout() {
  const theme = useTheme();
  const { saved } = useLocalData();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.ink,
        tabBarInactiveTintColor: theme.faint,
        tabBarStyle: { backgroundColor: theme.bg, borderTopColor: theme.line, borderTopWidth: StyleSheet.hairlineWidth, elevation: 0 },
        /*
         * The bar is a fixed 49 dp. On Android the label scales with the system text size and at
         * 200 % it no longer fits under the icon, so it grows only to 130 %. iOS keeps its own rule:
         * labels stay put and a long press shows the Large Content Viewer (React Navigation's default).
         */
        tabBarLabel: ({ color, children }) => (
          <AppText allowFontScaling={Platform.OS !== 'ios'} maxFontSizeMultiplier={1.3} numberOfLines={1} style={{ fontSize: 10.5, lineHeight: 13, fontWeight: '500', color, textAlign: 'center' }}>
            {children}
          </AppText>
        ),
        sceneStyle: { backgroundColor: theme.bg },
      }}
    >
      {TABS.map(tab => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            tabBarIcon: ({ color, focused }) => (
              <Icon name={focused && tab.iconOn ? tab.iconOn : tab.icon} size={24} color={String(color)} strokeWidth={focused ? 1.9 : 1.6} />
            ),
            tabBarBadge: tab.name === 'saved' && saved.length ? saved.length : undefined,
            tabBarBadgeStyle: { backgroundColor: theme.ink, color: theme.bg, fontSize: 10 },
          }}
        />
      ))}
    </Tabs>
  );
}
