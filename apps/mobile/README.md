# SEOSA mobile

Expo SDK 57, React Native, TypeScript, Expo Router로 만든 SEOSA 공식 모바일 앱입니다. 기존 웹의 `package.json`, API, Vercel 설정, Supabase 스키마를 변경하지 않습니다. 이 앱은 기존 공개 API를 **읽기만** 합니다.

화면 구조·색·여백·타이포는 **seosa.ai.kr 모바일 웹(390px 폭)을 직접 측정한 값**을 따릅니다. 앱만의 임의 섹션은 두지 않습니다.

## 실행

Node.js 22.13 이상과 pnpm 11을 사용합니다.

```sh
cd apps/mobile
pnpm install
cp .env.example .env
pnpm start
```

실기기 또는 에뮬레이터에서 Expo Go로 실행할 수 있습니다.

## 설치형 베타 빌드 (EAS internal distribution)

| 항목 | 값 |
| --- | --- |
| iOS bundle identifier / Android package | `kr.ai.seosa` (스토어에 올린 뒤에는 바꿀 수 없습니다) |
| 버전 | `app.json`의 `version`(사용자에게 보이는 버전), `ios.buildNumber`, `android.versionCode` — `eas.json`의 `appVersionSource: "local"`이라 저장소 값이 그대로 들어갑니다 |
| 런타임 | `runtimeVersion.policy: "appVersion"` — 네이티브가 호환되는 단위는 `version` |
| 업데이트 | `updates.enabled: false`, `expo-updates` 미설치. 베타에는 OTA가 없고, JS를 바꾸면 새 빌드를 배포합니다 |
| 빌드 재현성 | `requireCommit: true`(커밋된 트리만 빌드), Node `22.23.2`·pnpm `11.27.0` 고정, `EXPO_PUBLIC_API_BASE_URL`은 `eas.json`에서 주입(로컬 `.env`는 업로드되지 않음) |

```sh
cd apps/mobile
npx eas-cli login
npx eas-cli init                                   # 최초 1회: app.json에 extra.eas.projectId 기록 후 커밋
npx eas-cli device:create                          # iOS 기기 등록 (ad hoc)
npx eas-cli build --profile beta --platform android   # 설치용 APK 링크
npx eas-cli build --profile beta --platform ios       # 등록된 기기용 IPA 링크
npx eas-cli build --profile beta-simulator --platform ios  # 기기 등록 없이 시뮬레이터용
```

새 베타를 올릴 때마다 `ios.buildNumber`와 `android.versionCode`를 1씩 올려 커밋합니다. 스토어 제출용 프로필은 아직 두지 않았습니다.

## 환경 변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `EXPO_PUBLIC_API_BASE_URL` | `https://seosa.ai.kr` | API 주소. `https://`만 허용하고, 개발용으로 `http://localhost`·`http://127.0.0.1`만 예외입니다. 잘못된 주소면 요청을 보내지 않고 “API 주소를 확인해 주세요.”를 보여 줍니다. |

`EXPO_PUBLIC_*` 값은 앱 번들에 그대로 들어갑니다. 서버 키(Supabase secret, 쿠팡/ADPICK/AI 키 등)는 절대 넣지 마세요. 로컬 API를 쓰려면 휴대폰에서 접근 가능한 주소가 필요합니다(`localhost`는 휴대폰 자신을 가리킵니다).

## 검사

```sh
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint (eslint-config-expo)
pnpm test        # node --test tests/*.test.mjs
```

UI 렌더링 테스트 인프라는 두지 않았습니다. 화면이 쓰는 판단 로직을 순수 모듈로 분리해 node 테스트로 검증합니다.

- `lib/api.ts` — 요청·타임아웃·오류 분류·응답 검증 (`/api/init`, `/api/search`, `/api/history`)
- `lib/chart.ts` — 가격 그래프 좌표(날짜 비례 x축), y축 눈금·여백(큰 금액은 만/억), 최저·평균·최고 글자 라벨 배치, 채움 영역, 접근성 문구
- `lib/text.ts` — 상품명 HTML 엔티티 해제(한 단계만)
- `lib/typeface.ts` — 글꼴 굵기 → 번들 글꼴 파일 매핑
- `tests/beta.test.mjs` — 위 항목과 `app.json`/`eas.json` 베타 설정(식별자·버전·스플래시·글꼴 파일)
- `lib/format.ts` — 웹과 같은 표시 규칙(관측일 스탬프, 몰 색, 판정 문구, PRICE TREND, 최저/평균/최고)
- `lib/searchSession.ts` — 검색 중복 방지, 다른 검색어로 교체, 취소, 지연 안내

