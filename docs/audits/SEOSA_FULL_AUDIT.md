# SEOSA 전수 감사 — 발견 내역

대상: https://seosa.ai.kr · 저장소 `main` 35afa08 기준
감사: 2026-11-23 (KST) · 브랜치 `claude/seosa-system-audit-fixes-c7536b`

모든 수치는 실제로 측정한 값이다. 측정하지 않은 것은 «미측정» 이라고 적는다.
운영 DB 접속 수단이 없으므로(로컬 `.env.local` 에 `NEON_DATABASE_URL` 없음)
데이터 정합성은 공개 API 응답으로만 확인했다.

---

## F-01 (P1) 범주어 검색이 상품명 한 건 때문에 브랜드 검색으로 뒤집힌다 — **수정함**

### 증상 (운영 실측, 2026-11-23 22:05 KST)

`GET /api/search?keyword=운동화` 의 1위가 신발이 아니라 **책**이었다.

```
 1.     14400  rel=1.00  ADPICK  [국내도서] 운동화 신은 뇌
 2.     11900  rel=0.65  쿠팡    이더커머스 남성 발편한 가벼운 운동화
 3.     18900  rel=0.65  쿠팡    디아핏 가벼운 발편한 남성 런닝화 운동화
 …      (실제 운동화 19건이 전부 0.65)
```

### 원인

`api/_search.js` `analyzeQuery()` 의 `primaryHead` 가
«머리 토큰으로 시작하는 상품명이 **하나라도** 있으면» 그 검색어를 대표 머리
질의로 본다. 그 하나가 저 책이었다 — `identityTokens` 가 `["운동화","신은","뇌"]`
라서 머리로 시작한다.

토큰이 하나뿐이면 `intent = 'BRAND_ONLY'` 가 되고,
`titleRelation()` 의 `late-head` 규칙이 «머리 토큰이 3번째 이후에 나오는» 제목에
`×0.65` 를 먹인다. 한국어 상품명은 범주어가 맨 뒤에 온다(«… 가벼운 운동화»).
그래서 **진짜 상품만 전부 감점**되고, 범주어로 시작한 책 한 권만 1.00 으로 남았다.

오프라인 재현(외부 호출 0):

```
--- 책 포함   intent=BRAND_ONLY
   1.000  -          [국내도서] 운동화 신은 뇌
   0.650  late-head  이더커머스 남성 발편한 가벼운 운동화
--- 책 제외   intent=PRODUCT
   1.000  -          이더커머스 남성 발편한 가벼운 운동화
```

같은 상품의 점수가 **목록에 책이 있느냐 없느냐로 1.00 ↔ 0.65 로 흔들린다.**

### 운영 실측 범위 (검색어 10개)

| 검색어 | intent | 머리로 시작하는 상품명 |
|---|---|---|
| 운동화 | **BRAND_ONLY** | **1 / 20** ← 그 한 건이 책 |
| 게이밍 노트북 | BRAND_PRODUCT | 1 / 15 |
| 아이패드 | BRAND_ONLY | 3 / 21 |
| 삼성 갤럭시 | BRAND_PRODUCT | 6 / 6 |
| 노트북 · 무선 이어폰 · 책상 · 키보드 · 애플 맥북 · 10만원 이하 이어폰 | PRODUCT | 0 |

### 수정

`primaryHead` 가 성립하려면 머리로 시작하는 상품명이 **둘 이상**이어야 한다
(`PRIMARY_HEAD_MIN_TITLES = 2`). 브랜드는 여러 상품명의 맨 앞에 온다 —
`detectBrandHead` 주석이 이미 그렇게 적고 있고, 운영 실측도 그렇다(삼성 6/6).

회귀: `scripts/test-search-category-head.js` 신설(15검사). 기존
`test-search-ranking-intent.js` 151검사 전부 통과, **순위 변동 0건**.
바뀐 것은 호환 부속 5건의 점수가 0.26→0.40 / 0.29→0.45 로 오른 것뿐이고,
본품(0.9 / 1.0)보다 여전히 아래다.

---

## F-02 (P1) «SEOSA 검증» 배지가 운영에서 한 건도 뜨지 않는다 — **운영 상태, 미수정**

홈 핫딜 영역의 안내 문구는 이렇게 말한다.

> SEOSA 가격 이력으로 근거까지 확인한 상품에는 «SEOSA 검증» 배지를 붙였어요.

실측: `GET /api/hotdeals?view=today-drop&limit=60` → 60건 중 `verified: true` **0건**.
`GET /api/hotdeals` (핫딜 엔진 기본 뷰) → `items: []`.

