# SEOSA 2.0 — 진행 기록 · 다음 실행 지점

> 중단 후 이어받는 사람(사람이든 에이전트든)은 **이 파일의 맨 아래 「다음 실행 지점」부터** 읽는다.
> 계약은 [CONTRACTS.md](CONTRACTS.md). 이 파일은 사실만 적는다.

---

## 0. 복구 조사 (2026-09-24)

| 항목 | 결과 |
|---|---|
| 원격 브랜치 73개 | `codex/seosa2-integration` **없음** |
| PR 전체 (열림·닫힘) | "seosa2" 검색 0건. 열린 PR 은 #10 · #24 · #34 · #38 (모두 SEOSA 2.0 무관) |
| 전체 커밋 431개 (unshallow) | 메시지·파일 경로 어디에도 여섯 기능의 흔적 없음 |
| 결론 | 이전 Codex 작업(14 files, +891/−16)은 **GitHub 에 푸시된 적이 없다.** Codex 로컬/클라우드 작업 공간에만 있고 여기서는 접근할 수 없다. 아무것도 덮어쓰거나 지우지 않았다 — 새 작업은 별도 브랜치에서 처음부터 만든다 |

## 1. 기준선 (main `53f837e`)

| 스위트 | 결과 |
|---|---|
| `npm test` (60 스크립트) | exit 0 |
| `npm run test:regression` | 85 PASS / 0 FAIL |
| `npm run test:release` | **114 PASS / 6 FAIL** — 전부 AI 섹션 |

### 릴리스 테스트 6건 실패의 실제 원인

`2ce1803` (2026-09-20, "harden provider failures") 이 모든 provider 실패 시 응답을 **500 → 200 + `degraded:true`** 로
바꿨고 `test-ai-redteam.js`(npm test, CI 포함)가 새 계약을 고정했다. `test-release.js` 는 CI 밖이라 옛 500 을 요구한 채
남아 있었다 — 같은 동작을 두 테스트가 반대로 요구했다. 제품 버그가 아니라 낡은 테스트다.
→ 브랜치 `claude/lucid-wright-u0xgct-release-tests`: 현재 계약으로 맞추고(검사 항목은 오히려 늘림) CI 에 regression·release 를 추가. **121 PASS / 0 FAIL.**

## 2. 브랜치 · PR 구조

| 브랜치 | 내용 | 기반 |
|---|---|---|
| `claude/lucid-wright-u0xgct-release-tests` | 릴리스 테스트 6건 · CI | main |
| `claude/lucid-wright-u0xgct` | **기초** — 계약 문서 · 라우터 · 계열 로더 · 테스트 킷 · 러너 · v2 화면 틀 | main |
| `claude/lucid-wright-u0xgct-timing` | ① | 기초 |
| `claude/lucid-wright-u0xgct-waitroom` | ② (+ 마이그레이션, 미적용) | 기초 |
| `claude/lucid-wright-u0xgct-investigator` | ③ (+ `_specs` 무게·램 파싱 버그 수정) | 기초 |
| `claude/lucid-wright-u0xgct-extension` | ④ | 기초 |
| `claude/lucid-wright-u0xgct-cart` | ⑤ | 기초 |
| `claude/lucid-wright-u0xgct-anomaly` | ⑥ | 기초 |

기능 브랜치는 **자기 파일만 추가**한다. 공유 파일(history.js · alerts.js · ai.js · vercel.json · package.json)은 기초 브랜치만 고친다.
그래서 기능 PR 끼리 충돌하지 않는다.

## 3. 단계별 결과

### 3-1. 기초 (`claude/lucid-wright-u0xgct`)

- `api/_v2router.js` — 라우트 표 6개, 호스트 제한, 모듈 없음 → 501 NOT_READY
- `api/_series.js` — 가격 계열 로더 (원본 행 + 옵션 행 + 일별 곡선). `/api/history` 와 점 단위로 같음을 테스트로 고정
- 훅 3줄: `api/history.js` · `api/alerts.js` · `api/ai.js` 핸들러 첫 줄
- `vercel.json` rewrite 6개 — 서버리스 함수 12개 그대로
- `scripts/_v2-testkit.js` · `scripts/test-seosa2.js` · `scripts/test-v2-foundation.js` (48 PASS)
- `test-release.js` SAFE 검사가 러너의 자식 테스트까지 펼친다
- `public/v2/` — 공용 CSS·JS·허브. 기존 `index.html` 은 무수정

