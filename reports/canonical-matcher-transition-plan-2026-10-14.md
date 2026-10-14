# Canonical Matcher Transition — 계획서 (2026-10-14)

> **한 줄 요약** — PR #141 의 matcher 를 배포하면 운영 ACTIVE 그룹 1개(id 1, HyperX OMEN MAX 16 `16-AH1075TX`,
> 롯데홈쇼핑·Hmall)의 canonical key 가 `d8ef9634…` → `c926abe1…` 로 바뀌어 Phase 5 소비에서 사라진다.
> 이 PR 은 **STAGE → 배포 → FINALIZE** 3단계 전환과 **dual-read 소비자**로 그 공백을 없앤다.
> 운영 DB 에는 SELECT 만 했다. 마이그레이션은 적용하지 않았고 STAGE 도 하지 않았다.

PR #141 위에 쌓은 변경이다. #141 의 matcher 는 한 줄도 바꾸지 않았다(`CHIP_CODE_RE`·`effectiveTier` export 만 추가).
운영 카탈로그 71,278행 비교에서 #141 대비 판정 전이 **0건**(MATCH 589/589, 교차 그룹 332/332, 잃은 그룹 0)이다.

## 1. 문제

Phase 5 소비자(`api/_canonicalconsumer.js`)는 fail-closed 다. ACTIVE 그룹을 보여 주려면 다음이 모두 맞아야 한다.

- 구성원마다 «지금 파서로 읽은 스냅숏» 이 저장된 `identity_snapshot` 과 같다.
- 지금 파서로 계산한 키가 `canonical_key` 와 같다.

#141 은 같은 제목을 다르게 읽는다. 값은 그대로이고 표현만 바뀐다.

- 칩 코드 `u7270hxplus`·`rtx5070ti` 가 모델번호에서 빠져 CPU·GPU 부품으로 옮겨 간다.
- `32G` 가 규격 `g` 에서 메모리로 옮겨 간다.

그래서 배포 순간 스냅숏과 키가 둘 다 어긋나고 그룹이 화면에서 사라진다.

## 2. 설계 — 자리를 둘로 두고, 한 번에 하나씩 옮긴다

| 자리 | 누가 읽나 | 언제 쓰나 |
|---|---|---|
| 기존 자리 `canonical_key` · `identity` · `identity_snapshot` | 지금 운영 코드와 새 코드 | FINALIZE · REVERT |
| `next_*` 자리 `next_canonical_key` · `next_identity` · `next_identity_snapshot` … | 새 코드만 | STAGE |
| `previous_*` 자리 | 아무도 (REVERT 용) | FINALIZE |
| `rollout_key` | 새 코드의 rollout · 허용 목록 판정 | FINALIZE 때 처음 키로 고정 |

**새 소비자의 `identityVersion`:**

- 구성원 전부가 기존 자리와 맞으면 기존 자리로 검증한다.
- 그렇지 않고 구성원 전부가 `next_*` 와 맞으면 `next_*` 로 검증한다.
- 둘 다 아니면, 그리고 구성원이 두 자리에 나뉘어 맞으면 **fail-closed** 다.

어느 자리로 검증하든 나머지 관문은 그대로 돈다. 키 재계산, 모든 쌍의 hard conflict, 신선도·표시 가능 가격·신뢰, 옵션 일치, 판매처 2곳 이상이 그것이다.

**rollout:** `rollout_key`(없으면 `canonical_key`)로 판정한다. 키가 바뀌어도 rollout percent 버킷과 허용 목록 노출이 넓어지거나 끊기지 않는다.

### 전환 관문 (`api/_canonicaltransition.js`, 하나라도 아니면 HOLD → 배포 뒤 fail-closed)