원인은 코드가 아니라 **스케줄 중단**이다. GitHub Actions 워크플로 상태:

| 워크플로 | 상태 | 마지막 실행 |
|---|---|---|
| `SEOSA HOT` (hotdeals.yml) | **disabled_manually** | 2026-11-14 06:44 UTC |
| `Volatile Price Rechecks` (volatile-prices.yml) | **disabled_manually** | 2026-11-14 09:53 UTC (실패) |
| `SEOSA Product Identity Shadow` | disabled_manually | 2026-11-14 00:17 UTC |
| `Daily Price Collection` | active | 정상 (2026-11-23 다수 성공) |
| `SEOSA External Hotdeals` | active (스케줄은 코드에서 제거됨) | 2026-10-21 |

세 개가 모두 **2026-11-14** 에 멈췄다 — Neon 전송량 비상(5.19 GB / 70 CU-h)과
같은 날이다. 의도된 비용 조치로 보이며, 운영 판단이 필요하므로 켜지 않았다.
`vercel.json` 의 `"crons": []` 와 합쳐서 **낮/저녁 가격 재확인과 핫딜 판정이
2026-11-14 이후 돌지 않고 있다**.

사용자 영향: 핫딜 카드는 계속 뜨지만(= 오늘 하락 60건) 전부 미검증이고,
화면이 약속한 배지는 구조적으로 뜰 수 없다.

---

## F-03 (P2) 검색 응답과 상품 페이지가 운영에서 CDN 캐시를 전혀 쓰지 않는다 — 미수정

실측 (`Cache-Control` 응답 헤더):

| 주소 | Cache-Control | Vercel 캐시 |
|---|---|---|
| `/api/search?keyword=…` (10개 전부) | `no-store, max-age=0` | — |
| `/p/:pid` | `no-store, max-age=0` | MISS |
| `/api/hotdeals?view=today-drop` | `no-store, max-age=0` | MISS |
| `/category/:slug`, `/brand/:slug` | `public, max-age=0` | MISS/HIT |
| `/api/init` | `public, max-age=0` | STALE(=캐시 사용) |
| `/` | `public, max-age=0` | HIT |

원인: `api/search.js`, `api/_product-page.js` 가
`Canonical.config().enabled && percent > 0` 이면 무조건 `noStore(res)` 한다.
운영에 `IDENTITY_CANONICAL_CONSUMER_ROLLOUT_PERCENT > 0` 이 켜져 있어서
«롤아웃 중» 분기가 상시로 걸린다.

그 분기의 근거는 주석에 적혀 있다 — «중단을 즉시 반영하려고 매 요청에서 상태를
읽는다». 그런데 롤아웃 대상은 `stableHash(groupKey)` 로 정해지므로 **같은 주소는
언제나 같은 결과**다(사용자별 분기가 없다). 즉 캐시해도 변종이 섞이지 않는다.
다만 «ops 가 percent 를 내렸을 때 최대 s-maxage 만큼 늦게 반영된다» 는 성질은
남는다. 이건 제품/운영 판단이라 임의로 바꾸지 않았다.

측정된 비용: `/p/:pid` TTFB 0.41 s ~ 3.29 s (4회), `/category/:slug` 0.27 s ~ 3.20 s (3회).
표본이 작고 분산이 커서 **«캐시를 켜면 몇 초 빨라진다» 고 말할 근거는 없다.**
확실한 것은 크롤러·재방문이 전부 함수와 DB 를 친다는 사실이다.
사이트맵은 상품 URL 을 15개 파일로 제출하고 있다.

---

## F-04 (P2) 가격 조건이 들어간 검색어가 조건을 전혀 반영하지 않는다 — 미수정

`GET /api/search?keyword=10만원 이하 이어폰` 실측 결과 8건:

```
 1.    219000  rel=0.25  모토로라 블루투스 PMLN7851 무전기 악세사리 무전기 이어폰
 2.     23000  rel=0.25  제일이노텔 JM-205S 무전기 귀걸이형 이어폰 …
 5.      4300  rel=0.14  컬러 이어폰 케이스 USB 보관 사각 파우치 …
 7.    284120  rel=0.14  NF AUDIO NA2+ 유선 이어폰 리케이블
 8.    398550  rel=0.14  HEIR AUDIO IEM5.0 5x 밸런스드 아마츄어 이어폰
```

