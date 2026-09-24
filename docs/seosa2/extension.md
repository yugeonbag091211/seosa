# ④ 브라우저 확장 — 설계 기록

> 계약: [CONTRACTS.md](CONTRACTS.md) §3 ④ · §3-7. 이 문서는 계약을 «어떻게» 지켰는지와 그 이유를 적는다.

## 1. 한눈에

```
[쿠팡 상품 페이지]
  content.js  ── 버튼(닫힌 Shadow DOM) ── 누름 ──▶ chrome.runtime.sendMessage({type:'seosa:lookup', …})
                                                      │
  background.js (서비스 워커)  ◀────────────────────────┘
    · sender.id === 이 확장 · sender.url 이 지원하는 상품 페이지 · 번호 == 탭 주소의 번호 · 형식 검사
    · GET https://seosa.ai.kr/api/lookup?productId=&vendorItemId=&itemId=&title=
      (credentials:'omit', referrerPolicy:'no-referrer', redirect:'error', 10초 제한)
                                                      │
  api/history.js ─ _v2router(__route=lookup) ─▶ api/_lookup-api.js ─▶ api/_lookup.js (순수)
    · _series.loadSeries · _pricestat.fairness/loadStats · _identity · _hotgroup.canMerge
    · (있으면) _timing.analyze · _anomaly.analyze
```

| 파일 | 역할 |
|---|---|
| `extension/manifest.json` | MV3. `permissions:["storage"]`, `host_permissions:["https://seosa.ai.kr/*"]`, 상품 상세 페이지 3종에만 콘텐츠 스크립트 |
| `extension/src/parse.js` | 주소 → `{site, productId, itemId, vendorItemId}` · 제목 정리. 브라우저·Node 공용 순수 함수 |
| `extension/src/content.js` | 버튼 · 패널. 누르기 전에는 아무것도 보내지 않는다. `innerHTML` 없음 |
| `extension/src/background.js` | 메시지 검증 후 `/api/lookup` 한 번. 툴바 아이콘 = 버튼 보이기 토글 |
| `api/_lookup.js` | 입력 검증 · 검색어 · 동일상품 등급 · 오퍼 조립 (DB 모름) |
| `api/_lookup-api.js` | `GET /api/lookup` 핸들러 (읽기 전용) |
| `public/v2/extension.html` | 소개 · 설치 · 권한 · 개인정보 · 데모 |
| `scripts/test-v2-extension.js` | 오프라인 테스트 |

## 2. 권한 — 왜 이것뿐인가

| 권한 | 이유 | 없으면 |
|---|---|---|
| `storage` | «버튼 보이기» 설정 하나 (`seosaShowButton`) | 숨긴 버튼을 기억하지 못한다 |
| `https://seosa.ai.kr/*` | 서비스 워커가 `/api/lookup` 을 부른다 | API 를 부를 수 없다 |
| 콘텐츠 스크립트 match 3개 | 쿠팡 `/vp/products/*`, 11번가 `/products/*`, G마켓 `/Item*` | — |

요청하지 않은 것과 이유:

- `tabs` · `activeTab` — 탭 주소는 메시지의 `sender.url` 로 충분하다 (자기 콘텐츠 스크립트가 보낸 메시지에는 붙어 온다).
- `scripting` — 콘텐츠 스크립트를 manifest 로 선언했으니 동적 주입이 필요 없다.
- `cookies` · `history` · `webRequest` · `<all_urls>` — 쓸 일이 없다.
- `web_accessible_resources` — 패널 CSS 를 Shadow DOM 안 `<style>` 로 넣으니 페이지가 확장 파일을 읽을 필요가 없다.
  (이 항목이 있으면 아무 웹사이트나 확장 설치 여부를 탐지할 수 있다.)
- `externally_connectable` — 웹페이지가 확장에 메시지를 보낼 길을 만들지 않는다.
- `action` 은 권한이 아니다. 툴바 아이콘을 누르면 설정 값 하나를 뒤집는 데만 쓴다 (탭 정보는 읽지 않는다).

## 3. 개인정보 — 보내는 것 · 보내는 때

- **때**: `onLookupClick` 안의 `chrome.runtime.sendMessage` 한 곳. 그 함수는 버튼 `click` 리스너로만 불린다.
  테스트가 소스(한 번뿐 · 그 함수 안)와 가짜 DOM 실행(열고 시간이 흘러도 0회, 누르면 1회) 둘 다로 고정한다.
- **값**: 쿠팡은 `productId` · `vendorItemId` · `itemId`(주소에 있을 때) · 상품명. 11번가·G마켓은 **상품명만**.
- **곳**: `https://seosa.ai.kr/api/lookup`. 쿠키·리퍼러 없음. 리다이렉트는 따라가지 않는다.
- **저장**: `chrome.storage.local.seosaShowButton` 하나.
- 자세한 문장은 [extension/PRIVACY.md](../../extension/PRIVACY.md).

