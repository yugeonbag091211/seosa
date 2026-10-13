# Product Identity — Phase 2 Shadow Matching (2026-10-13)

```
products ──READ──▶ api/_offeridentity (Phase 1, 그대로) ──▶ identity_shadow_* 표
```

**사용자에게 보이는 변화는 0 이다.** 검색·AI·상품 상세·최저가·가격 그래프·핫딜·수집기·홈·모바일 앱 중
어느 것도 shadow 표를 읽지 않는다. Phase 2 는 판정이 운영 데이터에서 어떻게 나오는지 «지켜보는» 단계다.

## 1. Schema

`supabase/2026-10-13-identity-shadow.sql` — **additive only** (CREATE TABLE / CREATE INDEX / COMMENT / RLS).
운영 표를 만들지도 바꾸지도 않는다. 마이그레이션 본문에 `products` · `price_history` 라는 식별자가
**실행되는 구문으로는 한 번도 등장하지 않는다** (테스트가 고정한다).

| 표 | 내용 |
|---|---|
| `identity_shadow_runs` | 한 번의 계산 실행. 상태·통계·matcher 버전·스냅숏 시각 |
| `identity_shadow_groups` | canonical group 후보. `member_count >= 2` 만 |
| `identity_shadow_group_members` | 어떤 products 행이 어느 그룹에 |
| `identity_shadow_reviews` | REVIEW 로 남은 쌍 (Phase 4 큐의 재료) |
| `identity_shadow_job_state` | 동시 실행 방지 singleton (`hotdeal_job_state` 와 같은 꼴) |

DB 가 직접 지키는 불변식:

- `identity_shadow_group_members (run_id, product_id, mall, vendor_item_id)` **unique** → Invariant A
- `identity_shadow_runs (status) where status='running'` **unique** → 동시 run 금지
- `identity_shadow_groups (run_id, group_key)` unique → 재시도가 행을 두 배로 만들지 않는다
- `identity_shadow_reviews (run_id, left_offer_key, right_offer_key)` unique + `left < right` check
- `member_count >= 2` check → 1인 그룹 저장 불가

`products` 로 **FK 를 걸지 않는다**. `external_hotdeals` 와 같은 판단이다 — 카탈로그 도구가 products 행을
재등록·회수하는데 shadow 스냅숏이 그 작업을 막으면 안 된다. run_id FK 는 shadow 끼리라 cascade 로 건다.

전 표 RLS on, 정책 없음, `anon`/`authenticated` revoke (SEOSA 관례: service_role 만 접근).

## 2. Worker

`scripts/run-offer-identity-shadow.js`

1. opt-in 관문 (`IDENTITY_SHADOW_ENABLED`) → 없으면 exit 0
2. CAS 잠금 (`identity_shadow_job_state`) → 남이 쥐고 있으면 skip
3. 죽은 `running` run 회수 (TTL 경과분을 `failed` 로) — 부분 유일 인덱스가 영구히 막히지 않게
4. `products` SELECT (키셋 페이지네이션, `--limit` / `--mall` 적용)
5. run 행 생성 (`running`)
6. **Phase 1 그대로**: `parseOffer` → `clusterOffers` → `blockKeys` + `matchOffers` 쌍 전수 조사 → `verifyGroups`
7. 저장 **전** 불변식 검증 — 하나라도 깨지면 아무것도 쓰지 않고 `failed`
8. batch INSERT: groups → members → reviews
9. 전부 저장한 뒤에만 `completed`
10. 잠금 반납 (자기 토큰일 때만)

**Phase 1 로직을 다시 구현하지 않았다.** 식별·판정·군집은 전부 `api/_offeridentity.js` 호출이다.
Phase 1 에 더한 변경은 `contextFactory` 를 export 에 추가한 **한 줄**뿐이다(로직 변경 0). 이것이 없으면
`matchOffers(a, b)` 를 문맥 없이 부르게 되어 군집이 내린 판정과 다른 답이 나온다.

`api/_identityshadow.js` 는 DB 를 모르는 순수 부분(지문·행 생성·불변식·통계)이라 운영 DB 없이 테스트된다.

