# SEOSA AI v3.4 — 아키텍처 (2026-11-12)

브랜치 `feat/ai-v34-hybrid-eval-20261112` (v3.3 `fa172f3` 위). **Production 미반영·미푸시.** v3 엔진은 Production에서 여전히 꺼져 있다(`ENABLE_AI_V3` 미설정). 이 문서는 v3.3 위에 무엇이 추가·수정됐는지와, 그 경계가 어디인지를 적는다.

## 1. 요청 흐름

```
사용자 질문 (+ 서버가 서명 없이 돌려받는 state, 최근 대화 8개)
  └─ GPT 계획 (search_products 함수 호출 1회: 질의·카테고리·예산·제외·비교)    _ai-v3-openai.js
       └─ 서버가 계획을 사용자 말로 재검증 (예산·제외·모델은 사용자 발화가 우선)  _ai-v3-core.js sanitizePlan
            ├─ v3.4: 모순 조건이면 검색하지 않고 되묻는다 (예산 하한>상한, 제조사≠제품라인)
            └─ 검색 계획 → searchCatalog(전략)                                       _ai-v3-catalog.js
                 ├─ live    : 판매처 searchAll 1회 (기존 쿠팡·ADPICK 리미터·캐시·쿼터 임대 그대로)
                 ├─ keyword : Neon products ILIKE 탐침 (v3.1~v3.3) + v3.4 제외어 NOT ILIKE
                 └─ vector  : v3.4 pgvector HNSW (격리 DB) — 마감시간 1.5초, 실패해도 요청은 계속
                 → 채널별 사전 필터 → 결합(expand 또는 RRF) → SKU·제목 중복 제거 (최대 80)
            └─ 최종 검증 (모든 채널 공통, 채널을 묻지 않음)                         validateCandidates
                 유형·액세서리·중고·v3.4 목록 무결성 가드·정체성(모델/세대/용량/화면)·호환·브랜드·
                 판매처·모델코드·제외어·최소/최대 예산·배송비 포함 예산·v3.4 가격 유효기간·중복
            └─ GPT 선택 (서버가 준 ID 중 최대 4개만, 새 상품·가격·링크 생성 불가)
            └─ 서버가 카드 생성 (가격·링크·수집 시각·유효기간 상태는 DB/판매처 기록에서만)
            └─ 결과 없음 사유 구분: 가격이 오래됨 / 판매처 장애(DB만 확인) / 검증된 후보 없음 / 조건 모순
```

## 2. GPT와 서버의 역할 분리 (v3.3과 동일 원칙, v3.4에서 강화된 부분)

| GPT가 하는 일 | 서버가 하는 일 (GPT 출력과 무관하게) |
|---|---|
| 자연어 이해, 이전 대화 조건 해석 | 상품 ID 검증 — 후보 목록에 없는 ID는 버림 (fast-check 속성 13) |
| 카테고리·용도·선호 추출 | 브랜드·정확한 모델·변형(Pro/Plus/FE/Edge) 검증 (속성 1/9) |
| 검색 계획(검색어·비교 대상·예산 제안) | 가격·배송비 포함 예산 검증 (속성 2/4) |
| 검증된 후보 중 선택 | 구매 링크 검증 (http/https, 자격증명 포함 URL 거부, 속성 7) |
| | **v3.4** 가격 유효기간: 사이트 공통 `_price.productLifecycle`(10일) 적용, 카드에 `priceObservedAt`/`priceAgeDays` |
| | 재고 근거 구분: `priceStatus`(observed=판매처 API / cached_or_unverified=DB), `priceFreshness` |
| | SKU 중복 제거, 판매처 오류 처리, 최종 카드 생성 |

GPT가 만든 검색어는 **필수 조건을 새로 만들 수 없다**(정체성은 사용자 발화와 이전 상태에서만). v3.4의 벡터 채널도 같은 원칙: 벡터 유사도는 **후보를 늘리기만** 하고, 모든 벡터 후보는 키워드 후보와 같은 유형·브랜드 필터 + `matchRequested`(가격 범위·중고·모델코드·정체성·무선·목록 가드·제외어)를 통과해야 결합에 들어간다. 이후 엔진의 `validateCandidates`가 다시 판정한다.