| 관문 | 내용 |
|---|---|
| G1 구조 | ACTIVE · 구성원 2개 이상 · `offer_key = source_mall|product_id` · 중복 없음 |
| G2 상품 행 | 구성원 상품이 있고, 옵션(`vendor_item_id`)이 그대로다 |
| G3 이전 matcher 재현 | **운영 코드(legacy root)** 로 지금 제목을 다시 읽으면 저장 스냅숏과 키가 그대로 나온다. 이미 stale 한 그룹을 새 식별로 되살리지 않기 위한 관문이다 |
| G4 재검증 | 새 matcher 로 **모든 쌍이 MATCH** 다. 구성원 문맥과 **카탈로그 전체 문맥**에서 둘 다 확인한다. 후자가 #141 색 정책을 지킨다. STAGE 는 카탈로그 문맥이 필수다 |
| G5 등급 · 강한 식별자 | 등급이 같고, Tier A 강한 식별자의 **값**(`16ah1075tx`)이 같다 |
| G6 키 | 다음 키가 다른 그룹의 `canonical_key`·`next_canonical_key` 와 겹치지 않는다 |
| G7 판매처 | 표시 판매처 2곳 이상 |
| G8 식별 변화 | 표현 변화만 허용한다. 허용되는 것은 칩 코드가 부품으로 빠지기, `g`·`t` 가 메모리·저장으로 옮기기, 브랜드가 없다가 생기기, 계열 낱말이 빠지기다. 새 모델번호, 칩이 아닌 코드의 소실, 브랜드 교체, 새 계열 낱말, 규격·색·거래 유형 변화 같은 **값 변화는 HOLD** 다 |
| G9 자체 검사 | 만든 값을 새 소비자의 `identityVersion` 이 정말 `next` 로 받는지 확인한다 |

전환은 **구성원 집합을 바꾸지 않는다**. 판매처를 더하는 것은 별도의 승격 결정이다.

### DB (`supabase/2026-10-14-identity-matcher-transition.sql`, additive 전용)

**추가하는 것:**

- 컬럼: `next_*`, `previous_*`, `rollout_key`, `transitioned_at`, 구성원의 `next_identity_snapshot` · `previous_identity_snapshot`
- 제약: `next_*` 는 전부 있거나 전부 없다(check). `next_canonical_key` 는 유일하다(부분 인덱스)
- 감사 표 `canonical_identity_transitions`: RLS, 클라이언트 권한 회수, 수정·삭제 금지 트리거

**지키는 것:**

- DROP · TRUNCATE · `products`/`price_history` 쓰기가 없다.
- 재실행해도 안전하다.

**RPC 4개** — 모두 `service_role` 전용 · `search_path=''` · compare-and-set 이고, 감사 행을 남긴다.

| RPC | 조건 | 바꾸는 것 |
|---|---|---|
| `canonical_identity_transition_stage` | 그룹 `for update` · ACTIVE · 기대 키 일치. 구성원 수·키·옵션·저장 스냅숏이 계획과 같다. 상품 제목이 `for share` 로 계획과 같다. 다음 키가 겹치지 않는다 | `next_*` 와 `updated_at` **만** |
| `…_finalize` | ACTIVE · `next_canonical_key`·`next_plan_hash` 가 기대값과 같다. 모든 구성원에 `next_identity_snapshot` 이 있다 | `rollout_key` 고정. 기존 → `previous_*`, `next_*` → 기존, `next_*` 비움 |
| `…_abort` | `next_canonical_key` 가 기대값과 같다 | `next_*` 비움 |
| `…_revert` | 기존 키가 기대값과 같다. `previous_*` 가 있고 `next_*` 는 비어 있다 | `previous_*` → 기존, 지금 값 → `next_*` (옛·새 코드가 모두 읽는다) |

정적 검사가 SQL 의 대입 목록을 고정한다(`scripts/test-canonical-transition.js` F절, `scripts/verify-migrations.js`).

## 3. 운영 dry-run (SELECT 만, 2026-10-14)

```
node scripts/run-canonical-transition.js --legacy-root <운영 main 1362ed4 의 LF export>
```

| 항목 | 값 |
|---|---|
| ACTIVE 그룹 | 1 |
| 판정 | TRANSITION (`legacyVerified: true`, 카탈로그 문맥 재검증 통과) |
| 키 | `d8ef963465eef90d…` → `c926abe10082aebc…` |
| rollout 키 | `d8ef963465eef90d…` (그대로) |
| 식별 변화 | 표현만: `modelNumbers`, `specs`, `memory`, `cpu`, `gpu` · 값 변화 0 |
| 계획 해시 | `f18edb9b15e741d1a49187d3e51335f841c7a742e8d58369add0ea8906973ebc` (두 번 돌려 같음) |
| 쓰기 | 0 |
| `--check-ready` | exit 1 (STAGE 전이므로 정상) |

