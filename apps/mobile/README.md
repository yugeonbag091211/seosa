# SEOSA mobile

Expo SDK 57, React Native, TypeScript, Expo Router로 만든 독립 모바일 앱입니다. 기존 웹의 `package.json`, API, Vercel 설정, Supabase 스키마를 변경하지 않습니다.

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

## 연결 범위와 대기 정책

- 홈: `GET /api/hotdeals?source=internal-history&limit=4&sort=score`의 실제 가격 기록 기반 딜을 최대 3개 표시합니다. 추천 섹션은 명시적 준비 중 자리입니다. 핫딜 상태는 BUY/WAIT/WATCH 판정으로 바꾸지 않습니다.
- 검색: `GET /api/search?keyword=...`. 200 빈 배열, 503 공급자 장애, 네트워크 오류, 타임아웃을 구분합니다. 8초 이후 지연 안내를 보여주고 25초에 요청을 중단합니다.
- 상세: `GET /api/history?__route=product&pid=...&mall=...`를 15초까지 기다립니다. 서버가 반환한 상품, Deal Engine 문구, 최근 30개 관측일 선 그래프와 최근 관측값을 표시합니다.
- API 클라이언트에 `GET /api/history?productId=...&mall=...&vendorItemId=...&deal=1` 계약도 유지합니다. 상세 화면은 중복 호출을 피하려고 상품 응답에 포함된 가격 기록을 사용합니다.

검색은 쿠팡/ADPICK 공급자 호출 및 서버 저장이 일어날 수 있어 타임아웃 뒤 자동 재시도하지 않습니다. 사용자가 다시 시도하거나 진행 중 검색을 취소할 수 있습니다. 로그인, 관심상품, 푸시, AI Concierge와 앱스토어 설정은 포함하지 않습니다.

## Expo Go 실기기 확인

1. 컴퓨터와 휴대폰을 같은 Wi-Fi에 연결하고 `pnpm start`의 QR 코드를 Expo Go로 엽니다. 연결되지 않으면 `pnpm start --tunnel`을 사용합니다.
2. 라이트 모드에서 홈 브랜드·실제 딜 목록을 보고, **마우스**와 **에어팟 프로**를 각각 검색합니다. 첫 요청이 오래 걸리면 8초 후 안내가 바뀌는지 확인합니다.
3. 검색 결과 하나를 열어 상품명·몰·현재 표시 가격·BUY/WAIT/WATCH 등 서버 판정·이유·최근 가격 그래프가 보이는지 확인합니다. 기록이 없는 상품은 빈 기록 안내가 보여야 합니다.
4. 긴 상품명과 큰 가격의 줄바꿈, 이미지 비율, 키보드 닫힘, 스크롤, 검색 중 취소, 상세에서 뒤로 가기를 확인합니다.
5. 휴대폰을 다크 모드로 바꿔 홈·검색·상세의 텍스트, 선, 판정 배지를 다시 확인합니다.