### 3-2. 기능 (2026-09-24 완료 — 전부 PR 로 올라가 있고 CI 초록, **병합·배포는 하지 않았다**)

| 기능 | PR | 테스트 | 운영 DB 쓰기 | 외부 API | 비고 |
|---|---|---|---|---|---|
| 릴리스 테스트 6건 | #70 (→ main) | release 121/0 | — | — | 낡은 테스트 · CI 편입 |
| 기초 | #71 (→ main) | foundation 52/0 | — | — | 라우트 6개는 기능 PR 전까지 501 |
| ① 구매 타이밍 | #72 | 52/0 | 없음 | 없음 | 카탈로그 백테스트 CLI 는 미실행(자격증명) |
| ② 구매 대기실 | #73 | 69/0 | 새 표 2개 (**마이그레이션 미적용**) | Resend (기존) | 워크플로는 `WAITROOM_ENABLED=1` 때만 |
| ③ 쇼핑 조사관 | #74 | 62/0 | 없음 | 없음 (실시간 검색 꺼짐) | `_specs` 사양 오독 수정 포함 |
| ④ 브라우저 확장 | #75 | 262/0 | 없음 | 없음 | 실제 Chrome 로드 미확인 |
| ⑤ 장바구니 최저가 | #77 | 133/0 | 없음 | 없음 | 무작위 4,550건 전수탐색 대조 |
| ⑥ 가격 이상 패턴 | #76 | 121/0 | 없음 | 없음 | SHA-256 이력 지문 |


### 3-3. 통합 검증 (로컬 `integration-local` = 기초 + 릴리스 수정 + 여섯 기능 전부 병합)

- 병합 충돌 0 — 기능 PR 이 공유 파일을 고치지 않은 결과
- `npm test` exit 0 (SEOSA 2.0 7개 스위트 포함) · `test:regression` 85/0 · `test:release` **121/0** · `verify-migrations` 55 OK / 0 FAIL
- 기능 간 경로: `/api/lookup` 이 ①·⑥ 모듈로 `timing`·`anomaly` 를 실제로 채운다
- Chromium(Playwright) 으로 v2 화면 7개 × 모바일 390px·데스크톱 1280px: 콘솔 오류 0, 가로 넘침 0, 상품명 XSS escape 확인.
  실제 핸들러 + 가짜 DB 로 서빙했다 (운영 접속 없음)

## 4. 다음 실행 지점 (운영 반영 — 전부 승인 필요)

1. 리뷰 후 #70 → #71 순으로 main 병합 (main 병합 = Vercel 운영 배포)
2. 기능 PR 을 base `claude/lucid-wright-u0xgct` 에 병합하거나, #71 병합 뒤 각 PR 의 base 를 main 으로 바꿔 차례로 병합.
   읽기 전용 기능(① ③ ④ ⑤ ⑥)은 운영 DB 쓰기·외부 호출이 없다
3. ② 대기실: `supabase/2026-09-24-seosa2-waitroom.sql` → `.VERIFY.sql` → 배포 → 워크플로 dry-run → `WAITROOM_ENABLED=1` (`docs/seosa2/waitroom.md`)
4. 운영 읽기 자격증명으로 `node scripts/backtest-timing.js --limit 200` 실행해 카탈로그 전체 정확도 확인
5. 확장: 실제 Chrome 에서 로드, `https://seosa.ai.kr` 이 www 로 리다이렉트하지 않는지 확인, 아이콘 추가 후 스토어 등록 검토
6. v2 화면 진입점(홈 링크 등)은 기존 UI 수정이라 별도 승인 후

## 5. ③ 조사관 검색 정확도 수정 (2026-09-24, 실사용 신고)

신고: "100만 원 이하의 가볍고 배터리가 오래가는 노트북 3개" → 노트북 본체 0개, 교체용 배터리·건전지·키보드 8개.

