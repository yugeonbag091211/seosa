# 스토어 출시 체크리스트 (v1.0)

마지막 감사: 2026-10-10 · 상태 표기
- ✅ 해결 — 코드·설정으로 끝났고 자동 테스트가 지킨다
- 🟡 코드 완료 — 웹 배포 또는 실기기/첫 빌드에서 확인이 남았다
- ⛔ 외부 확인 또는 사람 작업 — 코드로 정할 수 없다(계정·결제·제휴사 답변·운영자 사실 확인)

> **검증의 한계.** 이 문서의 ✅ 는 `npm run check`(타입·린트·테스트 97개), `expo config --type introspect`(플러그인까지 반영한 최종 설정), `expo export`(Android·iOS Hermes 번들 생성), 웹 렌더(320·390·800·1280 폭)로 확인한 것이다. **iPhone·iPad 실기기, iOS 시뮬레이터, Android 태블릿 실기기에서는 확인하지 않았다** (Windows 환경, Android SDK 없음). Galaxy 폰 실기기는 사용자가 Expo 로 사용해 «괜찮음» 을 확인했다(2026-10-10, 이번 변경 전 빌드).

## 공통

| 항목 | 상태 | 값 / 근거 |
|---|---|---|
| 앱 이름 | ✅ | SEOSA (`app.json` `name`) |
| Bundle ID / Package | ✅ | `kr.ai.seosa` 양쪽 동일 — 콘솔에 같은 값으로 등록 (`tests/config.test.mjs`) |
| 버전 / 빌드 번호 | ✅ | 1.0.0 · iOS `buildNumber` "1" · Android `versionCode` 1. `appVersionSource: local`, `autoIncrement: false` → **업로드마다 둘 다 직접 올린다** |
| Android target SDK | ✅ | 36 (RN 0.86 기본값). Play 의 신규 앱 최소 요구(35)를 넘는다 |
| 권한 — Android | ✅ | 최종 매니페스트에 남는 요청 권한은 `INTERNET` 하나. 템플릿·라이브러리가 넣는 `VIBRATE`·저장소·`SYSTEM_ALERT_WINDOW`·카메라·위치·연락처·알림 등 12개는 `tools:node="remove"` (2026-10-10 `VIBRATE` 차단 추가). expo-image 의 `ACCESS_NETWORK_STATE`(일반 권한, 사용자 프롬프트 없음)는 이미지 재시도에 쓰여 그대로 둔다 |
| 권한 — iOS | ✅ | 최종 Info.plist 에 `*UsageDescription` **0개**. expo-secure-store 가 기본으로 넣던 Face ID 문구를 `faceIDPermission: false` 로 끔(앱은 생체인증을 쓰지 않는다) |
| 암호화(수출 규정) | ✅ | `ITSAppUsesNonExemptEncryption: false` — HTTPS 만 사용 |
| App Transport Security | ✅ | 실제 prebuild 템플릿은 `NSAllowsArbitraryLoads=false`. API 주소는 https 만 허용(`normalizeBaseUrl`, http 는 개발용 로컬 주소만) |
| 개인정보 매니페스트(iOS) | 🟡 | RN pod install 이 모든 pod 의 `PrivacyInfo.xcprivacy` 를 앱 매니페스트로 합친다(`privacy_file_aggregation_enabled: true`). 첫 TestFlight 업로드 후 Apple 의 ITMS-91053 경고 메일이 없는지 확인 |
| 아이콘 · 스플래시 | ✅ | 1024 RGB 풀블리드, Android adaptive(전경·배경·모노크롬), 라이트·다크 스플래시 |
| SDK 패치 버전 | 🟡 | `npx expo install --check` (2026-10-10): expo 57.0.26→57.0.27, expo-constants 57.0.20→.21, expo-linking 57.0.11→.12, expo-router 57.0.24→.25 권장. 출시 블로커는 아니다. 첫 EAS 빌드 전에 `npx expo install --fix` → `npm run check` → Galaxy 재확인 |
| 개인정보처리방침 URL | 🟡 | `https://seosa.ai.kr/privacy` — 정책 브랜치 머지·배포 후 열린다(그 전에는 404). 앱 마이 → 개인정보처리방침 |
| 이용약관 URL | 🟡 | `https://seosa.ai.kr/terms` — 위와 같음 |
| 고객지원 URL | 🟡 | `https://seosa.ai.kr/support` — 이메일, 문의 유형, 앱 밖 계정 삭제 안내, 사업자 정보, 판매처 문의 구분. 앱 마이 → 고객지원(시스템 브라우저). 웹 배포 후 사용 |
| 고객지원 이메일 | ✅ | `support@seosa.ai.kr` (ImprovMX → 운영자 Gmail). 앱 기본값으로 코드에 있다 — **EAS 빌드는 gitignore 된 `.env` 를 받지 못하므로** env 에만 두면 스토어 빌드에서 사라졌다. `EXPO_PUBLIC_SUPPORT_EMAIL` 은 유효한 주소일 때만 덮어쓴다. 메일 앱이 없으면 주소를 알려 주는 안내가 뜬다 |
| 정책 문서 정확성 | 🟡 | 2026-10-10 운영 코드(main)와 대조: OpenAI(1순위 AI) 추가, Instagram @seosashop, Sentry 문구 정정, 고객지원 메일 경로 기재. 정책 브랜치 `scripts/test-policy-pages.js` 67/0 (main 병합 시뮬레이션) |
| 정책 문서 — 운영자 사실 확인 | 🟡 | 2026-10-11 PR #118(`b1ca123`)에서 ① Supabase Inc. (인도) ② ImprovMX (프랑스·미국) ④ 만 14세 미만 로그인 제한을 반영. 남은 1건: ③ 운영에 `SENTRY_DSN` 설정 여부(코드 `api/_errors.js` 는 DSN 이 있으면 전송한다). 테스트가 목록을 출력한다 |
| 만 14세 미만 로그인 제한 | ✅ | 서버(`api/auth.js`, PR #118)는 `ageConfirmed: true` 없는 인증 코드 요청을 400 으로 거절한다. 앱 로그인 화면은 «만 14세 이상입니다 (필수)» 체크(열 때마다 해제 상태)가 없으면 요청을 보내지 않고, 체크하면 정확히 `ageConfirmed: true` 를 싣는다(`lib/login.ts`, `tests/login.test.mjs`). 검색·가격 확인은 로그인 없이 그대로 |
| 앱 내 계정 삭제 | 🟡 | 마이 → 계정 삭제(확인 체크 → 삭제). `POST /api/account/delete` 는 정책 브랜치에 있다 — 배포 전에는 앱에서 오류로 끝난다. 401→재로그인, 409(PRO 자동결제)→사유 표시, 5xx→재시도 문구 (`tests/release.test.mjs`, `tests/flows.test.mjs` FLOW E) |
| 앱 밖 계정 삭제 | 🟡 | `https://seosa.ai.kr/support` 와 `/privacy#delete-account`: 로그인 이메일로 «계정 삭제 요청» 메일 → 운영자가 수동 처리(운영 절차 필요 — 아래 «사람 작업») |
| 제휴 고지 | ✅ | 구매 링크가 보이는 모든 화면에 웹과 같은 문구, 마이에 쿠팡 파트너스 문구 |
| 제휴 링크 무결성 | ✅ | 서버 URL 을 바이트 그대로 `Linking.openURL` (재작성·리다이렉트·WebView 없음, `tests/affiliate.test.mjs`) |
| **쿠팡·ADPICK 네이티브 앱 채널 허용** | ⛔ **BLOCKED** | 아래 «제휴 링크 — 출시 전 필수 검증». 코드로 추정하지 않는다 |
| 딥링크 | ✅ | `seosa://product/<productId|mall|vendorItemId>`. 400자 초과·제어문자·과대 길이 키는 거절, 나머지는 인코딩된 쿼리 값으로만 서버에 간다 (`tests/hardening.test.mjs`) |
| 넓은 화면(태블릿·폴더블) | 🟡 | Android 16 은 API 36 대상 앱의 세로 고정을 sw≥600dp 기기에서 무시한다 → 앱 전체를 가운데 720dp 열로 제한(폰은 영향 없음). 웹 렌더 800·1280 폭 확인, **Galaxy Tab·Z Fold 실기기 미확인** |
| iPad | ✅ | `supportsTablet: false` → iPad 에서는 iPhone 레이아웃(호환 모드)으로 실행. iPad 스크린샷 불필요. 심사관이 iPad 에서 열어도 iPhone 화면 그대로 |
| 오류 상태 | ✅ | 네트워크·타임아웃·429·5xx·깨진 JSON·잘못된 형태의 응답이 각각 읽을 수 있는 문구로 끝난다. 서버 4xx 문구는 짧은 한국어 문장일 때만 표시(JSON·HTML·스택·영문 메시지는 앱 문구로 대체) |
| 반복 탭 | ✅ | 같은 화면을 700ms 안에 두 번 열지 않는다(상품·AI·로그인·계정 삭제) |
| 푸시 | ✅(비활성) | 켤 때: 기기 토큰 API → expo-notifications → `POST_NOTIFICATIONS` 차단 해제 → 정책 문서 갱신 |
| 비밀값 | ✅ | 앱 소스에 서버 비밀 이름·형태 없음(`tests/guard.test.mjs`), Android·iOS 번들에서 로컬 `.env` 의 실제 비밀값 10개 중 0개 발견(2026-10-10 스캔). 앱은 SEOSA API 만 부르고 Supabase 를 직접 부르지 않는다 |

## Google Play

| 항목 | 상태 | 메모 |
|---|---|---|
| Package name | ✅ | `kr.ai.seosa` — 한 번 정하면 바꿀 수 없다 |
| versionCode | ✅ | 1 (업로드마다 +1) |
| Play 개발자 계정 | ⛔ | 사용자 결제 필요(이번 작업에서 하지 않음). 개인/조직 계정 여부가 아래 테스트 요건을 바꾼다 |
| 비공개 테스트(Closed testing) | ⛔ | 2023-11 이후 만든 **개인** 계정은 프로덕션 신청 전 비공개 테스트(현재 안내 기준 12명 이상 · 14일 연속)가 필요하다. 조직 계정은 면제. 콘솔에서 현재 요건 재확인 |
| 내부 테스트 트랙 | ⛔ | 계정 생성 후 `eas build --profile production --platform android` (AAB) → 내부 테스트 업로드 |
| 개인정보처리방침 URL | 🟡 | `https://seosa.ai.kr/privacy` (배포 후) |
| 고객지원 이메일 | ✅ | `support@seosa.ai.kr` |
| 계정 삭제 URL(필수) | 🟡 | `https://seosa.ai.kr/support` (삭제 절차 섹션) 또는 `https://seosa.ai.kr/privacy#delete-account` |
| Data safety | ⛔ | 아래 «데이터 신고 초안» 을 근거로 작성 — 운영자가 OpenAI 등 처리자의 보관 정책을 보고 최종 판단 |
| 광고 포함 여부 | ⛔ | 앱에 광고 SDK 는 없다. 제휴 링크를 «광고» 로 신고할지는 콘솔 정의를 보고 운영자가 판단 |
| 콘텐츠 등급 설문 | ⛔ | 콘솔에서 작성(쇼핑·가격비교, 사용자 간 소통 없음) |
| 스토어 등록 자산 | ⛔ | 아이콘 512, 그래픽 이미지 1024×500, 폰 스크린샷 2장 이상 |
| 제휴 정책 확인 | ⛔ | 쿠팡 파트너스·ADPICK 앱 채널 허용 — 아래 |

## App Store

| 항목 | 상태 | 메모 |
|---|---|---|
| Bundle ID | ✅ | `kr.ai.seosa` |
| buildNumber | ✅ | "1" (업로드마다 +1) |
| Apple Developer 계정 | ⛔ | 연 회비 결제 필요(이번 작업에서 하지 않음). `eas init`·인증서 생성도 계정 소유자가 |
| TestFlight | ⛔ | 계정 생성 후 `eas build --profile production --platform ios` → `eas submit` |
| 개인정보처리방침 URL | 🟡 | `https://seosa.ai.kr/privacy` (배포 후) |
| Support URL | 🟡 | `https://seosa.ai.kr/support` (배포 후) |
| App Privacy(개인정보 라벨) | ⛔ | 아래 초안. 추적(Tracking) 없음 → ATT 프롬프트 불필요 |
| 5.1.1(v) 앱 내 계정 삭제 | 🟡 | 앱에서 시작·완료된다. 서버 배포 후 실기기에서 로그인 → 삭제 → 재로그인 시 빈 계정 확인 |
| 로그인 방식 | ✅ | 이메일 인증 코드만 → Sign in with Apple 의무 없음(소셜 로그인 없음) |
| 3.1 결제 | ✅ | 앱에서 결제·구독 판매 없음. 실물 상품은 판매처에서 구매(3.1.3(e)) |
| 심사 노트 | 🟡 | 초안 아래. 로그인 없이 전 기능 사용 가능. 계정 삭제 시연은 심사관 이메일로 코드를 받아 로그인 |
| iPad 스크린샷 | ✅ | 불필요(`supportsTablet: false`) |
| iPhone 스크린샷 | ⛔ | 6.9"(또는 6.7") 세트 필요 — 시뮬레이터/실기기에서 촬영 |
| 제휴 정책 확인 | ⛔ | 아래 |

