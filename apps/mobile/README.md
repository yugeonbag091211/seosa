# SEOSA mobile · Phase 1

Expo SDK 57, React Native, TypeScript, Expo Router로 만든 모바일 진입점입니다. 기존 웹의 `package.json`, API, Vercel 설정, Supabase 스키마와 독립적으로 유지합니다.

## 실행

Node.js 22.13 이상과 pnpm 11을 사용합니다.

```sh
cd apps/mobile
pnpm install
cp .env.example .env
pnpm start
```

실기기 또는 에뮬레이터에서 Expo Go로 실행할 수 있습니다. API 기본 주소는 `https://seosa.ai.kr`이며 `EXPO_PUBLIC_API_BASE_URL`로 바꿀 수 있습니다. 로컬 API를 쓰려면 기기에서 접근 가능한 주소가 필요합니다. 공개 클라이언트 번들에 들어가는 `EXPO_PUBLIC_*` 변수에는 비밀 키를 넣지 마세요.

```sh
pnpm typecheck
pnpm lint
pnpm test
```

## 연결 범위

- 홈: 브랜드와 검색 진입. 연결 상태는 검색 시 확인하므로 온라인 상태를 추정하지 않습니다.
- 검색: `GET /api/search?keyword=...`. 200 빈 배열과 503 장애를 구분합니다.
- 상세: `GET /api/history?__route=product&pid=...&mall=...`. 서버가 반환한 상품, 가격 기록, Deal Engine 문구를 표시합니다.
- API 클라이언트에 `GET /api/history?productId=...&mall=...&vendorItemId=...&deal=1` 계약도 준비했습니다. 상세 화면은 중복 호출을 피하려고 상품 응답에 포함된 가격 기록을 사용합니다.

Phase 1은 검색 결과에 상품 식별자가 있을 때 상세로 이동합니다. 가격 그래프 대신 최근 5개 관측일을 보여줍니다. 로그인, 관심상품, 푸시, AI Concierge와 앱스토어 설정은 포함하지 않습니다.