## 3. 검색 전략 (Feature Flag)

| 값 (`AI_V3_SEARCH_STRATEGY`) | 동작 | 기본 |
|---|---|---|
| `db-first` (또는 미설정/알 수 없는 값) | 기존 v3.3: DB 키워드, read-only가 아니고 DB가 비면 판매처 1회 | ✅ |
| `live-first` | 판매처 1회 → 검증된 4개 미만이면 DB 보완 (v3.3) | |
| `hybrid` | 판매처(허용 시) + DB 키워드 + 벡터를 함께 조회해 결합 | |

벡터 채널은 `hybrid`이고 다음이 모두 참일 때만 켜진다(`api/_ai-v34-strategy.js`):
- `AI_V34_VECTOR_ENABLED=1`
- `AI_V34_VECTOR_DATABASE_URL` 설정 — **메인 DB와 같은 호스트면 거부**(`AI_V34_VECTOR_ALLOW_MAIN_DB=1`은 별도의 운영 결정)
- 임베더: `AI_V34_EMBEDDER=hash`(기본, 무료·로컬) 또는 `openai`(`AI_V34_EMBEDDING_COST_CAP_USD` 필수)

결합 방식: `AI_V34_HYBRID_MODE=expand`(기본: 키워드 순서 유지 + 키워드가 못 찾은 검증된 벡터 후보를 뒤에 추가) 또는 `fuse`(RRF, k=60, `AI_V34_VECTOR_WEIGHT`). 실측상 `fuse`는 MRR을 올리지만 최종 카드 정확도를 떨어뜨려 기본값에서 제외했다(테스트 결과 문서 참조).

`SEOSA_DB_READONLY=1`이면 판매처 호출(쿼터 임대가 DB 쓰기를 요구)은 v3.3과 같이 건너뛴다 — v3.4는 이 보호를 우회하지 않는다.

## 4. 장애 처리 (판매처 장애 ≠ 상품 부재)

| 상황 | v3.4 동작 |
|---|---|
| 벡터 저장소 오류/시간 초과 | `vectorStatus: error/timeout`, 키워드(+판매처) 결과로 정상 응답 |
| DB 키워드 오류 + 다른 채널에 검증된 후보 있음 | 그 후보로 응답 (부분 성공) |
| DB 키워드 오류 + 다른 채널 결과 없음 | 예외 → HTTP 503 ("지금은 완료할 수 없어요"), "상품 없음"이라고 말하지 않음 |
| 판매처 실패 + DB에 후보 없음 | `noResult: provider_unavailable_db_checked` + "상품이 없다는 뜻은 아니다" 안내 |
| 조건에 맞는 기록은 있으나 모두 10일 초과 가격 | 카드 0개, `noResult: stale_price_only` + 오래된 가격을 현재가로 안내하지 않는다는 설명 |
| 판매처 stale-cache만 반환 | live로 취급하지 않음 (v3.3 유지) |

## 5. pgvector 계층

