# Cross-merchant Product Identity — 2026-10-13

`merchant offer → normalized identity → canonical product group → price comparison`

원칙: **Precision first. 애매하면 묶지 않는다.** 판정은 `MATCH` / `REVIEW` / `NO_MATCH` 셋이다.
이번 단계는 Phase 1(offline evaluator)이다. 운영 DB 에 쓰지 않았고, 화면·가격 로직이 이 결과를 소비하지 않는다.

## 1. 기존 구조 (조사 결과)

| 항목 | 현재 |
|---|---|
| `products` 식별 | `UNIQUE (product_id, mall)` — «상품 1개당 1행». 쿠팡 `product_id` = 쿠팡 productId, ADPICK `product_id` = `sha256(commissionlink)`, `mall` = `'쿠팡'` / `'ADPICK'`(+ `mall_label` = 제휴몰 이름) |
| `vendor_item_id` | products 에서는 «바뀌는 속성»(쿠팡 `collapseOptions` 가 productId 당 최저가 옵션 1건). ADPICK 은 항상 빈 값 |
| `price_history` | `UNIQUE (product_id, mall, vendor_item_id, recorded_date)` — 옵션별 이력. products 와는 `(product_id, mall)` 로 이어진다 |
| 기존 dedupe | `_search.dedupeItems` — `product_id|mall` 만. 제목으로 합치지 않는다 |
| 기존 grouping | 핫딜만 `_hotgroup.groupOffers`(대표와만 비교 + `_identity` tier A + 5중 관문). 판매처 교차 가격비교 그룹은 없었다 |
| canonical/group schema | `hotdeals.group_key`(회차 스냅숏) 외에 없음 |
| 상품 merge 와 price_history | merge 가 없다. 이번 작업도 products·price_history 를 바꾸지 않는다 |

## 2. 새 구조

