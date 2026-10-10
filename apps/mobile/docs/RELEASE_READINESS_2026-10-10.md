# SEOSA Mobile v1.0 Release Readiness

2026-10-10 · 자율 감사·수정 결과. 체크리스트 본문은 `docs/STORE_READINESS.md`.

## 1. 최종 판정

**조건부 가능.** 코드 쪽 출시 후보는 준비됐고, 남은 것은 대부분 사람·외부 확인이다.

- 코드 기준 준비도: **약 90%** — 남은 10%는 실기기에서만 드러날 수 있는 것(Android 키보드, iOS 모달 위 화면 전환)
- 스토어 제출까지 전체 준비도: **약 65%** — 개발자 계정, 정책 페이지 배포, 제휴 채널 허용, iOS 첫 빌드가 남았다
- **iPhone·iPad·iOS 시뮬레이터·Android 태블릿에서는 한 번도 실행하지 않았다.** «테스트 통과» 는 node 테스트·설정 점검·번들 생성·웹 렌더 결과다

## 2. 이번에 완료한 것

| 변경 | 파일 | 이유 | 검증 |
|---|---|---|---|
| 고객지원 = 웹 /support + 이메일 문의 행 | `lib/links.ts`, `app/(tabs)/me.tsx` | 웹 페이지는 메일 앱 없이도 항상 열리고 앱 밖 삭제 안내까지 담는다(스토어 Support URL 과 같은 주소). 이메일은 주소를 행에 보여 주고, 메일 앱이 없으면 주소를 알린다 | release·flows 테스트, 웹 렌더 |
| 공식 주소를 코드 기본값으로 | `lib/links.ts` | **EAS 빌드는 gitignore 된 `.env` 를 못 본다** → env 에만 있던 주소는 스토어 빌드에서 «준비 중» 이 됐다 | 테스트(빌드 프로필·잘못된 env 값 6종) |
| 링크 열기 실패 안내 | `me.tsx` | 실패를 삼켜 행이 죽은 것처럼 보였다 | 소스 테스트 |
| Face ID 문구 제거 | `app.json` (`faceIDPermission:false`) | expo-secure-store 플러그인이 쓰지도 않는 `NSFaceIDUsageDescription` 를 넣고 있었다(app.json 만 봐서는 안 보임) | `tests/config.test.mjs` (introspect) |
| `VIBRATE` 차단 | `app.json` | Android 템플릿이 넣는 권한, 앱은 진동을 쓰지 않는다 → 최종 요청 권한 `INTERNET` 하나 | config 테스트 |
| 최종 설정 점검 테스트 | `tests/config.test.mjs` | 플러그인이 몰래 넣는 권한까지 잡는다 | 99/99 에 포함 |
| 가격 그래프 축 라벨 잘림 | `lib/chart.ts`, `components/PriceChart.tsx` | 라벨 영역 64dp 고정 → **100만 원 이상 상품(노트북·TV)의 축 라벨이 «1,250,00» 처럼 잘렸다**(번들 폰트 기준 계산, 웹에서 실측) | 테스트 + 웹 렌더 |
| 가격 하락 행 줄바꿈 | `components/DropRow.tsx` | 320dp 폰 + 긴 가격에서 가로 넘침 | 웹 320 렌더 |
| 넓은 화면 720dp 열 | `app/_layout.tsx`, `lib/theme.ts` | Android 16 은 API 36 대상 앱의 세로 고정을 태블릿·펼친 폴더블에서 무시한다(앱 targetSdk 36 확인). 폰은 변화 없음 | 웹 800·1280 렌더 |
| 서버 오류 문구 필터 | `lib/api.ts` | HTML·JSON·스택·영문 메시지가 화면에 나올 수 있었다 | hardening·flows 테스트 |
| 중복 탭/중복 제출 | `lib/tapGuard.ts`, `lib/navigation.ts`, `login.tsx`, `concierge.tsx`, `account-delete.tsx` | 같은 화면 두 번 쌓임. 로그인은 키보드 «다음» + 버튼으로 **코드 메일 2통 → 첫 코드 무효** 가능 | 테스트 |
| 딥링크 방어 + 탭 복귀 | `lib/identity.ts`, `app/_layout.tsx` | 과대·제어문자 키 거절. 콜드 딥링크가 상품만 있는 화면으로 열려 iOS 에서 뒤로 갈 곳이 없었다 → 탭이 밑에 깔린다 | 테스트 + 웹 빌드에서 뒤로 → 홈 확인 |
| 뒤로 버튼 이름 | `app/_layout.tsx` | 스크린리더가 «(tabs)» 라고 읽었다 → «SEOSA» | 웹 접근성 트리 확인 |
| 손상된 최근 검색 복구 | `lib/suggest.ts`, `lib/local.tsx` | 문자열만, 80자 컷 | flows 테스트 |
| 흐름 테스트 FLOW A–G | `tests/flows.test.mjs` | 회귀 자동 탐지 | 8개 |
| 레드팀 테스트 | `tests/hardening.test.mjs` | 악성 입력·오류 상태 | 13개 |
| 정책: OpenAI 추가 등 | `public/privacy.html` 외 (정책 브랜치) | **운영(main)은 OpenAI 를 1순위 AI 로 쓰는데 방침에 없었다** | 정책 테스트 |
| 정책 테스트 강화 | `scripts/test-policy-pages.js` | main 에서는 AI 제공사 주소가 `_llm.js` 밖으로 옮겨가 **검사가 조용히 건너뛰어지고 있었다**(55→52개) | 변이 테스트 2종 검출 |

