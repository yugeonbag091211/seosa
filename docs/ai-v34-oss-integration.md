# SEOSA AI v3.4 — 오픈소스 통합 기록 (2026-11-12)

| 오픈소스 | 실제 버전 | 라이선스 | 설치 위치 | 기능 연결 |
|---|---|---|---|---|
| pgvector | **0.8.6** (격리 Neon 브랜치, PG 18.6) / **0.8.7** (PGlite 내장) | PostgreSQL License | Neon 개발 브랜치 `ai-v34-pgvector-dev-20261112`에만 `CREATE EXTENSION` | `ai_v34.product_embeddings` + HNSW, `pgVectorStore` → `searchCatalog(strategy:'hybrid')` |
| @electric-sql/pglite | 0.5.12 (exact) | Apache-2.0 | 앱 `devDependencies` | 로컬 PostgreSQL 18.6 (WASM) — 오프라인 실험·CI 통합 테스트 |
| @electric-sql/pglite-pgvector | 0.0.13 (exact, peer = pglite 0.5.12) | Apache-2.0 | 앱 `devDependencies` | PGlite용 pgvector 0.8.7 |
| promptfoo | **0.125.1** (exact) | MIT | `tools/ai-eval/` 별도 패키지·별도 lockfile | 커스텀 provider + JS assertion 2종(독립 판정기) |
| fast-check | 4.8.0 (기존 lockfile 유지, 범위 `^4.8.0`) | MIT | 앱 `devDependencies`(기존) | 속성 17종 3,510회 + 피드백 300회 + 기존 v3.3 380회 |

버전 선택 원칙: 2주 이상 지난 릴리스를 정확 고정(PGlite 0.5.12 = 2026-10-26, promptfoo 0.125.1 = 2026-10-25). PGlite 0.5.13+는 2주 미만이라 쓰지 않았다.

## 1. pgvector

### Neon 지원 여부 (격리 브랜치 실측)
- 운영 브랜치 `migration-test-20261020`(endpoint `ep-gentle-art-…`)에는 **아무것도 하지 않았다**.
- 개발 브랜치 `ai-v34-pgvector-dev-20261112` (`br-little-lab-aoyqkov8`, 부모=운영 브랜치 copy-on-write, **2026-11-15 자동 만료**, compute 0.25 CU 고정)를 만들어:
  - `pg_available_extensions`: `vector` 0.8.6, `pg_trgm` 1.6 (둘 다 미설치 상태였음)
  - 마이그레이션 적용 → 확장 0.8.6 설치, HNSW 생성 확인
  - 임베딩 2,000개(5.2초), 재실행 시 1,999개 unchanged(동률 경계 1개만 신규) — 증분 처리 확인
  - 20개 질의: HNSW recall@10 = **1.000**(정확 스캔 대비), 지연 p50 71ms / p95 72ms(정확 71/76ms) — **대부분 서울↔싱가포르 왕복**이고 서버 실행은 ~1.1ms(EXPLAIN ANALYZE)
  - 2,001행 규모에선 플래너가 HNSW 대신 순차 스캔+정렬을 선택(비용 기반; 작은 표에서 정상). 77,737행(PGlite)에선 `Index Scan using … hnsw` 확인.
- 소비: 연산 약 25분 × 0.25 CU(실패한 20분짜리 원격 벤치 포함) ≈ 0.1 CU-h, 전송 수 MB 미만, 저장 +5.6MB(만료 시 정리).
- **실패도 기록**: 7개 설정 × 100질의 원격 벤치(`pgvector-bench.js --target neon-dev`)는 20분 실행 후 결과 파일 없이 끝났다(오류 메시지가 출력 필터에 가려져 원인 미확인). 재시도 대신 20질의 최소 점검(`neon-dev-check.js`)으로 대체했다. 인덱스 비교 수치는 아래 PGlite 실측이 근거다.

### 인덱스 선택 (실험 E, PGlite PG 18.6 + pgvector 0.8.7, 77,737 × 256차원, 질의 100개)

| 설정 | recall@10 (정확 대비) | p50 ms | p95 ms | 빌드 | 인덱스 |
|---|---|---|---|---|---|
| 정확 스캔 | 1.000 | 90.2 | 118.6 | — | — |
| HNSW m16/efc64, ef_search 40 | 0.990 | 2.6 | 3.9 | 301.7초 | 99.4MB |
| **HNSW ef_search 100 (채택)** | **0.992** | **3.3** | **4.9** | 〃 | 〃 |
| HNSW ef_search 200 | 0.994 | 5.7 | 8.9 | 〃 | 〃 |
| IVFFlat lists 279, probes 1 | 0.750 | 1.5 | 2.8 | 17.2초 | 88MB |
| IVFFlat probes 10 | 0.928 | 5.8 | 8.3 | 〃 | 〃 |
| IVFFlat probes 40 | 0.957 | 16.0 | 21.3 | 〃 | 〃 |

HNSW가 같은 지연에서 재현율이 더 높아 채택. 빌드 시간은 단일 스레드 WASM 수치라 Neon(네이티브)과 다르다. 테이블+인덱스 합계 210MB → Neon Free 한도 관점의 결정 사항은 release-readiness 문서에 있다.

### 하이브리드 결합
- RRF(Cormack et al., 2009) `score = Σ w/(k+rank)`, k=60 구현(`_ai-v34-fusion.js`), 속성 테스트 16(모든 후보 정확히 1회, 만장일치 1위 유지).
- 실측(봉인 100문항, 테스트 결과 문서): RRF 융합은 MRR@20을 0.860→0.901~0.913으로 올렸지만 최종 PASS가 53→50~51, 잘못된 카드 40→43~45로 나빠졌다. 그래서 기본은 `expand`(키워드 순서 유지 + 벡터 전용 검증 후보 추가)이고 `fuse`는 실험 옵션.