## 3. Safety model

| 장치 | 내용 |
|---|---|
| opt-in | `IDENTITY_SHADOW_ENABLED` 가 `true`/`1` 이 아니면 **dry-run 포함** 아무것도 하지 않고 exit 0 |
| dry-run | `--dry-run` 은 SELECT 만. 잠금도 run 행도 만들지 않는다 (잠금 획득 자체가 쓰기이므로) |
| 잠금 | CAS + DB 부분 유일 인덱스 (두 겹). GitHub Actions `concurrency` 로 세 겹 |
| 검증 | 불변식 위반 → 저장 0, run `failed` |
| 상태 | `completed` 는 전부 저장한 뒤에만. 중간 실패는 `partial`(일부 저장) / `failed`(저장 전) |
| 운영 표 | `products` SELECT 만. `price_history` 는 읽지도 않는다 |
| 소비자 | shadow 표 이름이 Phase 2 파일 밖에 등장하면 테스트 실패 |

## 4. Dry-run (운영 데이터, read-only)

```
IDENTITY_SHADOW_ENABLED=true node scripts/run-offer-identity-shadow.js --dry-run
```

| 항목 | 값 |
|---|---|
| source products | 71,207 (쿠팡 23,613 · ADPICK 47,594) |
| parse 실패 | 0 |
| 후보 쌍 판정 | MATCH 536 · REVIEW 3,771 · NO_MATCH 78,223 (비교 82,530) |
| 그룹 (저장 대상, ≥2인) | 403 |
| 판매처 교차 / 동일 판매처 | 291 / 112 |
| 최대 그룹 / 평균 | 4 / 2.156 |
| all-pairs 위반 | **0** |
| 소요 | 57초 (읽기 포함) |
| DB 쓰기 | **0** |

**Phase 1 평가와 같은가** — 같은 스냅숏으로 `npm run eval:offer-identity-real` 을 돌려 대조했다:

| | Phase 1 eval | Phase 2 dry-run |
|---|---|---|
| groups | 70,741 | 70,741 |
| multi-offer groups | 403 | 403 |
| cross-merchant | 291 | 291 |
| all-pairs 위반 | 0 | 0 |

정확히 일치한다. (Phase 1 보고서의 288 은 2026-10-13 이전 스냅숏 숫자다 — 그 사이 수집기가 카탈로그를
갱신했다. 같은 스냅숏에서는 두 경로가 같은 답을 낸다.)

숫자 두 개는 Phase 1 과 «다르게 세는» 값이라 적어 둔다:

- `comparison_count` 82,530 vs `clusterStats.comparisons` 80,180 — 전자는 블록 안 모든 후보 쌍을 센 전수
  조사이고, 후자는 군집이 실제로 필요로 한 비교만 센 것이다.
- `match_pair_count` 536 vs 그룹 내부 쌍 535 — MATCH 인데 그룹이 되지 못한 쌍이 하나 있다. all-pairs
  제약이 일하고 있다는 뜻이다(A~B 는 MATCH 지만 A 가 B 그룹의 다른 구성원과 MATCH 가 아니면 못 들어간다).

## 5. 실제 shadow write 검증 — **미완 (NOT VERIFIED)**

운영 Supabase 에 마이그레이션이 아직 적용되지 않았다. 저장소 관례대로 운영자가 SQL Editor 에서 직접
적용하기로 했고, 나는 운영 DB 스키마를 바꾸지 않았다. 따라서 **실제 DB 에 shadow 행을 쓴 적이 없다.**

지금까지의 쓰기 경로 근거는 두 가지다:

- 가짜 Supabase 로 돌린 119개 테스트 (run 생성 → groups → members → reviews → completed, 실패 경로,
  유일 인덱스, 잠금 CAS 포함)
- 운영 데이터 71,207건 dry-run (쓰기 0)

적용 뒤 아래 두 명령으로 소규모 검증을 끝내면 된다 (§9 참고).

## 6. Performance