## 3. Android 상태

**해결:** 요청 권한 INTERNET 하나(최종 매니페스트 기준), target SDK 36, 태블릿·폴더블 레이아웃, 320dp 넘침, 그래프 라벨, 오류·빈 결과·이미지 없음/깨짐·긴 상품명·큰 가격, 외부 링크(바이트 그대로), mailto 실패 안내, 중복 탭, SecureStore 백업 규칙.

**남은 것:**
- AI 입력창이 키보드에 가려지는지 **Galaxy 실기기 확인**(Android 15+ edge-to-edge 에서 `KeyboardAvoidingView` 가 iOS 전용으로 설정됨. 가려지면 `behavior="padding"` 으로 바꾸는 한 줄 수정)
- 뒤로 가기 제스처·하드웨어 백: 코드상 문제 없음, 이번 변경 후 실기기 재확인
- Galaxy Tab / Z Fold 펼침 실기기 확인
- Play 개발자 계정·내부 테스트·(개인 계정이면) 비공개 테스트 14일

## 4. iOS/iPad 상태

**해결(코드·설정):** Bundle ID, buildNumber, 수출 규정 false, 권한 문구 0개, ATS(https 만), `supportsTablet:false` → iPad 는 iPhone 화면 그대로(iPad 스크린샷 불필요), 콜드 딥링크 탭 복귀, 계정 삭제 흐름, Sign in with Apple 불필요(소셜 로그인 없음).

**남은 것 (전부 미실행):** iOS 빌드·실행 0회. TestFlight 에서 ① 모달 위 상품 화면 전환 ② 키보드 ③ 쿠팡 유니버설 링크 귀속 ④ 개인정보 매니페스트 경고(ITMS-91053) 확인. Apple Developer 계정 필요.

## 5. 고객지원/정책 상태

| 항목 | 상태 |
|---|---|
| support@seosa.ai.kr | ✅ 앱 기본값·웹 3문서·.env.example 일치. 개인 Gmail 은 정책 3문서에서 제거(책임자 이름 유지) |
| /support | 🟡 페이지·라우팅·테스트 완료, **배포 전** (스크립트 없음, 다크 모드, 390px 넘침 없음 확인) |
| /privacy | 🟡 main 코드와 대조해 수정, **운영자 확인 4건**(Supabase 리전 · ImprovMX 국가 · SENTRY_DSN · 만 14세 미만) 남음 — 소스에 TODO 주석, 화면에는 안 보임 |
| /terms | 🟡 앱 밖 삭제 방법·고객지원 링크·Instagram 갱신 |
| 계정 삭제 | 🟡 앱 내 삭제 + API(정책 브랜치) 완성, 배포 후 실기기 시작→완료 확인. 앱 밖 요청은 운영자 수동 처리 절차 필요 |

## 6. 스토어 블로커

| 등급 | 항목 | 누가 |
|---|---|---|
| BLOCKER | 쿠팡 파트너스·ADPICK 네이티브 앱 채널에서 제휴 링크 허용 여부 | Coupang · ADPICK (사용자가 문의) |
| BLOCKER | 정책·고객지원·계정 삭제 API 를 main 에 병합·배포(/privacy·/terms·/support·/api/account/delete 가 지금은 404) | 사용자 (코드는 준비됨, 충돌 2곳은 단순 합치기) |
| BLOCKER | Apple Developer · Google Play 개발자 계정 | 사용자 (결제) |
| HIGH | 개인정보처리방침 운영자 확인 4건 | 사용자 |
| HIGH | iOS 첫 빌드·TestFlight(실행 0회) | 사용자 · Apple |
| HIGH | Play 개인 계정이면 비공개 테스트(12명 · 14일) 후 프로덕션 신청 | 사용자 · Google |
| MEDIUM | Android AI 입력창 키보드 실기기 확인 | 사용자 (가려지면 코드 한 줄) |
| MEDIUM | App Privacy · Data safety 작성(초안 있음) | 사용자 |
| MEDIUM | 앱 밖 삭제 요청 처리 절차 | 사용자 |
| LOW | 웹 index.html 옛 오버레이의 개인 Gmail 3곳 | 코드 (정책 브랜치 main 병합 후) |
| LOW | 스크린샷·스토어 문구·심사 노트(초안 있음) | 사용자 |

