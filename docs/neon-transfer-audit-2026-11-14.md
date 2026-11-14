# Neon 전송량 감사 — 2026-11-14

작성: Claude Code (읽기 전용 실측 + 코드 수정). 운영 DB·환경변수·플랜은 **바꾸지 않았다**.
모든 운영 조회는 `BEGIN READ ONLY` 안에서 몇 KB 이하로 했다.

## 1. 지금 상태 (운영 실측)

| 항목 | 값 (2026-11-14 09:00Z, 결제 주기 11-01 ~ 12-01) | 무료 한도 |
|---|---|---|
| 공용망 전송(egress) | **5,123,813,710 B = 5.124 GB = 4.772 GiB** | 5 GB (단위 미표기) |
| 연산 | **70.24 CU-h** (컴퓨트 활성 280 h / 경과 320.7 h = 87%) | 100 CU-h |
| 전송 비율 | 11월 평균 0.38 GB/일, 11-12 04:20Z→11-14 08:44Z 평균 **0.55 GB/일** | |
| 연산 비율 | 5.26 CU-h/일 → **11-19~20 경 100 CU-h 도달** 예상 | |

- 전송의 99.9%(5.119 GB)가 운영 브랜치 `migration-test-20261020`(엔드포인트 `ep-gentle-art-aoaa97v4`)에서 나왔다.
  `ai-v34-pgvector-dev-20261112` 브랜치는 0.002 GB.
- Neon 공식 문서(neon.com/docs/introduction/plans): «CU-hours 나 공용망 전송을 다 쓰면 다음 결제 주기까지
  또는 업그레이드할 때까지 컴퓨트가 정지된다. 접속은 SQLSTATE 53000 으로 실패한다.»
  5.124 GB 인데 아직 정지되지 않았으므로 한도는 5 GiB(5.369e9 B)로 보이며 **남은 여유는 약 0.25 GB(반나절 분)**.
- 사용량 카운터는 지연 갱신된다(08:44Z·09:00Z 값이 같았다) — 시간 단위 비율은 잴 수 없다.
- 09:52Z 재측정: **5,193,867,075 B = 5.194 GB (4.837 GiB)**, 연산 254,620 s. 52분 사이 +70 MB(묶음 갱신이라 정확한 시간당 값은 아님,
  이 감사의 운영 확인 호출 — 홈 핫딜 2회 ≈11 MB — 포함). 이 속도면 5 GiB 까지 2~3시간.
- 같은 41분(09:12→09:53Z) 테이블 통계: `price_history` 전체 스캔 4회(196만 행) · 인덱스 조회 45,781회(69만 행),
  `products` 인덱스 조회 675회(36만 행), canonical 묶음 구성원 표 전체 스캔 227회(홈 핫딜·이력의 canonical 읽기), `price_job_state` 읽기 5 · 쓰기 5.

## 2. 무엇이 읽어 가는가

`pg_stat_statements` 는 preload 되어 있지만 확장이 만들어져 있지 않아(`CREATE EXTENSION` 은 운영 DB 변경이라 하지 않음)
질의별 바이트는 볼 수 없다. 대신 (1) 테이블 통계, (2) 서버 쪽 크기 계산(`octet_length(row_to_json(...))`),
(3) 실제 GitHub Actions 실행 수, (4) 운영 응답의 stats 로 추정했다.

### 2-1. 수집기 상태 행 `price_job_state.last_result` — 확인됨, 하루 ≈100~150 MB

- 크기: **1,697,300 B** (10-21 447 KB → 4배). 그중 `malls` 1.675 MB:
  ADPICK `collectorAttempted` 962,625 B(12,835키) · `collectorCovered` 415,125 B · 쿠팡 `collectorAttempted` 172,029 B.
- 읽는 곳: `collect-all-prices.js` `loadState`(매 실행) + `releaseLock`(잠금을 잡은 실행) + `markV3Kill`,
  `collect-volatile-prices.js` `loadState` + `writeSlot`(×2) + `releaseLock`.