## 데이터 신고 초안 (App Privacy · Data safety 공통 근거)

코드 기준 사실(2026-10-10). **최종 답은 운영자가 콘솔 정의를 읽고 정한다.**

| 데이터 | 언제 | 어디로 | 사용자와 연결 | 비고 |
|---|---|---|---|---|
| 이메일 주소 | 로그인을 고른 경우 | SEOSA 서버(Supabase), Resend(코드 메일) | 예 | 계정 관리·앱 기능. 앱에서 삭제 가능 |
| 검색어 | 검색할 때 | SEOSA 서버 → 쿠팡·ADPICK 검색 | 아니오 | 검색 결과 캐시에 검색어 단위로 남음(누가 검색했는지는 저장 안 함). 앱은 검색 통계(`/api/stats`)를 보내지 않는다 |
| AI 질문·이전 대화·보던 상품 식별자 | AI 를 쓸 때 | SEOSA 서버 → OpenAI(1순위)·OpenRouter·Gemini·Groq | 로그인 시 요청에 토큰이 붙는다 | SEOSA DB 에 저장하지 않음. 처리자 쪽 보관은 각 사 정책 |
| 저장한 상품·최근 검색 | 항상 | **기기에만** | — | 최신 가격 조회 때 상품 식별자만 전송(`/api/history-batch`, 저장 안 함) |
| 로그인 토큰 | 로그인 시 | 기기 보안 저장소(Keychain / Keystore) | — | 서버에 저장하지 않음(무상태 서명 토큰) |
| 기기 ID·광고 ID·위치·연락처·사진·진단·사용 통계 | — | 수집 안 함 | — | 앱에 분석·크래시 SDK 없음 |