## 7. 테스트 결과

| 대상 | 명령 | 결과 |
|---|---|---|
| mobile | `cd apps/mobile && npm run check` | typecheck ✓ · lint ✓ · **99/99** (시작 77/77) |
| mobile 빌드 | `expo export --platform android / ios / web` | 3종 성공. Android·iOS 번들 비밀값 스캔: 비밀 형태 0, 로컬 `.env` 실제 값 10개 중 0개 |
| mobile 최종 설정 | `expo config --type introspect` | iOS 권한 문구 0, Android 요청 권한 INTERNET 1 |
| policy (브랜치) | `node scripts/test-policy-pages.js` | **66 PASS / 0 FAIL** (시작 55/0) — WARN 1: OpenAI 는 이 브랜치의 옛 코드에 없음(정상) |
| policy (main 병합 시뮬레이션) | 같은 명령 | **67 PASS / 0 FAIL**, WARN 없음 |
| full repo (main 병합 시뮬레이션) | `npm test` 의 81개 스크립트를 하나씩 | **81/81** (`OPENAI_API_KEY` 를 테스트 프로세스에서 뺀 경우). 이 PC 셸 그대로면 77/81 — AI 라우터 테스트 4개가 셸의 `OPENAI_API_KEY` 를 읽어 실패하며 **순수 main 도 똑같이 75/79** |
| radar (브랜치) | `node scripts/test-radar.js` | 149/1 «하락률 근거» — 아래 |
| radar (main 병합 시뮬레이션) | 같은 명령 | 150/0 |
| 웹 렌더 | 320 · 390 · 800 · 1280 폭, 모의 API | 가로 넘침 없음, 720dp 열, 그래프 라벨 맞음, 오류·빈 결과 문구 |

**test-radar «하락률 근거» 판정 — 기존 실패, 이번 변경과 무관, main 에서 이미 수정됨.** fixture 가 `TODAY='2026-09-07'` 고정이라 시계를 옮겨 돌리면 2026-10-05 까지 150/0, **2026-10-06 부터 매일 149/1**(3회 반복 동일 → flaky 아님, KST 날짜 의존). 브랜치는 radar 코드를 건드리지 않았고(`api/_account.js`·`api/auth.js` 만 변경), main 의 `de2b2a7`(10-08)이 fixture 를 상대 날짜로 고쳤다. 고치지 않았다.

## 8. 발견했지만 건드리지 않은 문제

1. AI 라우터 테스트 4개(`test-llm-router`·`test-multi-provider`·`test-ai-provenance`·`test-guest`)가 셸의 `OPENAI_API_KEY` 에 따라 결과가 바뀐다 — 키가 있는 PC 에서 `npm test` 가 깨진다(CI 는 무관)
2. main 의 `scripts/dev-server.js` 가 Supabase 환경변수 없이 홈을 열면 `/api/hotdeals?view=today-drop` 의 처리되지 않은 오류로 프로세스가 죽는다
3. 웹 `public/index.html` 옛 정책 오버레이: 개인 Gmail 3곳(main 4188·4282·4305행), 내용도 /privacy 와 다르다
4. 앱이 백그라운드에 오래 있다 돌아오면 «오늘 가격 하락» 이 당겨서 새로고침 전까지 어제 목록일 수 있다(React Query 에 AppState 연결 없음)
5. 저장 목록은 200개까지인데 최신 가격 일괄 조회는 100개까지 — 101번째부터는 저장 당시 가격만 보인다
6. PRO 자동결제 중이면 계정 삭제가 409 로 막히고 해지는 웹에서 해야 한다 — 심사관이 PRO 일 가능성은 낮지만 5.1.1(v) 관점의 위험
7. 로그인 토큰이 무상태 서명이라 로그아웃·삭제 뒤에도 탈취된 토큰은 최대 30일 유효(기존에 문서화된 한계)
8. 서버 4xx 문구 일부가 개발자 말투(«키워드 없음», «질문 없음») — 한국어라 화면에 그대로 나온다

## 9. 다음에 박유건이 직접 해야 할 것 (순서대로)

