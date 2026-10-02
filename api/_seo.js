'use strict';
/*
 * 기술 SEO 공용 도구 (2026-10-02).
 *
 * ── 이 파일에 있는 것 ──────────────────────────────────────────────
 *
 *   · 안전한 출력 — HTML 이스케이프, XML 이스케이프, JSON-LD <script> 직렬화
 *   · 상품 페이지의 title · description · 가격 요약 문장 (전부 결정론)
 *   · schema.org 조각 — Product(+Offer/AggregateOffer) · BreadcrumbList · ItemList
 *   · 카테고리 · 브랜드 레지스트리 (사람이 고른 목록)
 *   · 사이트맵 XML
 *
 *   DB 도 네트워크도 모른다. 순수 함수만 있다 — scripts/test-seo.js 가
 *   운영 DB 없이 전부 검사한다.
 *
 * ── 지키는 선 ──────────────────────────────────────────────────────
 *
 *   · 숫자는 전부 호출부가 넘긴 실제 기록에서 나온다. 기록이 모자라면
 *     그 줄을 «만들지 않는다» — 0 이나 «미정» 으로 채우지 않는다.
 *   · 평점·리뷰·재고 상태를 만들지 않는다. SEOSA 에는 그 데이터가 없다.
 *   · 구조화 데이터는 화면에 보이는 값만 담는다 (Google 구조화 데이터 지침).
 *   · 판매자 문자열(상품명·이미지 URL)은 출력 직전에 이스케이프한다.
 */

const { kstToday } = require('./_price');

/** 절대 URL 의 기준. _product-page.js 와 같은 값이다. */
const SITE = String(process.env.SITE_ORIGIN || 'https://seosa.ai.kr').replace(/\/+$/, '');

/* ── 안전한 문자열 ──────────────────────────────────────────────── */

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** XML 1.0 에 쓸 수 없는 제어문자까지 지운다 (판매자 제목에 섞여 들어온다). */
function xmlEsc(v) {
  return esc(String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''));
}

/**
 * 판매자 제목에 HTML 엔티티째 저장된 것이 있다 (운영 실측: "팝콘&amp;나쵸").
 * 그대로 다시 이스케이프하면 화면에 "&amp;" 가 보인다. 흔한 다섯 개만 풀고
 * 출력할 때 한 번 이스케이프한다 — 풀린 "<" 도 결국 이스케이프되므로 안전하다.
 */