## 디자인 기준 (웹 → 앱)

- 토큰은 `lib/theme.ts`에 있고 값마다 웹 CSS 변수 이름을 적어 두었습니다(`--bg`, `--ink`, `--soft`, `--faint`, `--line`, `--surface`, `--down`, `--up`, `--coupang` …). 라이트/다크 모두 웹과 같은 값입니다.
- 여백: 페이지 좌우 14, 히어로 좌우 28, 섹션 간격 56, 섹션 머리 아래 14, 그리드 간격 10, 헤더 50+1px 선.
- 반경: 데이터 박스 4, 썸네일 8, 신뢰도 패널 10, 핫딜 카드 14, 검색창 26. 그림자·그라데이션 없음.
- 글꼴: 본문 Pretendard(400·500·600·700·800), 관측일·그래프 축 IBM Plex Mono — 웹과 같은 글꼴을 `assets/fonts`에 번들합니다(SIL OFL 1.1, 라이선스 파일 동봉). 릴리스 빌드는 `expo-font` 플러그인으로 네이티브에 넣고, Expo Go에서는 실행 시 등록합니다. 파일 이름이 PostScript 이름과 같아 iOS·Android·Expo Go 모두 같은 이름으로 찾습니다. 굵기마다 파일을 따로 지정하고 `fontWeight`를 함께 주지 않아 Android의 가짜 굵게가 생기지 않습니다. 글꼴 로드가 실패하거나 2.5초를 넘기면 시스템 글꼴로 그대로 표시합니다.
- 스플래시: 라이트 흰 배경 + 검은 S 타일, 다크 `#16181C` 배경 + 밝은 S 타일(`splash-icon-dark.png`). 글꼴이 준비될 때까지 유지합니다.
- S 로고는 웹의 Georgia bold "S"를 래스터로 담은 `brand-mark.png`를 글자색으로 칠해 씁니다(Android에는 Georgia가 없음). 히어로 책장 그림은 웹의 `hero-still` SVG를 그대로 옮겼습니다(블러 그림자만 단색으로 대체).

## 화면

- **홈** (웹 홈과 같은 순서): 헤더(S + 검색창) → 회색 히어로 “최저가도, 고급지게.” + 책장 → 인기 검색어 줄 → **핫딜**(오늘 직전 기록보다 내려간 상품, ↓% · 수집 이후 최저) → **오늘의 셀렉션**(현재 키워드) → **이달의 추천**(9月 …) → 푸터(쿠팡 파트너스 고지). 데이터는 웹 홈과 같은 `GET /api/init`(서버 읽기 전용, 엣지 캐시 5분)입니다. 검색어를 누르면 그 검색어로 검색 화면이 열립니다.
- **검색**: 웹 헤더와 같은 검색창, `"키워드" 큐레이션 완료` 결과 요약(결과 중 최저 · 비교 상품 · 가격대), 2열 플랫 카드(사진 → 로켓배송 → 상품명 → 가격 → 몰·관측일). `GET /api/search?keyword=...`.
- **상세** (웹 «가격의 서사» 모달 순서): 상품 사진 → 상품명 → 가격 → 몰 → 판정 박스 → 가격 신뢰도 → 가격 그래프(y축 가격, 날짜 비례 x축, “최고/평균/최저 금액” 글자 라벨이 붙은 점선) → PRICE TREND → 최저/평균/최고 → 최근 관측 → 판단 근거. `GET /api/history?__route=product&pid=...&mall=...`.

웹에만 있는 기능(AI Concierge, 찜·레이더, 가격 알림, 구매 링크, 정렬·몰 필터, 기간 탭, 몰별 비교)은 앱에 넣지 않았습니다.

## 대기·오류 정책

| 요청 | 타임아웃 | 비고 |
| --- | --- | --- |
| 홈 (`/api/init`) | 12초 | 실패 시 “다시 시도” |
| 검색 | 25초 | 8초가 지나면 “조금 오래 걸리고 있어요” 안내, 언제든 “검색 취소” |
| 상세 | 15초 | 404(상품 없음)는 다시 시도 버튼 없이 안내 |