11번가·G마켓 번호를 보내지 않는 이유: 그 번호는 SEOSA 카탈로그의 번호(쿠팡 productId)와 다른 체계다.
보내면 서버가 «우연히 같은 숫자의 쿠팡 상품» 을 EXACT 로 잡을 수 있다. 같은 이유로 서버는 `mall` 을 쿠팡만 받는다.

## 4. EXACT · SIMILAR · NONE

| 상태 | 조건 | 화면 문구 |
|---|---|---|
| EXACT | `products(product_id=productId, mall='쿠팡')` 이 있거나 그 번호의 가격 기록이 있다 | «이 상품의 기록» |
| SIMILAR | EXACT 가 아니고 제목으로 찾은 후보가 아래 관문을 넘었다 | «비슷한 상품의 기록» (+ tier B 면 «확신 낮음») |
| NONE | 둘 다 아니다 | «기록 없음» |

SIMILAR 관문 (`_lookup.rankSimilar`). _identity 의 tier A 는 «사람이 검토할 재등록 후보» 용이라 느슨하다
(_hotgroup.js 머리 주석 — `WIN11` 이 모델코드로 잡혀 «그램 16» 과 «그램 AI 17» 이 tier A). 그래서 한 단계 더 조인다.

1. `judgeSameProduct` 가 C · D → 탈락 (용량·색상·수량·세대·모델코드 충돌)
2. 스펙 숫자(단위 없는 맨숫자) 집합이 다르면 → 탈락 («그램 16» vs «그램 17»)
3. tier A 이고 `canMerge` 까지 통과 → **tier A**
4. tier A 인데 `canMerge` 는 못 넘었거나(제목 겹침 부족 등), 원래 tier B → **tier B** + reasons 에 «확신이 낮아요»
5. 후보가 여럿이면: A → 살아 있는 행 → 쿠팡(옵션 단위 기록) → 제목이 더 닮은 것 → 최근 확인 → product_id

SIMILAR 응답의 `points` · `level` 은 **찾은 상품의 것**이다. `match.reasons[0]` 은 항상
«이 페이지의 상품이 아니라, 제목으로 찾은 다른 판매처 상품의 기록이에요.» 이고, 화면(확장·데모)은
상태를 배지·문장으로 바꿔 보여 준다. 가격 위치도 «비슷한 상품 기준» 이라고 적는다.

제목 검색 (`_lookup.searchPlans`) — 계획은 최대 두 개, 한 번에 ≤ 40행, 받아들일 후보가 생기면 멈춘다.

| 제목 | 1차 | 2차 |
|---|---|---|
| 모델코드 있음 | `[코드, 브랜드]` | `[코드]` (브랜드 표기가 다를 때) |
| 모델코드 없음 | `[브랜드, 가장 긴 낱말]` | `[브랜드, 두 번째로 긴 낱말]` (판매 문구가 1차를 망칠 때) |

검색어에는 `[0-9A-Za-z가-힣-]` 만 남는다 — `%` `_` `,` `(` 가 들어갈 수 없어 PostgREST 필터를 조작할 수 없다.

## 5. 다른 판매처 오퍼

후보군 = 대조된 상품과 같은 `keyword` 의 카탈로그 행 (쿠팡·ADPICK, ≤ 60). 통과 조건은 SEOSA HOT 이 카드를 묶는 관문과 같다.

1. 자기 자신(같은 product_id · mall) 제외
2. `productLifecycle(row).state === 'live'`
3. `judgeSameProduct(matched.title, row.title).tier === 'A'`
4. 값 = `loadStats` 마지막 관측가 (카탈로그가 더 나중에 확인됐으면 카탈로그 `lprice`) · 관측일
5. `canMerge(matched, row, df)` — 옵션 식별자 · 스펙 숫자 · 자카드 ≥ 0.8 · 값 비율 ≥ 0.35 · 변별력 있는 모델코드.
   `df` 는 후보군 전체에서 센다.
6. 값 오름차순, 최대 8개. 링크는 `products.link` 그대로 (http(s) 가 아니면 null)

결과적으로 **다른 쿠팡 상품 페이지는 오퍼가 되지 않는다** — 둘 다 vendorItemId 가 있고 서로 다르면 canMerge 0) 규칙이
«다른 옵션» 으로 본다. 오퍼는 사실상 ADPICK(11번가·G마켓 등) 행이다. 중복을 놓치는 쪽이 틀린 병합보다 안전하다
(_hotgroup.js: false merge < duplicate).

보고 있는 옵션(vendorItemId)이 카탈로그가 추적하는 옵션과 다르면, 카탈로그 제목은 다른 옵션의 이름이다.
그때는 곡선을 그 옵션의 행으로만 그리고(`sameVendorRows`), 오퍼는 싣지 않고, 제목은 페이지 제목을 쓴다.

