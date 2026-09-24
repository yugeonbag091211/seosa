import { PLEX_MONO, PRETENDARD } from './typeface';

/*
 * Runtime registration for Expo Go and development. Release builds also embed the same files natively
 * through the expo-font config plugin (app.json), under the same PostScript names.
 * Licenses: assets/fonts/Pretendard-OFL.txt, assets/fonts/IBMPlexMono-OFL.txt (SIL OFL 1.1).
 */
export const FONT_ASSETS = {
  [PRETENDARD[400]]: require('../assets/fonts/Pretendard-Regular.otf'),
  [PRETENDARD[500]]: require('../assets/fonts/Pretendard-Medium.otf'),
  [PRETENDARD[600]]: require('../assets/fonts/Pretendard-SemiBold.otf'),
  [PRETENDARD[700]]: require('../assets/fonts/Pretendard-Bold.otf'),
  [PRETENDARD[800]]: require('../assets/fonts/Pretendard-ExtraBold.otf'),
  [PLEX_MONO]: require('../assets/fonts/IBMPlexMono-Regular.ttf'),
};