1. **운영자 확인 4건 답하기** — Supabase 리전(대시보드 → Project Settings), ImprovMX 처리 국가, 운영 `SENTRY_DSN` 설정 여부, 만 14세 미만 정책
2. **쿠팡 파트너스·ADPICK 에 앱 채널 제휴 링크 허용 문의**(답을 받기까지 가장 오래 걸릴 수 있다)
3. **브랜치 반영 후 정책 PR 을 main 에 병합·배포** — 아래 «Git 상태» 의 명령으로 원래 브랜치를 앞으로 당긴 뒤, `package.json`(테스트 목록)·`scripts/dev-server.js`(rewrite 목록) 충돌은 양쪽 줄을 모두 남기면 된다. 배포 후 /privacy·/terms·/support 200 확인
4. **Galaxy 에서 이번 빌드로 실기기 확인** — 특히 AI 입력창 키보드, 이메일 문의 행, 구매 버튼 → 쿠팡 앱
5. **광고 일정이 잡히면** Apple·Google 계정 결제 → `eas build` → TestFlight · Play 내부/비공개 테스트

## 10. 광고 시작일 기준 출시 플랜

Play **개인** 계정이면 비공개 테스트 14일이 가장 긴 막대다. 조직 계정이거나 iOS 만 먼저라면 D-10 부터 시작해도 된다.

| 시점 | 할 일 |
|---|---|
| D-21 (Play 개인 계정) | 계정 결제, `eas build`(AAB·IPA), Play 비공개 테스트 시작(12명 이상), TestFlight 내부 테스트. 정책 페이지는 이미 배포돼 있어야 함 |
| D-10 | 실기기 체크리스트(키보드·모달·제휴 귀속·다크 모드·큰 글자) 통과, App Privacy·Data safety·스크린샷·심사 노트 입력 |
| D-7 | App Store 심사 제출(수동 출시로), Play 프로덕션 액세스 신청(비공개 테스트 14일 종료 후) |
| D-5 | 리젝 대응 버퍼 — 수정이 필요하면 buildNumber/versionCode 올려 재제출 |
| D-3 | 승인 확인, 출시 직전 제휴 링크 실적 귀속을 실기기에서 다시 확인 |
| D-1 | 스토어 출시 버튼, support@ 수신 확인, /support 열림 확인 |
| D-day | 광고 시작. 스토어 리뷰·문의 메일·서버 오류 모니터링 |

## 11. Git 상태

**하네스 제약:** 이 세션은 다른 worktree 의 파일 수정이 훅으로 막혀 있고(main 을 PR 브랜치에 합치는 것도 안전 분류기가 거절), 그래서 이 세션 worktree 에서 **원래 브랜치를 그대로 앞으로 당길 수 있는(fast-forward) 새 브랜치 2개**로 작업했다. push·병합 없음.

| worktree | branch | HEAD | 이번 커밋 | 남은 미커밋 |
|---|---|---|---|---|
| `.claude/worktrees/web-policy` | feat/policy-pages-account-delete | `04e9c58` | `04e9c58` feat: add production support page and support contact (기존 미커밋 작업을 그대로 커밋) | 없음 |
| `.claude/worktrees/mobile-app` | feat/mobile-app-v2 | `e63865e` | 없음 | `apps/mobile/.env.example`, `apps/mobile/docs/STORE_READINESS.md` — 내용은 아래 브랜치 첫 커밋에 포함됨 |
| 이 세션 worktree | claude/policy-support-v1 | `a781071` | `a781071` fix(policy): match privacy/terms/support to production code; harden policy tests | — |
| 이 세션 worktree | claude/mobile-v1-release (현재) | `66882c3` | `00568e2` chore: finalize mobile release support configuration and harden failure paths · `66882c3` fix(mobile): guard double submits; deep links keep the tabs underneath · (이 보고서 커밋) | 없음 (`apps/mobile/node_modules` 는 gitignore) |
| `C:\Users\yugeo\seosa` | fix/nomatch-reduction | `a57815e` | 건드리지 않음 | 사용자의 기존 미커밋 변경 그대로 |

원래 브랜치로 옮기는 명령 — `C:\Users\yugeo\seosa` 에서, 확인한 뒤 실행. mobile-app 의 미커밋 2파일은 내용이 `00568e2` 에 들어 있으므로 되돌린 뒤 당긴다:

```bash
git -C .claude/worktrees/web-policy merge --ff-only claude/policy-support-v1
```

```bash
git -C .claude/worktrees/mobile-app restore apps/mobile/.env.example apps/mobile/docs/STORE_READINESS.md
```

```bash
git -C .claude/worktrees/mobile-app merge --ff-only claude/mobile-v1-release
```