- **자동 재시도는 하지 않습니다.** 검색은 서버에서 공급자 호출과 저장이 일어날 수 있어, 다시 시도는 항상 사용자가 누를 때만 보냅니다.
- 같은 검색어를 검색 중에 다시 제출하면 무시합니다. 다른 검색어를 제출하면 진행 중 검색을 중단하고 새 검색으로 바꿉니다(이전 응답은 화면에 나오지 않습니다).
- 검색을 취소하면 직전에 보이던 결과로 돌아갑니다. 화면을 떠나면 진행 중인 요청은 중단됩니다.
- 오류 구분: 5xx → 서비스 일시 불안정, 응답 없음 → 네트워크 확인, 시간 초과 → 시간이 길어짐, 404 → 찾을 수 없음, 400 → 검색어 재입력, 읽을 수 없는 응답 → 받은 정보를 읽지 못함. 사용자가 취소한 요청은 오류로 보이지 않습니다.
- 목록 응답에서 형식이 깨진 항목은 버리고 나머지를 보여 줍니다. 홈은 섹션마다 따로 거르며, 받은 상품이 전부 깨졌을 때만 오류로 봅니다.
- 개발 빌드(`__DEV__`)에서만 실패한 요청의 경로와 오류 종류를 `console.warn`으로 남깁니다. 검색어·응답 본문·키는 기록하지 않으며, 프로덕션 빌드에서는 출력하지 않습니다.

## 알려진 제한

- 책장 그림의 바닥 그림자는 블러 없이 단색으로 그립니다(react-native-svg 필터 미지원).
- 상품명·몰 표시 이름의 HTML 엔티티(`&amp;`, `&quot;`, `&#39;` …)는 API 응답을 받을 때 한 번 풀어 표시합니다. 서버로 다시 보내는 `mall`·`productId`·검색어는 바꾸지 않습니다.
- 로그인, 관심상품, 푸시, 오프라인 캐시, OTA 업데이트, 스토어 제출 프로필은 없습니다.
- 가격 그래프 x축은 날짜에 비례합니다(수집이 빠진 날은 간격으로 보임). 날짜를 읽을 수 없는 기록만 순번 간격으로 그립니다. 그래프 안의 금액 글자(축·최저/평균/최고 라벨)는 그림의 일부라 글자 크기 설정을 따르지 않으며, 같은 내용이 그래프 접근성 문구와 아래 최저/평균/최고 칸에 있습니다.
- 글자 크기(Dynamic Type)는 따르고 헤더·검색창·카드는 글자에 맞춰 늘어납니다. 최대 배율만 제한합니다(본문 2배, 컨트롤 1.8배, 제목 1.6배, 히어로 제목 1.25배).
- 글꼴 5종 번들로 앱 크기가 약 8MB 늘어납니다.

## 실기기 체크리스트 (Expo Go)

1. 컴퓨터와 휴대폰을 같은 Wi-Fi에 연결하고 `pnpm start`의 QR 코드를 Expo Go로 엽니다. 연결되지 않으면 `pnpm start --tunnel`.
2. 홈을 seosa.ai.kr 모바일 웹과 나란히 놓고 헤더·히어로·핫딜·오늘의 셀렉션 순서와 간격을 비교합니다.
3. 인기 검색어를 누르면 그 검색어 결과가 바로 나오고, 검색창에 한글로 **마우스**를 입력해 키보드 검색 키를 누르면 마지막 글자까지 검색됩니다.
4. 검색 중 다른 검색어로 다시 검색하면 새 결과만 나오고, “검색 취소”를 누르면 이전 결과로 돌아갑니다.
5. 비행기 모드로 검색하면 “네트워크를 확인해 주세요”, 다시 켜고 “다시 시도”하면 결과가 나옵니다.
6. 상세: 판정 박스 색(초록/빨강/회색), 신뢰도 패널, 그래프 y축 가격과 점선, PRICE TREND, 최저/평균/최고가 웹 모달과 같은지 봅니다.
7. 상세 로딩 중 바로 뒤로 가기 → 오류 없이 이전 화면으로 돌아갑니다.
8. 다크 모드에서 홈·검색·상세의 배경, 구분선, 카드 면, 그래프 색을 확인합니다.
9. 글자 크기를 최대로 키워 헤더·검색창·카드가 잘리지 않는지 확인합니다.
10. VoiceOver/TalkBack으로 카드가 “상품명, 가격, 몰”로 읽히고 그래프가 요약되는지 확인합니다.