- 10만원 «이하» 를 요구했는데 1·7·8위가 10만원을 넘는다.
- 무선 이어폰은 한 건도 없다(«이어폰» 단독 검색은 26건을 제대로 준다).
- 머리 토큰이 `10`(숫자)이 되어 질의 분석 자체가 의미를 잃는다.

`/api/search` 에는 예산 해석이 없다(AI 경로의 `_shopintent` 에만 있다).
이건 결함이라기보다 **없는 기능**이라 임의로 넣지 않았다 — 추가하면 회수율이
바뀌므로 제품 결정이 필요하다.

---

## F-05 (P2) 상품 유형과 무관한 항목이 본품과 같은 1.00 을 받는다 — 미수정

F-01 수정 뒤에도 남는다. 오프라인 재현:

| 검색어 | 상품명 | relevance |
|---|---|---|
| 게이밍 노트북 | `… 일자형 **책상** 서랍 컴퓨터 게이밍 노트북` | 1.00 |
| 게이밍 노트북 | `hp OMEN i7 … 게이밍 노트북` (본품) | 1.00 |
| 노트북 | `루이비통 … 노트북 **가방** 숄더백 서류가방` | 1.00 |
| 아이패드 | `[서울/서초] 아이패드 드로잉 원데이 **클래스**` | 1.00 |
| 아이패드 | `뉴욕: 아이패드와 … 크리스마스 **투어**` | 0.90 |
| 아이패드 | `[국내도서] 30일 완성 아이패드 드로잉 …` | 1.00 |

본품과 동점이면 가격순 타이브레이크가 결정하므로, 운영에서는 실제로
«게이밍 노트북» 1위에 쿨링패드·책상이 올라왔다.

판매 대상(sold object)을 등급으로 보는 코드가 이미 있다
(`api/_search2-object-relation.js`, Search 2.1) — 다만 `?engine=mini21` 로만
켜지는 베타다. 기존 랭커에 그 판정을 끌어오는 것은 회수율에 영향을 주므로
별도 검증(봉인 holdout)이 필요하다. 이번 감사에서는 손대지 않았다.

---

## F-06 (P3) 같은 상품명·같은 가격의 쿠팡 등록이 중복으로 노출된다 — 설계상 의도

`10만원 이하 이어폰` 결과에 `제일이노텔 JM-205S …` 가 세 번 나온다.
`product_id` 는 셋 다 다르다(8549547989 / 8549727637 / 8549727756).

`_search.dedupeItems` 는 **일부러** `product_id + mall` 로만 합치고 상품명으로는
합치지 않는다. 주석에 근거(실측 1379행 중 상품명 동일·ID 상이 64그룹)가 적혀 있어
규칙을 바꾸지 않았다. 사용자 눈에는 중복이지만, 합치면 다른 상품의 가격을
덮어쓰는 쪽이 더 나쁘다.

---

## 확인했고 문제가 없던 것

- **오늘 하락 데이터 산술 정합성** — 60건에서 `dropAmount = previousPrice - currentPrice`
  불일치 0건, `dropPct` 계산 오차(>0.15%p) 0건, 음수·0원 0건, `productId|vendorItemId`
  중복 0건.
- **빈 섹션 처리** — 외부 핫딜·`FOR YOU` 는 데이터가 없으면 `display:none` 으로
  스스로 숨는다. 빈 블록이 남지 않는다.
- **제휴 링크 관문** (`api/_affiliate.js`) — 쿠팡은 `link.coupang.com/re/AFF*` + SEOSA
  `lptag`, 또는 `/a/<code>` 만 통과. 원본 상품 URL·타 파트너 lptag·lptag 없는 링크는
  `''` 로 막는다. 옵션(`vendorItemId`)이 양쪽 다 있고 다르면 링크를 내보내지 않는다.
  `javascript:` 등은 `^https?://` 에서 걸린다.
- **robots.txt / sitemap** — `/api/` 차단, `?q=`·`?p=` 는 `X-Robots-Tag: noindex, follow`,
  사이트맵 인덱스 16개 파일 전부 200.
- **상품 페이지 메타** — `<title>`, `description`, `canonical`, OG 5종, `application/ld+json`
  모두 존재.
- **보안 헤더** — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`, HSTS 전부 응답에 실린다.
- **순수 함수 크래시 스윕** — 16개 모듈의 공개 함수에 결측·NaN·서러게이트·1만자
  문자열 등을 넣어 36,015회 호출. 실제 호출부가 만들어 낼 수 있는 입력에서
  터지는 자리는 찾지 못했다(터진 것은 Symbol·숫자를 배열 자리에 넣는 등
  호출부가 만들지 않는 조합뿐).