## 6. ①·⑥ 연동

`api/_timing.js` · `api/_anomaly.js` 는 다른 브랜치에서 만든다. 이 브랜치에는 없다.

- 파일이 없으면(`MODULE_NOT_FOUND`) 그 필드는 `null`.
- 파일은 있는데 로드 중 다른 오류가 나면 던진다 (① · ⑥ 이 깨진 것을 숨기지 않는다 — `_v2router` 와 같은 원칙).
- `analyze` 호출이 던지거나 모양이 다르면 `null` — 조회 전체는 200 으로 산다.
- 매핑: `timing = { action: r.recommendation.action, label: r.recommendation.label }`,
  `anomaly = { status: r.summary.status, label: r.summary.label }`.
- 테스트는 파일이 없을 때 `null` 을, 있을 때(합친 뒤) 모양을 검사한다. 매핑 자체는 `_internal.setOptional` 로 가짜 모듈을 끼워 검사한다.

## 7. 응답 예

```json
{
  "ok": true,
  "match": { "status": "SIMILAR", "productId": "1001", "mall": "쿠팡", "vendorItemId": "9001", "mallLabel": "쿠팡",
             "title": "삼성전자 갤럭시 S25 자급제 SM-S931N 256GB 실버", "url": "https://link.coupang.com/…",
             "tier": "A", "reasons": ["이 페이지의 상품이 아니라, 제목으로 찾은 다른 판매처 상품의 기록이에요.", "정규화 제목 완전 일치", "묶음 검증 통과 (정규화 제목 완전 일치)"] },
  "points": [{ "date": "2026-09-05", "price": 1190000 }, "…"],
  "level": { "level": "cheap", "label": "저렴함", "pctRank": 5, "obs": 20, "…": "…" },
  "timing": null,
  "anomaly": null,
  "offers": [{ "mall": "ADPICK", "mallLabel": "G마켓", "title": "…", "price": 1020000, "url": "https://…", "observedDate": "2026-09-24", "identity": { "tier": "A" } }],
  "waitroomUrl": "/v2/waitroom.html?add=1&productId=1001&mall=%EC%BF%A0%ED%8C%A1&vendorItemId=9001&title=…"
}
```

`match` 에는 계약 필드 외에 `vendorItemId` · `mallLabel` · `url` 을 **덧붙였다** (SIMILAR 상품을 열 수 있게).
계약 필드는 바꾸지 않았다. NONE 이면 `points:[]`, `level/timing/anomaly: null`, `offers:[]`,
`waitroomUrl` 은 쿠팡 번호가 있을 때만 (대기실이 «추적 안 됨» 으로 등록) 아니면 `null`.

## 8. 운영 보호 (CONTRACTS.md §0)

- 새 서버리스 함수 없음 — `api/_lookup*.js` 는 `_` 로 시작해 함수로 세지 않는다. 라우트는 기초 브랜치가 이미 연결했다.
- 읽기 전용 — `products` · `price_history` 를 읽기만 한다. 테스트가 `state.writes.length === 0` 을 고정한다.
- 외부 쇼핑 API 호출 0회. 조회 수: EXACT ≤ 5회, SIMILAR ≤ 8회 (테스트로 상한 고정).
- `guard(v2-lookup, 60/분)` · `cachePublic(600)` (성공 응답만) · 오류는 `fail` (문장만, 스택은 Sentry).

## 9. 한계 · 다음 일

- **실제 Chrome 에서 로드해 보지 못했다** (이 작업 환경에는 브라우저가 없다). 서비스 워커와 콘텐츠 스크립트는
  vm 샌드박스(가짜 chrome · 가짜 DOM)에서 돌려 검사했다. 사람이 한 번 `chrome://extensions` 로 로드해
  쿠팡 페이지에서 확인해야 한다 — 특히 (1) 쿠팡의 옵션 변경이 주소를 바꾸는지와 `sender.url` 이 그 주소를 따르는지,
  (2) 쿠팡 `og:title` 형식, (3) `https://seosa.ai.kr` 이 `www` 로 리다이렉트하지 않는지 (`redirect:'error'` 이므로
  리다이렉트가 있으면 요청이 실패한다).
- 11번가 · G마켓의 주소 모양은 공개 상품 페이지 주소 규칙으로 정했다. 모바일 주소(`m.` 도메인)는 일부러 넣지 않았다.
- 아이콘이 없다 — 웹스토어 등록 때 추가해야 한다.
- 페이지의 현재 판매가는 읽지 않는다 (개인정보·유지보수 부담 최소화). 그래서 `level` 은 «SEOSA 가 마지막으로 본 값» 의 위치다.
- SIMILAR 는 제목 검색이라 재현율이 완벽하지 않다. 틀린 SIMILAR 보다 NONE 이 낫다는 쪽으로 기울였다.
