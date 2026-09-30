import Constants from 'expo-constants';
import { createApi } from './api';
import { buildLinks } from './links';

/*
 * Public configuration only. The app is a public client: anything here ends up in the bundle.
 * Server secrets (Supabase service role, Coupang/ADPICK keys, auth signing key) stay on Vercel;
 * the app reaches data only through the SEOSA API, exactly like the web.
 */
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://seosa.ai.kr';

export const APP_VERSION = Constants.expoConfig?.version || '1.0.0';

/** Policy pages and support contact (lib/links.ts). Support stays empty until EXPO_PUBLIC_SUPPORT_EMAIL is set. */
export const LINKS = buildLinks({ supportEmail: process.env.EXPO_PUBLIC_SUPPORT_EMAIL });

export const api = createApi({ baseUrl: API_BASE_URL });