function cleanText(v) {
  return String(v == null ? '' : v)
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

function won(n) {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * JSON-LD 를 <script> 안에 넣을 수 있는 문자열로.
 *
 * JSON.stringify 만으로는 안전하지 않다. 상품명에 `</script>` 가 있으면 그
 * 자리에서 스크립트 블록이 닫히고 뒤가 HTML 로 해석된다. `<` `>` `&` 를
 * 유니코드 이스케이프로 바꾸면 JSON 값은 그대로이고 HTML 파서는 태그를 못 본다.
 * U+2028/2029 는 옛 JS 엔진에서 문자열을 끊는다 — 같이 바꾼다.
 */
function jsonLdScript(obj) {
  const body = JSON.stringify(obj)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<script type="application/ld+json">${body}</script>`;
}

/** undefined · null · 빈 문자열 · 빈 배열 키를 지운다 (JSON-LD 에 빈 값을 싣지 않는다). */
function compact(obj) {
  if (Array.isArray(obj)) return obj.map(compact).filter(v => v !== undefined);
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  Object.keys(obj).forEach(k => {
    const v = compact(obj[k]);
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v) && !v.length) return;
    out[k] = v;
  });
  return out;
}

/* ── 검색엔진 소유 확인 ─────────────────────────────────────────── */

/*
 * Google Search Console · 네이버 서치어드바이저 확인 값.
 *
 * 값을 저장소에 만들어 넣지 않는다 — 환경변수에 있을 때만 메타를 낸다.
 * 이 값들은 비밀이 아니지만(페이지 소스에 그대로 보인다) 계정마다 다르다.
 *
 * ★ 홈(public/index.html)은 정적 파일이라 환경변수를 읽지 못한다. 네이버는
 *   사이트 루트에서 확인하므로 그 값은 index.html 머리의 표시된 자리에 직접
 *   붙여 넣어야 한다. 여기 값은 서버가 그리는 페이지(상품·카테고리·브랜드)용이다.
 */
function verificationMeta(env) {
  const e = env || process.env;
  const clean = v => String(v || '').trim().replace(/[^A-Za-z0-9_\-]/g, '');
  const out = [];
  const g = clean(e.GOOGLE_SITE_VERIFICATION);
  const n = clean(e.NAVER_SITE_VERIFICATION);
  if (g) out.push(`<meta name="google-site-verification" content="${g}">`);
  if (n) out.push(`<meta name="naver-site-verification" content="${n}">`);
  return out.join('\n');
}

/* ── 상품명 ─────────────────────────────────────────────────────── */

/** <title> 에 넣을 상품명 길이 상한 (한글 기준 검색 결과에 잘리지 않는 정도). */
const TITLE_NAME_MAX = 42;

/**
 * 검색 결과 제목 · 이미지 alt 에 쓸 짧은 상품명.
 *
 * 쿠팡 제목은 «이름, 색상, 용량, 수량» 처럼 쉼표 뒤에 옵션을 붙인다. 옵션은
 * 버리지 않고 이어 붙인 뒤 낱말 경계에서 자른다 — 같은 이름의 다른 옵션이
 * 똑같은 제목을 갖는 일을 줄인다. 배송·판촉 머리표([무료배송] 등)만 뺀다.
 * 낱말을 바꾸거나 키워드를 더하지 않는다.
 */
function shortName(title, max) {
  const limit = max || TITLE_NAME_MAX;
  const s = cleanText(title)
    .replace(/^\s*(\[[^\]]{1,20}\]\s*)+/, '')
    .replace(/\s*,\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit + 1);
  const sp = cut.lastIndexOf(' ');
  return (sp >= Math.floor(limit * 0.6) ? cut.slice(0, sp) : s.slice(0, limit)).trim();
}

/* ── 가격 요약 (결정론) ─────────────────────────────────────────── */

function mmdd(date) { return String(date || '').slice(5, 10); }

function addDays(date, n) {
  const p = String(date || '').split('-').map(Number);
  if (p.length !== 3 || p.some(x => !Number.isFinite(x))) return '';
  return new Date(Date.UTC(p[0], p[1] - 1, p[2]) + n * 86400000).toISOString().slice(0, 10);
}

function pct1(a, b) {
  if (!(b > 0)) return null;
  return Math.round(((a - b) / b) * 1000) / 10;
}

/**
 * 상품 페이지 «가격 요약» — 숫자와 문장.
 *
 * 창(최근 7일·30일)은 api/_pricestat.statsFrom 과 «같은 날짜 경계» 로 자른다.
 * 30일 평균은 그 함수의 avg30 을 그대로 쓴다 — 같은 화면의 통계 칸과 다른
 * 숫자가 나오면 둘 다 믿을 수 없게 된다.
 *
 * @param {Array<{date:string, price:number}>} points  KST 날짜당 한 점, 오름차순
 * @param {object|null} stat  statsFrom(points)
 * @param {{now?: number}} [opts]
 * @returns {null | {current, lastDate, prev, window7, window30, vsAvg30Pct, isLow30, sentences}}
 */
function priceSummary(points, stat, opts) {
  const pts = (points || []).filter(p => p && p.date && Number(p.price) > 0);
  if (!pts.length) return null;
  const now = (opts && Number.isFinite(opts.now)) ? opts.now : Date.now();
  const today = kstToday(now);
  const last = pts[pts.length - 1];
  const current = Math.round(Number(last.price));

  const windowOf = days => {
    const cut = kstToday(now - (days - 1) * 86400000);
    const w = pts.filter(p => String(p.date) >= cut).map(p => Math.round(Number(p.price)));
    if (w.length < 2) return null;
    return {
      days,
      count: w.length,
      low: Math.min.apply(null, w),
      high: Math.max.apply(null, w),
      avg: Math.round(w.reduce((s, v) => s + v, 0) / w.length)
    };
  };
  const window7 = windowOf(7);
  const window30 = windowOf(30);
  // 30일 평균은 statsFrom 값을 쓴다 (같은 창·같은 반올림이라 값도 같다).
  if (window30 && stat && stat.avg30 > 0) window30.avg = stat.avg30;
  if (window7 && stat && stat.avg7 > 0) window7.avg = stat.avg7;

  let prev = null;
  if (pts.length >= 2) {
    const p = pts[pts.length - 2];
    const price = Math.round(Number(p.price));
    const isYesterday = last.date === today && p.date === addDays(today, -1);
    prev = {
      date: p.date,
      price,
      diff: current - price,
      diffPct: pct1(current, price),
      label: isYesterday ? '어제 대비' : `직전 관측(${mmdd(p.date)}) 대비`
    };
  }

  // 30일 평균과의 비교는 그 창에 관측이 3일 이상일 때만 말한다.
  const vsAvg30Pct = window30 && window30.count >= 3 ? pct1(current, window30.avg) : null;
  const isLow30 = !!(window30 && window30.count >= 3 && current <= window30.low);

  const sentences = [];
  if (vsAvg30Pct !== null) {
    const abs = Math.abs(vsAvg30Pct);
    if (abs < 0.1) sentences.push(`현재 가격은 최근 30일 평균(${won(window30.avg)}원)과 같습니다.`);
    else sentences.push(`현재 가격은 최근 30일 평균(${won(window30.avg)}원)보다 ${abs}% ${vsAvg30Pct < 0 ? '낮습니다' : '높습니다'}.`);
  }
  if (isLow30) sentences.push(`최근 30일 동안 SEOSA가 관측한 가격 중 가장 낮은 값과 같습니다.`);
  if (prev) {
    const where = prev.label === '어제 대비' ? '어제' : `직전 관측(${mmdd(prev.date)})`;
    if (prev.diff === 0) sentences.push(`${where}${where === '어제' ? '와' : '과'} 가격이 같습니다.`);
    else sentences.push(`${where}보다 ${won(Math.abs(prev.diff))}원 ${prev.diff < 0 ? '내렸습니다' : '올랐습니다'}.`);
  }

  return { current, lastDate: last.date, today, prev, window7, window30, vsAvg30Pct, isLow30, sentences };
}

/* ── 상품 페이지 title · description ────────────────────────────── */

/**
 * <title>. "상품명 최저가·가격 추이 | SEOSA"
 *
 * ★ «가격비교» 는 이 페이지가 실제로 판매처 2곳 이상을 비교할 때만 쓴다.
 *   상품 페이지는 판매처 하나의 기록이라 «가격 추이» 가 사실이다.
 */
function productTitle(title, opts) {
  const name = shortName(title);
  const sellers = (opts && opts.sellerCount) || 1;
  return `${name} 최저가·${sellers >= 2 ? '가격비교' : '가격 추이'} | SEOSA`;
}

/** meta description. 실제 값만, 160자 안. 상품마다 숫자가 달라 중복되지 않는다. */
function productDescription(o) {
  const name = shortName(o.title, 40);
  const parts = [];
  if (o.price > 0) {
    parts.push(`${name} 현재 ${o.mall ? `${o.mall} ` : ''}${won(o.price)}원${o.lastDate ? `(${mmdd(o.lastDate).replace('-', '/')} 기준)` : ''}.`);
  } else {
    parts.push(`${name} 가격 기록.`);
  }
  const s = o.summary;
  if (s && s.window30 && s.window30.count >= 3) {
    parts.push(`최근 30일 최저 ${won(s.window30.low)}원·평균 ${won(s.window30.avg)}원.`);
  }
  parts.push('SEOSA가 매일 기록한 가격 추이와 구매 시점 판정을 확인하세요.');
  let out = parts.join(' ');
  if (out.length > 160) out = parts.slice(0, -1).join(' ');
  return out.slice(0, 160);
}

/* ── schema.org ─────────────────────────────────────────────────── */

/**
 * 오퍼 → Offer(1곳) 또는 AggregateOffer(2곳 이상).
 *
 * 재고(availability)·유효기간·배송비를 넣지 않는다. SEOSA 는 그 값을 모른다 —
 * 모르는 값을 그럴듯하게 채우면 그것이 거짓 구조화 데이터다.
 *
 * @param {Array<{price:number, seller?:string}>} offers
 */
function offersJsonLd(offers) {
  const list = (offers || []).filter(o => o && Math.round(Number(o.price)) > 0);
  if (!list.length) return null;
  if (list.length === 1) {
    const o = list[0];
    return compact({
      '@type': 'Offer',
      price: Math.round(Number(o.price)),
      priceCurrency: 'KRW',
      seller: o.seller ? { '@type': 'Organization', name: String(o.seller) } : undefined
    });
  }
  const prices = list.map(o => Math.round(Number(o.price)));
  return {
    '@type': 'AggregateOffer',
    priceCurrency: 'KRW',
    lowPrice: Math.min.apply(null, prices),
    highPrice: Math.max.apply(null, prices),
    offerCount: list.length
  };
}

/**
 * Product 구조화 데이터 (Google «제품 스니펫»).
 *
 * ── 예전에는 왜 넣지 않았고, 지금은 왜 넣는가 ──────────────────────
 *
 * 2026-08-30 판단은 "Product/Offer 는 그 페이지가 상품을 파는 경우를 전제로
 * 한다" 였다. 그 전제는 Google 의 «판매자 목록(merchant listing)» 에는 맞지만
 * «제품 스니펫(product snippet)» 에는 맞지 않는다. 제품 스니펫은 직접 구매할
 * 수 없는 페이지(리뷰·가격 비교 페이지)를 위한 것이고, 필수 속성은 name 과
 * offers·review·aggregateRating 중 하나다. 가격 비교 페이지는 offers 로 그
 * 조건을 채운다 — 여러 판매처면 AggregateOffer.
 *
 * 그래서 넣되, 다음을 지킨다.
 *   · 색인되는 페이지(indexable)에만 — 현재가로 쓸 수 있는 live 상품만이다.
 *   · 가격은 화면 큰 글씨와 같은 값 (마지막 관측가).
 *   · review / aggregateRating 은 절대 없다. SEOSA 에는 실제 리뷰가 없다.
 *   · brand 는 레지스트리에서 확인된 브랜드만. 제목 첫 낱말을 추측해 넣지 않는다.
 *   · description 은 SEOSA 가 만든 요약 문장이다. 판매처 원문을 복제하지 않는다.
 *   · image 는 오래 살아 있는 주소만 (ADPICK 임시 토큰 이미지는 몇 시간 뒤 404).
 */
function productJsonLd(p) {
  const offers = offersJsonLd(p.offers);
  if (!p || !p.name || !offers) return null;
  return compact({
    '@type': 'Product',
    '@id': `${p.url}#product`,
    name: String(p.name).slice(0, 200),
    url: p.url,
    image: p.image ? [p.image] : undefined,
    description: p.description,
    sku: p.sku,
    brand: p.brand ? { '@type': 'Brand', name: String(p.brand) } : undefined,
    offers
  });
}