### 실제 행으로 단계 재생 (메모리 사본에서만 상태를 바꿨다)

운영에서 읽은 그룹·구성원·상품 행에 STAGE·FINALIZE·REVERT·ABORT 를 적용했다. 적용은 SQL 과 같은 의미의 JS 모델(`scripts/fixtures/canonical-transition-model.js`)로 했다. 각 단계마다 **지금 운영 코드(main 1362ed4)**와 **새 코드**로 소비해 봤다.

| 단계 | 운영 코드 | 새 코드 |
|---|---|---|
| 지금 (STAGE 전) | 보임 · `d8ef…` · 2곳 · 최저 5,884,990 | **사라짐** (stale 1) ← 고치려는 문제 |
| STAGE 뒤 | 보임 · `d8ef…` | 보임 · next · `c926…` · 최저 5,884,990 |
| FINALIZE 뒤 | 사라짐 | 보임 · primary · `c926…` |
| REVERT 뒤 | 보임 · `d8ef…` | 보임 · next · `c926…` |
| ABORT 뒤 | 보임 · `d8ef…` | 사라짐 |

여기서 순서 규칙 두 가지가 나온다.

- **STAGE 와 배포 사이에서는 어느 코드도 그룹을 잃지 않는다.** 배포와 코드 되돌리기는 이 구간에서만 한다.
- **FINALIZE 뒤에 코드를 되돌리려면 REVERT 를 먼저 한다.**

## 4. 운영 절차 (운영자가 직접 — 이 PR 은 아무것도 적용하지 않았다)

> ⚠️ **#141 을 이 PR 없이 main 에 병합하면 안 된다.** main 병합은 곧 Production 배포이고, dual-read 가 없으면 그룹이 사라진다.
> 병합 순서는 다음과 같다.
>
> 1. 이 PR 을 #141 브랜치에 먼저 병합한다.
> 2. #141 을 #140 위에 병합한다.
> 3. #140 을 main 에 병합한다.
>
> 한 번에 squash 해도 된다. 어느 쪽이든 아래 1~5 를 **main 병합 전에** 끝낸다.

1. **마이그레이션 적용:** Supabase SQL Editor 에서 `supabase/2026-10-14-identity-matcher-transition.sql` 을 실행한다. 이어서 `node scripts/verify-migrations.js` 를 돌려 «identity transition 자리» 가 OK 인지 확인한다.
   - 지금 운영 코드는 새 컬럼을 읽지 않으므로 이 단계만으로는 아무것도 바뀌지 않는다.
2. **legacy root 준비:** 지금 운영에 배포된 커밋을 LF 로 export 한다.
   - `git -c core.autocrlf=false archive <운영 SHA> | tar -x -C <저장소 밖 폴더>`
3. **dry-run:** **병합될 트리와 같은 PR head**(main 최신 위로 올린 상태)에서 실행한다.
   - `node scripts/run-canonical-transition.js --legacy-root <폴더> --plan-out <저장소 밖>/plan.json`
   - 기대 결과는 group 1 TRANSITION 이다. 계획 해시는 위와 같아야 하며, 제목이 바뀌었으면 다를 수 있다.
4. **STAGE:**
   - `IDENTITY_TRANSITION_ENABLED=true node scripts/run-canonical-transition.js --stage --write --operator <이름> --legacy-root <폴더>`
   - rpc 결과가 `STAGED` 여야 한다.
   - `STALE_PRODUCT_CHANGED`·`CONFLICT_*` 가 나오면 dry-run 부터 다시 한다.
5. **배포 직전 확인:**
   - `node scripts/run-canonical-transition.js --check-ready --legacy-root <폴더>` 가 **exit 0** 이어야 한다(`ALREADY_STAGED 1`, `readyToDeploy: true`).
   - 아니면 병합하지 않는다.
   - 배포 뒤 사라져도 된다고 운영자가 확인한 HOLD 그룹만 `--accept-fail-closed <id,…>` 로 면제한다. 이유 코드로 자동 면제하지 않는다. legacy root 를 잘못 주면 모든 그룹이 «이미 stale» 로 보이기 때문이다.