| | |
|---|---|
| products 읽기 | 71,207행 / 72 페이지 (키셋) |
| parseOffer | ~8s (Phase 1 토큰 캐시 포함) |
| clusterOffers | ~1.1s |
| 쌍 전수 조사 | ~45s (82,530 쌍) |
| 저장 (예상) | groups 403 + members 869 + reviews 3,771 ≈ 5,043행 / batch 500 → 11회 요청 |
| 총 | 57초 (dry-run 기준) |

batch 크기 500 은 member 행이 `identity_snapshot`(jsonb)을 들고 있어 가장 무겁다는 점을 기준으로 잡았다.
`--batch-size` 로 조절하고, 테스트가 `batchSize=1` 에서도 결과가 같음을 고정한다.

## 7. DB impact

- 쓰는 표: `identity_shadow_*` 다섯 개뿐 (테스트가 단언)
- `products` — SELECT 만. 행 수·값 변화 0
- `price_history` — **접근 자체가 없다**
- 예상 행 수 (전체 run 1회): runs 1 · groups 403 · members 869 · reviews 3,771

## 8. Known limitations

- 쌍 전수 조사는 블록이 `censusMaxBlock`(기본 400)보다 크면 건너뛴다. 이번 운영 데이터에서는
  `censusSkippedBlocks: 0` 이라 전수였지만, 카탈로그가 커지면 건너뛴 수가 `metadata` 에 드러난다.
- `identity_shadow_reviews` 는 블록 안 후보 쌍의 REVIEW 만 담는다. 블록이 다른 두 상품은 애초에 비교
  대상이 아니다(Phase 1 blocking 과 같은 전제, 누락률은 Phase 1 보고서에서 0으로 측정).
- 그룹의 `confidence_tier` 는 구성원 쌍 중 가장 약한 등급이다. 그룹 전체를 A 라고 말하지 않는다.
- 상품명을 shadow 표에 복사하지 않는다. 사람이 검수할 때는 `(product_id, mall)` 로 products 를 본다
  (제휴사 응답 본문을 한 벌 더 쌓지 않기 위해서다).
- 보존 자동 삭제는 구현하지 않았다. 정책만 문서화했다(최근 30 run 유지, 수동).

## 9. Activation

코드 merge 와 운영 활성화는 분리돼 있다. merge 만으로는 아무 일도 일어나지 않는다.

1. **마이그레이션** — Supabase SQL Editor 에 `supabase/2026-10-13-identity-shadow.sql` 전체를 붙여넣고 Run.
2. **소규모 검증** (여기까지는 플래그 없이 로컬에서)

   ```bash
   IDENTITY_SHADOW_ENABLED=true node scripts/run-offer-identity-shadow.js --dry-run --limit 100
   IDENTITY_SHADOW_ENABLED=true node scripts/run-offer-identity-shadow.js --limit 100 --sample 5
   ```

   확인: `identity_shadow_runs` 에 `completed` 1행, groups/members 가 생겼고,
   `select count(*) from products` / `price_history` 가 그대로인지.
3. **상시화** — GitHub 저장소 변수 `IDENTITY_SHADOW_ENABLED=true`.
   워크플로 `SEOSA Product Identity Shadow` 가 하루 1회(04:10 KST, 수집 이후) 돈다.
   수동 실행은 Actions → Run workflow (기본값이 dry-run 이다).

## 10. Rollback

1. 저장소 변수 `IDENTITY_SHADOW_ENABLED` 를 `false` 로 (또는 삭제) → **즉시 중단**. 다음 실행은 exit 0.
2. 운영 서비스는 영향을 받지 않는다 — shadow 표를 읽는 코드가 없다. 표가 남아 있어도 무해하다.
3. 표까지 지우려면 마이그레이션 맨 아래 `drop table` 5줄. 운영 표를 건드리지 않았으므로 그것으로 끝이다.

## 11. Next (이 PR 에서 하지 않은 것)

Phase 3 이후는 **별도 PR** 이다. 이 PR 은 다음을 하지 않았다:

- 검색 결과·상품 상세·최저가·AI 검색에서 shadow group 사용
- UI 가격비교 표시
- `canonical_product` 운영 표 승격
- REVIEW 승인/거절 UI (Phase 4)
- shadow 결과 자동 삭제 cron
