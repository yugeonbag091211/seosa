'use strict';
/*
 * 카테고리 · 브랜드 랜딩 페이지와 사이트맵 인덱스 — 서버 렌더 (2026-10-02).
 *
 *   /category                 허브 (색인 문턱을 넘은 카테고리·브랜드 목록)
 *   /category/{slug}          카테고리 — api/_seo.js CATEGORIES 에 있는 것만
 *   /brand/{slug}             브랜드   — api/_seo.js BRANDS 에 있는 것만
 *   /sitemap.xml              사이트맵 인덱스
 *   /sitemaps/pages.xml       홈 · 허브 · 카테고리 · 브랜드
 *   /sitemaps/products-N.xml  상품 페이지 (products.id 범위로 나눈다)
 *
 * 새 서버리스 함수를 만들지 않는다 — api/history.js 의 __route 에 얹는다
 * (Vercel Hobby 함수 12개 상한, 이미 12개).
 *
 * ── 지키는 선 ──────────────────────────────────────────────────────
 *
 *   · 페이지 목록은 레지스트리(사람이 고른 것)다. 검색어마다 페이지를 찍지 않는다.
 *   · 상품이 문턱보다 적으면 페이지는 열려도 noindex 이고 사이트맵에 없다.
 *   · 목록의 값은 전부 products · price_history 에 실제로 있는 것이다.
 *   · 상품을 고르는 규칙은 화면과 같다 — 현재가가 살아 있는 행(freshRows 규칙),
 *     검색어와 관련 있는 행(relevantRows), 본품(부속 제외, _search.
 *     filterMainProductCandidates). 새 매칭 규칙을 만들지 않는다.
 *   · 읽기 전용. 아무것도 쓰지 않는다. 외부 API(쿠팡·ADPICK)를 부르지 않는다.
 */

const supabase = require('./_supabase');
const SEO = require('./_seo');
const { cachePublic } = require('./_http');
const { productLifecycle, LIFECYCLE, MAX_DISPLAY_AGE_DAYS, sameVendorRows, observedKstDate, kstToday } = require('./_price');
const { relevantRows } = require('./_shop');
const { withDbRetry } = require('./_dberror');

const { SITE, esc, won } = SEO;

const LIST_COLS = 'id, product_id, mall, mall_label, keyword, title, lprice, image, link, collected_at, vendor_item_id';
/** 허브 집계용 — 판정(usable · 관련성 · 본품 · 브랜드)에 필요한 컬럼만. */
const HUB_COLS = 'id, product_id, mall, keyword, title, lprice, link, collected_at';
/** 목록에 그리는 상품 수. 나머지는 SEOSA 검색으로 이어 준다. */
const LIST_SHOW = 60;
/** 한 페이지가 읽는 products 페이지 수 상한 (1,000행/페이지). */
const MAX_PAGES = 4;
/** 허브 집계 메모 — 인스턴스 안에서만. 캐시 미스가 겹쳐도 DB 를 한 번만 친다. */
const HUB_MEMO_MS = 10 * 60 * 1000;
/** 사이트맵 상품 파일 하나가 맡는 products.id 폭. URL 상한(45,000)보다 작다. */
const PRODUCT_ID_RANGE = 40000;

const PAGE_CACHE_S = 60 * 60;          // 1시간 — 가격은 하루 한 번 바뀐다
const SITEMAP_CACHE_S = 12 * 60 * 60;  // 12시간 (예전 /sitemap-products.xml 과 같다)

const PID_RE = /^[0-9a-f]{1,64}$/i;
const SLUG_RE = /^[a-z0-9-]{1,40}$/;

