# SEOSA 2.0 — 공통 API · DB 계약

> 이 문서가 여섯 기능의 **단일 기준**이다. 기능 브랜치는 이 계약을 구현할 뿐 바꾸지 않는다.
> 계약을 바꿔야 하면 이 파일부터 고치고, 그 변경을 기초(foundation) 브랜치에 먼저 싣는다.

진행 기록과 다음 실행 지점은 [PROGRESS.md](PROGRESS.md) 에 있다.

---

## 0. 지키는 선 (운영 보호)

| 규칙 | 어떻게 지키는가 |
|---|---|
| 새 서버리스 함수 없음 (Vercel Hobby 12/12) | 모든 새 API 는 기존 함수의 `__route` 분기로 얹는다. `api/_*.js` 는 함수로 세지 않는다 |
| 기존 UI 무수정 | 새 화면은 전부 `public/v2/` 아래 별도 페이지. `public/index.html` · `radar.*` 는 건드리지 않는다 |
| 가격 수집 · 핫딜 판정 무변경 | `collect-*.js`, `_hotdeal.js`, `_todaydrop.js`, `_dailydrop.js`, `price_drop_top` 을 수정하지 않는다. 새 기능은 이미 쌓인 `price_history`·`products` 를 **읽기만** 한다 |
| 쿠팡 · ADPICK 한도 | 새 기능은 기본값으로 외부 쇼핑 API 를 **한 번도** 부르지 않는다. 조사관의 실시간 검색은 `INVESTIGATOR_LIVE_SEARCH=1` 일 때만, 그것도 기존 `_shop.searchAll` 경로(캐시·분당 상한·서킷)를 그대로 탄다 |
| 유료 API 금지 | 새 LLM 호출 없음. 조사관·타이밍 문장은 결정론으로 만든다 |
| 운영 DB 변경은 승인 후 | 새 표는 ② 대기실 두 개뿐이고 `supabase/2026-09-24-seosa2-waitroom.sql` 로만 만든다. **적용하지 않았다.** 미적용 상태에서 API 는 503 `WAITROOM_NOT_READY` 로 닫힌다 |
| 운영 데이터 삭제 금지 | 새 코드가 지우는 것은 사용자가 스스로 지운 대기실 항목(자기 행)뿐이다 |
| 새 예약 작업은 꺼진 채로 | 대기실 알림 워크플로는 저장소 변수 `WAITROOM_ENABLED=1` 이 없으면 아무것도 하지 않는다 |

---

## 1. 라우팅 — 새 함수 없이 얹는 자리

`api/_v2router.js` 한 곳에 표로 적는다. 호스트 함수는 핸들러 **첫 줄**에서 `__route` 만 보고 넘긴다 —
기존 경로는 한 글자도 거치지 않는다.

| 공개 URL (vercel.json rewrite) | 호스트 | `__route` | 모듈 | 메서드 | CORS | 인증 |
|---|---|---|---|---|---|---|
| `/api/timing` | `api/history.js` | `timing` | `api/_timing-api.js` | GET | public | 없음 |
| `/api/anomaly` | `api/history.js` | `anomaly` | `api/_anomaly-api.js` | GET | public | 없음 |
| `/api/cart` | `api/history.js` | `cart` | `api/_cart-api.js` | POST | public | 없음 |
| `/api/lookup` | `api/history.js` | `lookup` | `api/_lookup-api.js` | GET | public | 없음 |
| `/api/waitroom` | `api/alerts.js` | `waitroom` | `api/_waitroom-api.js` | GET·POST·DELETE | private | Bearer 토큰 (이메일은 토큰에서만) |
| `/api/investigate` | `api/ai.js` | `investigate` | `api/_investigator-api.js` | POST | private | 선택 (게스트 허용, IP 한도) |

모듈이 아직 없으면 라우터가 **501 `{error, feature, code:'NOT_READY'}`** 를 돌려준다. 기능 PR 이 모듈 파일만 추가하면
라우팅이 저절로 이어진다 — 공유 파일(history.js · alerts.js · ai.js · vercel.json · package.json)을 기능 PR 이 고치지 않는다.

