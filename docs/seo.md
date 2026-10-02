# SEOSA 기술 SEO — 구조와 정책 (2026-10-02)

검색엔진(Google · 네이버)이 SEOSA 를 «상품별 최저가 · 가격 추이를 기록하는 가격비교 서비스» 로
읽게 하는 장치를 한곳에 적는다. 코드의 주석이 근거를, 이 문서는 지도를 맡는다.

## 1. URL 구조

| 주소 | 무엇 | 렌더 | 구현 |
|---|---|---|---|
| `/` | 홈 (SPA) | 정적 HTML + JS | `public/index.html` |
| `/p/{product_id}` | 상품 1개 (판매처 1곳의 기록) | 서버 렌더 | `api/_product-page.js` |
| `/category` | 카테고리·브랜드 허브 | 서버 렌더 | `api/_seo-pages.js` |
| `/category/{slug}` | 카테고리 (예: `/category/laptop`) | 서버 렌더 | `api/_seo-pages.js` |
| `/brand/{slug}` | 브랜드 (예: `/brand/lg`) | 서버 렌더 | `api/_seo-pages.js` |
| `/sitemap.xml` | 사이트맵 인덱스 | 서버 | `api/_seo-pages.js` |
| `/sitemaps/pages.xml` · `/sitemaps/products-N.xml` | 사이트맵 파일 | 서버 | `api/_seo-pages.js` |

* 상품 주소는 바꾸지 않았다. `/p/{id}` 는 이미 공유·색인되고 있고, 쿠팡 상품명은 길고 옵션이
  섞여 slug 로 얻는 것보다 주소가 바뀌는 위험이 크다.
* 새 서버리스 함수는 없다. 전부 `api/history.js` 의 `__route` 갈래다 (Vercel Hobby 12개 상한).

## 2. 색인 정책

| 페이지 | 색인 | 조건 |
|---|---|---|
| 홈 `/` | index | — |
| 상품 `/p/{id}` | index | live(10일 안에 확인) · 판매처 링크 · 관측 7일 이상 · 구매 가격(렌탈·구독·100원 미만 아님) |
| 상품 (위 조건 미달) | **noindex,follow** | 페이지는 열린다 (사용자·공유용) |
| 카테고리·브랜드 | index | 현재가가 살아 있는 본품 8개 이상 |
| 카테고리·브랜드 (미달) | **noindex,follow** | 0개면 404 |
| 허브 `/category` | index | 색인 묶음 3개 이상 |
| 검색 `/?q=` · 딥링크 `/?p=` | **noindex,follow** | `X-Robots-Tag` 헤더(vercel.json) + 열릴 때 canonical 제거(index.html) |
| 내 레이더 `/radar.html` | **noindex,follow** | 개인 저장 목록 |
| `/api/*` | robots.txt 차단 | 크롤러가 쿠팡 호출 한도를 태우지 않게 |

* **robots.txt 로 막는 것과 noindex 는 다르다.** robots 로 막으면 크롤러가 noindex 를 읽지 못해
  주소만 색인될 수 있다. 그래서 `/?q=` · `/p/` · `/category` 는 robots 로 막지 않는다.
* 사이트맵에는 index 인 주소만 들어간다. 규칙이 갈리면 Search Console 에 «제출됐지만 noindex»
  경고가 뜬다 — JS(`buildView.indexable`) 와 SQL(`seo_sitemap_products`) 이 같은 규칙을 쓰고
  `scripts/test-seo.js` 가 확인한다.

## 3. 카테고리·브랜드는 «사람이 고른 목록» 이다

`api/_seo.js` 의 `CATEGORIES` · `BRANDS`. 검색어마다 페이지를 만들지 않는다 (doorway page).

* 2026-10-02 실측: 상품 8개 이상인 짧은 검색어가 1,835개였지만 사용자 문장이 섞여 있고
  ("더 싼 데일리 향수 찾기 로 검색해드릴까요?") 같은 개념이 여러 검색어로 갈라져 있다.
* 카테고리 하나 = 개념 하나 = 검색어 여러 개 (마우스 = 마우스 · 무선 마우스 · 게이밍 마우스).
* 브랜드 = 상품명 첫 낱말이 별칭과 정확히 같을 때만. «호환» 상품 · LG생활건강 · 몰 이름 머리는 제외.
* 추가할 때: 운영 DB 에서 그 검색어의 «live 본품» 이 11개 이상인지 확인하고 한 줄 더한다.
  색인 여부는 그 뒤에도 실제 상품 수가 정한다.

목록에 드는 상품의 규칙 (카테고리): live · 링크 있음 · 구매 가격 · 관련성(`relevantRows`) ·
본품(`filterMainProductCandidates`) · 카테고리 중앙값의 20% 이상(키캡·어댑터·가방이 «가장 싼
노트북» 이 되지 않게). 브랜드 목록은 현재가 높은 순으로 보여 준다 (TV 와 리모컨을 견주지 않는다).