6. **병합 · 배포:** 배포 확인은 gh commit status 로 한다. 그 뒤 운영에서 해당 그룹이 계속 묶여 보이는지 확인한다.
7. **안정화:** 예를 들어 24시간 동안 지켜본다. 이 구간에서는 코드만 되돌려도 안전하다. 기존 자리는 손대지 않았기 때문이다.
8. **FINALIZE:**
   - `IDENTITY_TRANSITION_ENABLED=true node scripts/run-canonical-transition.js --finalize --write --operator <이름>`
   - 대상은 next 자리가 지금 matcher 와 맞는(ALREADY_STAGED) 그룹뿐이고, 계획 해시로 compare-and-set 한다.

### 되돌리기

| 시점 | 방법 | 결과 |
|---|---|---|
| STAGE 뒤 · 배포 전 | `--abort --group 1 --write --operator <이름>` 을 쓰거나, 그냥 둔다 | 운영 코드는 영향 없음 |
| 배포 뒤 · FINALIZE 전 | 코드 배포만 되돌린다 | 운영 코드가 기존 자리로 그대로 보여 준다 |
| FINALIZE 뒤 | **먼저** `--revert --group 1 --write --operator <이름>` 을 한 뒤 코드를 되돌린다 | REVERT 뒤에는 옛·새 코드가 모두 보여 준다 |

### 남는 위험과 처리

- **STAGE 와 FINALIZE 사이에 판매자가 제목을 바꾼 경우:** 새 코드는 그 그룹을 fail-closed 한다. 운영 코드도 스냅숏이 달라지면 같은 이유로 fail-closed 한다. `--check-ready` 에서는 `HOLD_STAGED_SNAPSHOT_STALE` 로 보인다. ABORT 한 뒤 다시 계획한다.
- **STAGE 뒤 리뷰 큐가 구성원을 더한 경우:** 새 구성원에는 `next_identity_snapshot` 이 없다. 그래서 새 코드는 fail-closed 하고 FINALIZE 는 `CONFLICT_MEMBER_SET_CHANGED` 로 거절된다. ABORT 한 뒤 다시 계획한다.
- **승격 워커:** 스케줄이 없다. 전환 구간에 수동으로 돌려도 키가 달라 `HOLD_CANONICAL_KEY_DRIFT` 가 되고 쓰지 않는다.
- **FINALIZE 의 제목 재검사:** FINALIZE 는 SQL 에서 제목을 다시 파싱하지 못한다. 대신 워커가 바로 앞에서 다시 계획한다(ALREADY_STAGED 확인). 그 사이에 바뀐 그룹도 소비자가 스냅숏 불일치로 fail-closed 한다.
- **`next_matcher_version`:** STAGE 를 실행한 checkout 의 HEAD 다. 기록용이고 판정에는 쓰지 않는다. 스냅숏은 matcher 코드 «내용» 으로만 정해진다.

## 5. 검증

| 항목 | 결과 |
|---|---|
| `scripts/test-canonical-transition.js` | 99 PASS. 운영 그룹 fixture · 관문별 HOLD · 식별 변화 · 단계별 소비 연속성 · 워커 쓰기 관문 · SQL 정적 검사를 다룬다 |
| `scripts/test-canonical-transition-mutations.js` | 관문 16개를 지운 사본이 전부 실패한다. 사본은 OS 임시 폴더에 만든다 |
| `scripts/test-canonical-consumer.js` · mutations | 통과. dual-read 와 rollout 고정을 포함해 보호 13개가 전부 kill 된다 |
| #141 회귀 | 운영 71,278행에서 #141 대비 판정 전이 0, 그룹 변화 0. `test-offer-matcher-evidence` 97 PASS (57 new MATCH · hard negative · 색 안전 그대로) |
| 운영 dry-run | 위 3절. 쓰기 0 |
| 마이그레이션 정적 검사 | `verify-migrations` 0 FAIL. 운영 live probe 결과는 «전환 자리 없음» 경고 1건이다(미적용이므로 정상) |
