# SEOSA 모바일 앱 — 구조 분석과 설계 (2026-09-30, main `9749341` 기준)

## 1. 현재 SEOSA 구조

| 항목 | 실제 구조 | 근거 |
|---|---|---|
| 프론트엔드 | 프레임워크 없음. `public/index.html` 한 파일(12,038줄)의 바닐라 JS SPA + `public/radar.html` | `vercel.json` rewrite `/(?!api/)` → `/public` |
| API | Vercel 서버리스 13개(`api/*.js`), `_`로 시작하는 파일은 공용 모듈. Hobby 12개 한도 때문에 `history.js` 가 `__route` 로 batch·product·page·sitemap·radar·alternatives 를 겸한다 | `api/history.js:401` |
| Supabase | **서버 전용**(service key, `api/_supabase.js`). 브라우저는 Supabase 를 전혀 부르지 않는다 | `public/index.html` 에 supabase 클라이언트 없음 |
| 인증 | Supabase Auth 가 **아니다**. `/api/auth` 가 6자리 코드를 메일(Resend)로 보내고, 코드가 맞으면 HMAC 서명 토큰 `v1.<payload>.<sig>` (30일)을 준다. 서버에 세션 없음 | `api/auth.js`, `api/_auth.js:48` |
| 검색 | `GET /api/search?keyword=` → 쿠팡 파트너스(limit 10) + ADPICK, 6시간 캐시, `products`/`price_history` 에 저장, 관련도→신뢰도→가격 정렬. 부가정보는 헤더(`X-Seosa-Source/Blocked/Correct/Suggest`). 30회/분/IP | `api/search.js` |
| 상품 데이터 | `toClientProduct`: title·lprice·link·image·mall·mallLabel·productId·vendorItemId·oprice·savePct·collectedAt (+검색 시 trust·priceChange·isRocket) | `api/_shop.js:984` |
| 가격 이력 | `GET /api/history?productId&mall&vendorItemId&deal=1` → `{points:[{date,price}], deal}`. KST 일별 최저가, 옵션은 `_price.sameVendorRows` 로 가른다. **상품명 조회 폴백은 제거됨** | `api/history.js:133` |
| 옵션 식별 | 키 = `productId|mall|vendorItemId` (웹 `histKey`, 서버 `splitKey`). `mall` 은 백엔드 ID('쿠팡'·'ADPICK'), 표시 이름은 `mallLabel`. ADPICK 은 vendorItemId 가 항상 '' 이고 productId 가 링크 해시라 옵션 혼동이 없다 | `public/index.html:4930`, `api/_price.js:622` |
| 제휴 링크 | 서버가 준 URL 을 **그대로** 새 창으로 연다(쿠팡 `productUrl` = `link.coupang.com/re/AFFSDP?lptag=…`, ADPICK commission link). 중계 리다이렉트 없음(귀속 손실 방지). 클릭은 `/api/stats?event=click` 로 따로 센다 | `public/index.html:6417`, `:11493` |
| 제휴 고지 | 구매 링크가 있는 화면마다 «이 페이지에는 제휴 링크가 포함되어 있으며, 구매 시 SEOSA가 일정 수수료를 제공받습니다.» + 푸터 쿠팡 파트너스 문구 | PR #113/#114, `scripts/test-affiliate-disclosure.js` |
| AI | `POST /api/ai {question, contextProducts, chatHistory, profile, view, prevTop, prevTopRef}`. 브라우저가 보낸 가격·할인·이력은 **읽지 않는다**(선택자만, 카탈로그와 productId+mall+vendorItemId 정확 일치). 이전 답변은 서버 서명(`turnSig`)이 맞을 때만 assistant 로 인정, 직전 추천은 서명 참조(`topRecommendationRef`). 토큰 없으면 게스트 모드(무료 모델), 틀린 토큰은 401 | `api/_aicontext.js`, `api/ai.js:3290` |
| 홈 | 웹 홈 «핫딜» = `/api/hotdeals?view=today-drop&limit=60` (오늘 실제 하락, 5% 또는 1,000원). `/api/init` 의 `priceDrop` 은 **레거시**(웹이 안 읽음, 뷰 타임아웃) | `public/index.html:5417`, `api/_todaydrop.js` |
| 저장(찜) | 웹 localStorage. 클라우드 동기화 `/api/sync` 는 POST 가 wish·viewed·searches 배열을 **통째로 교체** | `api/sync.js:36` |
| 알림 | 이메일 가격 알림(`/api/alerts` + cron). 푸시 없음 | `api/alerts.js` |
| 정책 문서 | 개인정보처리방침·이용약관은 index.html 안의 오버레이. **독립 URL 없음** | `public/index.html:4085` |
| CORS | public 엔드포인트는 `*`, private 는 허용 오리진만. **Origin 헤더가 없는 네이티브 요청은 그대로 통과**(User-Agent·Referer 검사 없음) | `api/_http.js:46` |