- `api/_identitycore.js` — 질의 식별(`_aiidentity`, PR #133)과 오퍼 식별이 **함께 쓰는** 순수 표기 읽기
  (색 · 용량 단위 · 상태 표기 · 판매자 지시문 걷어내기). `_aiidentity` 는 이제 이 모듈을 import 한다(동작 동일,
  단 `블루투스` 가 파란색으로 읽히던 결함은 고쳤다).
- `api/_offeridentity.js` — `parseOffer` · `matchOffers` · `blockKeys` · `clusterOffers` · `verifyGroups`.
  토큰화·붙여쓴 모델명 분해·등급 표기·상태 패턴·부속 낱말·대체품 표기는 `_search` 의 것을 그대로 쓴다.
- `scripts/test-offer-identity.js` + `scripts/fixtures/offer-identity-fixtures.js` — 쌍·군집·퍼즈·blocking 평가.
- `scripts/eval-offer-identity-real.js` — 운영 products **SELECT 전용** 오프라인 평가.

### Canonical identity

`brand · words(계열 낱말) · anchors/primaryAnchor(모델 번호 17·S26·3S·V15) · variants(Pro·Max·Ultra·+·FE·Detect) ·
modelNumbers(SM-R630=SMR630=SM R630) · gtins · storage · memory · specs(인치·mm·ml·g·W…) · colors · quantity ·
condition(new/open_box/used/refurbished/display/unstated) · transactionType(purchase/rental/subscription/contract) ·
region · bundle(none/bundle/gift/body_only) · included · accessory/accessoryType · substitute · year · deviceClass`

### 판정 계약

1. **충돌 관문(점수보다 먼저)** — 둘 다 알고 값이 다르면 `NO_MATCH`(confidence 1):
   GTIN · 브랜드 · 종류 · 제조사 모델번호 · 모델 번호/세대 · 등급 · 용량 · 메모리 · 크기 · 수량 · 색 ·
   본품↔부속 · 부속 종류 · 정품↔대체품/호환/replica · 구매↔렌탈/구독/약정 · 상태 · 지역 · 번들 · 연식 ·
   같은 판매처 상품의 다른 vendorItemId.
2. **모르는 값은 와일드카드가 아니다** — 한쪽만 아는 용량·색·수량(≥2)·상태(새상품 외)·지역(국내 외)·
   구성·크기 → `REVIEW`. 휴대폰·태블릿·노트북·의류는 «둘 다 안 적음» 도 REVIEW(용량/색이 SKU 차원).
   카탈로그의 같은 계열에서 값이 둘 이상 관측된 차원(색·용량·모델번호)도 같다.
3. **증거 위계** — Tier A(GTIN · 제조사 모델번호) / Tier B(브랜드·계열 낱말·모델 번호·등급이 모두 같음).
   Tier C(제목 유사)만으로는 MATCH 하지 않는다. 모델 번호가 없는 상품은 제목이 같아도 REVIEW.
   모델번호가 같아도 나머지 낱말이 다르면 REVIEW(운영 실례: 벽걸이형↔스탠드형, G304 LIGHTSPEED↔X SUPERLIGHT).
4. **군집** — union-find 를 쓰지 않는다. 새 오퍼는 군집의 **모든** 구성원과 MATCH 여야 들어간다.
   MATCH 는 한쪽만 아는 값을 허용하지 않으므로 «용량 모름» 오퍼는 256GB↔512GB 의 다리가 될 수 없다.
5. LLM 은 쓰지 않는다. 결정론 규칙만 판정한다.

## 3. 평가

### 픽스처 (`npm run test:offer-identity`, 401/401 PASS)

| | 수 |
|---|---|
| positive 쌍 (같은 SKU 17묶음) | 86 |
| negative 쌍 (충돌 태그까지 검증) | 84 |
| ambiguous 쌍 (REVIEW + 모르는 차원 검증) | 17 |
| TP / FP / TN / FN | 86 / **0** / 101 / 0 |
| precision / recall / F1 | 1.0000 / 1.0000 / 1.0000 |

픽스처는 설계 기준을 고정하는 회귀 집합이라 recall 1.0 은 운영 recall 이 아니다(아래 실데이터 참고).

- 퍼즈: 7 SKU × 표기 변형 166개 → 같은 SKU 1,886쌍 전부 MATCH. 모델·등급·용량·모델번호·수량·상태·부속·렌탈·
  대체품을 하나씩 바꾼 392쌍 중 MATCH 0 (NO_MATCH 280, 나머지 REVIEW).
- bridge poisoning 6종(용량·색·수량·상태·모델번호·브랜드 생략) × 입력 순서 6가지 — A·C 동거 0.
- all-pairs: 대표와만 비교하면 Sony·Bose 가 한 그룹이 되는 배치를 직접 검증.
- 입력 순서 15회 셔플 — 분할 동일.
- blocking: 전수 306,936쌍의 MATCH 4,554쌍 누락 0.

### 뮤테이션 (격리된 임시 복사본, 커밋하지 않음)

| 제거한 보호 | 결과 |
|---|---|
| variant mismatch (충돌 + 보조 검사 + Tier B 요건) | killed — 픽스처 FP 13 |
| storage mismatch | killed — FP 4 |
| accessory gate | killed — FP 5 |
| quantity mismatch | killed — FP 4 |
| condition mismatch | killed — FP 5 |
| rental/subscription | killed — FP 1 |
| substitute/replica | killed — FP 3 |
| model(anchor) mismatch | killed — 7 FAIL (Tier B 가 모델 번호 일치를 요구해 FP 는 안 났다) |
| all-pairs → 대표만 | killed — all-pairs 테스트 FAIL |
| 모르는 값을 와일드카드로 | killed — FP 4 |

10/10 killed. 작업 트리는 변경되지 않았다.

### 운영 데이터 (read-only, products 71,207행 SELECT — 쿠팡 23,613 · ADPICK 47,594)

| 항목 | 값 |
|---|---|
| 파싱 / 군집 | 14.7 s / 2.4 s (비교 80,180회, O(N²) 아님) |
| 다중 오퍼 그룹 / 판매처 교차 그룹 | 403 / 288 |
| 그룹 all-pairs 위반 | 0 |
| 판매처 교차 후보 쌍 판정 | MATCH 379 · REVIEW 1,816 · NO_MATCH 25,477 |
| blocking 누락 (3,649 오퍼 전수 6,655,747쌍) | MATCH 446 · 누락 0 |

사람이 본 것:
- **다중 오퍼 그룹 403개 전부** (반복 개선 중 새로 생긴 그룹까지 매번 전수) — 최종 집합 오병합 0.
  개선 과정에서 실제로 잡은 오병합 유형과 고친 방법은 코드 주석에 실례로 남겼다
  (모델번호 접두 일치·규격을 모델번호로 읽음·스타일 번호 무시·한 글자 크기 낱말·`30구+30구`·`WiFi 7`/`26FW`/`60초`·
  의류 색·`1+1 × x2` 수량·`Deco XE75 ↔ XE75 Pro`).
- 판정별 표본 (결정론 시드): MATCH 80쌍 → 80 같은 상품 (최종 코드로 재확인). NO_MATCH 80쌍 → 80 다른 상품.
  REVIEW 80쌍 → 약 13쌍이 실제로는 같은 상품(놓친 자동 묶음 — 안전한 방향). 나머지는 색·지역·기능 표기 한쪽,
  또는 무관한 상품.
- 주의: 같은 판매 글이 여러 제휴몰에 재게시된 «동일 제목» 그룹이 다수다(표본 MATCH 의 50/80). 제목만으로는
  숨은 옵션(사이즈·색 선택)을 알 수 없다 — 그래서 의류·휴대폰은 색·용량을 반드시 요구하고, 값이 두 배 넘게
  벌어지면 REVIEW 로 돌린다.

운영 제목 원문은 저장소에 넣지 않았다(ADPICK 응답 저장 조항). `--sample-out` 으로 로컬에서 재현한다.

## 4. 한계 (알고 둔 것)

- 브랜드 표는 표기가 여럿인 주요 브랜드만 담았다. 표에 없는 브랜드는 «낱말» 로 비교된다(양쪽에 같아야 MATCH) —
  더 엄격한 방향이다.
- «양쪽 다 색을 안 적은» 이어폰처럼 SKU 차원을 제목이 숨기는 경우, 같은 계열에서 색이 둘 이상 관측되지 않으면
  MATCH 될 수 있다(상품 페이지 단위의 같음). 휴대폰·태블릿·노트북·의류는 이 경우도 REVIEW 다.
- 기능 낱말 표기 차(노이즈캔슬링 ↔ 노이즈 캔슬링 이외의 동의 표현)는 REVIEW 로 남는다 — recall 손실.

## 5. Rollout

1. **Phase 1 (이번)** offline evaluator — `npm run eval:offer-identity-real` (read-only).
2. Phase 2 shadow matching — 수집기 회차마다 `clusterOffers` 결과를 별도 shadow 테이블(예: `offer_match_shadow`:
   run_id · offer key · group key · decision · evidence · unknown)에 기록만 한다. additive migration 필요, 아직 없음.
3. Phase 3 high-confidence MATCH only — Tier A/B MATCH 만, 판매처 교차 그룹만 노출 후보로.
4. Phase 4 REVIEW queue — `reviews` 간선(모르는 차원 포함)을 운영자가 승인/거절.
5. Phase 5 가격비교 UI/로직 소비 — 그룹 최저가·판매처 비교. price_history 는 계속 `(product_id, mall, vendor_item_id)`
   단위로 쌓고, 그룹은 그 위의 보기로만 쓴다(이력 병합 없음).
