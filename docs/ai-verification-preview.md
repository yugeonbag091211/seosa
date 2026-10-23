# 격리된 AI 검증 환경 (운영 DB 를 건드리지 않고 실호출)

2026-10-23 Codex 감사 CO-10 의 요구를 구현한 것이다. 감사는 "Preview 검색 성공 경로가 products 와
price_history 에 쓸 수 있어서 실호출을 중단했다" 고 기록했다
(`reports/ai-one-day-audit/preview-search-investigation.md`).

여기서 막는 것은 **쓰기** 다. 인증을 우회하거나 공급자 제한을 넘기지 않는다.

## 두 가지 모드

| | Mode A — 격리 DB 분기 | Mode B — 읽기 전용 가드 |
|---|---|---|
| DB | 운영과 분리된 Neon branch / 일회용 Supabase project | 운영 DB (읽기만) |
| 쓰기 | 허용 (그 분기 안에서만) | 전부 차단 |
| 읽기 | 분기 데이터 (가격 이력은 분기 시점 snapshot) | 운영 데이터 그대로 |
| 쓰이는 곳 | Preview 배포, 수집·저장까지 보는 검증 | 로컬 실호출, 응답·예산·식별 검증 |
| 한계 | 분기 생성·만료 관리가 필요하다 | 쓰기가 필요한 기능은 돌지 않는다 (아래) |

둘 다 **운영 DB 초기화·삭제·스키마 변경을 하지 않는다.**

## Mode B — 읽기 전용 가드 (`SEOSA_DB_READONLY=1`)

구현은 `api/_supabase.js` 한 군데다. 이 모듈이 내보내는 클라이언트의 쓰기 길을 모두 막는다.
어느 호출 경로가 쓰는지 일일이 찾지 않아도 되는 것이 요점이다.

```
insert · upsert · update · delete   → 즉시 예외 (DbReadOnlyError), 계측에 집계
rpc                                 → 기본 차단. SEOSA_DB_READONLY_RPC 에 적은 함수만 통과
select · 그 밖의 읽기               → 그대로 통과
```

- 쓰기를 **조용히 넘기지 않는다**. 저장된 척하면 검증 결과를 잘못 읽는다.
- `api/_shop.js saveProducts` 는 가드에 걸리기 전에 먼저 돌아온다 — "저장 실패" 로그로 결과를
  어지럽히지 않기 위해서다. 가드는 그 뒤의 모든 경로를 막는 뒷단이다.
- **Production 에서는 켜지지 않는다.** `VERCEL_ENV=production` + 이 플래그는 분명한 오류로 거절한다
  (운영 쓰기를 멈추면 수집·결제가 멈춘다). Neon 전환 스위치와 같은 방식이다.
- 회귀 검사: `node scripts/test-db-readonly.js` (16 어설션, npm test 에 포함).

### 환경변수

| 변수 | 값 | 뜻 |
|---|---|---|
| `SEOSA_DB_READONLY` | `1` | 쓰기 차단 |
| `SEOSA_DB_READONLY_RPC` | `a,b,c` | 통과를 허용할 **읽기 전용** rpc 이름 |

### 응답의 관측 블록

이 플래그가 켜진 배포에서만 `/api/ai` 응답에 `verify` 가 실린다. 운영에는 실리지 않는다.

```json
{"search":"found","intent":"PRODUCT_SEARCH","convCarried":false,
 "budgetScope":"product","budgetDropped":null,"dbWritesBlocked":2,"dbRpcBlocked":2}
```

- `search` — `found` / `empty` / `failed` / `none`. **검색 실패와 정상 0건을 구분한다** (CO-05).
- `budgetScope` · `budgetDropped` — 예산을 어느 범위로 적용했는지 (CO-03).
- `dbWritesBlocked` · `dbRpcBlocked` — 가드가 막은 쓰기 시도 수.
- 사용자 발화·검색 원문은 싣지 않는다.

## 실호출 러너

