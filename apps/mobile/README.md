# SEOSA 모바일 앱 (iOS · Android)

Expo SDK 57 · React Native 0.86 · TypeScript · Expo Router · TanStack Query.
웹(`public/index.html`)과 **같은 SEOSA API** 를 그대로 쓰는 독립 네이티브 앱이다. WebView 로 사이트를 감싸지 않는다.

- 설계·분석 보고: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 스토어 출시 체크리스트: [docs/STORE_READINESS.md](docs/STORE_READINESS.md)

## 실행

```bash
cd apps/mobile
npm install
npx expo start          # Expo Go 로 QR 스캔 (iOS/Android)
```

API 주소는 `EXPO_PUBLIC_API_BASE_URL`(기본 `https://seosa.ai.kr`). https 만 허용하고, http 는 localhost·사설망 개발 주소만 허용한다.
앱은 공개 클라이언트다 — `EXPO_PUBLIC_*` 외의 값은 번들에 넣지 않는다(`tests/guard.test.mjs` 가 막는다).

## 검사

```bash
npm run check           # tsc --noEmit + eslint + node 단위 테스트
npx expo export --platform ios --output-dir <임시폴더>
npx expo export --platform android --output-dir <임시폴더>
```

- `lib/` 의 순수 모듈(api·parse·identity·ai·chart·format·savedModel·sessionModel·suggest·affiliate·aiText)은
  React Native 를 import 하지 않는다. node 테스트가 `.ts` 를 직접 불러오기 때문이다
  (`node --experimental-strip-types`). 이 모듈들끼리의 import 는 `.ts` 확장자를 붙인다.
- 루트 웹 테스트(`npm test`, 저장소 루트)는 이 디렉터리를 보지 않는다. 앱 추가로 웹 CI 가 바뀌지 않는다.

## 화면

| 탭 | 데이터 |
|---|---|
| 홈 | `/api/hotdeals?view=today-drop&limit=60` (웹 홈과 같은 목록), `/api/init` (인기 검색어·오늘의 셀렉션) |
| 검색 | `/api/search?keyword=` — 웹과 같은 순위·같은 개수. 자동완성은 인기 검색어 + 이 기기 최근 검색(웹 `Auto` 와 같은 규칙) |
| 가격하락 | today-drop 전체 |
| 저장 | 이 기기(AsyncStorage). 최신 가격은 `/api/history-batch` |
| 마이 | 로그인(이메일 코드), 기기 데이터, 고지 |
| 상품 상세 | `/api/history?productId=&mall=&vendorItemId=&deal=1` — 웹 가격 모달과 같은 호출 |
| AI | `POST /api/ai` — 로그인 없으면 서버 게스트 모드 |

## 로컬에서 화면 확인하는 법 (운영 데이터, 쓰기 없음)

웹 export + 검증 프록시로 확인했다(`docs/ARCHITECTURE.md` «검증» 참고). 프록시는 GET 만 운영으로 넘기고,
`/api/stats` 는 204, 모든 쓰기는 403, `/api/auth` 는 메일을 보내지 않는 가짜 응답이다.
