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

### 3-2. 기능 — 아래 표를 기능 PR 이 채운다

| 기능 | 상태 | 테스트 | 비고 |
|---|---|---|---|
| ① 구매 타이밍 | 진행 중 | — | |
| ② 구매 대기실 | 진행 중 | — | |
| ③ 쇼핑 조사관 | 진행 중 | — | |
| ④ 브라우저 확장 | 진행 중 | — | |
| ⑤ 장바구니 최저가 | 진행 중 | — | |
| ⑥ 가격 이상 패턴 | 진행 중 | — | |

## 4. 다음 실행 지점

1. 기능 브랜치 여섯 개를 기초 브랜치에서 딴다 (없으면 `git checkout -b <이름> claude/lucid-wright-u0xgct`).
2. 각 기능은 CONTRACTS.md §3 의 계약대로 `api/_<feature>.js`(순수) + `api/_<feature>-api.js`(핸들러) +
   `scripts/test-v2-<feature>.js` + `public/v2/<feature>.html` 을 추가한다.
3. `npm test` · `npm run test:regression` · `npm run test:release` 전부 초록이어야 PR 을 올린다.
