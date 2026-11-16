# SEOSA 검색 실패 단계 진단 — 2026-11-17

## 범위

- 기반 PR: #242 → #243 → #244 (모두 Draft, 운영 미배포)
- 이 보고서의 수치는 **사전 등록된 합성 개발 세트 200문항**에서 나온 것이다. 실제 Coupang/ADPICK 응답·운영 DB·사용자 요청에 대한 정확도 측정이 아니다.
- 코드 변경 전 결과: `reports/codex-independent-20261116/development-run-after-lid-20261116.json`. 원본 파일에 기록된 `source_hashes` 기준.
- 코드 변경 후 결과: PR #244의 GitHub Actions `Tests` 로그, `STAGE_TRACE_PASS` 출력. 재실행 시 해당 시점의 `api_js_fingerprint`를 비교한다.

## 정답 후보 누락 단계 (후보 인스턴스 수)

| 단계 | 기존 결과 | PR #244 |
|---|---:|---:|
| 공급원 1차 관련도 필터 | 2 | 2 |
| 관련도/점수 하한 | 17 | 0 |
| 상품 정체성 관문 | 79 | 33 |
| 상품 관문 이후/표시 컷오프 | 0 | 0 |
| **합계** | **98** | **35** |

같은 입력 세트를 평가한 구체적인 후보 단계 비교이며, 검색 전체의 PASS 비율 또는 운영 정확도가 아님. 하나의 누락 후보는 여러 상품 관문 사유를 가질 수 있다.

## PR #244 관문 누락 사유 상위 5개

- `implausible_device_price`: 11개. 합성 데이터의 노트북 가격이 비정상적으로 낮아 기기 가격 안전 규칙이 적용됨. **합성 점수만 올리려고 가격 규칙을 해제하지 말 것.**
- `identity_word_absent`: 9개. 조사·활용 구문·고유명칭 추출 실패 사례를 개별 검증해야 함.
- `head_is_target`: 6개. 본품의 기능 설명과 호환 대상 부속 구분을 더 확인할 것.
- `accessory`: 3개. 기본 본품·부속 판단의 오탐 조사 필요.
- `category_absent`: 3개. 대화용 문구를 범주로 오해했는지 확인할 것.

이 숫자는 위 항목별 **영향받은 후보 수**로서, 동일한 상품이 두 가지 사유에 포함될 수 있음.

## 진단 실행

동일 저장소 체크아웃, 모의 DB 및 모의 검색 공급원만 사용하는 오프라인 평가:

```powershell
node scripts/test-search-stage-diagnostics.cjs
node scripts/test-search-korean-usage-20261117.cjs
node scripts/test-product-gate-recovery.cjs
node scripts/test-product-gate-followup-20261116.cjs
```

상세 리포트를 새 파일로 생성하려면(기존 파일 자동 덮어쓰기 금지):

```powershell
node scripts/search-eval/run-codex-independent-dev.cjs reports/codex-independent-20261116/run-new.json
node scripts/search-eval/explain-search-failures.cjs reports/codex-independent-20261116/run-new.json --questions reports/codex-independent-20261116/development-questions.json --out reports/codex-independent-20261116/stages-new.json
```

코드 파일을 수정하거나 평가를 반복해도 **새로운 독립 홀드아웃 PASS라고 주장하지 말 것**. 이 개발 세트는 이미 문제 분석에 사용됐고, 상시 회귀 테스트 용도에 적합하다.

## 운영 출시 전 차단 조건

1. 실공급원 상품을 사용한 합법적·격리된 재생 검증.
2. 새로운 블라인드 평가 세트의 PASS/FAIL/UNVERIFIED·P@5·Recall@10 비교.
3. 신규 기능이 기존 모델/가격/부속 정확도를 떨어뜨리지 않는지 확인.
4. Preview 독립 DB와 AI v3 라우팅·이전 대화 문맥 검증.
5. 정상 코드 병합·운영 DB 마이그레이션·운영 배포는 별도 승인 후 실시.

**현재 판단: NOT READY.**