기존 모바일 시도: PR #34(`feat/mobile-app-phase1`, `apps/mobile`, 2026-09-14 이후 정지)는 main `a57815e`(80여 개 PR 전) 기준이다. 홈이 레거시 `priceDrop`·옛 hotdeals 경로를 읽고, 탭·저장·로그인·AI·구매 버튼이 없다. 이 앱은 그 PR 의 폰트·아이콘 원본·텍스트 디코더·타이포 규칙만 가져왔다.

## 2. 앱에서 재사용하는 것

- **API 전부 그대로**: search · history(deal=1) · history-batch · hotdeals(today-drop) · init · auth · ai. 새 엔드포인트, 새 파라미터, 한도 변경 없음.
- **규칙 그대로**: 옵션 키(`histKey`), 서버 판정 문구(deal)는 다시 쓰지 않고 그대로, 모달 헤드라인 = 최근 기록점(없으면 행 가격), 자동완성 정규화(`Auto.key`), AI 요청 모양, 제휴 고지 문구.
- **브랜드**: 웹 CSS 변수(`--ink/--soft/--faint/--line/--down/--up/--brand`), Pretendard + IBM Plex Mono, «카드가 아니라 선이 구조를 만든다», 브랜드 금색은 검증·기록 표시에만.
- **자산**: PR #34 의 폰트(OFL)와 S 마크(아이콘은 iOS 마스크에 맞게 풀블리드로 다시 만듦).

## 3. 앱 전용으로 만든 것

