# Neon + R2 전환: 일정 · 환경변수 · 순서 · 되돌리기 (2026-10-21)

> 이 문서의 명령은 **아직 아무것도 실행하지 않았습니다**. 각 단계는 사용자 승인 뒤 실행합니다.
> 비밀값(연결 문자열·키)은 채팅·로그·커밋에 쓰지 않고, 대시보드 입력란이나 로컬 프롬프트에만 넣습니다.

## 0. 일정 — 테스트 브랜치 만료

| 항목 | 값 |
|---|---|
| Neon 프로젝트 | `withered-dew-45175008` (aws-ap-southeast-1, PostgreSQL 18, 요금제 free_v3) |
| 데이터가 있는 브랜치 | `migration-test-20261020` (`br-polished-meadow-aonxdoap`, 논리 크기 448MB) |
| **만료** | **2026-10-28T00:00:00Z = 10월 28일(화) 오전 9시 KST** — 지나면 브랜치와 복원 데이터가 사라집니다 |
| 빈 기본 브랜치 | `production` (`br-withered-mud-aoxop0nr`, 31MB, 이번 데이터 없음) |
| Supabase 원본 | 2026-10-19 22:08Z 이후 쓰기 없음(REST 402 `exceed_egress_quota`, 2026-10-21 운영 응답으로 재확인). 덤프가 최신입니다 |

**10-27(월)까지 할 일**: 아래 1-①로 만료를 먼저 해제합니다. 이것만으로 데이터 손실 위험이 사라집니다. 나머지 단계는 그 뒤 순서대로 진행하면 됩니다.

⚠ Supabase 제한이 다음 결제 주기에 풀리면 운영 사이트가 다시 Supabase에 쓰기 시작합니다. 그러면 Neon 데이터와 갈라집니다. 전환은 제한이 풀리기 전에 끝내거나, 풀린 뒤라면 새 덤프로 다시 맞춰야 합니다.

## 1. Neon 준비 (사용자 승인 후)

```bash
neon branches set-expiration migration-test-20261020 --project-id withered-dew-45175008
```
① `--expires-at`을 빼면 만료가 **해제**됩니다(CLI 도움말로 확인).

```bash
neon branches set-default migration-test-20261020 --project-id withered-dew-45175008
```
② 데이터가 있는 브랜치를 기본 브랜치로 지정합니다. 같은 덤프를 production에 다시 복원하는 방법도 있지만, 그러면 저장 용량을 두 배로 씁니다(1GB/프로젝트 한도).

③ **compute 상한 0.25 CU**: Neon 콘솔 → Branches → `migration-test-20261020` → Compute → Edit → Max 0.25. 지금은 프로젝트 기본값이 최대 2 CU라, 무거운 질의가 오면 같은 시간에 연산 시간을 최대 8배 씁니다.

④ 추가형 마이그레이션 적용: `supabase/2026-10-21-search-cache-hints.sql`(SQL Editor 또는 직접 연결 psql). 수집기의 전송량을 캐시 힌트 단계 1회당 51.6MB → 2.2MB로 줄입니다. 적용하지 않아도 동작은 같습니다.

⑤ 권장 설정(선택):
- `ANALYZE;` 한 번 실행. 복원 뒤 통계가 없는 표가 있습니다(reltuples −1). 데이터는 바꾸지 않습니다.
- 문장 시간 제한: `ALTER ROLE neondb_owner IN DATABASE neondb SET statement_timeout = '60s';`. pooled 연결은 세션 설정을 받지 않아 역할 단위로만 걸 수 있습니다. 덤프·복원처럼 오래 걸리는 작업은 직접 연결에서 `SET statement_timeout = 0` 뒤에 실행합니다.

⑥ Preview 전용 브랜치(권장): Vercel Preview가 운영 데이터에 쓰지 않도록, 기본 브랜치에서 자식 브랜치(예: `preview`)를 만들어 Preview의 `NEON_DATABASE_URL`에 넣습니다(브랜치 한도 10개).

## 2. Vercel 환경변수