### 공통 응답 규칙

- 성공: `200 { ok: true, ... }`
- 입력 오류: `400 { ok:false, error:'사람이 읽는 문장', code:'BAD_INPUT' }`
- 없음: `404 { ok:false, error, code:'NOT_FOUND' }`
- 한도: `429` (기존 `_ratelimit.guard` 그대로)
- 준비 안 됨: `501 NOT_READY` (모듈 없음) · `503 WAITROOM_NOT_READY` (마이그레이션 전)
- 서버 오류: `_http.fail` — 스택은 Sentry, 사용자에게는 문장만
- **모르는 값은 `null`**. 0 으로 채우지 않는다. 판단할 수 없으면 `INSUFFICIENT` 를 낸다.
- 모든 금액은 원 단위 정수.
- 날짜는 KST `YYYY-MM-DD` (`_kst.kstToday`), 시각은 ISO-8601 UTC.

---

## 2. 공통 데이터 계층

### 2-1. 상품 식별자

기존 그대로다. **`(product_id, mall, vendor_item_id)`** 가 가격 계열 하나다.

- `mall` 값은 `'쿠팡'` 또는 `'ADPICK'` (`_price.isRefreshableMall`). 실제 판매처 이름은 `mall_label`.
- 옵션 가르기는 반드시 `_price.sameVendorRows` 로 한다 (옛 기록 폴백 규칙 포함).
- `vendorItemId` 가 요청에 없으면 `products.vendor_item_id` → `link` 의 `vendorItemId=` 순으로 채운다 (`_price.vendorIdOf`).
- 상품명으로 가격을 모으지 않는다 (history.js 주석과 같은 이유).

### 2-2. `api/_series.js` — 가격 계열 로더 (① ④ ⑥ 공용)

```
loadSeries({ productId, mall?, vendorItemId? }, { days = 365 }) → {
  product:      products 행 | null,
  vendorItemId: 실제로 좁힌 옵션 ('' = 좁힐 근거 없음),
  rawRows:      [{ id, product_id, mall, vendor_item_id, price, recorded_date, recorded_at }]  // 옵션 무관, 시간 오름차순
  rows:         sameVendorRows(rawRows, vendorItemId)                                          // 이 옵션의 관측
  points:       [{ date, price }]   // rows 를 KST 날짜당 최저가 한 점으로 접은 것 (history.js 와 같은 규칙)
  truncated:    boolean             // MAX_ROWS 에 걸렸는가
}
```

- 읽기 전용. `price_history` 1회 + `products` 1회.
- 실패하면 throw 한다 (핸들러가 `fail` 로 처리). 빈 기록은 throw 가 아니라 빈 배열이다.
- `points` 는 `/api/history?productId=` 가 그리는 곡선과 **같은 값**이어야 한다 (테스트로 고정).

기존 재사용: `_pricestat.statsFrom` · `fairness` · `loadStats`, `_deal.dealOf`, `_radar.decisionOf`,
`_identity.judgeSameProduct`, `_hotgroup.canMerge`, `_price.productLifecycle`.

---

## 3. 기능별 계약

### ① AI 구매 타이밍 — `GET /api/timing`

쿼리: `productId`(필수) · `mall` · `vendorItemId` · `horizon`(7|14|30, 기본 14)

```
{
  ok, asOf, product: { productId, mall, vendorItemId, title|null },
  observations, firstDate, lastDate, staleDays,
  level:    _pricestat.fairness() 결과 (현재가의 상대 위치 — 90일 분포 백분위),
  deal:     { verdict, label } | null,              // _deal.dealOf — 모순 방지 기준
  forecast: {
    method: 'empirical-analog' | 'volatility-band' | 'insufficient',
    horizonDays, currentPrice,
    dropProbability: { pct3, pct5, pct10 } | null,   // horizon 안에 현재가 대비 x% 이상 내려갈 확률 (0~1)
    expectedMin:     { p10, p50, p90 } | null,       // horizon 안 최저가의 분위 (원)
    samples
  },
  recommendation: { action: 'BUY_NOW'|'WAIT'|'NEUTRAL'|'INSUFFICIENT', label, reasons[], cautions[] },
  backtest: {                                        // 이 상품의 실제 과거 기록으로 한 walk-forward 검증
    samples, brier, brierBaseline, skill, bandCoverage,
    decisionHitRate, avgSavingPct, verdict: 'reliable'|'weak'|'insufficient'
  },
  uncertainty: { level: 'low'|'medium'|'high'|'unknown', notes[] },
  points: [{ date, price }]
}
```