function pageUrl(pid) { return `${SITE}/p/${encodeURIComponent(pid)}`; }
function safeUrl(u) { const s = String(u == null ? '' : u).trim(); return /^https?:\/\//i.test(s) ? s : ''; }
function liveCutoffIso() { return new Date(Date.now() - MAX_DISPLAY_AGE_DAYS * 86400000).toISOString(); }
/** 판매처 표시 이름. ADPICK 은 제휴 네트워크 이름이지 판매처가 아니다 — 몰 이름이 없으면 «제휴몰». */
function mallName(r) { return r.mall_label || (r.mall === 'ADPICK' ? '제휴몰' : r.mall) || ''; }

/* ══════════════════════════════════════════════════════════════════
 *  데이터
 * ══════════════════════════════════════════════════════════════════ */

/**
 * range 로 끝까지 (maxPages 상한). 순서가 고정돼야 페이지가 겹치지 않는다 — id 순.
 * desc 는 상한에 걸렸을 때 «최근 행» 이 남아야 하는 곳(가격 기록)에 쓴다.
 *
 * ★ 페이지는 순차로, count 없이 읽는다. 2026-10-02 로컬 검증 중 허브 집계가
 *   운영 DB 에서 statement timeout 으로 한 번 실패했다(같은 시각 /api/init 도
 *   같은 오류). 동시 요청·count(*) 를 얹으면 DB 가 바쁠 때 더 쉽게 넘어진다.
 *   이 결과는 Edge 에서 몇 시간씩 캐시되므로 몇 초 느린 편이 낫다.
 *   일시 장애(timeout·연결)는 _dberror.withDbRetry 로 한 번만 다시 시도한다.
 */
async function readAll(build, maxPages, desc) {
  const PAGE = 1000;
  const out = [];
  for (let i = 0; i < (maxPages || MAX_PAGES); i++) {
    const { data, error } = await withDbRetry(
      () => build().order('id', { ascending: !desc }).range(i * PAGE, i * PAGE + PAGE - 1),
      { attempts: 2, baseDelayMs: 500 });
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** 현재가로 쓸 수 있고(/p/ 페이지가 열리고) 판매처 링크가 있는 행. */
function usable(rows) {
  return (rows || []).filter(r => r
    && productLifecycle(r).state === LIFECYCLE.LIVE
    && !SEO.isNonPurchaseListing(r)      // 렌탈 월 요금·1원 명목가는 «최저가» 가 아니다
    && safeUrl(r.link)
    && PID_RE.test(String(r.product_id || '')));
}

let searchMod = null;
function mainOnly(rows, keyword) {
  if (!searchMod) searchMod = require('./_search');
  return searchMod.filterMainProductCandidates(keyword, rows).items;
}

function dedupe(rows) {
  const seen = new Set();
  return (rows || []).filter(r => {
    const k = `${r.product_id}|${r.mall}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/*
 * 카테고리 중앙값 대비 이 비율보다 싼 행은 그 카테고리의 본품으로 보지 않는다.
 *
 * ── 왜 필요한가 (2026-10-02 운영 실측, /category/laptop) ──────────────
 *
 * 관련성(relevantRows)과 부속 낱말(ACCESSORY_TIER)을 통과한 «노트북» 33개 중
 * 현재가 하위 5개가 전부 본품이 아니었다.
 *     7,520원  "… 노트북 키보드 키캡용 싱글 키 힌지 고무"
 *    27,500원  "LG 그램 노트북 핀 타입 19V … 2.53A"  (어댑터)
 *    37,170원 · 43,560원  "… 백팩 노트북 태블릿 …"
 *    69,700원  "여성 … 노트북가방 숄더백"
 * 목록이 «현재가 낮은 순» 이라 이런 행이 맨 위에 서고, «가장 싼 노트북은
 * 7,520원» 이라는 거짓 문장이 된다.
 *
 * 검색 순위의 late-head 감점으로 거르려 했지만 그 값(0.65)은 «LG 그램 Pro AI
 * 노트북» 같은 진짜 본품에도 똑같이 붙는다 — 쓸 수 없다. 값 차이는 다르다:
 * 위 5개는 전부 중앙값(53만원)의 13% 미만이고 본품 최저(17만원)는 34%다.
 *
 * _hotgroup MERGE_MIN_PRICE_RATIO · _radar 대체 상품 가격대와 같은 생각이다 —
 * «제목이 닮아도 값이 터무니없이 다르면 같은 물건이 아니다». 이 목록에만
 * 쓴다. 검색 결과와 상품 페이지는 건드리지 않는다.
 */
const CATEGORY_MIN_PRICE_RATIO = 0.2;
/** 중앙값이 의미를 가지려면 이만큼은 있어야 한다. 적으면 거르지 않는다. */
const PRICE_BAND_MIN_ROWS = 5;

function priceBand(rows) {
  const prices = rows.map(r => Number(r.lprice) || 0).filter(v => v > 0).sort((a, b) => a - b);
  if (prices.length < PRICE_BAND_MIN_ROWS) return rows;
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
  return rows.filter(r => (Number(r.lprice) || 0) >= median * CATEGORY_MIN_PRICE_RATIO);
}

/** 카테고리에 속한 본품 — 검색어마다 그 검색어로 관련성·부속을 거르고, 값이 동떨어진 행을 뺀다. */
function categoryProducts(cat, rows) {
  const byKw = new Map();
  usable(rows).forEach(r => {
    if (!byKw.has(r.keyword)) byKw.set(r.keyword, []);
    byKw.get(r.keyword).push(r);
  });
  let out = [];
  cat.keywords.forEach(kw => { out = out.concat(mainOnly(relevantRows(byKw.get(kw) || []), kw)); });
  return priceBand(dedupe(out));
}

/**
 * 브랜드에 속한 본품 — 제목 첫 낱말이 별칭과 정확히 같은 것만 (_seo.brandOfTitle).
 *
 * memberKeysOf(cat) 가 주어지면, 레지스트리 카테고리 검색어로 모인 행은 그 카테고리의
 * 본품이기도 해야 한다 (상품 페이지 productContext 의 brand 규칙과 같다). 그래야
 * «LG 그램 노트북 핀 타입 19V» 어댑터가 /brand/lg 에는 LG전자 제품으로 오르고 그
 * 상품 페이지는 brand 를 빼는 식으로 두 곳이 갈리지 않는다. 판정 집합이 없으면 뺀다.
 */
function brandProducts(brand, rows, memberKeysOf) {
  const mine = usable(rows).filter(r => SEO.brandOfTitle(r.title) === brand);
  const main = dedupe(mainOnly(mine, brand.name));
  if (!memberKeysOf) return main;
  return main.filter(r => {
    const cat = SEO.categoryOfKeyword(r.keyword);
    if (!cat) return true;
    const keys = memberKeysOf(cat);
    return !!keys && keys.has(`${r.product_id}|${r.mall}`);
  });
}

/** 행 목록에 나오는 레지스트리 카테고리들의 본품 집합 (인스턴스 메모 재사용). */
async function memberKeysFor(rows) {
  const cats = new Map();
  (rows || []).forEach(r => { const c = SEO.categoryOfKeyword(r.keyword); if (c) cats.set(c.slug, c); });
  const sets = new Map();
  await Promise.all([...cats.values()].map(async c => { sets.set(c.slug, await categoryMemberKeys(c)); }));
  return cat => sets.get(cat.slug);
}

/*
 * 상품 페이지의 카테고리 breadcrumb · Product.brand (2026-10-02 레드팀 후속).
 *
 * 레드팀이 실제로 찾은 것: 키워드 «노트북» 으로 수집된 백팩·노트북가방·«LG 그램
 * 노트북 핀 타입 19V» 어댑터가 index 페이지에서 «홈 › 노트북 › …» 이었고, 어댑터는
 * brand=LG전자 였다. «닌텐도 스위치 OLED 전용 필름» 은 brand=닌텐도.
 *
 *   카테고리 — 그 카테고리 목록(categoryProducts)에 «실제로 드는» 상품일 때만.
 *              목록 페이지와 같은 함수·같은 행이라 둘의 판단이 갈리지 않는다.
 *   브랜드   — 첫 낱말 별칭(brandOfTitle) + 브랜드 목록의 본품 판정(brandProducts:
 *              부속 낱말이 있으면 탈락) + 카테고리 검색어로 모인 상품이면 그
 *              카테고리 본품이어야 한다(어댑터처럼 부속 낱말이 없는 부속을 막는다).
 *   판정할 수 없으면(조회 실패 등) 둘 다 비운다 — 틀린 계층·브랜드보다 없는 편이 낫다.
 *
 * 검색·매칭 로직은 바꾸지 않는다. SEO 메타데이터 판정에만 쓴다.
 *
 * ★ 비용: 카테고리 검색어로 모인 상품 페이지는 그 카테고리 목록 조회가 1회 늘어난다.
 *   같은 인스턴스에서 같은 카테고리의 상품 페이지가 이어서 그려지면(크롤러가 흔히
 *   그렇게 돈다) 본품 집합을 CATEGORY_MEMBERS_MEMO_MS 동안 재사용한다. 본품 집합은
 *   가격 수집(하루 한 번) 때만 바뀌므로 10분 묵어도 판단이 달라지지 않는다.
 */
const CATEGORY_MEMBERS_MEMO_MS = 10 * 60 * 1000;
const categoryMembersMemo = new Map();   // slug → { at, keys: Set<'pid|mall'> } 또는 진행 중 Promise

function categoryMemberKeys(cat) {
  const hit = categoryMembersMemo.get(cat.slug);
  if (hit && hit.keys && Date.now() - hit.at < CATEGORY_MEMBERS_MEMO_MS) return Promise.resolve(hit.keys);
  if (hit && hit.pending) return hit.pending;
  const pending = loadCategoryRows(cat)
    .then(rows => {
      const keys = new Set(categoryProducts(cat, rows).map(r => `${r.product_id}|${r.mall}`));
      categoryMembersMemo.set(cat.slug, { at: Date.now(), keys });
      return keys;
    })
    .catch(e => { categoryMembersMemo.delete(cat.slug); throw e; });
  categoryMembersMemo.set(cat.slug, { pending });
  return pending;
}

async function productContext(row) {
  if (!row) return {};
  const cat = SEO.categoryOfKeyword(row.keyword);
  let category = null;
  if (cat) {
    const keys = await categoryMemberKeys(cat);
    if (keys.has(`${row.product_id}|${row.mall}`)) category = cat;
  }
  const b = SEO.brandOfTitle(SEO.cleanText(row.title));
  const brandOk = !!b && brandProducts(b, [row]).length === 1 && (!cat || !!category);
  return { category, brand: brandOk ? b : null };
}

/**
 * DB 접두 검색 조건 — 다른 별칭으로 시작하는 별칭은 뺀다 (LG전자 ⊂ LG*).
 * 대소문자를 구분한다(아래 like). 운영 제목은 "[나이키] …" 처럼 대괄호로
 * 시작하는 것이 많아서(2026-10-02 실측: [나이키] 80 · [삼성] 76 · [LG] 45)
 * 같은 별칭의 «[별칭» 접두도 함께 찾는다. 최종 판정은 brandOfTitle 이 한다.
 */
function brandPrefixes(brands) {
  const all = [];
  brands.forEach(b => b.aliases.forEach(a => { if (all.indexOf(a) < 0) all.push(a); }));
  const base = all.filter(a => !all.some(o => o !== a && a.startsWith(o)));
  return base.concat(base.map(a => `[${a}`));
}

async function loadCategoryRows(cat) {
  const cutoff = liveCutoffIso();
  return readAll(opts => supabase.from('products').select(LIST_COLS, opts)
    .in('keyword', cat.keywords).gte('collected_at', cutoff), MAX_PAGES);
}

/*
 * 브랜드 후보 — 제목 접두 검색.
 *
 * ★ PostgREST or 조건 안의 값은 , . ( ) : 를 구분자로 쓴다. 별칭에 그런 문자가
 *   있으면 조건이 깨진다 — 레지스트리 별칭은 영문·한글·숫자·하이픈만 쓴다
 *   (scripts/test-seo.js 가 확인한다). 와일드카드 % · _ 도 별칭에 없다.
 *
 * ★ like(대소문자 구분)를 쓴다. 2026-10-02 운영 실측(접두 41개, 읽기 전용):
 *     ilike  count 4,461 ms · 2,039행
 *     like   count   558 ms · 2,032행
 *   대소문자 표기는 별칭에 따로 적는다(SONY · Sony). 최종 판정은 어차피
 *   _seo.brandOfTitle 이 대소문자 없이 한다 — 여기는 후보를 좁히는 단계다.
 *   허브와 브랜드 페이지가 «같은» 조건을 써야 상품 수가 같다.
 */
async function loadBrandRows(brands, cols) {
  const cutoff = liveCutoffIso();
  const ors = brandPrefixes(brands).map(a => `title.like.${a}*`).join(',');
  return readAll(opts => supabase.from('products').select(cols || LIST_COLS, opts)
    .or(ors).gte('collected_at', cutoff), MAX_PAGES + 2);
}

/** 상품 목록에 가격 기록을 붙인다 — 관측 일수 · 직전 관측 대비 · 30일 최저. 실패하면 빈 Map. */
async function loadHistory(products) {
  const out = new Map();
  const list = (products || []).slice(0, LIST_SHOW);
  if (!list.length) return out;
  const ids = [...new Set(list.map(p => String(p.product_id)))];
  // 20개씩 · 최근 행부터 3,000행 — 상품 하나에 150행이면 하루 여러 번 관측해도 수십 일치다.
  const CHUNK = 20;
  const chunks = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  try {
    const rows = [];
    await Promise.all(chunks.map(async chunk => {
      const got = await readAll(opts => supabase.from('price_history')
        .select('id, product_id, mall, price, recorded_at, recorded_date, vendor_item_id', opts)
        .in('product_id', chunk), 3, true);
      rows.push(...got);
    }));
    const byKey = new Map();
    rows.forEach(r => {
      const k = `${r.product_id}|${r.mall}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    });
    const cut30 = kstToday(Date.now() - 29 * 86400000);
    list.forEach(p => {
      const k = `${p.product_id}|${p.mall}`;
      const daily = new Map();
      sameVendorRows(byKey.get(k) || [], p.vendor_item_id).forEach(r => {
        const d = observedKstDate(r);
        if (!d || !(Number(r.price) > 0)) return;
        const cur = daily.get(d);
        if (cur === undefined || r.price < cur) daily.set(d, Math.round(Number(r.price)));
      });
      const pts = [...daily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      if (!pts.length) return;
      const last = pts[pts.length - 1];
      const prev = pts.length >= 2 ? pts[pts.length - 2] : null;
      const w30 = pts.filter(x => x[0] >= cut30).map(x => x[1]);
      out.set(k, {
        days: pts.length,
        lastDate: last[0],
        diff: prev ? last[1] - prev[1] : 0,
        prevDate: prev ? prev[0] : '',
        low30: w30.length >= 3 ? Math.min.apply(null, w30) : 0
      });
    });
  } catch (e) {
    console.warn(`[seo] 가격 기록을 붙이지 못했다 — 기록 없이 그린다: ${e.message}`);
  }
  return out;
}

/** 목록 요약 — 전부 실제 값에서. */
function listStats(products) {
  const prices = products.map(p => Math.round(Number(p.lprice) || 0)).filter(v => v > 0).sort((a, b) => a - b);
  if (!prices.length) return null;
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2);
  const malls = new Map();
  products.forEach(p => { const m = mallName(p); malls.set(m, (malls.get(m) || 0) + 1); });
  const updated = products.reduce((m, p) => (String(p.collected_at || '') > m ? String(p.collected_at) : m), '');
  return {
    count: products.length,
    low: prices[0],
    high: prices[prices.length - 1],
    median,
    malls: [...malls.entries()].sort((a, b) => b[1] - a[1]),
    updated: updated ? kstToday(Date.parse(updated)) : ''
  };
}

/* ── 허브 집계 (허브 페이지 · pages.xml 이 같이 쓴다) ──────────────── */

let hubMemo = null;
let hubInflight = null;

async function computeHub() {
  const keywords = [];
  SEO.CATEGORIES.forEach(c => c.keywords.forEach(k => keywords.push(k)));
  const cutoff = liveCutoffIso();
  const CHUNK = 30;
  const kwChunks = [];
  for (let i = 0; i < keywords.length; i += CHUNK) kwChunks.push(keywords.slice(i, i + CHUNK));

  // 허브는 «몇 개인가» 만 센다 — 이미지·옵션 컬럼은 받지 않는다 (전송량이 절반이 된다).
  const [catRowSets, brandRows, eligible] = await Promise.all([
    Promise.all(kwChunks.map(chunk => readAll(opts => supabase.from('products').select(HUB_COLS, opts)
      .in('keyword', chunk).gte('collected_at', cutoff), MAX_PAGES))),
    loadBrandRows(SEO.BRANDS, HUB_COLS),
    eligibleProductIds()
  ]);
  const catRows = [].concat(...catRowSets);

  const entry = (kind, def, products, gate) => {
    const st = listStats(products);
    const g = gate(products, eligible);
    return { kind, def, count: products.length, tracked: g.tracked, lastmod: st ? st.updated : '', indexable: g.indexable };
  };
  // 카테고리 본품 집합은 이미 읽은 행으로 만든다 — 브랜드 판정(brandProducts)에 추가 조회가 없다.
  const catMembers = new Map(SEO.CATEGORIES.map(c => [c.slug, categoryProducts(c, catRows)]));
  const memberKeys = new Map([...catMembers].map(([slug, list]) => [slug, new Set(list.map(r => `${r.product_id}|${r.mall}`))]));
  return {
    categories: SEO.CATEGORIES.map(c => entry('category', c, catMembers.get(c.slug), categoryGate)),
    brands: SEO.BRANDS.map(b => entry('brand', b, brandProducts(b, brandRows, cat => memberKeys.get(cat.slug)), brandGate))
  };
}

/*
 * 목록 페이지 색인 판정 — 카테고리·브랜드 페이지 · 허브 · pages.xml 이 이 둘만 쓴다.
 *   ① 현재가가 살아 있는 본품 ≥ *_MIN_PRODUCTS
 *   ② 그중 상품 페이지가 index 인 것(= 상품 사이트맵에 오른 것) ≥ *_MIN_TRACKED
 * ②의 판정은 상품 사이트맵과 «같은 목록» 을 쓴다 — 목록마다 따로 이력을 세지 않는다.
 */
function trackedCount(products, eligible) {
  return products.filter(p => eligible.has(String(p.product_id))).length;
}
function categoryGate(products, eligible) {
  const tracked = trackedCount(products, eligible);
  return { tracked, indexable: products.length >= SEO.CATEGORY_MIN_PRODUCTS && tracked >= SEO.CATEGORY_MIN_TRACKED };
}
function brandGate(products, eligible) {
  const tracked = trackedCount(products, eligible);
  return { tracked, indexable: products.length >= SEO.BRAND_MIN_PRODUCTS && tracked >= SEO.BRAND_MIN_TRACKED };
}

async function hubData() {
  if (hubMemo && Date.now() - hubMemo.at < HUB_MEMO_MS) return hubMemo.data;
  if (!hubInflight) {
    hubInflight = computeHub()
      .then(data => { hubMemo = { at: Date.now(), data }; return data; })
      .catch(e => {
        // 다시 세지 못했으면 직전 결과를 쓴다 (같은 인스턴스가 이미 센 값이다). 없으면 오류.
        if (!hubMemo) throw e;
        console.warn(`[seo] 허브 집계 실패 — ${Math.round((Date.now() - hubMemo.at) / 60000)}분 전 결과를 쓴다: ${e.message}`);
        return hubMemo.data;
      })
      .finally(() => { hubInflight = null; });
  }
  return hubInflight;
}

/* ══════════════════════════════════════════════════════════════════
 *  HTML
 * ══════════════════════════════════════════════════════════════════ */

/* 상품 페이지(api/_product-page.js)와 같은 색·글꼴·폭이다. */
const CSS = [
  ':root{--ink:#111;--soft:#5b616b;--line:#e6e8eb;--bg:#fff;--brass:#8A6D1C;--down:#0b7a4b;--up:#c9362b}',
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);',
  'font-family:Pretendard,"Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif;line-height:1.55;-webkit-font-smoothing:antialiased}',
  'a{color:inherit}.wrap{max-width:760px;margin:0 auto;padding:0 20px}',
  'header{border-bottom:1px solid var(--line)}header .wrap{display:flex;align-items:center;justify-content:space-between;height:56px}',
  '.logo{font-weight:800;letter-spacing:.14em;text-decoration:none;font-size:.95rem}.logo b{color:var(--brass)}',
  '.hlink{font-size:.82rem;color:var(--soft);text-decoration:none}',
  '.crumb{font-size:.78rem;color:var(--soft);margin:20px 0 8px}.crumb a{text-decoration:none;color:var(--soft)}.crumb a:hover{color:var(--ink)}',
  'h1{font-size:1.28rem;line-height:1.4;margin:0 0 6px;letter-spacing:-.01em}',
  '.meta{font-size:.8rem;color:var(--soft);margin:0 0 18px}',
  '.facts{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:0 0 12px}@media(max-width:560px){.facts{grid-template-columns:repeat(2,1fr)}}',
  '.facts div{border:1px solid var(--line);border-radius:6px;padding:10px 12px}.facts dt{font-size:.7rem;color:var(--soft)}.facts dd{margin:0;font-weight:700;font-variant-numeric:tabular-nums}',
  '.lead{font-size:.88rem;color:var(--soft);margin:0 0 6px}',
  'h2{font-size:1rem;margin:30px 0 10px}',
  '.plist{list-style:none;padding:0;margin:0;border-top:1px solid var(--line)}',
  '.plist li{border-bottom:1px solid var(--line)}.plist a{display:grid;grid-template-columns:56px 1fr auto;gap:12px;align-items:center;padding:10px 0;text-decoration:none}',
  '.plist .th{width:56px;height:56px;border:1px solid var(--line);border-radius:6px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#fff}',
  '.plist .th img{max-width:100%;max-height:100%;object-fit:contain}',
  '.plist .t{font-size:.84rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.plist a>span:nth-child(2){min-width:0}',
  '@media(max-width:560px){.plist a{grid-template-columns:48px 1fr auto;gap:10px}.plist .th{width:48px;height:48px}}',
  '.plist .s{display:block;font-size:.72rem;color:var(--soft);margin-top:2px}',
  '.plist .p{text-align:right;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.plist .d{display:block;font-size:.72rem;font-weight:400}.plist .d.down{color:var(--down)}.plist .d.up{color:var(--up)}',
  '.more{margin:16px 0 0;font-size:.86rem}',
  '.tiles{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(3,1fr);gap:10px}@media(max-width:560px){.tiles{grid-template-columns:repeat(2,1fr)}}',
  '.tiles a{display:block;border:1px solid var(--line);border-radius:6px;padding:12px;text-decoration:none}.tiles b{display:block}.tiles span{font-size:.74rem;color:var(--soft)}',
  'footer{margin:48px 0 32px;font-size:.74rem;color:var(--soft);border-top:1px solid var(--line);padding-top:16px}'
].join('');

function layout(o) {
  const graph = (o.jsonLd || []).filter(Boolean);
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta name="robots" content="${o.indexable ? 'index,follow' : 'noindex,follow'}">
${o.canonical ? `<link rel="canonical" href="${esc(o.canonical)}">` : ''}
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${SEO.verificationMeta()}
<meta property="og:type" content="website">
<meta property="og:site_name" content="SEOSA">
<meta property="og:locale" content="ko_KR">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
${o.canonical ? `<meta property="og:url" content="${esc(o.canonical)}">` : ''}
<meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary">
${graph.length ? SEO.jsonLdScript({ '@context': 'https://schema.org', '@graph': graph }) : ''}
<style>${CSS}</style>
</head>
<body>
<header><div class="wrap">
  <a class="logo" href="/">SEO<b>SA</b></a>
  ${o.headerLink || ''}
</div></header>
<main class="wrap">
${o.body}
</main>
<footer class="wrap">
  SEOSA 는 상품을 직접 팔지 않아요. 목록의 가격은 SEOSA 가 판매처에서 <b>관측한 값</b>이고 실제 결제 금액과 다를 수 있어요.
  실제 결제 금액은 판매처에서 확인해 주세요.
</footer>
</body>
</html>`;
}

function crumbs(items) {
  return `<nav class="crumb" aria-label="경로">${items.map((it, i) =>
    (i < items.length - 1 && it.href ? `<a href="${esc(it.href)}">${esc(it.name)}</a>` : esc(it.name))).join(' › ')}</nav>`;
}

function diffBadge(h) {
  // 관측 일수는 제목 아랫줄에 이미 있다 — 바뀐 값이 있을 때만 배지를 단다.
  if (!h || !h.prevDate || !h.diff) return '';
  const down = h.diff < 0;
  return `<span class="d ${down ? 'down' : 'up'}">${down ? '▼' : '▲'}${won(Math.abs(h.diff))}원 <span class="s" style="display:inline">직전 관측 대비</span></span>`;
}

function productList(products, hist) {
  return `<ol class="plist">${products.map(p => {
    const h = hist.get(`${p.product_id}|${p.mall}`);
    const img = SEO.isDurableImage(p.image) ? p.image : '';
    const name = SEO.shortName(p.title, 60);
    return `
  <li><a href="/p/${encodeURIComponent(p.product_id)}">
    <span class="th">${img ? `<img src="${esc(img)}" alt="${esc(name)}" width="56" height="56" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>
    <span><span class="t">${esc(SEO.cleanText(p.title))}</span><span class="s">${esc(mallName(p))}${h && h.days >= 2 ? ` · 기록 ${h.days}일` : ''}${h && h.low30 ? ` · 30일 최저 ${won(h.low30)}원` : ''}</span></span>
    <span class="p">${won(p.lprice)}원${diffBadge(h)}</span>
  </a></li>`;
  }).join('')}
</ol>`;
}

/*
 * 목록 순서.
 *
 *   카테고리  현재가 낮은 순 — 같은 종류의 물건이라 값끼리 견줄 수 있다.
 *   브랜드    현재가 높은 순 — 한 브랜드 안에는 TV 와 리모컨이 섞여 있다. 낮은 순이면
 *             호환 리모컨(7,400원)이 «가장 싼 LG전자 제품» 으로 맨 위에 선다
 *             (2026-10-02 /brand/lg 실측). 값을 견줄 수 없는 묶음에 «최저» 를 말하지 않는다.
 */
function orderProducts(products, order) {
  const sign = order === 'desc' ? -1 : 1;
  return products.slice().sort((a, b) => sign * ((Number(a.lprice) || 0) - (Number(b.lprice) || 0)));
}

/** 카테고리·브랜드 페이지 공통. */
function renderListing(o) {
  const { name, products, hist, stats, canonical, indexable, crumbTrail, searchQuery } = o;
  const order = o.order === 'desc' ? 'desc' : 'asc';
  const shown = orderProducts(products, order).slice(0, LIST_SHOW);
  // 가격 기록은 화면에 그린 목록(shown)에만 붙어 있다 — 그래서 문구도 «목록 중» 이라고 말한다.
  const drops = [...hist.values()].filter(h => h.prevDate && h.diff < 0).length;
  const tracked = [...hist.values()].filter(h => h.days >= 7).length;

  const title = `${name} 최저가·가격비교 | SEOSA`;
  const description = stats
    ? `${name} 목록 ${stats.count}개 상품의 현재가 범위 ${won(stats.low)}원~${won(stats.high)}원. ${stats.malls.map(m => m[0]).slice(0, 3).join('·')} 가격을 SEOSA가 매일 기록해 비교합니다.`.slice(0, 160)
    : `${name} 가격을 SEOSA가 매일 기록해 비교합니다.`;

  const facts = stats ? `
  <dl class="facts">
    <div><dt>가격 기록 중인 상품</dt><dd>${won(stats.count)}개</dd></div>
    <div><dt>목록 현재가 범위</dt><dd>${won(stats.low)}~${won(stats.high)}원</dd></div>
    <div><dt>목록 현재가 중앙값</dt><dd>${won(stats.median)}원</dd></div>
    <div><dt>목록 중 직전 관측보다 내린 상품</dt><dd>${hist.size ? `${drops}개` : '—'}</dd></div>
  </dl>` : '';
  /*
   * «지금 가장 낮은 ○○ 상품은 …» 문장을 쓰지 않는다 (2026-10-02 레드팀 후속).
   *
   * 목록 1위가 본품이 아닌 경우가 실제로 남아 있다 — /category/body-lotion 1위
   * «빈티지 도자기 로션 병»(빈 병), /category/rice 1위 «쌀조청». 그 행을 «가장 낮은
   * 바디로션» 이라고 부르면 거짓 문장이다. 목록은 «현재가 낮은 순» 으로 보여 주기만 하고,
   * 어떤 행이 최저가 본품이라고 단정하지 않는다.
   */
  const lead = tracked ? `<p class="lead">목록의 상품 중 가격 기록이 7일 이상 쌓인 것은 ${tracked}개입니다.</p>` : '';
  const urls = shown.map(p => pageUrl(p.product_id));

  const body = `
  ${crumbs(crumbTrail)}
  <h1>${esc(name)} 최저가·가격 추이</h1>
  <p class="meta">SEOSA 가 가격을 기록 중인 ${esc(name)} ${stats ? won(stats.count) : 0}개${stats ? ` · ${stats.malls.slice(0, 3).map(m => `${esc(m[0])} ${m[1]}`).join(' · ')}${stats.malls.length > 3 ? ` 외 ${stats.malls.length - 3}곳` : ''}` : ''}${stats && stats.updated ? ` · ${esc(stats.updated)} 업데이트` : ''}</p>
  ${facts}
  ${lead}
  <h2>현재가 ${order === 'desc' ? '높은' : '낮은'} 순</h2>
  ${productList(shown, hist)}
  <p class="more"><a rel="nofollow" href="/?q=${encodeURIComponent(searchQuery || name)}">SEOSA 검색에서 ${esc(name)} 더 보기 →</a> · <a href="/category">카테고리·브랜드 전체 →</a></p>`;

  return layout({
    title, description, canonical, indexable,
    headerLink: `<a class="hlink" rel="nofollow" href="/?q=${encodeURIComponent(searchQuery || name)}">SEOSA에서 검색 →</a>`,
    jsonLd: [
      SEO.breadcrumbJsonLd(crumbTrail.map(c => ({ name: c.name, url: c.href ? `${SITE}${c.href}` : canonical }))),
      {
        '@type': 'CollectionPage',
        '@id': canonical,
        url: canonical,
        name: `${name} 최저가·가격 추이`,
        description,
        inLanguage: 'ko-KR',
        isPartOf: { '@id': `${SITE}/#website` },
        mainEntity: SEO.itemListJsonLd(urls)
      }
    ],
    body
  });
}

function render404(what) {
  return layout({
    title: '페이지를 찾을 수 없어요 | SEOSA',
    description: '요청한 페이지가 없어요.',
    // 404 에는 canonical 을 달지 않는다 — 없는 상품 페이지(api/_product-page.js render404)와 같은 정책.
    canonical: '',
    indexable: false,
    body: `<h1 style="margin-top:40px">«${esc(what)}» 페이지를 찾을 수 없어요</h1>
  <p class="meta">주소가 바뀌었거나 지금 가격을 확인한 상품이 없어요.</p>
  <p class="more"><a href="/category">카테고리·브랜드 전체 보기 →</a> · <a href="/">SEOSA 홈으로</a></p>`
  });
}

/* ══════════════════════════════════════════════════════════════════
 *  핸들러
 * ══════════════════════════════════════════════════════════════════ */

function sendHtml(res, status, html, indexable) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!indexable) res.setHeader('X-Robots-Tag', 'noindex');
  return res.status(status).end(html);
}

/** /category/{slug} */
async function categoryHandler(req, res) {
  const slug = String((req.query || {}).slug || '').trim().toLowerCase();
  const cat = SLUG_RE.test(slug) ? SEO.categoryBySlug(slug) : null;
  if (!cat) { cachePublic(res, 300); return sendHtml(res, 404, render404('카테고리'), false); }

  const products = categoryProducts(cat, await loadCategoryRows(cat));
  if (!products.length) { cachePublic(res, 300); return sendHtml(res, 404, render404(cat.name), false); }

  // 색인 판정은 허브·pages.xml 과 같은 함수·같은 목록으로 (categoryGate 주석).
  const [hist, eligible] = await Promise.all([loadHistory(orderProducts(products, 'asc')), eligibleProductIds()]);
  const indexable = categoryGate(products, eligible).indexable;
  cachePublic(res, PAGE_CACHE_S);
  return sendHtml(res, 200, renderListing({
    name: cat.name, products, hist, stats: listStats(products), indexable,
    canonical: SEO.categoryUrl(cat), searchQuery: cat.keywords[0],
    crumbTrail: [{ name: '홈', href: '/' }, { name: '카테고리', href: '/category' }, { name: cat.name }]
  }), indexable);
}

/** /brand/{slug} */
async function brandHandler(req, res) {
  const slug = String((req.query || {}).slug || '').trim().toLowerCase();
  const brand = SLUG_RE.test(slug) ? SEO.brandBySlug(slug) : null;
  if (!brand) { cachePublic(res, 300); return sendHtml(res, 404, render404('브랜드'), false); }

  const rows = await loadBrandRows([brand]);
  const products = brandProducts(brand, rows, await memberKeysFor(rows.filter(r => SEO.brandOfTitle(r.title) === brand)));
  if (!products.length) { cachePublic(res, 300); return sendHtml(res, 404, render404(brand.name), false); }

  const [hist, eligible] = await Promise.all([loadHistory(orderProducts(products, 'desc')), eligibleProductIds()]);
  const indexable = brandGate(products, eligible).indexable;
  cachePublic(res, PAGE_CACHE_S);
  return sendHtml(res, 200, renderListing({
    name: brand.name, products, hist, stats: listStats(products), indexable,
    canonical: SEO.brandUrl(brand), searchQuery: brand.aliases[0], order: 'desc',
    crumbTrail: [{ name: '홈', href: '/' }, { name: '브랜드', href: '/category' }, { name: brand.name }]
  }), indexable);
}

/** /category — 허브 */
async function hubHandler(req, res) {
  const hub = await hubData();
  const cats = hub.categories.filter(e => e.indexable);
  const brands = hub.brands.filter(e => e.indexable);
  const tile = e => `<li><a href="/${e.kind}/${e.def.slug}"><b>${esc(e.def.name)}</b><span>${won(e.count)}개 · 최저가·가격 추이</span></a></li>`;
  const canonical = `${SITE}/category`;
  const indexable = cats.length + brands.length >= 3;
  const body = `
  ${crumbs([{ name: '홈', href: '/' }, { name: '카테고리·브랜드' }])}
  <h1>카테고리·브랜드별 최저가</h1>
  <p class="meta">SEOSA 가 매일 가격을 기록하는 상품을 카테고리와 브랜드로 묶었어요. 지금 현재가를 확인한 상품이 ${SEO.CATEGORY_MIN_PRODUCTS}개 이상이고 가격 기록이 충분히 쌓인 상품이 ${SEO.CATEGORY_MIN_TRACKED}개 이상인 묶음만 보여드려요.</p>
  <h2 id="categories">카테고리</h2>
  ${cats.length ? `<ul class="tiles">${cats.map(tile).join('')}</ul>` : '<p class="meta">지금 보여드릴 카테고리가 없어요.</p>'}
  <h2 id="brands">브랜드</h2>
  ${brands.length ? `<ul class="tiles">${brands.map(tile).join('')}</ul>` : '<p class="meta">지금 보여드릴 브랜드가 없어요.</p>'}`;
  cachePublic(res, PAGE_CACHE_S);
  return sendHtml(res, 200, layout({
    title: '카테고리·브랜드별 최저가·가격비교 | SEOSA',
    description: `${cats.slice(0, 6).map(e => e.def.name).join('·')} 등 카테고리와 브랜드별로 SEOSA가 매일 기록한 최저가와 가격 추이를 비교하세요.`.slice(0, 160),
    canonical, indexable, body,
    jsonLd: [
      SEO.breadcrumbJsonLd([{ name: '홈', url: `${SITE}/` }, { name: '카테고리·브랜드', url: canonical }]),
      { '@type': 'CollectionPage', '@id': canonical, url: canonical, name: '카테고리·브랜드별 최저가', inLanguage: 'ko-KR', isPartOf: { '@id': `${SITE}/#website` } }
    ]
  }), indexable);
}

/* ── 사이트맵 ───────────────────────────────────────────────────── */

/**
 * products.id 범위 하나의 색인 대상 — supabase/2026-10-02-seo-sitemap.sql.
 * @returns {{ok:true, list:Array<{pid, lastmod}>} | {ok:false}}  함수가 없으면 ok:false
 */
async function rpcRange(from, to) {
  const { INDEX_MIN_DAYS } = require('./_product-page')._internal;
  const { data, error } = await supabase.rpc('seo_sitemap_products', {
    p_id_from: from, p_id_to: to, p_min_days: INDEX_MIN_DAYS, p_max_age_days: MAX_DISPLAY_AGE_DAYS
  });
  if (error) {
    // 함수가 아직 없다(마이그레이션 미적용) — 폴백한다. 그 밖의 오류는 던진다.
    if (error.code === 'PGRST202' || /could not find the function/i.test(error.message || '')) return { ok: false };
    throw new Error(error.message);
  }
  // 배열이 아니면 «빈 결과» 로 삼키지 않는다 — 형식이 틀린 응답은 오류다.
  if (!Array.isArray(data)) throw new Error(`seo_sitemap_products 응답 형식 오류: ${typeof data}`);
  return {
    ok: true,
    list: data.filter(x => Array.isArray(x) && PID_RE.test(String(x[0] || '')))
      .map(x => ({ pid: String(x[0]), lastmod: String(x[1] || '') }))
  };
}

async function maxProductId() {
  const { data, error } = await supabase.from('products').select('id').order('id', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  return data && data[0] ? Number(data[0].id) || 0 : 0;
}

function productFileCount(maxId) {
  return Math.max(1, Math.ceil((Number(maxId) + 1) / PRODUCT_ID_RANGE));
}

/*
 * ── 상품 사이트맵 원천 — 한 번 계산해 인덱스·파일·목록 색인 판정이 같이 쓴다 ──
 *
 * 2026-10-02 레드팀 후속. 예전에는 /sitemap.xml 이 범위별 RPC 6개를 전부 성공해야
 * 응답했다 — 하나만 실패해도 500 이고 pages.xml 까지 인덱스에서 사라졌다.
 *
 *   · 범위 하나가 실패해도 나머지는 낸다. 실패는 로그로 남긴다.
 *   · 실패한 범위는 «직전 정상 결과» 가 있으면 그것을 쓴다 (이 인스턴스가 이미 센 값).
 *   · 성공했어도 직전보다 비정상적으로 적으면(절반 미만, 직전 ≥ DROP_MIN) 직전 결과를
 *     쓴다 — «0개나 반토막을 200 으로 정상 처리» 하는 것이 가장 위험하다.
 *   · 전부 실패했고 직전 결과도 없으면 던진다 → 503 (크롤러가 나중에 다시 온다).
 *
 * «직전 정상 결과» 는 이 서버리스 인스턴스의 메모리뿐이다. 새 저장소를 만들지 않는다 —
 * 허브 집계(hubMemo)와 같은 방식이다. 갓 뜬 인스턴스에는 비교 기준이 없다.
 */
const SITEMAP_MEMO_MS = 10 * 60 * 1000;
const DROP_RATIO = 0.5;
const DROP_MIN = 20;
let smLastGood = null;   // { at, mode, count, shards: Map<n, list> }
let smInflight = null;

function looksDropped(prevLen, curLen) {
  return prevLen >= DROP_MIN && curLen < prevLen * DROP_RATIO;
}

async function computeProductSitemap() {
  const probe = await rpcRange(0, 0);   // 함수가 있는가 (권한·timeout 은 여기서 던진다)
  if (!probe.ok) {
    // DB 함수 미적용 — 폴백(묶인 양만 읽는 안전망)을 products-1 하나로 낸다.
    const list = await require('./_product-page')._internal.indexableProducts();
    return { mode: 'legacy', count: 1, shards: new Map([[1, list]]), failed: [] };
  }
  const count = productFileCount(await maxProductId());
  const shards = new Map();
  const failed = [];
  for (let i = 0; i < count; i += 3) {
    const nums = [];
    for (let n = i + 1; n <= Math.min(count, i + 3); n++) nums.push(n);
    const settled = await Promise.allSettled(nums.map(n => rpcRange((n - 1) * PRODUCT_ID_RANGE, n * PRODUCT_ID_RANGE)));
    settled.forEach((s, k) => {
      const n = nums[k];
      if (s.status === 'fulfilled' && s.value.ok) shards.set(n, s.value.list);
      else {
        failed.push(n);
        console.error(`[seo] 상품 사이트맵 ${n}번 범위 실패: ${s.status === 'rejected' ? s.reason && s.reason.message : '함수 없음'}`);
      }
    });
  }
  if (!shards.size) throw new Error(`상품 사이트맵 범위 ${count}개 전부 실패`);
  return { mode: 'rpc', count, shards, failed };
}

/**
 * 직전 결과를 «기준» 으로 쓸 수 있는 최대 나이. 급감이 진짜(상품이 대량으로 stale)일
 * 수도 있으므로 하루가 지나면 기준을 버리고 새 계산을 받아들인다 — 영원히 옛 목록을
 * 붙들지 않는다.
 */
const BASELINE_MAX_MS = 24 * 60 * 60 * 1000;

/** 이번 계산을 직전 정상 결과와 맞춰 본다. */
function reconcile(cur, prev, now) {
  const t = now || Date.now();
  const same = prev && prev.mode === cur.mode && t - (prev.computedAt || 0) < BASELINE_MAX_MS;
  const shards = new Map(cur.shards);
  const stale = [];
  cur.failed.forEach(n => {
    if (same && prev.shards.has(n)) { shards.set(n, prev.shards.get(n)); stale.push(n); }
  });
  if (same) {
    for (const [n, list] of cur.shards) {
      const before = prev.shards.get(n);
      if (before && looksDropped(before.length, list.length)) {
        console.error(`[seo] 상품 사이트맵 ${n}번이 ${before.length} → ${list.length} 로 급감 — 직전 결과를 유지한다`);
        shards.set(n, before);
        stale.push(n);
      }
    }
    const total = m => [...m.values()].reduce((s, l) => s + l.length, 0);
    if (looksDropped(total(prev.shards), total(shards))) {
      console.error(`[seo] 상품 사이트맵 전체가 ${total(prev.shards)} → ${total(shards)} 로 급감 — 직전 결과를 유지한다`);
      // computedAt 은 직전 값 그대로 — 기준 나이(BASELINE_MAX_MS)가 계속 흐르게 한다.
      return Object.assign({}, prev, { stale: [...prev.shards.keys()], missing: [] });
    }
  }
  const missing = cur.failed.filter(n => !shards.has(n));
  // computedAt — «새로 센» 시각. 직전 결과로 대신한 경우에도 이번 계산이 받아들여진 것이므로 갱신한다.
  return { mode: cur.mode, count: cur.count, shards, stale, missing, computedAt: t };
}

async function productSitemap() {
  if (smLastGood && Date.now() - smLastGood.at < SITEMAP_MEMO_MS) return smLastGood;
  if (!smInflight) {
    smInflight = computeProductSitemap()
      .then(cur => {
        const out = reconcile(cur, smLastGood);
        // at — 메모 유효 시간의 기준(10분). out 의 옛 at 이 덮어쓰지 않게 마지막에 둔다.
        smLastGood = Object.assign({}, out, { at: Date.now() });
        return smLastGood;
      })
      .catch(e => {
        if (!smLastGood) throw e;
        console.error(`[seo] 상품 사이트맵 계산 실패 — ${Math.round((Date.now() - smLastGood.at) / 60000)}분 전 결과를 쓴다: ${e.message}`);
        // 전 범위를 «직전 결과로 대신함» 으로 표시한다 → 짧게만 캐시. 메모 시각은 그대로라 다음 요청이 다시 센다.
        return Object.assign({}, smLastGood, { stale: [...smLastGood.shards.keys()] });
      })
      .finally(() => { smInflight = null; });
  }
  return smInflight;
}

/** 상품 페이지가 index 인 product_id 집합 — 목록 색인 판정(categoryGate·brandGate)이 쓴다. */
async function eligibleProductIds() {
  const sm = await productSitemap();
  const ids = new Set();
  for (const list of sm.shards.values()) list.forEach(p => ids.add(String(p.pid)));
  return ids;
}

async function pagesEntries() {
  const hub = await hubData();
  /*
   * 홈·허브에는 lastmod 를 달지 않는다. 매 요청 «오늘» 을 찍으면 실제로 바뀌지 않은 날도
   * 바뀌었다고 말하게 된다 — 근거 없는 최신 날짜보다 생략이 낫다. 카테고리·브랜드는
   * 목록 상품의 마지막 수집일(KST)이라 실제 값이다.
   */
  const out = [{ loc: `${SITE}/` }, { loc: `${SITE}/category` }];
  hub.categories.concat(hub.brands).filter(e => e.indexable).forEach(e => {
    out.push({ loc: e.kind === 'brand' ? SEO.brandUrl(e.def) : SEO.categoryUrl(e.def), lastmod: e.lastmod });
  });
  return out;
}

function sendXml(res, status, xml) {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  return res.status(status).end(xml);
}

/** 계산할 수 없을 때 — 캐시하지 않는 503. 크롤러는 나중에 다시 오고, 이미 아는 URL 은 버리지 않는다. */
function unavailable(res, e, where) {
  console.error(`[seo] ${where} 503: ${e && e.message}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Retry-After', '3600');
  return sendXml(res, 503, SEO.urlsetXml([]));
}

/** /sitemap.xml — 인덱스. pages.xml 은 상품 사이트맵과 무관하게 항상 싣는다. */
async function sitemapIndexHandler(req, res) {
  const files = [{ loc: `${SITE}/sitemaps/pages.xml` }];
  let sm;
  try { sm = await productSitemap(); } catch (e) { return unavailable(res, e, 'sitemap.xml'); }
  // 비어 있는 범위는 올리지 않는다 (빈 사이트맵은 Search Console 경고만 만든다).
  [...sm.shards.entries()].sort((a, b) => a[0] - b[0]).forEach(([n, list]) => {
    if (list.length) files.push({ loc: `${SITE}/sitemaps/products-${n}.xml` });
  });
  // 실패했고 직전 결과도 없던 범위·직전 결과로 대신한 범위는 짧게만 캐시한다 — 곧 다시 센다.
  cachePublic(res, (sm.missing && sm.missing.length) || (sm.stale && sm.stale.length) ? 600 : SITEMAP_CACHE_S);
  return sendXml(res, 200, SEO.sitemapIndexXml(files));
}

/** /sitemaps/{file} */
async function sitemapFileHandler(req, res) {
  const file = String((req.query || {}).file || '').trim();
  if (file === 'pages.xml') {
    let entries;
    try { entries = await pagesEntries(); } catch (e) { return unavailable(res, e, 'pages.xml'); }
    cachePublic(res, SITEMAP_CACHE_S);
    return sendXml(res, 200, SEO.urlsetXml(entries));
  }
  const m = /^products-([1-9]\d{0,3})\.xml$/.exec(file);
  if (!m) { cachePublic(res, 300); return sendXml(res, 404, SEO.urlsetXml([])); }
  const n = Number(m[1]);

  let sm;
  try { sm = await productSitemap(); } catch (e) { return unavailable(res, e, file); }
  if (n > sm.count) { cachePublic(res, 300); return sendXml(res, 404, SEO.urlsetXml([])); }
  const list = sm.shards.get(n);
  if (!list) return unavailable(res, new Error(`${n}번 범위를 셀 수 없었다`), file);
  cachePublic(res, sm.stale && sm.stale.indexOf(n) > -1 ? 600 : SITEMAP_CACHE_S);
  return sendXml(res, 200, SEO.urlsetXml(list.map(p => ({ loc: pageUrl(p.pid), lastmod: p.lastmod }))));
}

module.exports = {
  categoryHandler, brandHandler, hubHandler, sitemapIndexHandler, sitemapFileHandler, productContext,
  _internal: {
    categoryProducts, brandProducts, brandPrefixes, listStats, loadHistory, hubData, renderListing,
    rpcRange, productFileCount, pagesEntries, productSitemap, eligibleProductIds, categoryGate, brandGate,
    reconcile, PRODUCT_ID_RANGE, LIST_SHOW, DROP_RATIO, DROP_MIN,
    resetMemo() { hubMemo = null; hubInflight = null; smLastGood = null; smInflight = null; categoryMembersMemo.clear(); },
    expireMemo() {
      if (hubMemo) hubMemo.at = Date.now() - HUB_MEMO_MS - 1;
      if (smLastGood) smLastGood.at = Date.now() - SITEMAP_MEMO_MS - 1;
    }
  }
};