암호화 전송: 예(HTTPS). 삭제 요청 수단: 앱 내 삭제 + 웹 안내(support 페이지).

## 심사 노트 초안 (App Review Information · Play 앱 액세스)

```
SEOSA compares product prices from Korean marketplaces (Coupang, ADPICK partners) and shows
price history. Every feature works without an account; the AI assistant also runs in guest mode.
Optional sign-in uses a 6-digit code sent to any e-mail address (no password, no social login).
To test account deletion: 마이(My) → 이메일로 로그인 → enter an address you can read → enter the code
→ 마이 → 계정 삭제 → tick the confirmation → 계정 삭제.
Purchase buttons open the seller's page in the system browser/app (affiliate links, disclosed on
every screen that has one). The app sells nothing itself.
Support: https://seosa.ai.kr/support · support@seosa.ai.kr
```

## 제휴 링크 — 출시 전 필수 검증 (Coupang / ADPICK affiliate link use in native mobile app)

**코드가 보장하는 것 (tests/affiliate.test.mjs, tests/hardening.test.mjs):**
- 서버가 준 URL 을 바이트 그대로 `Linking.openURL` 에 넘긴다 — 검색·가격하락·AI·저장 목록 어느 경로든.
- `lptag`·`subid`·`traceid`·`vendorItemId`·`token` 등 쿼리와 해시가 바뀌지 않는다. 호스트가 바뀌지 않는다(중계 리다이렉트 없음).
- 앱 코드는 제휴 URL 을 만들거나 감싸지 않는다(파트너 도메인·`lptag=` 리터럴, `/go?url=` 류 패턴, WebView·인앱 브라우저 없음).
- `javascript:`·`data:`·`intent:`·상대 주소 등은 버튼 자체를 만들지 않는다.
- 외부 URL 을 여는 곳은 구매 버튼과 마이 화면뿐이다.