원인 (재현으로 확인)
1. 부속 판정을 «검색어에 부속 낱말이 있는가»(부분 문자열)로 껐다 — "배터리가 오래가는" 이 "배터리를 찾는다" 로 읽혀 부속 필터가 꺼졌다.
   AI Concierge 의 `_search.queryWantsAccessory` 도 같은 방식이다 (핫딜·메인 검색이 같이 쓰므로 바꾸지 않았다 — 아래 제안).
2. 검색어가 조건 낱말로 오염됐다 ("가볍고 배터리 오래가 노트북 3개") — 배터리 제목이 순위에서 올라왔다.
3. 수집 키워드(`keyword ilike %노트북%`)로 "노트북 배터리"·"노트북 키보드" 수집분이 통째로 후보가 됐다.
4. 부속 목록(`ACCESSORY_TIER`)은 검색 감점용이라 키보드·건전지가 없다. 5. 재검색 없음. 6. "3개" 무시(8개). 7. "가볍고" 미인식.
8. AI 카드의 "기록상 최저가" 는 기록 1건이어도 붙었다.

수정
- `api/_product-role.js` (신규) — 머리 명사 규칙(질문) + 상품명 판별(본품/부속/관련 없음/다른 기기/확인 불가).
  10개 프로필(노트북·스마트폰·태블릿·카메라·헤드셋/이어폰·모니터·스마트워치·키보드·마우스) + 목록 밖은 머리 명사 + ACCESSORY_TIER(읽기만).
- `api/_investigator.js` — 찾는 종류만 평가, 개수·숫자 없는 조건(가볍고·배터리) 이해, 검색어 정리, 조건 확인은 상품명 근거로만,
  가격 판단은 관측 7일·기간 14일 이상일 때만 기간·건수와 함께, 못 찾으면 범위·뺀 종류와 개수·재검색 사실을 요약.
- `api/_investigator-api.js` — 재검색: DB 최대 3회(상품명 기기 이름 → 제품군 → 수집 키워드) + 실시간 검색 최대 1회(승인 전 꺼짐).
- `api/ai.js` — Concierge 검색: 검색어 정리("경량 노트북"), 부속품·관련 없는 상품을 카드에서 제외, 모자라면 1회 재검색,
  남은 것이 없으면 코드가 사실 문장을 붙인다. 목록 밖 카테고리는 기존 경로 그대로.
- `api/_price-claims.js` (신규) — «기록상 최저가» 최소 근거. AI 카드(toCard)·`_shopintent`·`_decision` 문장에 적용 (순위 점수는 그대로).

바꾸지 않은 것: 가격 수집, 핫딜 판정(`_hotdeal`·`_search.ACCESSORY_TIER`), 메인 검색, 상품 데이터, 메인 UI, DB 스키마.

검증: `scripts/test-v2-investigator-accuracy.js` 107/0 (부속품만 있는 DB × 5개 카테고리 포함) · `test-ai-pipeline` [42] 역할 선별 ·
`npm test` exit 0 · `test:regression` 85/0 · `test:release` 121/0 · Chromium 모바일 375px/데스크톱 오류 0·넘침 0.

제안(미적용, 승인 필요): 메인 검색 `_search.queryWantsAccessory` 를 머리 명사 기준으로 바꾸면 메인 검색의 같은 오탐도 줄어든다.
핫딜 판정과 공유하는 목록이라 별도 PR·회귀 측정 후에만.

## 6. 홈페이지 SEOSA 2.0 진입점 (2026-09-24, 별도 PR — 승인 대기)

기존 요구(“홈은 v2 를 전혀 링크하지 않는다”, `test-v2-foundation`·`test-v2-extension` 고정)를 지키는 동안
배포된 v2 기능(③ 조사관·⑤ 장바구니·⑥ 이상 패턴)에 도달할 방법이 없었다. 최소 진입점 하나를 추가했다.

- `public/index.html` — 기존 «부가 기능» 오버플로 메뉴(`#navMenu`, 이미 데스크톱·모바일 양쪽에 상시 노출)에
  `SEOSA 2.0 새 기능 (베타)` 항목 1개 추가. 기존 항목("내 레이더 보기")과 같은 마크업이라 새 CSS 없음.
  헤더 아이콘 줄·검색창·가격 카드·핫딜·그래프는 전혀 건드리지 않았다.
