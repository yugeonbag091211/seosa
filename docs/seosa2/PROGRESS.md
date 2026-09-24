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
