import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/*
 * Two stores, split by sensitivity:
 *   kv      — AsyncStorage: saved products, recent searches. Nothing that grants access.
 *   secure  — Keychain (iOS) / Keystore-backed (Android) via expo-secure-store: the login token.
 *
 * On web (development preview only) SecureStore does not exist; the token is then held in
 * memory for the tab's lifetime and never written to localStorage.
 */

export const KEYS = {
  saved: 'seosa.saved.v1',
  recentSearches: 'seosa.searches.v1',
  session: 'seosa.session.v1',
} as const;

export const kv = {
  async get<T>(key: string, fallback: T): Promise<T> {
    try {
      const raw = await AsyncStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    try { await AsyncStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or unavailable: keep in memory */ }
  },
  async remove(key: string): Promise<void> {
    try { await AsyncStorage.removeItem(key); } catch { /* ignore */ }
  },
};

const memory = new Map<string, string>();
const webOnly = Platform.OS === 'web';

export const secure = {
  async get(key: string): Promise<string | null> {
    if (webOnly) return memory.get(key) ?? null;
    try { return await SecureStore.getItemAsync(key); } catch { return null; }
  },
  async set(key: string, value: string): Promise<void> {
    if (webOnly) { memory.set(key, value); return; }
    await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  },
  async remove(key: string): Promise<void> {
    if (webOnly) { memory.delete(key); return; }
    try { await SecureStore.deleteItemAsync(key); } catch { /* ignore */ }
  },
};