- `public/v2/index.html` — ①구매 타이밍·②구매 대기실은 PR #72·#73 이 아직 안 병합돼 실제로는 404 이므로
  (이 허브 페이지 자체는 foundation PR 로 이미 main 에 있었다 — 지금 운영에도 이 상태로 떠 있다),
  두 카드를 링크 없이 “준비 중” 배지로 가렸다. #72·#73 병합 후 되돌린다.
- 홈은 개별 기능을 딥링크하지 않고 이 허브 하나로만 보낸다 — `test-v2-extension.js`·`test-v2-foundation.js` 에
  “허브 링크 정확히 1개 · 개별 v2 페이지·extension.html 딥링크 0개 · 기존 nav-menu 안” 을 계약으로 고정했다.

검증: `npm test` exit 0(SEOSA 2.0 스위트 포함) · `test:regression` 85/0 · `test:release` 121/0 ·
Chromium 데스크톱 1280px·모바일 390px × 라이트/다크 4장 — 콘솔 오류 0, 가로 넘침 0, 메뉴·허브 카드 정상 렌더.

**기존 UI(헤더·검색·가격 카드·핫딜·그래프)를 바꾸는 변경이라 병합 전 사용자 승인이 필요하다.**

## 7. 재개 확인 및 현재 중단 지점 (2026-09-24)

### GitHub · 배포

- `main`: `72a8e3c5af4c1bd8c37291ae47627c45873dc863` — PR #79 병합 후 기준.
- 열린 관련 PR: #72, #73, #80. PR #72/#73은 GitHub상 `mergeable=true`지만, 이것만으로 제품 검증이 끝난 것은 아니다. #72의 검증 데이터가 부족해 병합 보류.
- PR #80 (`codex/seosa-home-feature-links`): 이 진행 기록을 추가하기 직전 head는 `cc23e31aa8a7deb0037be7e4d696b9d26b501902`, [PR 링크](https://github.com/yugeonbag091211/seosa/pull/80). 새 main 위에 재적용했고 해당 head의 Vercel 및 GitHub Actions `test` 모두 성공. 최신 Preview는 `https://seosa-git-codex-seosa-home-feature-links-seosa.vercel.app`.
- Preview는 Vercel SSO에서 HTTP 302 로그인으로 돌려보낸다. 따라서 Preview의 실제 브라우저 화면과 함수 응답은 검증하지 못했다. **성공한 배포 체크를 기능 확인 완료로 간주하지 않는다.** 허용된 경우 로그인된 브라우저로 다시 확인한다.
- 로컬 Chrome 캡처는 운영/Preview 응답이 아니다. 홈은 JavaScript 비활성, V2 허브는 로컬 정적 파일로 열고 실제 CSS viewport를 DevTools로 375×812·1440×1000으로 에뮬레이션했다. 홈 375px에서 `scrollWidth=375`; 세 링크는 모두 44px 높이로 두 줄에 배치되며 히어로 첫 화면 끝에서 19px 아래부터 시작한다. 1440px에서는 링크가 첫 화면 안에 있다. V2 허브 375px에서 `scrollWidth=375`, 카드 우측 경계 359px로 화면 안에 남았다. 화면 캡처는 Codex 시각화 디렉터리에 있다.
- PR #80의 `public/v2/index.html`에서 병합 직전 상태에 남아 있던 타이밍·대기실 카드도 제거했다. 준비 전 기능은 링크뿐 아니라 공개 목록에도 나오지 않는다. 홈의 AI Concierge 아래 준비된 조사관·장바구니·이상 패턴 링크와 기존 `부가 기능` 허브 메뉴는 유지한다.

### Production · 검색