불변식: `deal.verdict ∈ {WAIT, DONT_BUY}` 이면 `BUY_NOW` 를 내지 않는다. 관측이 모자라면 확률을 만들지 않고 `INSUFFICIENT`.

### ② AI 자동 구매 대기실 — `/api/waitroom` (Bearer 토큰 필수)

| 메서드 | 본문 | 응답 |
|---|---|---|
| GET | — | `{ ok, items:[Item], limits:{ max } }` |
| POST | `{ action:'save', productId, mall, vendorItemId?, title, targetPrice, link?, image? }` | `{ ok, item }` |
| POST | `{ action:'pause' \| 'resume', id }` | `{ ok, item }` |
| DELETE | `{ id }` | `{ ok }` |

```
Item = { id, productId, mall, vendorItemId, title, image, link, targetPrice,
         status: 'WAITING'|'REACHED'|'PAUSED',
         tracking: 'TRACKED'|'UNTRACKED',        // 카탈로그에 있어 매일 수집되는가
         lastPrice|null, lastPriceAt|null, gapPct|null,
         notifiedAt|null, notifiedPrice|null, createdAt }
```

- 신원은 **토큰에서만** (`_auth.identify`). 본문의 email 은 읽지 않는다.
- 사용자당 최대 50개. 목표가는 1원 이상, 현재가의 5배 이하.
- 알림 발송은 `scripts/check-waitroom.js` (GitHub Actions, `WAITROOM_ENABLED=1` 일 때만).
- 중복 알림 방지: `waitroom_notifications (item_id, notify_date)` UNIQUE 로 **먼저 선점**한 행만 메일을 보낸다.
  한 번 알린 항목은 가격이 목표가 × 1.03 위로 올라갔다가 다시 내려와야 다시 무장된다(히스테리시스),
  그리고 같은 항목은 7일에 한 번을 넘지 않는다.

#### DB (마이그레이션 `supabase/2026-09-24-seosa2-waitroom.sql` — **미적용**)

```
waitroom_items (
  id bigserial pk, email text, product_id text, mall text, vendor_item_id text default '',
  title text, image text, link text, target_price integer check (> 0),
  status text default 'WAITING' check in ('WAITING','REACHED','PAUSED'),
  armed boolean default true,
  last_price integer, last_price_at timestamptz,
  notified_at timestamptz, notified_price integer, notify_count integer default 0,
  created_at, updated_at,
  unique (email, product_id, mall, vendor_item_id)
)
waitroom_notifications (
  id bigserial pk, item_id bigint references waitroom_items on delete cascade,
  email text, notify_date date, price integer, target_price integer,
  status text check in ('claimed','sent','failed'), error text, created_at, sent_at,
  unique (item_id, notify_date)
)
```
두 표 모두 RLS on + anon/authenticated 권한 회수 (service_role 만).

### ③ AI 쇼핑 조사관 — `POST /api/investigate`

본문: `{ question, limit? (≤8) }`

```
{
  ok, query: { raw, searchPhrase, constraints, category, wantedFeatures },
  candidates: [{
    productId, mall, title, image, url,
    price: { value, verified, observedDate|null, staleDays|null, source:'price_history'|'catalog' },
    specs: { verified: { key: { value, text, evidence } }, unverifiedFeatures[] },
    fits: boolean, violations[],
    level (fairness) | null, deal: { verdict, label } | null,
    pros: [{ text, basis }], cons: [{ text, basis }]
  }],
  excluded: [{ productId, title, reason }],
  summary: { text, grounded: { ok, unmatched[] } },
  coverage: { source: 'catalog' | 'catalog+live', scanned },
  disclaimers[]
}
```

