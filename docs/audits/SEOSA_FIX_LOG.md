# SEOSA 전수 감사 — 수정 기록

브랜치 `claude/seosa-system-audit-fixes-c7536b` · 기준 `main` 35afa08

«수정 완료» 는 코드와 테스트가 이 브랜치에 들어갔다는 뜻이다.
**Production 반영은 별개다** — 이 브랜치는 아직 병합되지 않았다.

---

## FIX-01 — 범주어 검색이 상품명 한 건으로 브랜드 검색이 되지 않게 한다

- 발견: `SEOSA_FULL_AUDIT.md` F-01
- 우선순위: P1 (검색 결과의 심각한 부정확성)

### 바꾼 파일

| 파일 | 내용 |
|---|---|
| `api/_search.js` | `PRIMARY_HEAD_MIN_TITLES = 2` 신설. `analyzeQuery()` 의 `primaryHead` 를 `.some()` → «머리로 시작하는 상품명 수 ≥ 2» 로 변경 |
| `scripts/test-search-category-head.js` | 신규 회귀 테스트 (15검사, 외부 호출 0 · DB 0) |
| `package.json` | `test` · `test:search` 체인에 위 테스트 추가 |

### 변경 전후 (오프라인 재현, 외부 호출 0)

검색어 `운동화`, 후보 = 2026-11-23 운영 응답에서 가져온 책 1건 + 운동화 5건

| 상품명 | 수정 전 | 수정 후 |
|---|---|---|
| `[국내도서] 운동화 신은 뇌` | 1.000 | 1.000 |
| `이더커머스 남성 발편한 가벼운 운동화` | 0.650 (`late-head`) | **1.000** |
| `디아핏 가벼운 발편한 남성 런닝화 운동화` | 0.650 (`late-head`) | **1.000** |
| `아디다스 바레다 로우 운동화 KI6726` | 0.650 (`late-head`) | **1.000** |
| `JLVJ 여성 운동화 가벼운 스니커즈 데일리 런닝화` | 0.650 (`late-head`) | **1.000** |
| `뉴발란스 2002 남여공용 운동화 …` | 0.650 (`late-head`) | **1.000** |

`analyzeQuery('운동화').intent`: `BRAND_ONLY` → `PRODUCT`

신규 테스트: 수정 전 **3/15 PASS (12 FAIL)** → 수정 후 **15/15 PASS**.

### 회귀 결과

| 스위트 | 수정 전 | 수정 후 |
|---|---|---|
| `test` 체인 145단계 (개별 실행) | 145 PASS / 0 FAIL | **145 PASS / 0 FAIL** |
| `pretest` 23단계 + `test:search` 5단계 | 28 PASS / 0 FAIL | **28 PASS / 0 FAIL** |
| `test:regression` | PASS | **PASS** |
| `test:release` | PASS | **PASS** |
| `test-search-ranking-intent.js` | 151 PASS / 0 FAIL | **151 PASS / 0 FAIL** |
| `test-search-adversarial.js --split dev` | 2311 PASS / 0 FAIL | **2311 PASS / 0 FAIL** |

`test-search-ranking-intent.js --report` 로 수정 전/후 스냅숏 47건을 비교했다.

- 순위가 바뀐 픽스처: **0건**
- `intent` 가 바뀐 픽스처: 9건 (`BRAND_ONLY` → `PRODUCT`) — 전부 **본품이 1건뿐인**
  2건짜리 픽스처라 «둘 이상» 요건을 못 채운다. 운영 브랜드 검색은 본품이 여럿이라
  영향이 없다(`삼성 갤럭시` 실측 6/6).
- `relevance` 가 바뀐 값: 5건. 전부 호환 부속이 `late-head` 중복 감점을 잃어
  0.26 → 0.40, 0.293 → 0.45 로 **오른** 것이고, 본품(0.9 / 1.0)보다 여전히 아래다.
  이 픽스처들이 지키려는 명제(«본품 > 호환 부속»)는 그대로 지켜진다.

### 남은 위험

- 후보가 2건뿐이고 그중 본품이 1건인 목록에서는 브랜드 질의가 `PRODUCT` 로 내려간다.
  그 목록에서 호환 부속의 점수가 0.14 정도 오르지만 순서는 바뀌지 않는다(위 실측).
- `PRIMARY_HEAD_MIN_TITLES` 를 1로 되돌리면 F-01 이 그대로 되살아난다.
  그래서 상수에 그 사실을 주석으로 박아 두었다.