- 2026-09-24 읽기 요청: `/`, `/v2/index.html`, `/v2/investigator.html`, `/v2/cart.html`, `/v2/anomaly.html`은 모두 HTTP 200.
- 운영 API: `/api/ai?__route=investigate`, `/api/history?__route=cart`, `/api/history?__route=anomaly` GET이 모두 HTTP 501. 별도로 요청된 노트북 질의의 `POST /api/investigate`도 `NOT_READY`를 반환했다. 추천 결과나 Concierge의 실제 사용자 응답은 확인되지 않았다. PR #80의 Vercel `includeFiles` 수정은 Preview SSO 때문에 런타임 검증 보류.
- Supabase 프로젝트 `pcnhktxltojbkrmpafsz`의 SELECT만 사용. 상품 69,852행, 가격 이력 154,027행; `waitroom_items`, `waitroom_notifications` 및 해당 migration은 Production에 없다. 가격 기록의 non-positive price 0건, option identity 누락 0건.
- DB 카탈로그 SELECT에서 본품 노트북 및 이미지 URL·쿠팡 제휴 URL 필드를 확인했다. 501 응답으로 사용자 API에서 실제 상품 이미지·제휴 링크 렌더는 확인되지 않았다. 제휴 URL을 클릭하지 않았다.
- 메인 검색 PR #78의 정확도 스위트는 10개 기기 유형의 오프라인 테스트 107/107 PASS. Production 검색 API는 `NOT_READY`여서 본품·부속품 분리를 운영에서 검증했다고 말할 수 없다. 조사관 live search는 기본 꺼짐이며 켜는 API/공급자 호출은 하지 않았다.
- real-time search 코드 점검: `MAX_LIVE_ATTEMPTS=1`이지만 이 한 경로는 `_shop.searchAll`을 불러 Coupang과 ADPICK을 병렬로 조회한다. 결과는 DB에 저장하지 않으며 두 공급자의 6시간 캐시·전역 quota gate·회로 차단을 공유해 수집기/API 호출과 quota 경쟁을 할 수 있다. 순차 반복은 캐시가 줄이지만 keyword별 in-flight single-flight는 없어 동시 동일 질의가 중복 miss 할 수 있다.
- 호출 상한 검토에서 차이를 발견했다. 현재 `_coupang.js`는 자체 기본 상한 20회/분, 코드 주석은 Search API 50회/분이라고 하지만, 공식 [Coupang Partners 사용 가이드(PDF, 2024-12-16)](https://partners.coupangcdn.com/partners-guide/partners-guide-20241216163254.pdf)는 Search를 시간당 최대 10회, 위반 1회 시 24시간 차단, 3회 시 전체 Partner 기능 차단으로 안내한다. 이 문서가 현행인지 계정 포털에서 재확인하고 quota를 맞추기 전에는 real-time search를 켜지 않는다. 요청당 유료 과금은 공식 자료로 확인하지 못했으며 provider 사용료를 0으로 단정하지 않는다.

### #72 구매 타이밍

- 기존 `scripts/backtest-timing.js`를 Production SELECT 스냅샷에 적용했다. 22,973 Coupang 상품 중 ≥10일 이력 1,305개, ≥45일 16개, ≥60일 0개, ≥90일 0개(중앙값 2일, 최댓값 53일).
- 최신 600개 샘플에서 45일 이력을 가진 상품은 2개뿐이며 둘 다 전자제품이 아니다. H14 예측은 0개의 점수화 가능한 표본, Brier·기준모델 점수·skill 모두 산출 불가. 탐색 H7은 52표본, Brier 0.038 대 기준모델 0.038, skill 0, 결정 hit 0.
- 옵션 단위 가격 및 KST 일별 최저가를 사용했다. 90일 백분위는 이 두 시계열 중 한 개에만 관측 45개를 기준으로 계산 가능했고, 다른 하나는 가격이 평평해 백분위 의미가 없었다. 이 기록으로 90일·14일 예측을 공개하거나 제품군 정확도를 주장할 수 없다.
- 결과와 한계는 #72의 `docs/seosa2/timing-production-backtest-2026-09-24.md`, 커밋 `6b6f163c3a085f11441efe3ffb073fb2710033f8`에 기록했고 PR에 반영했다. timing 52/52, #72 Actions `test` 성공. DB 쓰기·공급자 호출 없음.

### #73 구매 대기실

- PR의 migration은 신규 두 테이블만 만들고 RLS 활성화, 사용자 직접 grant/policy 없이 service role로만 접근한다. 사용자별 필터, 중복 등록/알림 제약, 인덱스, VERIFY 및 ROLLBACK SQL을 정적으로 확인했다.
- `scripts/test-v2-waitroom.js`: 69/69 PASS. `scripts/verify-migrations.js`: 55 OK / 0 FAIL / 1 warning (DB 자격증명 부재로 live schema check 생략). SQL은 별도 DB에서 실행하지 않았다.
- `armed` 원자 claim 및 unique item/date로 동시 중복 발송을 막지만, 이메일 공급자가 수락한 직후 응답이 유실되면 재시도 시 같은 날짜에 중복 메일 가능성이 남는다. ROLLBACK은 신규 두 테이블과 그 데이터 전체를 삭제하므로 적용 후 먼저 export해야 한다.
- 별도 Supabase 개발 브랜치 생성 비용은 `$0.01344/hour`로 확인했다. `supabase_confirm_cost` 사용자 확인과 개발 브랜치가 아직 없다. 비용 확인 전에는 branch/migration 실행을 중단한다. Production migration 미적용, 실제 이메일 0건, `WAITROOM_ENABLED` 변경 없음.

### 홈페이지 PR #80 변경 · 테스트

- 변경 파일: `public/index.html`, `public/v2/index.html`, `public/v2/v2.css`, `vercel.json`, `scripts/test-v2-home-links.js`, 기존 세 V2 테스트 파일.
- 기능 링크는 홈 Concierge 아래에 보조 링크로 표시하고, 타이밍·대기실은 홈과 2.0 목록에 표시하지 않는다. 터치 높이 44px, 링크 줄바꿈 적용. Vercel의 동적 helper 모듈 누락을 해결하기 위해 `api/ai.js`, `api/history.js`, `api/alerts.js` 함수에 `includeFiles: "api/_*.js"`를 추가했으나 운영 미배포.
- 최종 로컬 결과: SEOSA 2.0 7개 그룹 PASS / 0 FAIL; regression 85/0; release 121/0; 조사관 accuracy 107/107; timing 52/52; waitroom 69/69. `git diff --check` 통과. 가격 수집과 핫딜 판정 코드는 변경하지 않았다.
- 이 런타임에는 `npm` 명령이 없다. `npm test`는 `npm is not recognized`로 시작되지 않아 각 `node scripts/...` 명령을 직접 실행했다. Regression/release는 직접 실행 후 통과했다.
- PR #80의 merge는 승인 대기. Production 병합은 하지 않았다.

### 다음 실행 지점

1. 사용자가 `$0.01344/hour` Supabase dev branch 비용을 확인하면 개발 브랜치를 만들고 PR #73 migration → VERIFY → 테스트 결과 기록 순으로 **해당 브랜치에서만** 수행한다. Production migration은 별도 승인이 있을 때까지 금지.
2. Vercel Preview가 SSO로 보호되어 있으므로 로그인된 접근 또는 승인된 우회 방법을 통해 PR #80 화면과 `/api/ai?__route=investigate`, `/api/history?__route=cart|anomaly`의 안전한 GET 결과를 확인한다. POST 검색은 비용/실시간 공급자 호출 여부를 먼저 확인하기 전 실행하지 않는다.
3. PR #80 Production 병합 승인 요청 전 Preview 결과와 현재 PR check를 최신 head에서 다시 확인한다. 승인이 오기 전에는 병합하지 않는다.
4. #72는 최소 90일 가격 원장이 쌓이고 사전 등록된 기준 모델과 비교할 만큼 평가 표본이 확보된 뒤 백테스트를 반복한다. 그 전에는 사용자 대상 미래 가격 예측을 공개하지 않고 PR merge 보류.
5. 실제 이메일 발송, `WAITROOM_ENABLED=1`, 조사관 real-time search 활성화, Production DB migration, Production 병합은 각각 사용자 승인을 기다린다. 특히 live search 활성화 전에 Coupang Partners의 현행 호출 한도·과금과 중복 miss 방지, shared collector quota 영향을 해결한다.