## 4. 구조화 데이터 (JSON-LD)

| 페이지 | 스키마 |
|---|---|
| 홈 | `WebSite` + `SearchAction`, `Organization` (기존) |
| 상품 (index 일 때) | `BreadcrumbList`, `WebPage`, `Product` + `Offer`(1곳) |
| 상품 (noindex) | `BreadcrumbList`, `WebPage` — Product 없음 |
| 카테고리·브랜드 | `BreadcrumbList`, `CollectionPage` + `ItemList`(상세 URL) — Product 없음 |

* Product 는 Google «제품 스니펫» 용이다 (직접 팔지 않는 가격 비교 페이지). 판매처가 2곳 이상인
  경우를 위해 `AggregateOffer`(lowPrice · highPrice · offerCount) 도 공용 함수에 있다.
  지금 상품 페이지는 판매처 1곳의 기록이라 `Offer` 다.
* 가격은 화면 큰 글씨와 같은 값 (마지막 관측가). `review` · `aggregateRating` · `availability` 는
  넣지 않는다 — SEOSA 에 그 데이터가 없다.
* 직렬화는 `_seo.jsonLdScript` 하나로 한다 (`< > & U+2028 U+2029` 이스케이프 — `</script>` 주입 방지).

## 5. 사이트맵

* `/sitemap.xml` → `pages.xml` + `products-1..N.xml`. 상품 파일 하나는 `products.id` 40,000 폭
  (URL 상한 45,000 < 프로토콜 50,000). 비어 있는 범위는 인덱스에 올리지 않는다.
* 상품 판정은 DB 함수 `seo_sitemap_products` (supabase/2026-10-02-seo-sitemap.sql) 가 한 번에 한다.
  **함수가 아직 없으면** 예전 계산(상한 5,000개, `indexableProducts`)으로 `products-1.xml` 하나만 낸다.
* `/sitemap-products.xml`(예전 주소)은 같은 인덱스를 낸다 — 이미 제출된 주소가 깨지지 않는다.
* Edge 캐시 12시간. DB 오류는 5xx 로 낸다 (빈 사이트맵으로 숨기지 않는다 — 크롤러가 다시 온다).

## 6. 404 · 품절 · 삭제

| 상황 | 응답 |
|---|---|
| 없는 `product_id` (지워졌거나 수집된 적 없음) | 404 + noindex (짧게 캐시 — 나중에 수집되면 열린다) |
| 수집이 10일 넘게 끊김 (stale) · 연동이 끊긴 몰 | 200 + noindex — 기록은 남아 있다 |
| 판매처 링크 없음 | 200 + noindex |
| 레지스트리에 없는 카테고리·브랜드 slug | 404 |
| 레지스트리에 있지만 상품 0개 | 404 (soft 404 금지) |

* 410 은 쓰지 않는다. «영구 삭제» 와 «아직 수집 안 됨» 을 DB 로 가를 수 없다.
* 품절 상태는 모른다 (쿠팡 검색 API 에 재고 필드가 없다). 재고를 추측해 표시하지 않는다.
* 판매처 하나가 사라져도 상품 페이지는 지우지 않는다 — 링크가 없으면 noindex 로 내려간다.

## 7. 중복

* 상품 하나 = `(product_id, mall)` 한 행 = 주소 하나. 운영 DB 에 product_id 가 두 몰에 걸친 행은
  0건이다 (2026-10-02). `?m=` · `?mall=` · utm 이 붙어도 canonical 은 `/p/{id}` 하나다.
* 옵션(vendor_item_id) 이 다른 것은 다른 상품이다 — 합치지 않는다. 같은 물건이 재등록돼 다른
  product_id 를 가진 경우도 합치지 않는다 (`_hotgroup` 원칙: 잘못 합치는 것 < 중복).

## 8. 사람이 해야 하는 일

1. **Supabase SQL Editor** 에서 `supabase/2026-10-02-seo-sitemap.sql` 실행 → `.VERIFY.sql` 로 확인.
   (읽기 전용 함수 하나. 안 해도 사이트는 돈다 — 사이트맵이 상한 5,000개 폴백으로 남는다.)
2. **Google Search Console**: `https://seosa.ai.kr/sitemap.xml` 제출. (소유 확인 메타는 index.html 에 이미 있다.)
3. **네이버 서치어드바이저**: 사이트 등록 → 발급된 확인 값을 `public/index.html` 머리의 주석 자리에
   붙여 넣고 배포 → 사이트맵 `https://seosa.ai.kr/sitemap.xml` 제출 → robots.txt 검증.
4. (선택) 서버가 그리는 페이지에도 확인 메타를 넣으려면 Vercel 환경변수
   `GOOGLE_SITE_VERIFICATION` · `NAVER_SITE_VERIFICATION`.
