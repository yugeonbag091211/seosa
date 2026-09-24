# ⑥ 가격 이상 패턴 — 설계 메모

계약: [CONTRACTS.md §3 ⑥ · §3-7](CONTRACTS.md). 구현: `api/_anomaly.js`(순수) · `api/_anomaly-api.js`(GET `/api/anomaly`) ·
`public/v2/anomaly.html` · 테스트 `scripts/test-v2-anomaly.js`.

## 무엇을 하는가

튀는 점 하나는 **진짜 가격 변동 · 옵션 변경 · 수집 오류** 중 하나다. 이 기능의 핵심은 탐지가 아니라 **셋을 섞지 않는 것**이다.

처리 순서 (앞 단계가 걸러낸 것은 뒤 단계가 보지 않는다):

1. **원본 관측** — `rawRows` 전부(옵션 무관)를 `recorded_at → id` 순으로 `history.observations` 에 싣는다.
2. **OPTION_CHANGE** — 원본에서 *알려진* 옵션 식별자끼리 바뀐 곳. `''` · `'__LEGACY__'` 는 «모름» 이라 건너뛴다.
   같은 두 옵션이 3일 안에 번갈아 오면 한 사건으로 묶는다(운영의 «블루 그레이 ↔ 펄 화이트» 사례).
   급등·급락은 이 옵션의 `rows` 로만 판정하므로 다른 옵션 값은 애초에 끼지 않는다. `rows` 에 알려진 옵션이 둘 이상
   섞여 오면(좁힐 근거가 없었던 경우) 가장 최근 옵션으로 좁힌다.
3. **COLLECTION_ERROR (a)(b)** — `isSanePrice` 실패(0원·음수·1억 초과·숫자 아님) / 같은 날 같은 옵션 두 값이 2배 이상 충돌
   (앞뒤 날짜 수준에 가까운 값을 남긴다 — 그날 최저가로 접으면 낮은 쪽 오류에 속는다).
4. **일별 최저가로 접기** — `history.js` · `_series.toDailyPoints` 와 같은 규칙.
5. **COLLECTION_ERROR (c)** — 하루 튐: 양쪽 이웃 모두에서 ≥40% (또는 robust z ≥5 이면서 ≥25%) 벗어났다가 다음 관측이
   직전 수준 ±5% 로 돌아옴. 짧은 이탈: 2~3일 연속 직전 수준의 5배(`SUSPECT_RATIO`) 밖 → 복귀.
6. **SPIKE / CRASH · FAKE_DISCOUNT · SAWTOOTH · REFERENCE_INFLATION** — 1~5를 걷어낸 계열에서.
7. **분포 · 요약 · 관측 표시 · digest.**

## 기준값

| 이름 | 값 | 이유 |
|---|---|---|
| `MIN_OBS` | 5일 | `_pricestat.FAIR_MIN_OBS` 와 같다. 미만이면 `INSUFFICIENT` |
| `SHIFT_WINDOW` · `SHIFT_MIN_BASE` | 7 · 3 | 평소 수준 = 직전 7개 관측 중앙값(≈ 일주일) |
| `SHIFT_PCT` · `SHIFT_Z` | ±15% · 3.5 | 둘 다 넘어야 급변. 3.5 = Iglewicz–Hoaglin modified z |
| 척도 | max(1.4826·MAD, 1.2533·평균절대편차, 1%·중앙값) | 값이 한 가격에 오래 머물면 MAD 가 0 이 되어 규칙적 등락이 «10 시그마» 가 된다 |
| `LEVEL_TOL` · `CONFIRM_OBS` | ±5% · 2회 | 같은 수준 2회 연속이면 확정 (`LOW_CONFIRM_DAYS` 와 같은 이유) |
| `SAME_DAY_CONFLICT_RATIO` | 2배 | `OPTION_SWITCH_RATIO` · `ANOMALY_JUMP` 와 같다 |
| `BLIP_MIN_DEV` / `BLIP_Z`+`BLIP_Z_MIN_DEV` | 40% / 5 + 25% | 하루 특가(−15~30%)를 수집 오류로 지우지 않기 위한 금액 문턱 |
| `EXCURSION_MAX_RUN` | 3일 | 15,900 → 242,100 · 222,390 → 15,900 모양 |
| `FAKE_*` | 기준 7관측 중앙값·기준 구간 최고 +5% 이내, +10% 이상 인상, 인상 1일 이상 유지(=2회 이상 관측), 21일 안에 기준 −3% 이상으로 5% 이상 «할인» | 기준 구간 안정 조건이 규칙적 등락을 뻥튀기로 부르지 않게 막는다 |
| `SAW_*` | 최근 30일, 8% 이상 꺾임(zigzag), 3주기 이상 | ±3% 잡음의 최대폭(≈6%) 바깥 |
| `REF_*` | 정가 대비 ≥30% «할인» 인데 현재가 ≥ 관측 중앙값, 또는 정가 > 관측 최고 × 1.3 | |
| `RECENT_DAYS` | 7일 | `_deal.FRESHNESS` 'fair' 와 같은 경계 |