/** [{name, url}] → BreadcrumbList. 마지막 칸은 지금 페이지다. */
function breadcrumbJsonLd(items) {
  const list = (items || []).filter(it => it && it.name && it.url);
  if (!list.length) return null;
  return {
    '@type': 'BreadcrumbList',
    itemListElement: list.map((it, i) => ({
      '@type': 'ListItem', position: i + 1, name: String(it.name).slice(0, 200), item: it.url
    }))
  };
}

/** 목록 페이지의 상품 순서 (요약 페이지 방식 — 각 항목은 자기 상세 페이지 URL). */
function itemListJsonLd(urls) {
  const list = (urls || []).filter(Boolean);
  if (!list.length) return null;
  return {
    '@type': 'ItemList',
    numberOfItems: list.length,
    itemListElement: list.map((url, i) => ({ '@type': 'ListItem', position: i + 1, url }))
  };
}

/* ── 구매 가격이 아닌 표시가 ────────────────────────────────────── */

/*
 * 렌탈·구독 상품의 «가격» 은 월 요금이고, 1원 같은 값은 문의용 명목가다.
 *
 * 2026-10-02 운영 실측 (live 36,717행, 읽기 전용)
 *   제목에 렌탈·구독         43행  — "[렌탈] LG 휘센 … 58,900" (월 요금)
 *   lprice < 100원           20행  — 18행이 1원: "LG냉장고렌탈/구독 … 1원"
 * 이 값을 «최저가» 목록 맨 위에 세우거나 Product 오퍼 가격으로 내면 거짓
 * 가격이 된다 (/brand/lg 에서 «가장 낮은 LG전자 제품은 1원» 이 실제로 나왔다).
 *
 * 그래서 SEO 층에서만 이 행을 뺀다: 색인(noindex) · 구조화 데이터 · 카테고리
 * ·브랜드 목록 · 사이트맵. 상품 페이지 자체와 검색·수집은 그대로다.
 * ★ supabase/2026-10-02-seo-sitemap.sql 의 같은 조건과 맞춰야 한다.
 */