```bash
node scripts/verify-ai-live.js --env .env.local                  # 전체 묶음
node scripts/verify-ai-live.js --env .env.local --only budget     # 예산만
node scripts/verify-ai-live.js --env .env.local --ask "30만원 이하 노트북"
node scripts/verify-ai-live.js --env .env.local --out reports/live.json
```

- `api/ai.js` 핸들러를 **그대로** 불러 쓴다. 네트워크로 Vercel 에 가지 않으므로 SSO 가 필요 없다.
- LLM·쿠팡·ADPICK 호출은 **실제** 다. 비용과 공급자 쿼터를 쓴다. `npm test` 에는 넣지 않았다.
- `SEOSA_DB_READONLY=1` 을 스스로 설정하고, 그 없이는 실행하지 않는다.
- `--delay`(기본 7500ms) — ADPICK 간격 제한·쿠팡 분당 창 때문에 붙여 던지면 두 번째 질문부터
  검색이 SKIP 된다(실측).

### Mode B 에서 돌지 않는 것 (실측 2026-10-23)

| 막힌 쓰기 | 결과 |
|---|---|
| `rpc coupang_acquire_v2` (쿠팡 전역 분당 한도 차감) | 쿠팡 검색이 **스스로 거부** 한다 — "전역 쿠팡 호출 허가 확인 실패". 쿠팡 경로는 검증되지 않는다 |
| 검색 캐시 힌트 쓰기 | 캐시가 쌓이지 않는다. 기능 영향 없음 |
| `saveProducts` (products·price_history) | 의도된 것 — 원장에 남지 않는다 |

쿠팡 경로까지 봐야 한다면 둘 중 하나다.

1. Mode A 로 분리된 DB 에서 돌린다 (권장).
2. 운영자가 판단해 `SEOSA_DB_READONLY_RPC=coupang_acquire_v2` 로 **그 하나만** 허용한다.
   운영 쿼터 카운터에 쓰기가 생기고 호출 한 칸을 쓴다. 상품 원장에는 쓰지 않는다.

ADPICK 경로는 Mode B 에서 그대로 돈다(간격을 띄우면).

## Mode A — Preview 배포를 격리하기

Preview 를 운영과 분리하는 것은 **Vercel 환경변수 scope** 로 한다. 코드로는 할 수 없다.

1. 분리된 DB 를 만든다 — Neon branch(`docs/migration/neon-cutover-env.md`) 또는 일회용 Supabase project.
2. 그 PR 의 branch scope 로만 DB 변수를 덮는다
   (Vercel > Settings > Environment Variables > Preview > 특정 branch).
   - Supabase 경로: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`
   - Neon 경로: `SEOSA_DB_BACKEND=neon`, `SEOSA_NEON_EXPERIMENTAL=1`, 그 분기의 연결 문자열
   - `SEOSA_NEON_PRODUCTION_APPROVED` 는 **설정하지 않는다**.
3. 공급자 키는 Preview 전용 값이 있으면 그것을 쓴다. 없으면 쿠팡·ADPICK 호출이 운영과 같은
   쿼터를 쓴다는 것을 알고 호출 수를 제한한다.
4. 첫 검색 한 건 뒤에 행 수 변화를 **그 분기에서** 확인한다. 운영 테이블의 행 수는 변하지 않아야 한다.
5. Preview 접근 인증은 운영자 본인의 정상 권한으로 한다. SSO 보호를 우회하지 않는다.

## 검증 전 확인 목록

- [ ] `SEOSA_DB_READONLY=1` 또는 분리된 DB 변수가 그 배포에만 걸려 있다
- [ ] `VERCEL_ENV=production` 인 배포에는 둘 다 없다
- [ ] `node scripts/test-db-readonly.js` 통과
- [ ] 검색 한 건 뒤 운영 `products` · `price_history` 행 수 불변
- [ ] 응답 `verify.search` 가 `failed` 와 `empty` 를 구분한다
- [ ] 러너 결과를 `reports/` 에 남겼다
