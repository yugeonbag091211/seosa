# SEOSA AI: 단계별 품질 개선 검증 (2026-10-30)

## 범위와 배포 상태

- 대상: Draft PR #206, branch `codex/ai-integration-release`
- Production: 변경하지 않음. 기존 검색 확대 PR #207은 Production에 유지.
- 이번 변경은 별도 판매처 API 호출·운영 DB 쓰기 없이 테스트함.
- 실제 GPT 호출: **0**. 실제 쿠팡·ADPICK API 호출: **0**.
- 실사용 품질·실제 결제 가격 일치율은 아직 검증되지 않음.

## 1단계 — 최종 서버 사실 관문

`api/_ai-fact-gate.js`와 `api/ai.js` 마지막 쇼핑 응답 경로에서
다음 오류를 차단함:

1. UNKNOWN_PRODUCT_ID: 승인된 현재 후보 목록에 없는 상품 ID·옵션·판매처.
2. CROSS_PRODUCT_EVIDENCE: 다른 상품 근거를 현재 상품에 붙인 구조화 근거, 불일치 추천 메타데이터.
3. PRICE_MISMATCH: 검증된 상품 카드의 가격 또는 표시 가격과 다른 값.
4. BUDGET_VIOLATION: 실제 사용자 상한·하한을 위반한 표시 가격.
5. EXCLUDED_BRAND_VIOLATION: 서버에서 제외된 대상이나 명시된 브랜드·게이밍 제외 조건.
6. UNSOURCED_PRICE_HISTORY: 검증된 이력이 없는 상태의 확정적 가격 추세 주장.

중요한 예외(정상 답변 보호):

- 비쿠팡 판매처의 내부 옵션 ID는 화면 카드에 공개되지 않을 수 있음.
  고유한 상품·판매처·가격 결합으로만 매칭하며, 모호하면 차단함.
- 묶음(정규화 그룹) 상품은 대표 오퍼 가격과 최저 표시 오퍼 가격을 구분함.
- 현재 표시가가 불명확하더라도 서버가 이미 검증한 특정 옵션의 **과거 기록가**를 설명하는
  안전한 답변은 제거하지 않음.
- 단순히 테스트 성공률을 올리기 위해 기존 판정 강도를 낮추지 않음.

## 2단계 — 실패 원인 자동 분류 기반

- `scripts/report-ai-eval-clusters.js`: 기존 JSONL 품질 평가 결과 또는
  앞으로 생성할 격리된 실호출 평가 기록을 입력받아 실패를 유형별로 집계.
- 원본 대화·상품 제목 대신 사례 해시 및 그룹별 건수만 보고서에 남김.
- 모호하거나 결과를 확인할 수 없는 건을 PASS로 만들지 않음.
- 독립 검토·실제 모델 판정을 대체하지 않으며, 근본 원인 후보를 좁히는 도구임.

사용법:

```bash
node scripts/report-ai-eval-clusters.js --input path/to/eval.jsonl --out path/to/clusters.json
```

## 3단계 — 실제 사용자 품질 지표 집계 기반

- `scripts/report-ai-experience.js`: 별도 동의를 받아 수집한 실사용 평가 JSONL만 집계.
- 평점 4~5점 비율, 상품 적합성 표본, 추천 후보 활용률, 응답 지연을 산출.
- 실제 데이터 0건이면 **NOT_VERIFIED**, 평점 30건 미만이면 **INSUFFICIENT_SAMPLE**.
- 원본 채팅, 이메일, 구매 기록을 포함하지 않는 단순 집계; 운영 추적·사용자 데이터
  수집 기능 자체를 이번 변경에서 활성화하지 않음.

사용법:

```bash
node scripts/report-ai-experience.js --input consented-events.jsonl --out user-quality.json
```

## 검증 결과 (격리된 로컬/CI, 실 API 호출 없음)

| 검사 | 수행 | 통과 | 실패 | 성공률 |
|---|---:|---:|---:|---:|
| 최종 사실 관문 정상·반례 | 20 | 20 | 0 | 100% |
| 자동 실패 분류 도구 | 8 | 8 | 0 | 100% |
| 실사용 지표 계산 도구 | 7 | 7 | 0 | 100% |
| 가격 근거·대화 회귀 | 292 | 292 | 0 | 100% |
| 레드팀 회귀 | 197 | 197 | 0 | 100% |
| 정규화 그룹 후보 | 70 | 70 | 0 | 100% |
| 원래 서로 다른 질문 | 1,000 | 1,000 | 0 | 100% |
| 독립 홀드아웃 질문 | 200 | 200 | 0 | 100% |

최종 `npm test` 성공. GitHub Tests / AI security validation /
Collector Regression / Mobile Check 모두 성공으로 확인.

**위 수치는 자동화된 격리 테스트 통과율이지, 실제 GPT의 정답률이나
운영 사용자 만족도 100%를 의미하지 않음.**

## 배포 전 필수 잔여 작업

1. PR #206 Preview에 운영 DB와 분리된 DB 또는 검증된
   `SEOSA_DB_READONLY=1`을 *브랜치 전용*으로 설정.
   기존 범용 Preview DB 연결만 믿고 테스트를 실행해서는 안 됨.
2. 실제 GPT + 실제 상품 데이터 50문항 이상, 비용·실패 원인을 별도 기록.
   이후 새 질문을 통해 자동 분류 결과 및 평가기 오판까지 확인.