불변식: 요약 문장의 모든 금액·수치는 `candidates` 안의 값이어야 한다 (`grounded.ok`). 제목에서 확인되지 않은 기능은
`unverifiedFeatures` 로만 말한다. AI Concierge 와 같은 모듈(`_shopintent` · `_specs` · `_deal` · `_concierge`)을 쓴다.

### ④ 브라우저 확장 — `GET /api/lookup`

쿼리: `productId` · `vendorItemId` · `mall`(기본 쿠팡) · `title`

```
{ ok, match: { status: 'EXACT'|'SIMILAR'|'NONE', productId, mall, title, tier, reasons[] },
  points, level, timing: { action, label } | null, anomaly: { status, label } | null,
  offers: [{ mall, mallLabel, title, price, url, observedDate, identity: { tier } }],
  waitroomUrl }
```
확장은 Manifest V3, 권한은 `storage` 하나 + `https://seosa.ai.kr/*` 호스트뿐. 사용자가 버튼을 눌렀을 때만
상품 식별자와 제목을 보낸다 (쿠키·계정·다른 탭 정보는 읽지 않는다).

### ⑤ 장바구니 최저가 — `POST /api/cart`

본문: `{ items:[{ productId?, mall?, vendorItemId?, title?, quantity }], shipping?:{ [mall]:{ fee, freeOver } }, coupons?:[{ mall, amount?, percent?, minSpend?, maxDiscount? }] }`

```
{ ok,
  items: [{ input, offers:[Offer], excluded:[{ offer, reason }] }],
  plan:  { total, itemsCost, shippingCost, couponDiscount, optimal, searchedNodes,
           byMall:[{ mall, lines:[{ itemIndex, offer, quantity, lineTotal }], subtotal, shipping, coupon, total }] },
  baselines: { singleMall: { mall, total } | null, cheapestEach: { total } },
  savings: { vsSingleMall|null, vsCheapestEach },
  assumptions[], unresolved[] }
Offer = { mall, mallLabel, productId, vendorItemId, title, unitPrice, observedDate, staleDays,
          availability:'LIVE'|'STALE', url, identity:{ tier, reasons[] }, option:{ ok, notes[] } }
```
쿠폰은 **사용자가 입력한 것만** 적용한다 (확인할 수 없는 쿠폰을 지어내지 않는다). 배송비는 입력값 → 몰 기본값(추정, `assumptions` 에 명시) 순.
링크는 `products.link` (기존 제휴 링크) 그대로.

### ⑥ 가격 이상 패턴 — `GET /api/anomaly`

쿼리: `productId` · `mall` · `vendorItemId`

```
{ ok, asOf, product,
  distribution: { count, min, p5, p25, median, p75, p95, max, mean, mad, histogram:[{ from, to, count }] },
  events: [{ date, kind, severity:'info'|'warn'|'alert', price, ref, changePct, note, evidence }],
  summary: { status:'NORMAL'|'WATCH'|'ANOMALOUS'|'INSUFFICIENT', label, counts:{ kind:n } },
  history: { observations:[{ at, date, price, vendorItemId, flag }], digest:'sha256:…', canonical:'설명' } }
kind ∈ SPIKE · CRASH · FAKE_DISCOUNT · SAWTOOTH · OPTION_CHANGE · COLLECTION_ERROR · REFERENCE_INFLATION
```
`digest` 는 `observations` 를 정해진 규칙으로 직렬화한 SHA-256 이다 — 같은 기록이면 누가 계산해도 같은 값이 나온다.

---

## 4. 테스트 계약

- 기능마다 `scripts/test-v2-<feature>.js`. `scripts/test-seosa2.js` 가 `test-v2-*.js` 를 찾아 전부 돌리고,
  `npm test` 에는 그 러너 한 줄만 들어간다 (기능 PR 이 package.json 을 고치지 않는다).
- 공용 도구 `scripts/_v2-testkit.js` — 가짜 Supabase, `global.fetch` 차단, 가짜 req/res.
- 외부 호출 0회. `test-release.js` 의 SAFE 검사가 러너의 자식 테스트까지 펼쳐서 검사한다.