- 실제 실행 수(gh run list): daily-prices **11-12 40회 · 11-13 24회**(예약 + 이어 붙이기), volatile 6~7회/일.
- 테이블 통계: `price_job_state` seq_scan 10,182 중 UPDATE 7,970 → 읽기 ≈2,200회(약 24일) ≈ **92회/일**.
- 92회 × 1.69 MB ≈ **155 MB/일 ≈ 4.7 GB/월** — 이것 하나로 무료 한도와 같은 속도다.
- 그런데 그 실행 대부분은 할 일이 없다: 다른 실행이 잠금을 쥠(1회 읽기) · 오늘 두 몰 완료 · 두 제공자 하루 예산
  소진(잠금 잡고 풀며 2회 읽기). 낮 칸(KST 09:05~23:35)은 하루 예산이 이미 소진된 뒤라 거의 전부 이 경우다.

### 2-2. 홈 핫딜 `/api/hotdeals?view=today-drop` — 확인됨, 방문당 ≈5.7 MB

- 운영 응답 헤더 `Cache-Control: no-store` (canonical 읽기 켜짐 → CDN 캐시 없음). `/api/hotdeals` 도 no-store.
- 운영 응답 stats: 오늘치 **8,374행**(1,000행 × 9장) + 직전 관측 RPC **7,753행**.
- 서버 쪽 크기: 오늘치 `LEDGER_COLS` JSON **3,514,344 B**(link 848 KB · title 747 KB 포함),
  직전 관측 RPC(`SETOF price_history` 전 열) JSON **3,468,057 B**. 와이어 기준 약 5.7 MB/요청.
- 방문 수(봇·테스트 포함)는 Vercel 로그 없이 알 수 없다. 하루 30회면 170 MB/일.

### 2-3. 그 밖 (추정 — 근거 약함)

- 수집기 활성 실행의 대상·캐시·직전 관측 조회, 핫딜 수집(Actions 하루 캐시 뒤 0.26 MB/회), 상품 페이지·사이트맵,
  `/api/ai` 카탈로그 검색. 테이블 통계상 `products` seq_scan 12,095회(×5.2만 행 스캔)는 연산(CU)에 크게 들지만
  반환 행 수는 알 수 없다. **확인하려면 `pg_stat_statements` 활성화(사용자 결정)가 필요하다.**
- `check-alerts.js` 는 이미 «알림 0개면 가격을 읽지 않는다»로 고쳐져 있다(10-21).

## 3. 이번 수정 (코드만, 쓰기 규칙 불변)

| # | 파일 | 바꾼 것 | 기대 절감 |
|---|---|---|---|
| 1 | `scripts/collect-all-prices.js` | `loadStateHead()` 로 몇 바이트(잠금·대상 서명·ADPICK 상태·재확인 원장, JSON 경로)만 먼저 읽고 `idleRunReason()` 이 «잠금 충돌 / 오늘 완료»면 끝. 그다음 하루 사용량 count 2회로 «두 제공자 예산 소진»이면 끝. 그 밖에만 예전 `loadState` 전체 경로 | 할 일 없는 실행 1회당 1.7~3.4 MB → ≈0.3 KB. 실행 수 기준 **하루 60~120 MB** |
| 2 | `scripts/collect-volatile-prices.js` | `volatileFastPath()` — 잠금 충돌 · 이미 처리된 슬롯 · 창 밖 감시(놓친 슬롯 없음)는 요약만 읽고 끝. 슬롯을 맡거나 MISSED 를 표시(쓰기)할 때만 예전 경로 | 재확인 1회당 3.4 MB → ≈0.3 KB (슬롯을 맡는 하루 2회는 그대로) |
| 3 | `api/hotdeals.js` | 판정 스캔 열을 `id, product_id, mall, price, recorded_at, vendor_item_id, item_id` 로(`title`·`link`·`recorded_date` 제외). 직전 관측 RPC 도 같은 열만(`rpc().select()`). 옵션 열이 둘 다 빈 행만 id 로 link 를 다시 읽고(최근 9일 72,000행 중 0행), 화면 카드(≤limit)의 원장 title·link 만 따로 읽는다 | 운영 원장 실측(11-14): 오늘치 와이어 2.84 MB → 1.14 MB, 직전 관측 JSON 3.47 MB → 1.49 MB — 요청당 ≈5.6 MB → ≈2.3 MB (**−60%**) |
| 4 | `api/hotdeals.js` | `loadTodayDropsMemo()` — 같은 인스턴스에서 원장으로 만든 목록(canonical 묶기 «전»)을 60초 재사용, 동시 요청은 한 번을 같이 기다림. canonical 묶기는 요청마다 그대로(롤백 스위치 즉시 반영). `HOME_DROP_MEMO_MS=0` 이면 끔 | 따뜻한 인스턴스의 반복 방문은 0 MB |
| 5 | `api/_neonpg.js` | `rpc(...).select(cols)` — PostgREST 와 같은 결과 열 선택 (행 반환 함수만, 식별자 검증 그대로) | 3 의 RPC 절감을 Neon 백엔드에서도 적용 |