- 하단 탭 5개(홈·검색·가격하락·저장·마이), 상품 상세 스택 화면, AI·로그인 모달.
- 손가락으로 훑는 가격 그래프(계단선, 실제 관측점에만 스냅, 1주/1개월/3개월/1년).
- 토큰 보관: SecureStore(Keychain/Keystore, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`). AsyncStorage 에는 토큰을 절대 두지 않는다.
- 이 기기 저장 목록(옵션 단위), 최근 검색.
- React Query 캐시(staleTime = 서버 엣지 캐시 시간, 검색은 자동 재시도 안 함 — 호출마다 쿠팡 쿼터).
- 푸시 알림 인터페이스(비활성, `lib/notifications.ts`).

## 4. 기술 스택 (선택 이유)

| 선택 | 이유 |
|---|---|
| Expo SDK 57 + RN 0.86 + TS | 제안대로. EAS Build 로 맥 없이 iOS 빌드, OTA 끔(`updates.enabled:false` — 심사 빌드와 실행 코드가 같게) |
| Expo Router | 파일 기반, 딥링크 스킴 `seosa://` 기본 제공 |
| TanStack Query | 웹의 HistCache 역할을 전 화면 공용 캐시로. 중복 호출·재시도 정책을 한 곳에서 |
| expo-image | 디스크+메모리 캐시, ADPICK 임시 이미지 404 시 글자 대체 |
| FlatList | 목록 최대 60개(today-drop)·검색 최대 ~20개라 FlashList(추가 네이티브 의존성)는 불필요 |
| **Supabase SDK 미사용** | 웹도 브라우저에서 Supabase 를 부르지 않는다. 앱이 anon 키로 직접 읽으면 RLS·한도·판정 로직을 우회하는 새 경로가 생긴다 |
| npm (루트와 같은 도구) | 앱은 독립 `package.json`/lock. 루트에 workspaces 를 만들지 않아 Vercel 설치·웹 CI 에 영향 없음 |

## 5. 디렉터리 구조

```
apps/mobile/
  app/                    Expo Router 화면
    _layout.tsx           Provider(QueryClient·Session·LocalData·Typeface), Stack
    (tabs)/_layout.tsx    하단 탭 5개
    (tabs)/index.tsx      홈
    (tabs)/search.tsx     검색
    (tabs)/drops.tsx      가격하락
    (tabs)/saved.tsx      저장
    (tabs)/me.tsx         마이
    product/[key].tsx     상품 상세 (key = productId|mall|vendorItemId)
    concierge.tsx         AI (모달)
    login.tsx             이메일 코드 로그인 (모달)
  components/             AppText · Icon · Thumb · Price · ProductRow · DropRow · PriceChart · BuyButton · Screen · ui
  lib/                    순수: api · parse · types · identity · ai · aiText · chart · format · affiliate · savedModel · sessionModel · suggest · notifications · productCache · aiContext
                          RN: config · storage · session · local · queries · theme · typeface · fontAssets
  tests/                  node --test (51개)
  assets/                 아이콘·스플래시·폰트
  docs/                   이 문서, STORE_READINESS.md
```

## 6. 신규 파일

`apps/mobile/**` 76개(소스 + package-lock + 자산 + 문서). 저장소의 다른 경로에는 파일을 추가하지 않았다.

## 7. 기존 코드에 영향을 주는 부분

**없음.** `api/`, `public/`, `scripts/`, `supabase/`, `.github/`, `vercel.json`, 루트 `package.json` 은 한 글자도 바뀌지 않았다.
- 배포: Vercel 은 루트만 설치하고 비-api 경로는 `/public` 으로만 rewrite 된다(`/package.json` 등 저장소 파일은 운영에서 404 — 실측). `apps/` 는 업로드만 되고 서빙·빌드되지 않는다. 업로드 크기를 줄이려면 `.vercelignore` 에 `apps/` 를 넣을 수 있으나 배포 설정 변경이라 하지 않았다.
- 웹 CI: `tests.yml` 은 루트 `npm ci && npm test` 만 돈다. 앱 검사를 CI 에 넣으려면 `apps/mobile/**` paths 필터를 가진 **새** 워크플로가 필요(미작성).
- 운영 부하: 앱 사용자는 웹 사용자와 같은 엔드포인트·같은 IP당 한도를 쓴다. 검색 1회 = 웹 검색 1회와 같은 쿠팡/ADPICK 호출.

## 8. 예상 위험

| 위험 | 내용 | 대응 / 필요한 결정 |
|---|---|---|
| **쿠팡 파트너스 앱 채널** | 파트너스 링크를 새 채널(앱)에서 쓰려면 채널 등록·앱 내 표기 규정 확인이 필요할 수 있다. 앱은 URL 을 바꾸지 않고 OS 로 연다(인앱 WebView 아님) | 출시 전 쿠팡 파트너스·ADPICK 에 앱 채널 확인 **(사용자)** |
| 제휴 클릭 계측 | 앱은 `/api/stats` 를 부르지 않는다(운영 지표 오염 방지). 따라서 앱 클릭은 SEOSA 지표에 안 잡힌다(귀속 자체는 URL 로 유지) | `src=app` 같은 구분을 서버에 추가할지 결정 **(사용자)** |
| **계정 삭제** | Apple 5.1.1(v): 계정을 만들 수 있는 앱은 앱 안에서 삭제를 시작할 수 있어야 한다. 이메일 인증으로 profiles·user_data·alerts 행이 생기는데 삭제 API 가 없다 | 인증된 삭제 엔드포인트 신설(새 API) **(승인 필요)**. 지금은 안내 문구만 |
| **정책 URL** | 스토어는 개인정보처리방침 URL 필수. 현재 오버레이뿐 | `public/privacy.html`·`terms.html` 신설 **(웹 변경 — 승인 필요)** |
| 찜 동기화 | `/api/sync` POST 는 전체 교체 → 앱이 쓰면 웹 찜을 덮어쓴다. 게다가 웹 `Sync.cleanItem` 이 vendorItemId 를 버린다(웹 기존 결함) | 앱은 기기 저장만. 병합형 동기화는 서버 변경과 함께 |
| 딥링크 옵션 | `/api/history?__route=product` 는 (productId, mall) 당 한 행(한 옵션)만 준다 | 앱은 받은 행의 vendorItemId 가 다르면 가격을 보여 주지 않는다(구현됨) |
| 관련 상품 | `/api/alternatives` 의 `mall` 은 표시 이름이고 vendorItemId 가 없다 → 안전한 식별 불가 | 서버 응답에 백엔드 mall·vid 를 **추가**하면 구현 가능. 이번엔 제외 |
| 다른 판매처 비교 | 웹 «몰별 비교»는 상품명 앞 3단어로 **재검색**(쿠팡 호출 1회)하는 휴리스틱 | 쿼터 비용이 있어 이번엔 제외 |
| `/api/init` 지연 | 캐시 MISS 13~14.5초(`price_drop_top` 뷰 타임아웃, 2026-09-28 실측) | 앱은 init 을 인기 검색어·셀렉션에만 쓰고, 홈 핫딜은 today-drop 을 따로 받아 먼저 그린다(타임아웃 20초) |
| ADPICK 표시 이름 | today-drop 일부 행의 `mallLabel` 이 비어 «ADPICK» 으로 보인다(웹도 같다) | 서버 `mall_label` 채움 문제 |
| 운영 부하 | 앱 트래픽이 늘면 검색 한도(30/분/IP, 쿠팡 분당 쿼터)를 웹과 나눠 쓴다 | 한도 완화 없음. 모니터링 필요 |

## 9. 화면 구성

- **홈**: SEOSA 워드마크 · AI 버튼 / 검색창 / 인기 검색어 칩 / 오늘 가격 하락 5개(«N개 모두 보기») / AI 진입 / 오늘의 셀렉션 4개 / 제휴 고지. 설명 문단 없음.
- **검색**: 입력창(자동완성·최근·인기 순위) → 결과(가격 → 하락 → 상품명 → 판매처·로켓배송). 오래된 캐시면 경고 한 줄, 0건이면 서버 보정어 칩, 장애(503)면 «다시 시도».
- **가격하락**: 순위 · 현재가 · 이전가(취소선) · ▼금액·% · «어제 대비» · SEOSA 검증 배지. 숫자는 전부 서버 값, 맞지 않으면 행을 버린다.
- **상품 상세**: 이미지 · 판매처 · 상품명 · 현재가(관측일) · 서버 판정 / 가격 기록 그래프 · 최저(날짜)·최고·관측 횟수 / AI에게 묻기 / 제휴 고지 / 하단 고정 «쿠팡에서 보기».
- **저장**: 옵션 단위, 최신 기록가 + 저장 후 변화. 이 기기에만.
- **마이**: 로그인/로그아웃/계정 삭제 안내, 기기 데이터, 정책(준비 중 표시), 버전, 제휴·쿠팡 파트너스 고지.
- **AI**: 보고 있던 상품/검색 결과를 선택자로 전달, 서버 상품만 카드로, 게스트 안내, 후속 질문 칩.

## 10. 구현 순서와 현재 위치

| Phase | 상태 |
|---|---|
| 1 구조 분석 · 2 설계 · 3 프로젝트 생성 | 완료 |
| 4 홈/검색 · 5 API 연결 · 6 상세 · 7 그래프 · 8 가격하락 | 골격 완료(운영 데이터로 확인) |
| 9 저장/로그인 | 기기 저장 · 이메일 코드 로그인(검증 프록시의 가짜 응답으로만 확인 — 실제 메일 미발송) |
| 10 AI | 게스트 실호출 2회(빈 문맥 / 검색 결과 8개 선택자 문맥 — 서버가 카탈로그로 확인한 상품만 답에 씀), 만료 토큰(401) 경로 확인 |
| 11 제휴 링크 | URL 무변형 단위 테스트. **실기기에서 쿠팡 앱/사파리로 열린 뒤 귀속 확인은 미실시** |
| 12 스토어 준비 | 앱 설정·아이콘·권한 0개. 정책 URL·계정 삭제·지원 연락처는 결정 필요(`STORE_READINESS.md`) |
| 13 테스트 | 아래 |

## 검증 (2026-09-30)

- `npm run check`: tsc · eslint · node 테스트 51/51.
- `expo export --platform ios|android`: Hermes 번들 생성(2.9MB / 3.2MB). 번들 문자열에 service_role·SUPABASE_SERVICE·각종 API 키 이름 없음(UTF-8/16 모두).
- 루트 `npm test`(웹 전체): exit 0.
- 화면: web export(390×844, headless Chrome) + 검증 프록시(GET 만 운영, `/api/stats` 204, 쓰기 403, auth 가짜). 홈·상세·그래프 스크럽·저장(새로고침 뒤 유지)·검색·자동완성·0건·503·가격하락·마이·로그인·만료 토큰·AI 답변·딥링크·다크모드 — 콘솔 오류 0. 운영으로 간 실제 검색은 2회, AI 게스트 2회.
- **미확인**: 실제 iOS/Android 기기·시뮬레이터 실행(이 PC 에 없음), SecureStore 실기기 동작, 쿠팡 앱 유니버설 링크 귀속, 실제 메일 로그인.