## 2. Promptfoo

- **앱 의존성 트리에 넣지 않았다.** 루트에 `npm install -D promptfoo`를 하자 운영 의존성 `@aws-sdk/*`·`@smithy/*` 19개의 잠금 버전이 함께 올라갔다(lockfile 재해결) → 되돌리고 `tools/ai-eval/`에 별도 패키지·lockfile로 격리. 루트 lockfile 변경은 PGlite 2개 패키지 추가뿐(기존 패키지 버전 변경 0 — 스크립트로 확인).
- 커스텀 provider `providers/seosa-engine.js`: 실제 엔진(`createEngine`+`searchCatalog`)을 오프라인 하네스로 구동, 다중 턴은 서버 state를 이어 붙여 재현, **원시 결과만 반환**(provider가 스스로 채점하지 않음).
- 판정: `assertions/judges.js:v34Oracle`(봉인 정답 조건 + 코퍼스 재확인)과 `:v2Evaluator`(기존 v2, 질문 문장에서 요구 도출) 두 assertion. 하나라도 실패면 테스트 실패 → 판정기 불일치는 자동 PASS가 아니다. UNVERIFIED는 `pass:false, score:0.5`.
- 설정: `promptfooconfig.offline.yaml`(봉인 100문항 × v3.3/v3.4 DB-first/v3.4 Hybrid), `promptfooconfig.fixture.yaml`(CI용 합성 26행·8문항), `promptfooconfig.preview.yaml`(격리 Preview E2E — **미실행**, provider가 운영 도메인·토큰 없음·$10 초과 상한·무제한 요청을 거부).
- **개인정보/외부 전송 실측 발견**: Promptfoo 0.125.1은 `PROMPTFOO_DISABLE_TELEMETRY=1`이어도 `telemetry-*.js`의 `recordTelemetryDisabled()`가 `https://r.promptfoo.app/`로 "telemetry disabled" 이벤트를 **1회 POST**한다(사용자 ID·런타임 메타데이터 포함, 끄는 환경변수 없음). `tools/ai-eval/network-guard.cjs`(NODE_OPTIONS 선적재)가 모든 비-루프백 연결을 거부하고 기록하므로 실제 전송은 0이며, `run-eval.js`가 시도를 `networkBlockedAttempts`로 보고한다. CI는 "텔레메트리 외 시도 0건"을 강제한다.
- 실행: `node tools/ai-eval/run-eval.js --config promptfooconfig.offline.yaml --out <json>` (env: `SEOSA_EVAL_SNAPSHOT`, `SEOSA_EVAL_PGLITE`, `SEOSA_EVAL_V33_ROOT`). 항상 `--no-share --no-cache --no-write`.

### 보안 점검
- `npm audit --omit=dev`(앱): **0건**.
- `tools/ai-eval` 전체 트리: 8건(high 5, moderate 3) — 모두 promptfoo 전이 의존성: `basic-ftp`(FTP 목록 파서 DoS), `get-uri`/`pac-proxy-agent`/`proxy-agent`(그 경유), `glob`/`minimatch`(DoS), `@modelcontextprotocol/server-filesystem`. 우리 평가 경로는 FTP·PAC 프록시·MCP 파일시스템 서버를 쓰지 않고, 개발 전용·격리 디렉터리·네트워크 차단 상태로만 실행한다. `npm audit`이 제안하는 "fix"는 promptfoo 0.5.1로의 대폭 다운그레이드라 적용하지 않았다.

## 3. fast-check

- 기존 v3.3 테스트(200+100+80 생성 입력)는 그대로 두고 확장: `scripts/test-ai-v34-properties.js` — 17개 실패 유형을 16개 속성으로, 고정 시드(기본 20261112, 속성별 +offset), 총 **3,510회 생성 입력**. 실패 시 시드·경로·축소된 반례를 `reports/ai-v34-evaluation/fastcheck-failures.json`에 기록(`--record`).
- 요청된 14개 유형 대응: 1/9 유사 모델·변형(Pro/Plus/FE/Edge) · 2 예산 초과 옵션 · 3 복수 옵션 제목의 가격 불일치 · 4 배송비 포함 초과 · 5 오래된 가격 · 6 중복 SKU · 7 잘못된 URL · 8 유선/무선 · 10 액세서리 · 11 비교 한쪽 누락 · 12 대화 조건 유지 · 13 존재하지 않는 상품 · 14 판매처 장애 vs 부재. 추가: 15 벡터가 모델 필터 우회 불가, 16 RRF 불변식, 17 가격 유효기간 경계.
- **fast-check가 실제로 찾은 결함 4건** (모두 수정·회귀 테스트화):
  1. 속성 8, 시드 20261120, 경로 `0`, 축소 반례 `[{"cat":["마우스","마우스"],"brand":"로지텍"}]` — "무선 마우스" 요청에 "로지텍 유선 마우스 USB 연결"이 카드로 나감(필수 속성 표에 무선 방향이 없었음).
  2. 속성 11, 시드 20261123, 경로 `3:2`, 반례 `[{"aOk":true,"bOk":true}]` — **테스트 데이터 오류**(G502 X ≠ G502는 엔진이 맞음). 데이터 수정, 엔진 변경 없음.
  3. 피드백 속성, 시드 20261140, 반례 `["HP   ","   "]` — 대문자 브랜드(HP) 토큰이 형식 검사에 걸려 기록 자체가 거부됨.
  4. 피드백 속성, 시드 20261140, 반례 `["   ","MlGe4"]` — 16진 HMAC에 "010…"이 생기면 전화번호로 오인.