**코드로 확인할 수 없는 것 — 허용 여부를 추정하지 않는다:**
- [ ] 쿠팡 파트너스: 네이티브 앱에서 파트너스 링크 사용 허용 여부, 채널(앱) 등록 필요 여부, 앱 내 고지 문구 요건
- [ ] ADPICK: 같은 항목
- [ ] 실기기: iOS 에서 `link.coupang.com` 링크가 쿠팡 앱(유니버설 링크) 또는 사파리로 열린 뒤 실적이 귀속되는지(파트너스 리포트로 확인)
- [ ] 실기기: Android 에서 같은 확인

## 실기기에서 꼭 볼 것 (이번 감사가 확인하지 못한 것)

1. **AI 입력창과 키보드** (Android): 입력창이 키보드 위로 올라오는지. Android 15+ edge-to-edge 에서 `KeyboardAvoidingView` 가 iOS 에서만 동작하도록 되어 있다. 가려지면 수정 필요
2. iOS 모달(AI·로그인·계정 삭제) 위에서 상품을 눌렀을 때 상세가 모달 안에 쌓이고 뒤로 가기가 자연스러운지
3. 쿠팡·ADPICK 구매 버튼 → 쿠팡 앱/브라우저 → 실적 귀속(위 체크리스트)
4. 이메일 문의 행: 메일 앱이 있는 기기/없는 기기
5. Galaxy Z Fold 펼침·Galaxy Tab: 가운데 720dp 열, 회전
6. 다크 모드 전 화면, 시스템 글자 크기 최대