- 스키마 `ai_v34` (격리 DB 전용 마이그레이션 `db/isolated/2026-11-12-ai-v34-pgvector.sql`): `product_embeddings(mall, product_id, embedder_id, dims=256, lexicon_version, content_hash, embedding vector(256), embedded_at)`, `embedding_runs`(실행 감사), `retrieval_feedback`(설계용).
- HNSW `vector_cosine_ops`, `m=16, ef_construction=64`, 질의 시 `hnsw.ef_search=100`, `hnsw.iterative_scan=relaxed_order`(가격 필터와 함께), 읽기 전용 트랜잭션.
- 문서 정규화(`_ai-v34-text.js`): 카테고리·브랜드·모델코드(숫자 시작 코드 포함)·제목 정체성(family/series/variant/storage…)·동의어 키(랩탑→노트북 등)·정규화 제목. 어휘집 버전이 content hash에 들어가 **어휘가 바뀌면 영향받는 상품만 재임베딩**된다.
- 임베더: `seosa-hash-ngram-v1`은 단어 + 문자 2·3-gram 부호 해싱(256차원)으로 **의미 모델이 아니라 어휘(철자·띄어쓰기·어순·동의어 키) 모델**이다. OpenAI `text-embedding-3-small`(256차원) 경로는 구현돼 있으나 이 세션에서는 키가 없어 실행하지 않았다.
- 운영 반영 시 고려: 77,737개 × 256차원 = 테이블+HNSW 약 210MB(PGlite 실측). Neon Free 프로젝트 한도 1GB(현재 운영 브랜치 논리 크기 ~700MB)에 그대로는 부담 → `halfvec`, 128차원, 또는 가격이 신선한 상품만(스냅샷 기준 약 37%) 임베딩.

## 6. 피드백 루프 (자동 수정 금지)

`api/_ai-v34-feedback.js` → `scripts/ai-v34/propose-lexicon.js`:
1. 사용자의 거절/재요청 신호 종류만 메시지에서 읽는다(`reject|retry|refine|report`).
2. 기록은 **이전 턴의 서버 상태와 카운터**로 만든다: 카테고리, 조건 종류(예산/브랜드/모델/제외/중고/기능), 거절 사유 카운트(화이트리스트 키), 결과 없음 사유, 화이트리스트 토큰(알려진 브랜드·동의어 키·엄격한 모델코드 모양). 원문·답변·카드 제목·상품 ID·가격·링크·계정·IP는 없다. 세션 키는 서버 비밀로 만든 HMAC이며 하루마다 바뀐다.
3. 저장은 `AI_V34_FEEDBACK_ENABLED=1`일 때만, read-only면 거부, 격리 스키마에만.
4. 제안 스크립트는 3개 이상 서로 다른 세션이 겹친 패턴만 "검토 대기"로 내보낸다. 승인돼도 **사람이 별도 브랜치에서** 어휘 버전을 올리고 테스트 + 봉인 평가를 통과시켜야 반영된다. 엔진·DB·임베딩을 자동으로 바꾸는 경로는 없다.

## 7. 파일 지도

| 파일 | 역할 |
|---|---|
| `api/_ai-v34-freshness.js` | 가격 유효기간(사이트 공통 규칙, 재생용 시계 주입) |
| `api/_ai-v34-listing-guards.js` | 기기 최저가·통신사 약정가·묶음/스토어 페이지·도서·색상 가드 |
| `api/_ai-v34-text.js` / `_ai-v34-embedding.js` | 정규화·어휘집 / 임베더·비용 가드 |
| `api/_ai-v34-vector.js` / `_ai-v34-fusion.js` | 벡터 저장소·검색·마감시간 / RRF |
| `api/_ai-v34-strategy.js` | 전략 플래그·벡터 런타임(격리 DB 강제) |
| `api/_ai-v34-feedback.js` | 비식별 실패 기록 |
| `api/_ai-v3-core.js` `_ai-v3-catalog.js` `_ai-v3-route.js` | 위 모듈 연결, 모순 조건, 제외어 검색 반영 |
| `api/_ai-v31-taxonomy.js` `_ai-v31-retrieval.js` `_ai-v32-intent.js` `_price.js` | 무선/저소음/게이밍/거실 요구, 에어팟 맥스, 부정 표현, 띄어쓴 앵커, 브랜드 충돌, `now` 주입 |
| `db/isolated/…pgvector.sql` | 격리 DB 전용 스키마 |
| `scripts/ai-v34/*` | 임베딩 파이프라인, 대상 DB 가드, 벤치, Neon 점검, 평가 하네스 |
| `tools/ai-eval/*` | Promptfoo(격리 설치), provider·판정 assertion·네트워크 가드 |