const NON_PURCHASE_RE = /렌탈|구독/;
const NOMINAL_PRICE_MIN = 100;

function isNonPurchaseListing(row) {
  if (!row) return true;
  if (!(Math.round(Number(row.lprice) || 0) >= NOMINAL_PRICE_MIN)) return true;
  return NON_PURCHASE_RE.test(cleanText(row.title));
}

/* ── 이미지 ─────────────────────────────────────────────────────── */

/**
 * og:image · JSON-LD image 에 써도 되는 «오래 사는» 주소인가.
 *
 * ADPICK 의 cloudfront `.../apis/search_img.php?code=` 는 발급 직후에만 열리는
 * 임시 토큰이다 (scripts/collect-external-hotdeals.js 주석의 실측: 몇 시간 뒤 404).
 * 검색엔진·공유 카드가 나중에 가져가면 깨진다 — 그런 주소는 내보내지 않는다.
 */
function isDurableImage(u) {
  const s = String(u || '').trim();
  if (!/^https:\/\//i.test(s)) return false;
  try {
    const url = new URL(s);
    if (/(^|\.)cloudfront\.net$/i.test(url.hostname) && /\/apis\/search_img\.php$/i.test(url.pathname)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

/* ── 카테고리 · 브랜드 레지스트리 ───────────────────────────────── */

/*
 * ── 왜 «사람이 고른 목록» 인가 ──────────────────────────────────────
 *
 * products.keyword 는 수집기가 쓴 검색어다. 2026-10-02 운영 실측에서
 * 상품이 8개 이상 모인 짧은 검색어가 1,835개였다. 전부 페이지로 만들 수
 * 있지만 하지 않는다.
 *
 *   · 그 안에 사용자가 친 문장이 섞여 있다 ("더 싼 데일리 향수 찾기 로
 *     검색해드릴까요?" · "생신 골프용품 너무 싫어"). 검색어마다 페이지를
 *     찍으면 그것이 doorway page 다.
 *   · 같은 개념이 여러 검색어로 갈라져 있다 (마우스 · 무선 마우스 · 게이밍
 *     마우스). 따로 만들면 거의 같은 목록의 페이지가 여럿 생긴다.
 *
 * 그래서 개념 하나 = 페이지 하나로 묶고, 그 개념을 이루는 검색어를 여기
 * 적는다. 목록에 넣는 것은 사람의 결정이고, 넣은 뒤에도 실제 상품 수가
 * CATEGORY_MIN_PRODUCTS 를 넘을 때만 색인된다.
 *
 * 아래 검색어는 전부 2026-10-02 운영 DB 에서 «현재가가 살아 있는 본품
 * (부속 제외)» 이 11개 이상이던 것이다. 추가할 때도 같은 기준으로 확인한다.
 * 다른 상품(악기 키보드 · 세차 샴푸 · 고양이 샴푸 · 노트북 파우치)이 섞이는
 * 검색어는 일부러 뺐다.
 */
const CATEGORIES = [
  { slug: 'laptop', name: '노트북', keywords: ['노트북'] },
  { slug: 'monitor', name: '모니터', keywords: ['4K 모니터', '게이밍 모니터', '27인치 모니터', '서브 모니터'] },
  { slug: 'wireless-earbuds', name: '무선 이어폰', keywords: ['무선 이어폰', '오픈형 이어폰'] },
  { slug: 'mouse', name: '마우스', keywords: ['마우스', '무선 마우스', '게이밍 마우스'] },
  { slug: 'keyboard', name: '키보드', keywords: ['키보드', '게이밍 키보드'] },
  { slug: 'gaming-headset', name: '게이밍 헤드셋', keywords: ['게이밍 헤드셋'] },
  { slug: 'speaker', name: '스피커', keywords: ['게이밍 스피커', '방수 스피커', '포터블 스피커', '북쉘프 스피커', '액티브 스피커'] },
  { slug: 'power-bank', name: '보조배터리', keywords: ['무선 보조배터리', 'PD 보조배터리'] },
  { slug: 'charger', name: '충전기', keywords: ['충전기', '맥세이프 충전기', '4포트 충전기'] },
  { slug: 'projector', name: '프로젝터', keywords: ['UHD 프로젝터'] },
  { slug: 'dehumidifier', name: '제습기', keywords: ['대용량 제습기', '소형 제습기'] },
  { slug: 'humidifier', name: '가습기', keywords: ['가습기', '가열 가습기'] },
  { slug: 'vacuum-cleaner', name: '청소기', keywords: ['물걸레 청소기', '샤크 청소기', '차량용 청소기'] },
  { slug: 'dryer', name: '건조기', keywords: ['건조기'] },
  { slug: 'washing-machine', name: '드럼세탁기', keywords: ['LG 드럼세탁기', '삼성 드럼세탁기'] },
  { slug: 'refrigerator', name: '냉장고', keywords: ['LG 냉장고'] },
  { slug: 'air-circulator', name: '서큘레이터', keywords: ['에어 서큘레이터', '무선 서큘레이터'] },
  { slug: 'portable-fan', name: '휴대용 선풍기', keywords: ['휴대용 선풍기', '목걸이 선풍기', '미니 선풍기'] },
  { slug: 'coffee-machine', name: '커피머신', keywords: ['전자동 커피머신'] },
  { slug: 'coffee-beans', name: '원두', keywords: ['다크로스트 원두', '에스프레소 원두', '블렌드 원두', '브라질 원두', '스페셜티 원두', '에티오피아 원두', '콜롬비아 원두'] },
  { slug: 'rice-cooker', name: '압력밥솥', keywords: ['압력밥솥'] },
  { slug: 'electric-kettle', name: '전기포트', keywords: ['전기포트'] },
  { slug: 'toaster-oven', name: '토스터 오븐', keywords: ['토스터 오븐'] },
  { slug: 'hair-dryer', name: '드라이어', keywords: ['고속 드라이어'] },
  { slug: 'shaver', name: '면도기', keywords: ['면도기'] },
  { slug: 'massage-chair', name: '안마의자', keywords: ['전신 안마의자', '안마 의자'] },
  { slug: 'desk-chair', name: '책상 의자', keywords: ['척추 의자', '게이밍 의자', '공부 의자'] },
  { slug: 'desk', name: '책상', keywords: ['L자형 책상', '학생 책상', '컴퓨터 책상'] },
  { slug: 'mattress', name: '매트리스', keywords: ['라텍스 매트리스', '에어 매트리스'] },
  { slug: 'comforter', name: '이불', keywords: ['오리털 이불', '여름 이불'] },
  { slug: 'tent', name: '텐트', keywords: ['백패킹 텐트', '4인용 텐트', '티피 텐트', '돔 텐트', '가족 텐트', '전실 텐트'] },
  { slug: 'suitcase', name: '캐리어', keywords: ['28인치 캐리어', '24인치 캐리어', '20인치 캐리어', '기내반입 캐리어', '여행용 캐리어', 'PP 캐리어', '알루미늄 캐리어', '소프트 캐리어'] },
  { slug: 'backpack', name: '백팩', keywords: ['여행 백팩', '노트북 백팩', '미니 백팩', '스포츠 백팩'] },
  { slug: 'jeans', name: '청바지', keywords: ['와이드 청바지', '슬림 청바지'] },
  { slug: 'padded-jacket', name: '패딩', keywords: ['롱 패딩', '경량 패딩'] },
  { slug: 'trench-coat', name: '트렌치코트', keywords: ['트렌치코트'] },
  { slug: 'shampoo', name: '샴푸', keywords: ['볼륨 샴푸', '모발강화 샴푸', '저자극 샴푸', '케라틴 샴푸', '탈모 샴푸', '보습 샴푸', '드라이샴푸'] },
  { slug: 'body-lotion', name: '바디로션', keywords: ['바디로션'] },
  { slug: 'moisturizer', name: '수분크림', keywords: ['수분크림'] },
  { slug: 'perfume', name: '향수', keywords: ['향수', '데일리 향수'] },
  { slug: 'diaper', name: '기저귀', keywords: ['기저귀 밴드형', '기저귀 1단계', '기저귀 2단계', '팬티 기저귀'] },
  { slug: 'wet-wipes', name: '물티슈', keywords: ['물티슈', '순면 물티슈'] },
  { slug: 'rice', name: '쌀', keywords: ['햅쌀', '유기농 쌀'] },
  { slug: 'cup-noodles', name: '컵라면', keywords: ['농심 컵라면', '오뚜기 컵라면'] },
  { slug: 'ice-cream', name: '아이스크림', keywords: ['아이스크림'] }
];

/*
 * 브랜드 — 상품명 «첫 낱말» 이 별칭 중 하나와 정확히 같을 때만 그 브랜드다.
 *
 * _query.brandOf 와 같은 관례(한국 쇼핑몰 제목은 브랜드로 시작한다)를 쓰되,
 * 첫 낱말을 그대로 브랜드로 믿지는 않는다. 2026-10-02 실측에서 첫 낱말
 * 상위는 «보리보리 · 해외 · 기타 · 하프클럽 · 현대백화점» — 몰·셀러 이름이었다.
 * 그래서 별칭 목록에 있는 것만 인정한다.
 *
 *   · 제목에 «호환» 이 있으면 그 브랜드 상품이 아니다 ("삼성 호환 리모컨").
 *   · exclude 낱말이 있으면 다른 회사다 (LG생활건강 ≠ LG전자).
 *
 * 별칭의 대소문자 표기는 운영 제목에 실제로 나온 것을 적는다 (DB 접두 검색이
 * 대소문자를 구분한다 — api/_seo-pages.js loadBrandRows 주석).
 */
const BRANDS = [
  { slug: 'samsung', name: '삼성전자', aliases: ['삼성전자', '삼성', 'SAMSUNG'] },
  { slug: 'lg', name: 'LG전자', aliases: ['LG전자', 'LG'], exclude: ['생활건강', '유플러스'] },
  { slug: 'apple', name: 'Apple', aliases: ['Apple', 'APPLE', 'apple', '애플'] },
  { slug: 'sony', name: '소니', aliases: ['소니', 'SONY', 'Sony'] },
  { slug: 'philips', name: '필립스', aliases: ['필립스', 'PHILIPS'] },
  { slug: 'xiaomi', name: '샤오미', aliases: ['샤오미', 'Xiaomi', 'XIAOMI'] },
  { slug: 'logitech', name: '로지텍', aliases: ['로지텍', '로지텍코리아', 'Logitech'] },
  { slug: 'hp', name: 'HP', aliases: ['HP'] },
  { slug: 'canon', name: '캐논', aliases: ['캐논', 'Canon', 'CANON'] },
  { slug: 'nintendo', name: '닌텐도', aliases: ['닌텐도', 'Nintendo'] },
  { slug: 'tp-link', name: '티피링크', aliases: ['티피링크', 'TP-Link', 'TP-LINK'] },
  { slug: 'britz', name: '브리츠', aliases: ['브리츠', 'Britz'] },
  { slug: 'iriver', name: '아이리버', aliases: ['아이리버', 'iriver'] },
  { slug: 'cuckoo', name: '쿠쿠', aliases: ['쿠쿠', 'CUCKOO'] },
  { slug: 'shinil', name: '신일', aliases: ['신일'] },
  { slug: 'nike', name: '나이키', aliases: ['나이키', 'NIKE', 'Nike'] },
  { slug: 'adidas', name: '아디다스', aliases: ['아디다스', 'adidas', 'ADIDAS'] },
  { slug: 'new-balance', name: '뉴발란스', aliases: ['뉴발란스'] },
  { slug: 'lego', name: '레고', aliases: ['레고', 'LEGO'] },
  { slug: 'ikea', name: '이케아', aliases: ['이케아', 'IKEA'] },
  { slug: 'hanssem', name: '한샘', aliases: ['한샘'] },
  { slug: 'cj', name: 'CJ제일제당', aliases: ['CJ제일제당', 'CJ'] },
  { slug: 'pulmuone', name: '풀무원', aliases: ['풀무원'] },
  { slug: 'ottogi', name: '오뚜기', aliases: ['오뚜기'] },
  { slug: 'nongshim', name: '농심', aliases: ['농심'] }
];

/** 색인 문턱 — 이보다 적으면 페이지는 열리지만 noindex 이고 사이트맵에 없다. */
const CATEGORY_MIN_PRODUCTS = 8;
const BRAND_MIN_PRODUCTS = 8;

const CATEGORY_BY_SLUG = new Map(CATEGORIES.map(c => [c.slug, c]));
const BRAND_BY_SLUG = new Map(BRANDS.map(b => [b.slug, b]));
const CATEGORY_BY_KEYWORD = new Map();
CATEGORIES.forEach(c => c.keywords.forEach(k => CATEGORY_BY_KEYWORD.set(k, c)));
const BRAND_BY_ALIAS = new Map();
BRANDS.forEach(b => b.aliases.forEach(a => BRAND_BY_ALIAS.set(a.toLowerCase(), b)));

function categoryBySlug(slug) { return CATEGORY_BY_SLUG.get(String(slug || '').toLowerCase()) || null; }
function brandBySlug(slug) { return BRAND_BY_SLUG.get(String(slug || '').toLowerCase()) || null; }
/** products.keyword → 카테고리 (정확히 같은 검색어만). */
function categoryOfKeyword(keyword) { return CATEGORY_BY_KEYWORD.get(String(keyword || '').trim()) || null; }

let brandOfFn = null;
function firstToken(title) {
  if (!brandOfFn) brandOfFn = require('./_query').brandOf;
  return brandOfFn(title);
}

/** 상품명 → 레지스트리 브랜드 (확인되지 않으면 null). */
function brandOfTitle(title) {
  const t = String(title || '');
  if (!t || /호환/.test(t)) return null;
  const b = BRAND_BY_ALIAS.get(String(firstToken(t) || '').toLowerCase());
  if (!b) return null;
  if ((b.exclude || []).some(w => t.indexOf(w) > -1)) return null;
  return b;
}

function categoryUrl(c) { return `${SITE}/category/${c.slug}`; }
function brandUrl(b) { return `${SITE}/brand/${b.slug}`; }

/* ── 사이트맵 XML ───────────────────────────────────────────────── */

/** 한 사이트맵 파일의 URL 상한 — 프로토콜 상한(50,000)보다 넉넉히 낮게. */
const SITEMAP_FILE_MAX = 45000;

/** [{loc, lastmod?}] → urlset */
function urlsetXml(entries) {
  const rows = (entries || []).filter(e => e && e.loc).slice(0, SITEMAP_FILE_MAX).map(e =>
    `  <url><loc>${xmlEsc(e.loc)}</loc>${/^\d{4}-\d{2}-\d{2}$/.test(e.lastmod || '') ? `<lastmod>${e.lastmod}</lastmod>` : ''}</url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    .concat(rows, ['</urlset>']).join('\n');
}

/** [{loc, lastmod?}] → sitemapindex */
function sitemapIndexXml(entries) {
  const rows = (entries || []).filter(e => e && e.loc).map(e =>
    `  <sitemap><loc>${xmlEsc(e.loc)}</loc>${/^\d{4}-\d{2}-\d{2}$/.test(e.lastmod || '') ? `<lastmod>${e.lastmod}</lastmod>` : ''}</sitemap>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    .concat(rows, ['</sitemapindex>']).join('\n');
}

module.exports = {
  SITE, esc, xmlEsc, cleanText, won, jsonLdScript, compact, verificationMeta,
  shortName, priceSummary, productTitle, productDescription,
  offersJsonLd, productJsonLd, breadcrumbJsonLd, itemListJsonLd, isDurableImage, isNonPurchaseListing, NOMINAL_PRICE_MIN,
  CATEGORIES, BRANDS, CATEGORY_MIN_PRODUCTS, BRAND_MIN_PRODUCTS,
  categoryBySlug, brandBySlug, categoryOfKeyword, brandOfTitle, categoryUrl, brandUrl,
  urlsetXml, sitemapIndexXml, SITEMAP_FILE_MAX, TITLE_NAME_MAX
};