## 사람 작업 (운영)

- 앱 밖 삭제 요청 메일을 받았을 때의 처리 절차: 보낸 주소 = 로그인 이메일 확인 → 같은 범위 삭제(서버의 `api/_account.js` 와 같은 표) → 회신. 지금은 관리자 도구가 없어 Supabase 에서 수동 처리
- 웹 `public/index.html` 의 옛 정책 오버레이 3곳에 개인 Gmail 주소가 남아 있다(정책 브랜치 범위 밖, main 기준 4188·4282·4305행) → 정책 브랜치를 main 에 합친 뒤 `support@seosa.ai.kr` 로 바꾸기 권장

## 후속 과제 — 앱 클릭 통계 (이번 출시 블로커 아님)

현재 앱은 `/api/stats` 를 **부르지 않는다**. 그래서 앱 구매 클릭은 SEOSA 지표에 잡히지 않는다(제휴 귀속은 URL 로 유지).

`/api/stats` 의 현재 의미 (api/stats.js · api/_analytics.js · api/_funnel.js):
- `?event=<이름>` → `daily_metrics(metric_date, metric)` 날짜별 카운터. 이름은 `METRICS` 허용 목록만.
- `?event=visit&vid=` → `visitors` (브라우저 난수 id, 첫/마지막 방문일).
- `?event=affiliate_click&src=&mall=&pid=&vid=` → `funnel_events` 행. **`source` 는 «어느 화면에서» (hotdeal·search·product·radar·ai·compare·home·hero_book)** 라는 뜻이다.

그러므로 `source=mobile_ios` 처럼 넣으면 기존 뜻과 섞인다. 설계안(스키마 변경 필요 — 이번 PR 에서 하지 않음):
1. `funnel_events` 에 `platform text not null default 'web'` 추가(기존 행은 web). 값: `web` · `ios` · `android`.
2. `daily_metrics` 는 (날짜, 지표) 키라 차원이 없다 → `platform` 열을 키에 넣는 마이그레이션, 또는 앱 전용 지표 이름(`app_click` 등)을 허용 목록에 추가.
3. `/api/stats` 가 `platform` 을 허용 목록(web·ios·android)으로만 받는다. 없으면 `web`.
4. 앱은 방문자 id 를 보내지 않거나, 보낸다면 설치별 난수 id 로만(개인 식별과 연결 금지).
5. **개인정보처리방침의 «앱은 이용 통계를 보내지 않습니다» 문장을 먼저 고친 뒤** 켠다.

## 빌드

```bash
npx eas-cli login
npx eas-cli build --profile preview --platform android   # 내부 배포용 APK
npx eas-cli build --profile production --platform ios
```

`eas init` 은 Expo 계정에 프로젝트를 만든다 — 계정 소유자가 직접 실행.