| 이름 | 값 | Preview | Production | 비고 |
|---|---|---|---|---|
| `SEOSA_DB_BACKEND` | `neon` | ✅ | ✅(전환 시) | 비우면 Supabase(지금 동작) |
| `SEOSA_NEON_EXPERIMENTAL` | `1` | ✅ | ✅ | |
| `SEOSA_NEON_PRODUCTION_APPROVED` | `1` | — | ✅ | Preview 값이 실수로 Production에 복사돼도 전환되지 않게 하는 두 번째 열쇠 |
| `NEON_DATABASE_URL` | **pooled** 연결 문자열(호스트에 `-pooler`), `sslmode=require` | ✅(preview 브랜치) | ✅(기본 브랜치) | 비밀값 |
| `SEOSA_NEON_POOL_MAX` | (선택) 기본 5 | | | 함수 인스턴스당 연결 수 |
| `SEOSA_R2_HISTORY_ENABLED` | `1` | ✅ | (선택) | 가격 그래프 과거분을 R2에서 |
| `R2_ACCOUNT_ID` · `R2_BUCKET`=`seosa-price-history` · `R2_ACCESS_KEY_ID` · `R2_SECRET_ACCESS_KEY` | **읽기 전용** 토큰 권장 | ✅ | (선택) | 업로드용 읽기·쓰기 토큰을 Vercel에 넣지 않습니다 |
| `SEOSA_R2_HISTORY_CUTOFF` | `2026-10-19T22:08:57.620Z` | (선택) | (선택) | 넣으면 그 이전 기록은 DB에서 받지 않고 R2만 사용(그래프 동일, DB 전송 절감). 빼면 DB 전체 + R2 병합 |
| `SUPABASE_URL` | **그대로 둠** | | | 되돌리기용 |
| `SUPABASE_SECRET_KEY` | **그대로 둠 — 절대 지우거나 바꾸지 않음** | | | 아래 ★ |
| `AUTH_SECRET` | **지금 없으면 새로 만들지 않음** | | | 아래 ★ |

★ `AUTH_SECRET`이 없는 환경에서는 `SUPABASE_SECRET_KEY` 값이 서명 키 재료로 쓰입니다(`api/_auth.js signingKey`, `api/_aicontext.js keyFor`, `api/_billing.js customerKeyFor`). 이 값을 지우거나 `AUTH_SECRET`을 새로 넣으면 세 가지가 깨집니다.
- 기존 로그인 토큰 전부 무효(전원 로그아웃)
- AI 서명 검증 실패
- **토스 정기결제 customerKey가 바뀌어** 기존 빌링키와 맞지 않음

Supabase 프로젝트를 나중에 지우더라도 이 **문자열 값**은 Vercel에 남겨 둬야 합니다. 현재 설정은 `/api/cron` 진단 출력(`CRON_SECRET` 필요)의 `AUTH_SECRET: 설정됨/없음` 줄로 값 없이 확인할 수 있습니다.

**함수 리전**: Vercel → Project → Settings → Functions → Region을 `sin1`(Singapore)으로 바꾸는 것을 권장합니다. 지금 운영 함수는 `iad1`(미국 동부)이라 Neon(싱가포르)까지 질의마다 왕복이 큽니다. 한국 사용자에게도 iad1보다 sin1이 가깝습니다. 코드(`vercel.json`)는 바꾸지 않았습니다. Supabase를 쓰는 동안 리전이 바뀌면 Supabase 지연이 어떻게 변할지 몰라서, **전환과 같은 시점**에 대시보드에서 바꿉니다.

## 3. GitHub Actions