### 심각도와 요약

| 사건 | severity |
|---|---|
| FAKE_DISCOUNT | alert |
| COLLECTION_ERROR · REFERENCE_INFLATION · 마지막 1회만 본 SPIKE/CRASH · 2배 이상 OPTION_CHANGE · 확정됐지만 2배 이상/절반 이하인 SPIKE/CRASH(`_deal.anomalies` 와 같은 «같은 상품인지 확인») | warn |
| 확정된 보통 SPIKE/CRASH · 하루만 보고 되돌아온 SPIKE/CRASH · SAWTOOTH · 2배 미만 OPTION_CHANGE | info |

`summary.status`: 유효 관측 < 5일 → `INSUFFICIENT` / alert 가 있거나 최근 7일 안에 확정 SPIKE·CRASH 또는 COLLECTION_ERROR →
`ANOMALOUS` / warn 이 있으면 `WATCH` / 아니면 `NORMAL`. 계약 밖으로 `summary.note`(한 문장)와 `summary.validDays` 를 더 싣는다.

### 같은 일을 두 번 말하지 않기

- FAKE_DISCOUNT 가 설명하는 인상~할인 구간의 SPIKE/CRASH 는 따로 내지 않는다.
- 며칠 특가가 끝나 원래 값으로 돌아온 SPIKE 는 «인상» 이 아니라 «직전 인하가 끝나고 돌아왔다» 고 적는다(`evidence.returnOf`).
- 한 인하가 사흘 이어지면 사건은 첫날 하나다(`evidence.runObs`).

## 분포 · digest

- `distribution` 은 수집 오류를 뺀 **일별 최저가** 위에서 계산한다. 분위수는 선형 보간(numpy 기본 · PERCENTILE.INC),
  `mad` 는 배율 없는 중앙값 절대편차, 히스토그램 칸 수는 Sturges(⌈log2 n⌉+1, 최대 12), 칸은 `[from, to]` 양끝 포함 정수 원.
- `count` 는 **일수**, `excluded` 는 수집 오류로 뺀 **원본 관측(행)** 수다 — 단위가 다르다.
- `digest = 'sha256:' + hex(sha256(UTF-8(JSON.stringify(observations.map(o => [o.at, o.price, o.vendorItemId])))))`.
  화면의 «이 브라우저에서 다시 계산하기» 버튼이 SubtleCrypto 로 같은 값을 계산해 대조한다.

## 한계

- 하루 한 번 수집이라 하루 안의 움직임은 모른다. 하루만 보인 −15~25% 는 «짧은 특가» 와 «잘못 들어온 값» 을 가를 근거가
  없어서 미확정 CRASH(info) 로 남긴다 — 지우지도 단정하지도 않는다.
- 옵션 식별자가 없는 옛 기록(''·`__LEGACY__`)에서는 옵션 변경을 «사실» 로 말할 수 없다. 그 경우 크기(5배 이탈 후 복귀)로만
  수집 오류를 추정한다.
- 정가(`products.oprice`)는 쿠팡 검색 API 에서 판매가와 같은 값이라(_price.js 주석) 쿠팡 상품에서는 REFERENCE_INFLATION 이 거의
  나오지 않는다. 별도 정가를 주는 몰에서만 의미가 있다.
- 180일 창 · 행 3,000개 상한(`_series.MAX_ROWS`). 잘리면 응답의 `truncated` 가 true 다.
- 기록이 14일 넘게 끊긴 뒤의 급변은 «그 사이 언제 바뀌었는지 모른다» 고 적을 뿐 날짜를 추정하지 않는다.
