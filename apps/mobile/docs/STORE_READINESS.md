# 스토어 출시 체크리스트

상태: ✅ 완료 · 🟡 코드 완료, 배포/확인 대기 · ⛔ BLOCKED(사람의 결정·외부 확인 필요)

## 공통

| 항목 | 상태 | 값 / 메모 |
|---|---|---|
| 앱 이름 | ✅ | SEOSA (`app.json` `name`) |
| 버전 / 빌드 | ✅ | 1.0.0 / iOS buildNumber 1 · Android versionCode 1 — 올릴 때마다 둘 다 증가 (`appVersionSource: local`) |
| Bundle ID / Package | ✅ | `kr.ai.seosa` — Apple·Google 콘솔에 같은 값으로 등록 |
| 아이콘 · 스플래시 | ✅ | 1024 RGB 풀블리드(알파 없음), Android adaptive(전경·배경·모노크롬), 라이트·다크 스플래시 |
| 권한 | ✅ | **없음**. Android `permissions: []` + 카메라·위치·연락처·저장소·알림 차단, iOS UsageDescription 없음 (`tests/guard.test.mjs`) |
| 암호화 | ✅ | `usesNonExemptEncryption: false` (HTTPS 만) |
| 개인정보처리방침 URL | 🟡 | `https://seosa.ai.kr/privacy` — 정책 페이지 PR 머지·배포 후 열림(그 전에는 404). 앱 마이 화면에서 연결됨 |
| 이용약관 URL | 🟡 | `https://seosa.ai.kr/terms` — 위와 같음 |
| 정책 문서 검토 | ⛔ | 운영자 확인 필요: Supabase 저장 리전(국외 이전 국가), Sentry 실제 사용 여부, 만 14세 미만 이용 정책, 책임자·연락처 표기 |
| 계정 삭제 | 🟡 | 앱: 마이 → 계정 삭제(확인 체크 + 삭제 버튼). 서버: `POST /api/account/delete` — 정책 페이지 PR 에 포함, 배포 전에는 앱에서 오류로 끝남 |
| 고객지원 연락처 | ⛔ **BLOCKED** | 미정. 앱은 `EXPO_PUBLIC_SUPPORT_EMAIL` 로만 받는다(코드에 주소 없음). 값이 없으면 «준비 중» |
| 제휴 고지 | ✅ | 구매 링크가 있는 화면마다 웹과 같은 문구, 마이에 쿠팡 파트너스 문구 |
| **Coupang / ADPICK affiliate link use in native mobile app** | ⛔ **BLOCKED** | 아래 «제휴 링크 — 출시 전 필수 검증» |
| 심사용 안내 | ✅ | 로그인 없이 전 기능 사용 가능(AI 는 게스트). 계정 삭제 심사용 로그인은 이메일 코드 방식임을 심사 노트에 적기 |
| 푸시 | ✅(비활성) | 켤 때: 기기 토큰 API → expo-notifications → `POST_NOTIFICATIONS` 차단 해제 → 정책 문서 갱신 |

## App Store 전용

| 항목 | 상태 | 메모 |
|---|---|---|
| App Privacy(개인정보 라벨) | ⛔ | 정책 문서 확정 후 작성. 앱 기준: 이메일(로그인 시, 앱 기능), 검색어·AI 질문(앱 기능, 사용자 식별과 연결 안 함). 추적 없음 |
| 5.1.1(v) 앱 내 계정 삭제 | 🟡 | 서버 배포 후 실기기에서 시작→완료 확인 필요 |
| 실기기 / TestFlight 빌드 | ⛔ | EAS 계정·Apple Developer 계정 필요(`eas init` 은 계정 소유자가) |

## Google Play 전용

| 항목 | 상태 | 메모 |
|---|---|---|
| Data safety 양식 | ⛔ | App Privacy 와 같은 근거로 작성 |
| 계정 삭제 **웹 링크** | ⛔ | Play 는 앱 밖에서 삭제를 요청할 수 있는 URL 도 요구한다. 지금은 앱에서만 가능 — 웹 삭제 안내(또는 요청 폼) 필요 |
| 실기기 / 내부 테스트 트랙 빌드 | ⛔ | Play Console 계정 필요 |

## 제휴 링크 — 출시 전 필수 검증 (Coupang / ADPICK affiliate link use in native mobile app)

**코드가 보장하는 것 (tests/affiliate.test.mjs):**
- 서버가 준 URL 을 바이트 그대로 `Linking.openURL` 에 넘긴다 — 검색·가격하락·AI·저장 목록 어느 경로든.
- `lptag`·`subid`·`traceid`·`vendorItemId`·`token` 등 쿼리와 해시가 바뀌지 않는다. 호스트가 바뀌지 않는다(중계 리다이렉트 없음).
- 앱 코드는 제휴 URL 을 만들거나 감싸지 않는다(파트너 도메인·`lptag=` 리터럴, `/go?url=` 류 패턴, WebView·인앱 브라우저 없음).
- 외부 URL 을 여는 곳은 구매 버튼과 마이 화면뿐이다.

**코드로 확인할 수 없는 것 — 허용 여부를 추정하지 않는다:**
- [ ] 쿠팡 파트너스: 네이티브 앱에서 파트너스 링크 사용 허용 여부, 채널(앱) 등록 필요 여부, 앱 내 고지 문구 요건
- [ ] ADPICK: 같은 항목
- [ ] 실기기: iOS 에서 `link.coupang.com` 링크가 쿠팡 앱(유니버설 링크) 또는 사파리로 열린 뒤 실적이 귀속되는지(파트너스 리포트로 확인)
- [ ] 실기기: Android 에서 같은 확인

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