| 종류 | 이름 | 값 | 비고 |
|---|---|---|---|
| Secret(신규) | `NEON_DATABASE_URL` | pooled 연결 문자열 | |
| Variable(신규) | `SEOSA_DB_BACKEND` | `neon` | 비우면 Supabase |
| Variable(신규) | `SEOSA_NEON_EXPERIMENTAL` | `1` | |
| Secret(유지) | `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | 그대로 | 되돌리기용 |
| Variable(**결정 필요**) | `EXTERNAL_HOTDEAL_PPOMPPU_ENABLED` | 지금 `1` | 15분마다 상품 5,000행(2.83MB)을 읽어 **월 약 8GB**입니다. 이것만으로 Neon 무료 전송 5GB를 넘깁니다. 전환 전에 `0`(끄기)이나 1시간 간격 조정을 권장합니다(`neon-free-plan-budget.md`) |

- 스위치를 넣은 곳: `daily-prices.yml`(3 step), `hotdeals.yml`(3), `external-hotdeals.yml`(1), `identity-shadow.yml`(1), `conversions.yml`(1). `SUPABASE_URL`을 받는 모든 step입니다.
- schedule 실행은 **기본 브랜치(main)의 workflow 파일**을 씁니다. 그래서 이 브랜치가 병합되기 전에는 Variables를 넣어도 효과가 없습니다.
- `pg`를 dependencies로 옮겼습니다. `npm ci --omit=dev`를 쓰는 workflow 4개에서도 Neon 드라이버가 설치됩니다.

## 4. 전환 순서 (한 번에 — 두 DB에 나눠 쓰지 않기)

1. **확인**: Supabase가 여전히 제한 상태인지, 덤프 뒤 쓰기가 없는지 확인합니다(운영 `/api/history` 응답이 `exceed_egress_quota`).
2. **Neon 준비**: 1-①~④(+⑤ 권장).
3. **PR 병합**: 코드는 환경변수 없이는 아무 일도 하지 않습니다(기본값 Supabase).
4. **Preview 검증**: Preview 환경변수(preview 브랜치) → Preview 배포 → 아래 실측 도구를 Preview 기준으로 돌립니다. 그리고 로그인·찜·알림을 손으로 한 번씩 확인합니다.
5. **수집기 전환**: GitHub Variables 설정 → `daily-prices`를 workflow_dispatch로 한 번 수동 실행 → 로그에서 `DB 백엔드: Neon`과 저장 행 수를 확인합니다.
6. **사이트 전환**: Vercel Production 환경변수 + 함수 리전 `sin1` → Production 재배포(사용자가 직접).
7. **관찰 48시간**: `neon projects get withered-dew-45175008 --output json`의 `data_transfer_bytes`·`compute_time_seconds`, 수집기 리포트, `price_history` 신규 행(평균 6,653행/일이 정상 수준).

## 5. 되돌리기

- Vercel Production·GitHub Variables에서 `SEOSA_DB_BACKEND`를 비우고 재배포하면 **즉시 Supabase 경로로 돌아갑니다**(코드 경로는 바뀌지 않음).
- 단, 전환 뒤 Neon에만 쓰인 데이터(새 가격 기록·가입·알림)는 Supabase에 없습니다. 되돌리기 전에 Neon에서 그 기간 행을 내보내야 합니다.
- **Supabase 원본은 삭제하지 않습니다**. 동결된 백업으로 둡니다(로컬 덤프 `D:\SEOSA-Archive\supabase`, R2 아카이브와 함께 3중).

## 6. 실측 도구 (격리된 테스트 브랜치 전용 — 다른 호스트면 스스로 거절)

| 명령 | 보는 것 | 쓰기 |
|---|---|---|
| `npm run test:migration` | 어댑터·R2 단위(오프라인) | 없음 |
| `node scripts/migration/test-neon-conformance.js` | PostgREST와 같은 값·오류 모양 | 검사용 행만, 지움 |
| `node scripts/migration/test-neon-collector-sandbox.js` | 수집기 잠금·상태·중복 방지·한도 RPC | 트랜잭션 ROLLBACK |
| `node scripts/migration/test-neon-search-ai-sandbox.js` | 검색 캐시 적중·AI 카탈로그·옵션·가격 판단 | 트랜잭션 ROLLBACK |
| `node scripts/migration/test-neon-cache-hints.js` | 캐시 힌트 DB 계산 == 옛 스캔 | 트랜잭션 ROLLBACK(DDL 포함) |
| `node scripts/migration/test-neon-r2-history-live.js` | 실제 R2 + Neon 그래프 3방식 동일 | 없음 |
| `node scripts/migration/smoke-neon-preview.js` | dev 서버로 API 20개 | 없음 |
| `node scripts/migration/measure-neon-budget.js` | 저장·증가량·요청당 전송 | 없음 |

연결 문자열은 Neon CLI에서 바로 프로세스 환경으로 넣습니다(화면에 찍지 않음). 2026-10-21 실행에 쓴 래퍼는 `NEON_DATABASE_URL`, `SEOSA_DB_BACKEND=neon`, `SEOSA_NEON_EXPERIMENTAL=1`, `VERCEL_ENV=preview`만 넣고 끝나면 지웁니다. R2 키는 DPAPI로 보호된 로컬 자격 파일에서 읽습니다.