- 판정·카드·순서가 예전과 같은지: `scripts/test-neon-transfer-guards.js`(44개) 가 같은 원장으로 전 열 판정과 비교한다.
  기존 `test-today-drop`(140) · `test-today-drop-bounds`(24) · `test-hotdeal-api`(144) · 수집기 회귀 14종 통과.
- 운영 영향 시점: 1·2 는 **main 에 병합되는 순간 다음 Actions 실행부터**(Vercel 배포 불필요). 3·4·5 는 Vercel 배포 뒤.
- 바뀌는 관찰값: 할 일 없는 실행은 더 이상 잠금을 잡지 않으므로 `price_job_state.last_run_at` 이 «실제로 일한
  실행»만 반영한다(진단 출력 `observe-cron`·`verify-today` 만 읽는다 — 경보 없음).

## 4. 남은 위험과 사용자 결정 사항

1. **전송 한도가 반나절 안에 찰 수 있다.** 이 PR 이 병합·배포되어도 남은 0.25 GB 안에서 버텨야 한다.
   즉시 조치는 사용자만 할 수 있다: (a) Neon 유료 플랜 전환, (b) 병합 전까지 `volatile-prices` 워크플로 일시 중지,
   (c) `IDENTITY_CANONICAL_CONSUMER_ENABLED` 를 끄면 홈 핫딜이 다시 CDN 120초 캐시를 탄다(제품 결정).
2. **연산(CU-h)도 11-19~20 경 한도.** 컴퓨트가 87% 시간 깨어 있다 — 낮 30분 칸마다 수집기가 DB 를 깨우고(5분 유지),
   봇·사용자 요청이 깨운다. 이 PR 은 깨우는 횟수를 줄이지 않는다(요약 읽기도 DB 접속이다).
   줄이려면 낮 칸 축소 또는 «하루 완료/예산 소진» 표식을 Actions 캐시에 두어 DB 접속 자체를 건너뛰어야 한다(후속).
3. **질의별 근거 부족.** `pg_stat_statements` 확장 생성(운영 DB 변경)을 승인하면 다음 감사부터 질의별 행·시간이 보인다.
4. **재확인 원장이 지워진다(기존 결함 의심).** 11-14 18시 KST 상태에 `volatileSlots` 키가 없다 — 오늘 정오 슬롯
   기록이 수집기의 상태 저장에 덮였을 수 있다. 그러면 감시 실행이 놓친 슬롯으로 보고 전체 경로를 탄다. 별도 조사 필요.

## 5. 재현 방법 (읽기 전용)

```bash
neon projects get withered-dew-45175008 --output json   # data_transfer_bytes · compute_time_seconds
```

```sql
-- BEGIN READ ONLY 안에서
select pg_column_size(last_result), octet_length(last_result::text) from price_job_state;
select count(*), sum(octet_length(row_to_json(t)::text)) from (
  select product_id, mall, title, price, link, recorded_at, recorded_date, vendor_item_id, item_id
  from price_history where recorded_at >= '<KST 오늘 00시의 UTC>') t;
```
