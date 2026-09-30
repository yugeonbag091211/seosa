import Constants from 'expo-constants';
import { createApi } from './api';

/*
 * Public configuration only. The app is a public client: anything here ends up in the bundle.
 * Server secrets (Supabase service role, Coupang/ADPICK keys, auth signing key) stay on Vercel;
 * the app reaches data only through the SEOSA API, exactly like the web.
 */
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://seosa.ai.kr';

export const APP_VERSION = Constants.expoConfig?.version || '1.0.0';

/*
 * The web shows the privacy policy and terms as overlays inside index.html; there is no
 * standalone URL yet, and no public support address has been chosen. Empty values render as
 * "준비 중" instead of a link (see docs/STORE_READINESS.md — both are required for submission).
 */
export const LINKS = {
  site: 'https://seosa.ai.kr',
  privacy: '',
  terms: '',
  support: '',
} as const;

export const api = createApi({ baseUrl: API_BASE_URL });