3. 사용자 동의를 받은 실제 평가로 추천 만족도와 오추천율을 측정.
4. 위 실측이 완료되어 승인되기 전에는 PR #206 병합/Production 배포 금지.

## Preview 접근 제한 및 환경 설정 (추가 확인)

- Vercel Preview 브랜치 `codex/ai-integration-release` 전용으로
  `SEOSA_DB_READONLY=1` 환경변수 등록 확인.
- Production에는 이 변수 설정을 추가하지 않았음.
- 이 변경으로 새로 빌드되는 Preview에서 DB 쓰기를 차단하도록 의도됨.
  그러나 실제 인증된 Preview 요청에서 쓰기 차단을 실측하지 않았으므로
  **가드의 런타임 적용까지 검증됐다고 주장하지 않음**.
- 실 GPT·쇼핑 API 호출은 아직 0건. 공급자 쿼터와 비용은 소비하지 않았음.

## 2026-10-30 추가 진행: Preview 설정과 실호출 안전관문

- PR #206 Preview 배포 최신 코드는 Vercel READY, Production은 미변경.
- Vercel 브랜치 전용 `SEOSA_DB_READONLY=1` 등록 유지 확인.
- DB 읽기 전용 오프라인 계약 검사: **16/16 PASS**.
- 실제 Preview에서 운영 DB 쓰기 차단을 강제로 검증한 것은 아님. 자격이 필요한 실제 요청 전까지 별도 확인 필요.
- 연결된 Desktop Commander 장치가 **offline**; 안전한 격리 실행기에 OpenAI/쇼핑 API 자격 증명은 주어지지 않음. Vercel에 저장된 `OPENAI_API_KEY`는 민감 변수라 API로 원문을 반환하지 않음. 따라서 실제 GPT·쇼핑 공급자 종단 호출은 **0건**. 임의로 실제 테스트 성공을 주장하지 않음.

### 실호출 검증 스크립트 안전성 보강

`scripts/verify-ai-live.js`는 이제 반드시 다음을 사전 확인:

1. `VERCEL_ENV=production` 실행 거부. 원래의 `delete process.env.VERCEL_ENV` 우회 제거.
2. 양수이며 5달러 이하인 `--max-usd` 비용 한도 필수.
3. LLM 키, 쿠팡 또는 ADPICK API 키, DB 읽기용 연결 정보가 없으면 검증을 시작하지 않음.
4. `SEOSA_DB_READONLY=1` 설정 및 DB Guard 활성화 확인.
5. 가격을 모르는 OpenAI 모델이면 비용 보증 불가로 중지.
6. 계산 가능한 모델 추정 사용료가 상한에 도달하면 남은 질문 실행 중단.

사전 거부 및 오프라인 회귀 **7/7 PASS**, 외부 호출 및 DB 쓰기 **0**. 비용은 실제 청구액이 아닌 모델별 추정치이며 실제 사용 전에 가격표 확인 필요.

실행 예 (자격 정보를 코드·로그·보고서에 기록하지 않음):

```bash
node scripts/verify-ai-live.js --ask "15만원 이하 무선 헤드셋 추천해줘" --max-usd 1
# 실제 GPT만, 저장된 시험용 상품 데이터와 오프라인 서비스 경계 사용:
LIVE_REDTEAM_MAX_USD=5 node scripts/live-redteam-codex.js --run --round all --limit 50 --concurrency 1
```

### 자동 오류 분류 — 역사적 기준선과 수정 후 비교

`scripts/report-ai-eval-clusters.js`에 `--phase before|after`를 추가.
불확실한 판정이나 `functionCheck=PASS`만으로 답변 품질 PASS를 만들지 않음.
테스트 **12/12 PASS**.

기존 1,250개 오프라인 품질 검토 기록:

| 평가 시점 | 평가 | PASS | FAIL | UNVERIFIED |
|---|---:|---:|---:|---:|
| 수정 전(before) | 1,250 | 641 | 559 | 50 |
| 수정 후(after) | 1,250 | 1,250 | 0 | 0 |

수정 전 오류 유형별 발생 건수(한 실패가 여러 유형에 포함될 수 있음):
질문 충족 319, 문장 자연스러움 293, 가격/사양 근거 95, 가격 이력 94,
대화 상태 31, 답변 정확성 11, 예산 조건 4.

위 숫자는 **과거 모의 GPT·고정 상품 데이터에 대한 평가**, 현재 실사용 성능 증명이 아님.

명령:
```bash
node scripts/report-ai-eval-clusters.js --input reports/ai-answer-quality-2026-10-29/quality-review.jsonl --phase before
node scripts/report-ai-eval-clusters.js --input reports/ai-answer-quality-2026-10-29/quality-review.jsonl --phase after
```

### 최종 상태

최신 변경 전체 `npm test` **PASS**. GitHub Tests / Collector Regression / Mobile Check / AI security validation 모두 성공.
PR #206은 **Draft, 미병합, Production 미배포** 상태를 유지.

다음 완료 조건은 민감키를 로그/파일에 노출하지 않는 승인된 실행 환경에서 비용 한도를 걸고 **실제 GPT 50개 응답**을 얻어 코드 기반 사실 검사와 실패 자동 분류에 연결한 다음, 최소 일부 **실제 쇼핑 공급자 응답**으로 종단 검증을 수행하는 것. 사용자의 실제 만족도는 별도 동의 데이터로 추후 측정.
