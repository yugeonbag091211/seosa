'use strict';
/*
 * 상품 페이지 · 상품 JSON · 상품 사이트맵 — 서버 렌더 (2026-09-02).
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────
 *
 * SEOSA 는 단일 페이지(SPA)라 상품마다 주소가 없었다. 그래서
 *   · 검색엔진·AI 검색이 상품 단위로 색인할 것이 없었다 (sitemap 1줄)
 *   · 상품을 링크로 공유할 수 없었다 (제휴 링크만 공유됐다)
 *   · 새로고침·뒤로가기로 보던 상품에 돌아올 수 없었다
 *
 * 이 모듈은 `/p/{product_id}` 를 서버에서 HTML 로 그린다. 새 서버리스 함수를
 * 만들지 않는다 — api/history.js 의 라우터(`__route`)에 얹고 vercel.json 이
 * `/p/:pid` 를 그리로 보낸다 (Hobby 함수 12개 상한, 지금 11개).
 *
 * ── 지키는 선 ──────────────────────────────────────────────────────
 *
 *   · 저품질 페이지를 대량 생성하지 않는다. 가격 기록이 INDEX_MIN_DAYS 미만이거나
 *     현재가로 쓸 수 없는(stale·링크 없음) 상품은 noindex 이고 사이트맵에도 없다.
 *   · 값은 전부 DB 에 실제로 있는 것이다. 판정 문장은 api/_deal.js 가 만든 것을
 *     그대로 옮긴다 — 화면 모달·AI 답변·알림 메일과 같은 말을 한다.
 *   · 구조화 데이터는 BreadcrumbList · WebPage, 그리고 색인되는 페이지에만
 *     Product(제품 스니펫, Offer 1곳). 2026-10-02 에 판단을 바꿨다 — 그 이유와
 *     지키는 선은 api/_seo.js productJsonLd 주석에 있다. 가격 사실은 여전히
 *     본문 텍스트(«가격 요약»)로도 낸다 — 검색봇이 그래프 안의 숫자를 읽지 못한다.
 *   · 상품명·링크·이미지는 판매자 문자열이다. 전부 이스케이프하고 URL 은
 *     http(s) 만 통과시킨다.
 *   · 읽기 전용. 아무것도 쓰지 않는다.
 */

const supabase = require('./_supabase');
const SEO = require('./_seo');
const { toClientProduct, freshRows, relevantRows, preferLive } = require('./_shop');
const { attachTrust } = require('./_trust');
const { observedKstDate, kstToday, productLifecycle, sameVendorRows, LIFECYCLE } = require('./_price');
const { statsFrom } = require('./_pricestat');
const { dealOf } = require('./_deal');
const { cachePublic } = require('./_http');

/** 절대 URL 의 기준. 배포 도메인이 바뀌면 환경변수로 덮는다. */
const SITE = String(process.env.SITE_ORIGIN || 'https://seosa.ai.kr').replace(/\/+$/, '');

/** 이 일수 미만의 기록은 색인하지 않는다 — 카드의 ATL_MIN_POINTS 와 같은 문턱. */
const INDEX_MIN_DAYS = 7;
/** 사이트맵 상한. 그 이상은 "많이" 가 아니라 "얕게" 가 된다. */
const SITEMAP_MAX = 5000;
/** 가격 기록 조회 상한 (api/history.js SINGLE_MAX_ROWS 와 같다). */
const MAX_ROWS = 3000;
/** 같은 검색어의 다른 상품(내부 링크) 수. */
const SIBLINGS = 3;
/** 그래프에 그릴 최근 점. */
const SPARK_POINTS = 30;

const PAGE_CACHE_S = 60 * 60;         // 1시간 — 가격은 하루 한 번 바뀐다
const SITEMAP_CACHE_S = 12 * 60 * 60; // 12시간

/*
 * 이 숫자가 무엇인지 밝히는 한 줄.
 *
 * ── 왜 문구를 바꿨나 (2026-09-04 감사) ──────────────────────────
 *
 * 예전 문구는 "배송비·쿠폰·카드 할인은 포함되지 않았어요" 였다. 확인되지
 * 않은 단정이다. 우리가 가진 가격은 쿠팡 파트너스 검색 API 의 productPrice
 * 하나뿐이고, 그 응답에는 가격의 종류를 말해 주는 필드가 없다.
 *
 *   실제 응답 키 (2026-09-04 원본 확인, 10건 전수):
 *     productId / productName / productPrice / productImage / productUrl
 *     categoryName / keyword / rank / isRocket / isFreeShipping
 *   basePrice · salePrice · discountPrice · 회원가 · 쿠폰가 — 전부 없다.
 *
 * 그리고 그 값이 상품 페이지 가격과 다른 사례를 실측했다.
 *   productId 7912306911 / vendorItemId 88764198511
 *     API productPrice   22,320원
 *     상품 페이지        26,900원 (와우 회원 쿠폰가 23,610원)
 *
 * 즉 이 값이 "쿠폰이 빠진 가격" 이라고 말할 근거가 없다 — 오히려 어떤
 * 할인이 이미 반영된 값일 수도 있다. 어느 쪽인지 우리는 모른다.
 *
 * 그래서 아는 것만 적는다: 어디서 받은 값인지, 그리고 실제 결제 금액은
 * 판매처에서 확인해야 한다는 것. 모르는 것을 아는 척하지 않는다.
 */
const PRICE_SOURCE_NOTE = 'SEOSA 가 쿠팡 파트너스 검색 API 로 매일 받아 기록한 값이에요. '
  + '이 값에 어떤 할인이 반영돼 있는지는 API 가 알려주지 않아서, 판매처에서 보이는 '
  + '금액과 다를 수 있어요. 실제 결제 금액은 판매처에서 확인해 주세요.';

/* ── 안전한 문자열 ──────────────────────────────────────────────── */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function safeUrl(u) {
  const s = String(u == null ? '' : u).trim();
  return /^https?:\/\//i.test(s) ? s : '';
}
function won(n) {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
/** product_id 로 받아들일 모양. 쿠팡은 숫자, ADPICK 은 sha256 hex. */
const PID_RE = /^[0-9a-f]{1,64}$/i;
function cleanPid(v) {
  const s = String(v == null ? '' : v).trim();
  return PID_RE.test(s) ? s : '';
}
function pageUrl(pid) { return `${SITE}/p/${encodeURIComponent(pid)}`; }

/* ── 데이터 ─────────────────────────────────────────────────────── */

async function loadProduct(pid, mall) {
  const { data, error } = await supabase
    .from('products').select('*').eq('product_id', pid).limit(5);
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (!rows.length) return null;
  if (mall) { const hit = rows.find(r => r.mall === mall); if (hit) return hit; }
  return rows.find(r => r.mall === '쿠팡') || rows[0];
}

/**
 * KST 날짜당 최저가 한 점, 오름차순 (api/history.js collapseToDaily 와 같은 규칙).
 *
 * ── vendorItemId 로 좁히는 이유 (2026-09-04) ─────────────────────
 *
 * 쿠팡은 같은 product_id(= 상품 페이지) 아래 색상·용량·수량 옵션을 묶어 두고,
 * 실제로 팔리는 단위는 vendor_item_id 다. 그 값을 빼고 조회하면 한 페이지에
 * 묶인 서로 다른 상품의 가격이 한 곡선으로 합쳐진다.
 *
 * 운영 DB 실측 (2026-09-04, price_history 24,014행)
 *   (product_id, mall) 조합 3,220개 중 실제 vid 가 2종 이상인 것 714개.
 *   그중 301개는 "역대 최저" 가 지금 파는 옵션의 값이 아니었다.
 *   예) 8082654809|쿠팡
 *         vid 95768196637 : 15,900원 (28회)  ← 지금 파는 옵션
 *         vid 91193685703 : 222,390~242,100원 (2회)
 *       두 값이 한 곡선에 들어가 최고가·평균·변동성이 통째로 망가졌다.
 *
 * api/history.js 의 단건·배치 조회와 api/_trust.js 는 이미 vid 로 좁히고
 * 있었다. 이 경로(/p/{pid} 서버 렌더 · ?p= 딥링크 JSON)만 빠져 있어서 같은
 * 상품인데 화면 모달과 상품 페이지가 다른 숫자를 말했다.
 *
 * 좁히는 판정은 _price.sameVendorRows 한 곳에 있다 (폴백 규칙까지 거기 적혀
 * 있다). 이 경로만 다른 규칙을 쓰면 모달과 상품 페이지가 또 갈린다.
 */
async function loadPoints(pid, mall, vendorItemId) {
  const { data, error } = await supabase
    .from('price_history')
    // vendor_item_id 도 받는다 — 옵션 계열을 가르는 데 쓴다.
    .select('recorded_date, recorded_at, price, vendor_item_id')
    .eq('product_id', pid).eq('mall', mall)
    .order('recorded_date', { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw new Error(error.message);
  const byDate = new Map();
  sameVendorRows(data || [], vendorItemId).forEach(r => {
    const d = observedKstDate(r);
    if (!d) return;
    const cur = byDate.get(d);
    if (cur === undefined || r.price < cur) byDate.set(d, r.price);
  });
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, price]) => ({ date, price }));
}

/**
 * 비슷한 가격의 다른 선택 — 내부 링크. 현재가로 쓸 수 있는 행만.
 *
 * ── 왜 «같은 검색어» 로 끝내지 않는가 ──────────────────────────────
 *
 * 제목이 "비슷한 가격의 다른 선택" 인데 같은 검색어에서 아무거나 3개를
 * 집어 오면 그 제목이 거짓이 된다. 실제로 같은 검색어 안에는 본체 옆에
 * 케이스·필름 같은 부속이 섞여 있고 가격대도 10배까지 벌어진다.
 *
 * 순위는 api/_radar.alternativesFor 가 정한다. 그 함수가 부속 제외
 * (_search.ACCESSORY_TIER)·가격대 제한·현재가 존재를 결정론으로 거른다.
 * /api/alternatives 와 «같은 규칙» 을 쓰게 되므로, 페이지와 API 가 서로
 * 다른 후보를 내놓는 일도 없어진다.
 */
async function loadSiblings(row, limit) {
  if (!row || !row.keyword) return [];
  try {
    const { data } = await supabase
      .from('products')
      .select('product_id, mall, keyword, title, lprice, image, link, collected_at')
      .eq('keyword', row.keyword)
      .neq('product_id', row.product_id)
      .limit(40);
    const usable = preferLive(freshRows(relevantRows(data || []))).filter(r => r.link);

    const R = require('./_radar');
    const ranked = R.alternativesFor(
      { productId: row.product_id, title: row.title, price: Math.round(Number(row.lprice) || 0) },
      usable.map(r => ({
        productId: r.product_id, title: r.title, price: Math.round(Number(r.lprice) || 0),
        mall: r.mall, image: r.image, url: r.link
      })),
      limit == null ? SIBLINGS : limit
    );
    /* 원래 행 모양(product_id·lprice·title)을 그대로 돌려준다 — 렌더러가 그것을 읽는다. */
    const byId = new Map(usable.map(r => [String(r.product_id), r]));
    const out = ranked.map(a => byId.get(String(a.productId))).filter(Boolean);
    /*
     * 걸러 낸 뒤 하나도 안 남을 수 있다(가격대가 전부 벗어난 경우 등).
     * 그때는 섹션을 통째로 비운다 — 제목이 약속한 것을 못 주면 안 주는 편이 낫다.
     */
    return out;
  } catch (e) {
    return [];
  }
}

/*
 * ── 상품 페이지 색인 규칙 — 한 곳 (2026-10-02 레드팀 후속) ──────────────
 *
 * 이 두 함수를 상품 페이지(buildView)와 폴백 사이트맵(indexableProducts)이 같이
 * 쓴다. supabase/2026-10-02-seo-sitemap.sql 의 seo_sitemap_products 가 같은 규칙을
 * SQL 로 옮긴 것이다 — 한쪽을 고치면 셋 다 고친다 (scripts/test-seo.js 가 본다).
 *
 * 레드팀 실측: 예전 폴백은 관측일을 옵션 구분 없이 세서, 페이지는 noindex 인데
 * 사이트맵에는 오른 URL 이 표본 250개 중 5개였다 (/p/9606124637: 전체 18일 ·
 * 현재 옵션 1일). 관측일은 반드시 «현재 옵션(sameVendorRows)» 으로 센다.
 */

/** 이 상품(현재 옵션)의 관측 KST 날짜 수. */
function observedDays(rows, vendorItemId) {
  const days = new Set();
  sameVendorRows(rows || [], vendorItemId).forEach(r => {
    const d = observedKstDate(r);
    if (d) days.add(d);
  });
  return days.size;
}

/**
 * 상품 페이지가 index 인가.
 *   live(수집 10일 이내 · 수집 가능한 몰 · 가격 > 0) · 판매처 링크 · /p/ 주소로 쓸 수
 *   있는 id · 구매 가격(렌탈·구독·100원 미만 아님) · 현재 옵션 관측 INDEX_MIN_DAYS 일 이상
 */
function isIndexableProduct(row, days) {
  return !!row
    && productLifecycle(row).state === LIFECYCLE.LIVE
    && !!safeUrl(row.link)
    && !!cleanPid(row.product_id)
    && !SEO.isNonPurchaseListing(row)
    && Number(days) >= INDEX_MIN_DAYS;
}

/**
 * 페이지·JSON 이 공유하는 뷰 모델. 없으면 null.
 * @returns {{row, product, points, stat, deal, life, price, indexable, today}}
 */
async function buildView(pid, mall) {
  const row = await loadProduct(pid, mall);
  if (!row) return null;

  // 옵션(vendor_item_id)까지 좁힌다 — loadPoints 주석의 근거 참고.
  const points = await loadPoints(row.product_id, row.mall, row.vendor_item_id);
  // vendorItemId 는 toClientProduct 가 이미 싣는다.
  const product = toClientProduct(row);
  try { await attachTrust([product]); } catch (e) { /* 신뢰도 없이 그린다 */ }

  const today = kstToday();
  const stat = statsFrom(points);
  // 모달(api/history.js deal=1)과 같은 기준 — 마지막 관측가로 판정한다.
  const price = points.length ? points[points.length - 1].price : (Number(product.lprice) || 0);
  const deal = dealOf(stat, price, today);
  const life = productLifecycle(row);
  // points 는 현재 옵션의 KST 날짜당 한 점이라 그 길이가 곧 관측일 수다 (observedDays 와 같다).
  const indexable = isIndexableProduct(row, points.length);

  return { row, product, points, stat, deal, life, price, indexable, today };
}

/* ── 스파크라인 ─────────────────────────────────────────────────── */
function sparkSvg(points) {
  const pts = (points || []).slice(-SPARK_POINTS);
  if (pts.length < 2) return '';
  const W = 640, H = 140, PAD = 8;
  const prices = pts.map(p => p.price);
  const lo = Math.min.apply(null, prices), hi = Math.max.apply(null, prices);
  const span = hi - lo;
  if (!(span > 0)) return '';
  const x = i => PAD + (i / (pts.length - 1)) * (W - PAD * 2);
  const y = v => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="140" role="img"
    aria-label="최근 ${pts.length}일 가격 그래프, 최저 ${won(lo)}원, 최고 ${won(hi)}원">
    <path d="${d}" fill="none" stroke="#8A6D1C" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last.price).toFixed(1)}" r="4" fill="#8A6D1C"/>
  </svg>`;
}

/* ── HTML ───────────────────────────────────────────────────────── */
const CSS = [
  ':root{--ink:#111;--soft:#5b616b;--line:#e6e8eb;--bg:#fff;--brass:#8A6D1C;--down:#0b7a4b;--up:#c9362b}',
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);',
  'font-family:Pretendard,"Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif;line-height:1.55;-webkit-font-smoothing:antialiased}',
  'a{color:inherit}.wrap{max-width:760px;margin:0 auto;padding:0 20px}',
  'header{border-bottom:1px solid var(--line)}header .wrap{display:flex;align-items:center;justify-content:space-between;height:56px}',
  '.logo{font-weight:800;letter-spacing:.14em;text-decoration:none;font-size:.95rem}.logo b{color:var(--brass)}',
  '.crumb{font-size:.78rem;color:var(--soft);margin:20px 0 8px}.crumb a{text-decoration:none;color:var(--soft)}.crumb a:hover{color:var(--ink)}',
  'h1{font-size:1.28rem;line-height:1.4;margin:0 0 6px;letter-spacing:-.01em}',
  '.meta{font-size:.8rem;color:var(--soft);margin-bottom:22px}.meta span+span:before{content:" · ";color:var(--line)}',
  '.hero{display:grid;grid-template-columns:200px 1fr;gap:24px;align-items:start}@media(max-width:560px){.hero{grid-template-columns:1fr}}',
  '.thumb{border:1px solid var(--line);border-radius:6px;overflow:hidden;background:#fff;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center}',
  '.thumb img{max-width:100%;max-height:100%;object-fit:contain}',
  '.price{font-size:2rem;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}.price small{font-size:1rem;font-weight:400;color:var(--soft)}',
  '.verdict{margin:12px 0 0;padding:14px 16px;border-left:3px solid var(--brass);background:#faf8f3;border-radius:0 6px 6px 0}',
  '.verdict b{display:block;font-size:1rem;margin-bottom:6px}.verdict ul{margin:0;padding-left:18px;font-size:.86rem;color:var(--soft)}.verdict li+li{margin-top:3px}',
  '.verdict .warn{color:var(--up)}',
  '.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:22px 0 10px}@media(max-width:560px){.stats{grid-template-columns:repeat(2,1fr)}}',
  '.stat{border:1px solid var(--line);border-radius:6px;padding:10px 12px}.stat span{display:block;font-size:.7rem;color:var(--soft)}.stat b{font-size:1rem;font-variant-numeric:tabular-nums}',
  '.spark{border:1px solid var(--line);border-radius:6px;padding:10px;margin:8px 0 6px}.note{font-size:.74rem;color:var(--soft)}',
  '.cta{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0}',
  '.btn{display:inline-block;padding:12px 18px;border-radius:6px;text-decoration:none;font-size:.9rem;font-weight:700;border:1px solid var(--ink)}',
  '.btn.primary{background:var(--ink);color:#fff}.btn.off{opacity:.45;pointer-events:none}',
  'button.btn{font-family:inherit;background:var(--bg);color:var(--ink);cursor:pointer}.btn[aria-pressed=true]{background:#f3f4f6}.journey{margin:18px 0;padding:18px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.journey ol{list-style:none;padding:0;margin:12px 0 0;display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.journey span{display:block;font-size:.72rem;color:var(--soft)}.journey b{font-variant-numeric:tabular-nums}',
  '.unitprice{color:var(--soft);font-size:.82rem;margin:-6px 0 10px}',
  '.goodbuy{margin:14px 0;padding:12px 14px;background:var(--surface,#f4f5f7);border-radius:6px;font-size:.86rem}.goodbuy b{display:block;font-size:.95rem}.goodbuy span{display:block;color:var(--soft);font-size:.78rem;margin-top:3px}',
  'h2{font-size:1rem;margin:34px 0 10px}.sib{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(3,1fr);gap:12px}',
  '@media(max-width:560px){.sib{grid-template-columns:repeat(2,1fr)}}',
  '.sib li a{display:block;text-decoration:none;border:1px solid var(--line);border-radius:6px;padding:10px;font-size:.8rem;min-height:100%}',
  '.sib .t{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--soft);margin-bottom:6px}.sib .p{font-weight:700;font-variant-numeric:tabular-nums}',
  'footer{margin:48px 0 32px;font-size:.74rem;color:var(--soft);border-top:1px solid var(--line);padding-top:16px}',
  '.trust{font-size:.78rem;color:var(--soft);margin-top:10px}',
  // 제휴 고지 — public/index.html .aff-note 와 같은 모양·문구 (그 주석 참고)
  '.aff-note{display:flex;align-items:baseline;gap:8px;margin:22px 0 -10px;padding:8px 12px;background:var(--surface,#f4f5f7);border-radius:6px;font-size:.8rem;line-height:1.55;color:var(--soft);word-break:keep-all;overflow-wrap:anywhere}.aff-note b{flex:none;color:var(--ink)}',
  // 가격 요약 (2026-10-02) — .stats 와 같은 칸 모양을 쓴다
  '.facts{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:0 0 10px}@media(max-width:560px){.facts{grid-template-columns:repeat(2,1fr)}}',
  '.facts div{border:1px solid var(--line);border-radius:6px;padding:10px 12px}.facts dt{font-size:.7rem;color:var(--soft)}.facts dd{margin:0;font-weight:700;font-variant-numeric:tabular-nums}',
  '.facts .dn{color:var(--down)}.facts .upc{color:var(--up)}.lead{font-size:.88rem;color:var(--soft);margin:0}.lead b{color:var(--ink);font-weight:600}',
  '.thumb.noimg:after{content:"이미지 없음";color:var(--soft);font-size:.8rem}',
  '.explore p{margin:0;font-size:.86rem}.explore a{color:var(--ink)}'
].join('');

/**
 * 제휴 링크 경제적 이해관계 고지 (2026-09-29, ADPICK 승인 요청).
 * 판매처 링크가 있을 때만 그 버튼 «바로 위» 에 붙는다. 문구를 줄이지 마라 —
 * scripts/test-affiliate-disclosure.js 가 public/index.html 과 같은 문구인지 본다.
 */
const AFFILIATE_DISCLOSURE = '이 페이지에는 제휴 링크가 포함되어 있으며, 구매 시 SEOSA가 일정 수수료를 제공받습니다.';

function mallName(product) {
  return product.mallLabel || product.mall || '';
}

/*
 * meta description — api/_seo.productDescription 이 만든다 (2026-10-02).
 *
 * 현재가와 최근 30일 최저를 «따로» 적는다 (test-price-integrity CASE 2).
 * 숫자는 전부 이 상품의 실제 기록이라 페이지마다 다르다 — 같은 설명이
 * 수천 페이지에 반복되지 않는다.
 */
function describeForMeta(v) {
  const { product, stat, points } = v;
  return SEO.productDescription({
    title: SEO.cleanText(product.title),
    price: v.price,
    // 판매처를 아는 경우만 이름을 쓴다 — "현재 ADPICK 99,000원" 은 ADPICK 이 판다는 말이 된다.
    mall: SEO.sellerOf(v.row),
    lastDate: points.length ? points[points.length - 1].date : '',
    summary: SEO.priceSummary(points, stat)
  });
}

/** -31,000원 / +5,000원 / 0원 */
function signedWon(n) {
  const v = Math.round(Number(n) || 0);
  return `${v < 0 ? '-' : v > 0 ? '+' : ''}${won(Math.abs(v))}원`;
}
function signedPct(p) {
  return p === null || p === undefined ? '' : `${p < 0 ? '-' : p > 0 ? '+' : ''}${Math.abs(p)}%`;
}

/**
 * 가격 요약 — 숫자와 문장이 HTML 텍스트로 남는다 (그래프 SVG 안에만 있으면
 * 검색봇이 읽지 못한다). 값은 전부 api/_seo.priceSummary 가 이 상품의 기록에서
 * 계산한 것이다. 기록이 모자란 줄은 그리지 않는다.
 */
function summaryHtml(s) {
  if (!s || !(s.prev || s.window7 || s.window30)) return '';
  const rows = [];
  if (s.prev) {
    const cls = s.prev.diff < 0 ? 'dn' : s.prev.diff > 0 ? 'upc' : '';
    const val = s.prev.diff
      ? `${signedWon(s.prev.diff)}${s.prev.diffPct !== null ? ` (${signedPct(s.prev.diffPct)})` : ''}`
      : '변동 없음';
    rows.push(`<div><dt>${esc(s.prev.label)}</dt><dd${cls ? ` class="${cls}"` : ''}>${val}</dd></div>`);
  }
  if (s.window7) rows.push(`<div><dt>최근 7일 최저 · 평균</dt><dd>${won(s.window7.low)}원 · ${won(s.window7.avg)}원</dd></div>`);
  if (s.window30) rows.push(`<div><dt>최근 30일 최저 · 평균</dt><dd>${won(s.window30.low)}원 · ${won(s.window30.avg)}원</dd></div>`);
  if (s.vsAvg30Pct !== null) {
    const cls = s.vsAvg30Pct < 0 ? 'dn' : s.vsAvg30Pct > 0 ? 'upc' : '';
    rows.push(`<div><dt>30일 평균 대비</dt><dd${cls ? ` class="${cls}"` : ''}>${signedPct(s.vsAvg30Pct)}</dd></div>`);
  }
  // 업데이트 날짜는 칸이 아니라 문장 줄 머리에 둔다 — 칸이 5개면 4열 격자에서 한 칸만 줄을 넘는다.
  return `
  <section aria-labelledby="price-summary">
    <h2 id="price-summary">가격 요약</h2>
    <dl class="facts">${rows.join('')}</dl>
    <p class="lead"><b>가격 업데이트 ${esc(s.lastDate)}</b>${s.sentences.length ? ` · ${s.sentences.map(esc).join(' ')}` : ''}</p>
  </section>`;
}

/**
 * @param {object} v         buildView 결과
 * @param {Array}  siblings  비슷한 가격의 다른 선택
 * @param {{category?:object, brand?:object}} [ctx]
 *   본품 판정을 통과한 카테고리·브랜드 (api/_seo-pages.productContext). 없으면
 *   breadcrumb 은 «홈 › 상품» 이고 brand 를 쓰지 않는다 — 틀린 계층보다 짧은 계층이 낫다.
 */
function renderPage(v, siblings, ctx) {
  const { product, points, stat, deal, price, indexable, row } = v;
  // DB 에 HTML 엔티티째 저장된 제목이 있다 ("팝콘&amp;나쵸"). 풀어서 한 번만 이스케이프한다.
  const title = SEO.cleanText(product.title).slice(0, 200);
  const img = safeUrl(product.image);
  // 검색엔진·공유 카드가 나중에 가져가도 열리는 이미지만 밖으로 낸다 (_seo.isDurableImage).
  const shareImg = SEO.isDurableImage(img) ? img : '';
  const link = safeUrl(product.link);
  const url = pageUrl(product.productId);
  const last = points.length ? points[points.length - 1].date : '';
  const desc = describeForMeta(v);
  const mall = mallName(product);
  const name = SEO.shortName(title);
  const summary = SEO.priceSummary(points, stat);
  /*
   * 카테고리·브랜드 — 본품 판정을 통과한 것만 (2026-10-02 레드팀 후속).
   *
   * 예전에는 products.keyword 가 «노트북» 이면 무조건 «홈 › 노트북 › 상품» 이었고,
   * 상품명 첫 낱말이 «LG» 면 brand=LG전자 였다. 그래서 노트북 키워드로 수집된
   * 백팩·노트북가방·«LG 그램 노트북 핀 타입 19V» 어댑터가 노트북 계층에, 어댑터는
   * LG전자 제품으로 표시됐다. 판정은 카테고리 목록과 같은 규칙으로 호출부가 한다.
   */
  const category = (ctx && ctx.category) || null;
  const brand = (ctx && ctx.brand) || null;
  const seller = SEO.sellerOf(row);

  const crumbItems = [{ name: '홈', url: `${SITE}/` }]
    .concat(category ? [{ name: category.name, url: SEO.categoryUrl(category) }] : [])
    .concat([{ name, url }]);
  /*
   * Product 는 ① 색인되는 페이지 ② 가격이 있고 ③ 마지막 관측이 STALE_OFFER_DAYS 이내일
   * 때만. 가격은 화면 큰 글씨와 같은 값(마지막 관측가)이다. 묵은 값을 현재가 Offer 로
   * 내보내느니 Product 를 빼는 편이 낫다 (_seo.STALE_OFFER_DAYS 주석).
   */
  const offerFresh = !!last && SEO.offerIsFresh(last, v.today || kstToday());
  const productLd = indexable && price > 0 && offerFresh ? SEO.productJsonLd({
    name: title,
    url,
    image: shareImg,
    description: desc,
    // 쿠팡이 준 판매 단위 식별자만 — ADPICK 의 product_id 는 우리가 만든 해시라 sku 가 아니다.
    sku: product.isCoupang && product.vendorItemId ? String(product.vendorItemId) : undefined,
    brand: brand ? brand.name : undefined,
    // 판매처를 모르면 seller 를 쓰지 않는다 — "ADPICK" 은 판매처가 아니다.
    offers: [{ price, seller: seller || undefined }]
  }) : null;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      SEO.breadcrumbJsonLd(crumbItems),
      SEO.compact({
        '@type': 'WebPage',
        '@id': url,
        url,
        name: `${name} 최저가·가격 추이`,
        description: desc,
        inLanguage: 'ko-KR',
        isPartOf: { '@id': `${SITE}/#website` },
        dateModified: last ? `${last}T00:00:00+09:00` : undefined,
        primaryImageOfPage: shareImg ? { '@type': 'ImageObject', url: shareImg } : undefined,
        mainEntity: productLd ? { '@id': productLd['@id'] } : undefined
      }),
      productLd
    ].filter(Boolean)
  };

  const reasons = (deal.reasons || []).slice(0, 3);
  const cautions = (deal.cautions || []).slice(0, 2).concat((deal.anomalies || []).slice(0, 1).map(a => a.note));

  const statsHtml = stat ? `
    <div class="stats">
      <div class="stat"><span>기록</span><b>${points.length}일</b></div>
      <div class="stat"><span>수집 이후 최저</span><b>${won(stat.low)}원</b></div>
      <div class="stat"><span>30일 평균</span><b>${stat.avg30 > 0 ? won(stat.avg30) + '원' : '—'}</b></div>
      <div class="stat"><span>수집 이후 최고</span><b>${won(stat.high)}원</b></div>
    </div>` : '';

  /*
   * ── 얼마면 좋은 가격인가 · 단위 가격 (2026-09-07 통합) ─────────────
   *
   * 둘 다 api/_radar.js 가 정한다. 이 페이지에서 다시 계산하지 않는다 —
   * /api/radar 와 이 페이지가 서로 다른 숫자를 말하면 안 된다.
   *
   * ★ 근거가 얇으면 두 함수 모두 null 을 돌려준다. 그때는 영역 자체를
   *   그리지 않는다. 없는 값을 0 으로 채우거나 «미정» 으로 적지 않는다.
   */
  const RADAR = require('./_radar');
  const goodBuy = RADAR.goodBuyPrice(stat);
  const goodBuyHtml = goodBuy ? `
    <div class="goodbuy">
      <b>${won(goodBuy.price)}원 이하라면 좋은 가격</b>
      <span>${esc(goodBuy.explain)}</span>
    </div>` : '';

  const unit = RADAR.unitPriceOf(title, price);
  const unitHtml = unit
    ? `<div class="unitprice">${esc(unit.unit)}당 ${won(unit.unitPrice)}원</div>`
    : '';

  const spark = sparkSvg(points);
  const trust = product.trust && product.trust.label
    ? `<div class="trust">가격 신뢰도 · ${esc(product.trust.label)}${product.trust.summary ? ` — ${esc(product.trust.summary)}` : ''}</div>`
    : '';

  const sibHtml = siblings.length ? `
    <h2>비슷한 가격의 다른 선택</h2>
    <ul class="sib">${siblings.map(s => `
      <li><a href="/p/${encodeURIComponent(s.product_id)}">
        <div class="t">${esc(SEO.cleanText(s.title))}</div>
        <div class="p">${won(s.lprice)}원</div>
      </a></li>`).join('')}
    </ul>` : '';

  const storyPoints = points.length >= 3 ? [points[0], points[Math.floor((points.length - 1) / 2)], points[points.length - 1]] : [];
  const storyHtml = storyPoints.length ? `<section class="journey" aria-labelledby="price-story"><h2 id="price-story">가격에도 서사가 있습니다.</h2><ol>${storyPoints.map((p, i) => `<li><span>${i === 2 ? '오늘' : esc(p.date)}</span><b>${won(p.price)}원</b></li>`).join('')}</ol></section>` : '';
  const radarProduct = JSON.stringify({ title, productId: product.productId, mall: product.mall, mallLabel: mall, price, link, image: img, verdict: deal.verdict, verdictLabel: deal.label, verdictReason: reasons[0] || '' }).replace(/</g, '\\u003c');

  // 내부 링크 — 이 상품이 속한 카테고리·브랜드 페이지 (레지스트리에서 확인된 것만).
  const explore = [
    category ? `<a href="/category/${esc(category.slug)}">${esc(category.name)} 최저가 전체 보기</a>` : '',
    brand ? `<a href="/brand/${esc(brand.slug)}">${esc(brand.name)} 제품 가격비교</a>` : ''
  ].filter(Boolean);
  const exploreHtml = explore.length
    ? `<nav class="explore" aria-label="더 둘러보기"><h2>더 둘러보기</h2><p>${explore.join(' · ')}</p></nav>`
    : '';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(SEO.productTitle(title))}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="${indexable ? 'index,follow' : 'noindex,follow'}">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${SEO.verificationMeta()}
<script src="/radar-store.js"></script>
<meta property="og:type" content="website">
<meta property="og:site_name" content="SEOSA">
<meta property="og:locale" content="ko_KR">
<meta property="og:title" content="${esc(name)}${price > 0 ? ` · ${won(price)}원` : ''}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(shareImg || `${SITE}/og.png`)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(name)}${price > 0 ? ` · ${won(price)}원` : ''}">
<meta name="twitter:description" content="${esc(desc)}">
${SEO.jsonLdScript(jsonLd)}
<style>${CSS}</style>
</head>
<body>
<header><div class="wrap">
  <a class="logo" href="/">SEO<b>SA</b></a>
  <a rel="nofollow" href="/?q=${encodeURIComponent(row.keyword || title.split(' ').slice(0, 2).join(' '))}" style="font-size:.82rem;color:var(--soft);text-decoration:none">비슷한 상품 더 보기 →</a>
</div></header>
<main class="wrap">
  <nav class="crumb" aria-label="경로"><a href="/">홈</a> › ${category ? `<a href="/category/${esc(category.slug)}">${esc(category.name)}</a> › ` : ''}${esc(name)}</nav>
  <h1>${esc(title)}</h1>
  <div class="meta"><span>${esc(mall)}</span>${last ? `<span>${esc(last)} 관측</span>` : ''}${row.keyword ? `<span>검색어 ${esc(row.keyword)}</span>` : ''}</div>

  <section class="hero">
    <div class="thumb">${img ? `<img src="${esc(img)}" alt="${esc(SEO.shortName(title, 80))}" decoding="async" fetchpriority="high" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('noimg');this.remove()">` : '<span style="color:var(--soft)">이미지 없음</span>'}</div>
    <div>
      <div class="price">${price > 0 ? `${won(price)}<small> 원</small>` : '가격 미확인'}</div>
      ${unitHtml}
      <div class="verdict">
        <b>${esc(deal.label)}</b>
        ${reasons.length ? `<ul>${reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        ${cautions.length ? `<ul>${cautions.map(c => `<li class="warn">${esc(c)}</li>`).join('')}</ul>` : ''}
      </div>
      ${goodBuyHtml}
      ${trust}
      <div class="cta"><button class="btn" id="saveProduct" type="button">저장</button><a class="btn" href="/radar.html">내 레이더</a></div>
    </div>
  </section>

  ${summaryHtml(summary)}
  ${statsHtml}
  ${spark ? `<div class="spark">${spark}</div><div class="note">${PRICE_SOURCE_NOTE}</div>` : (points.length ? `<div class="note">기록 ${points.length}일치 — 그래프를 그릴 만큼 값이 움직이지 않았어요. ${PRICE_SOURCE_NOTE}</div>` : '<div class="note">아직 가격 기록이 없어요. 내일부터 쌓입니다.</div>')}
  ${storyHtml}

  ${link ? `<p class="aff-note" data-aff-note="product"><b>제휴 안내</b><span>${AFFILIATE_DISCLOSURE}</span></p>` : ''}
  <div class="cta">
    ${link ? `<a class="btn primary" id="affiliateLink" href="${esc(link)}" target="_blank" rel="nofollow sponsored noopener">${esc(mall)}에서 보기 →</a>` : '<span class="btn off">판매처 링크 없음</span>'}
    <a class="btn" href="/?p=${encodeURIComponent(product.productId)}">SEOSA에서 가격 추이 보기</a>
  </div>

  ${sibHtml}
  ${exploreHtml}
</main>
<footer class="wrap">
  SEOSA 는 상품을 직접 팔지 않아요. 위 가격은 SEOSA 가 그 시점에 <b>관측한 값</b>이고 판매처의 실제 결제 금액과 다를 수 있어요.
  판정은 SEOSA 가 수집한 기록만을 근거로 계산한 것이고 미래 가격을 예측하지 않아요.
</footer>
<script>(function(){
/* 계측 — api/_funnel.js FUNNEL_EVENTS 와 «같은 이름» 을 쓴다. 그래야 상품 단위
   행(funnel_events)까지 남는다. 다른 이름으로 부르면 날짜 카운터만 오르고
   «무엇이 저장·클릭됐는지» 는 사라진다.
   ★ 링크를 가로채지 않는다. preventDefault 도 새 탭 강제도 없다 —
     가운데 클릭·새 탭·키보드 이동을 막으면 안 된다. 계측만 얹는다. */
var product=${radarProduct},button=document.getElementById('saveProduct');
function track(name){try{var q='/api/stats?event='+encodeURIComponent(name)
+(product.productId?'&pid='+encodeURIComponent(product.productId):'')
+(product.mallLabel?'&mall='+encodeURIComponent(product.mallLabel):'')
+(product.price>0?'&price='+encodeURIComponent(String(product.price)):'')
+'&src=product';fetch(q,{keepalive:true}).catch(function(){})}catch(_){}}
function sync(){var on=!!RadarStore.find(product);button.textContent=on?'저장됨':'저장';button.setAttribute('aria-pressed',String(on))}
button.addEventListener('click',function(){var result=RadarStore.toggle(product);track(result.saved?'radar_save':'radar_remove');sync()});
var affiliate=document.getElementById('affiliateLink');
if(affiliate)affiliate.addEventListener('click',function(){track('affiliate_click')},{once:true});
Array.prototype.forEach.call(document.querySelectorAll('.sib a'),function(a){a.addEventListener('click',function(){track('compare_open')},{once:true})});
track('buy_wait_watch_view');sync()})();</script>
</body>
</html>`;
}

function render404(pid) {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>상품을 찾을 수 없어요 · SEOSA</title><meta name="robots" content="noindex"><style>${CSS}</style></head>
<body><header><div class="wrap"><a class="logo" href="/">SEO<b>SA</b></a></div></header>
<main class="wrap"><h1 style="margin-top:40px">이 상품의 가격 기록을 찾을 수 없어요</h1>
<p class="note">주소가 바뀌었거나 아직 수집되지 않은 상품이에요.${pid ? '' : ' 상품 식별자가 비어 있어요.'}</p>
<div class="cta"><a class="btn primary" href="/">SEOSA 홈으로</a></div></main></body></html>`;
}

/* ── 핸들러 ─────────────────────────────────────────────────────── */

/** JSON — 프론트 딥링크(?p=)가 상품 모달을 여는 데 쓴다. */
async function productHandler(req, res) {
  const q = req.query || {};
  const pid = cleanPid(q.pid);
  if (!pid) return res.status(400).json({ error: '상품 식별자 없음' });
  const v = await buildView(pid, String(q.mall || '').trim());
  if (!v) return res.status(404).json({ error: '상품 없음' });
  cachePublic(res, 300);
  return res.json({
    product: v.product,
    points: v.points,
    deal: { verdict: v.deal.verdict, label: v.deal.label, reasons: v.deal.reasons.slice(0, 4), cautions: v.deal.cautions.slice(0, 3) },
    indexable: v.indexable
  });
}

/** HTML — /p/{pid} */
async function pageHandler(req, res) {
  const q = req.query || {};
  const pid = cleanPid(q.pid);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!pid) { res.setHeader('Cache-Control', 'no-store'); return res.status(404).end(render404('')); }

  const v = await buildView(pid, String(q.m || '').trim());
  if (!v) {
    // 없는 상품 주소가 캐시에 오래 남으면 나중에 수집돼도 404 가 이어진다. 짧게.
    cachePublic(res, 60);
    return res.status(404).end(render404(pid));
  }
  const [siblings, ctx] = await Promise.all([
    loadSiblings(v.row),
    // 실패하면 빈 맥락 — breadcrumb 은 «홈 › 상품», brand 없음 (틀린 값보다 없는 값).
    require('./_seo-pages').productContext(v.row).catch(() => ({}))
  ]);
  if (!v.indexable) res.setHeader('X-Robots-Tag', 'noindex');
  cachePublic(res, PAGE_CACHE_S);
  return res.status(200).end(renderPage(v, siblings, ctx));
}

/**
 * 색인할 만한 상품만 고른다 — live 이고 링크가 있고 최근 30일 기록이 INDEX_MIN_DAYS 이상.
 * price_history 30일치를 훑어 상품별 관측 일수를 센다 (PostgREST 1,000행 페이지).
 */
/** 사이트맵 조회에서 동시에 보내는 페이지 요청 수. */
const SITEMAP_CONCURRENCY = 6;

/*
 * ★ 페이지를 동시에 읽는다 (2026-09-13 감사 후속 P2).
 *
 *   예전에는 30일 이력 3만여 행을 1,000행씩 순차로 34번 읽어 캐시 미스 한 번에
 *   12~15초가 걸렸다(운영 실측 14.7초, 로컬 DB 대기 11.85초). 첫 페이지에서 전체
 *   행 수를 받고, 나머지 페이지를 SITEMAP_CONCURRENCY 개씩 동시에 받는다.
 *   페이지 상한(maxPages)과 정렬은 예전과 같아 읽는 행과 결과가 같다.
 *   행 수를 모르면(count 없음) 예전처럼 순차로 읽는다.
 */
async function readPages(build, page, maxPages) {
  const first = await build({ count: 'exact' }).range(0, page - 1);
  if (first.error) throw new Error(first.error.message);
  const firstRows = first.data || [];
  if (firstRows.length < page) return firstRows;

  const total = Number(first.count);
  if (!Number.isFinite(total)) {
    const rows = firstRows.slice();
    for (let from = page, pages = 1; pages < maxPages; from += page, pages++) {
      const { data, error } = await build().range(from, from + page - 1);
      if (error) throw new Error(error.message);
      rows.push(...(data || []));
      if (!data || data.length < page) break;
    }
    return rows;
  }

  const offsets = [];
  for (let from = page, pages = 1; from < total && pages < maxPages; from += page, pages++) offsets.push(from);
  const results = new Array(offsets.length);
  let next = 0;
  const worker = async () => {
    while (next < offsets.length) {
      const i = next++;
      const { data, error } = await build().range(offsets[i], offsets[i] + page - 1);
      if (error) throw new Error(error.message);
      results[i] = data || [];
    }
  };
  await Promise.all(Array.from({ length: Math.min(SITEMAP_CONCURRENCY, offsets.length) }, worker));
  return firstRows.concat(...results);
}

/*
 * 폴백 사이트맵 — DB 함수(seo_sitemap_products)가 아직 없을 때만 쓰는 안전망.
 *
 * 읽는 양은 예전 그대로 묶어 둔다 (이력 40페이지 · 상품 10페이지). 매 요청마다
 * 운영 DB 를 전부 훑지 않는다 — 전수 계산은 DB 함수의 몫이다. 그래서 이 목록은
 * «전부» 가 아니다 (레드팀 재현: 2,012개 중 약 1,140개).
 *
 * 대신 «담은 것은 전부 index» 여야 한다. 판정은 상품 페이지와 같은
 * isIndexableProduct 이고, 관측일은 현재 옵션(sameVendorRows)으로 센다. 읽은
 * 이력은 30일 창의 일부라 관측일은 실제보다 적게 나온다 — 빠뜨릴 수는 있어도
 * 페이지가 noindex 인 URL 을 올리는 쪽으로는 틀리지 않는다.
 */
async function indexableProducts() {
  const PAGE = 1000;
  const since = new Date(Date.now() - 30 * 86400000).toISOString();

  const [history, products] = await Promise.all([
    readPages(opts => supabase
      .from('price_history')
      .select('product_id, mall, recorded_date, recorded_at, vendor_item_id', opts)
      .gte('recorded_at', since)
      .order('id', { ascending: true }), PAGE, 40),
    readPages(opts => supabase
      .from('products')
      .select('product_id, mall, keyword, title, lprice, link, collected_at, vendor_item_id', opts)
      .order('collected_at', { ascending: false }), PAGE, 10)
  ]);

  const rowsByKey = new Map();
  history.forEach(r => {
    const k = `${r.product_id}|${r.mall}`;
    if (!rowsByKey.has(k)) rowsByKey.set(k, []);
    rowsByKey.get(k).push(r);
  });

  const out = [];
  for (const p of products) {
    const days = observedDays(rowsByKey.get(`${p.product_id}|${p.mall}`), p.vendor_item_id);
    if (!isIndexableProduct(p, days)) continue;
    // lastmod 는 KST 날짜 — UTC 로 자르면 KST 00~09시 수집분이 하루 이르게 찍힌다.
    const t = Date.parse(p.collected_at || '');
    out.push({ pid: p.product_id, lastmod: Number.isFinite(t) ? kstToday(t) : '' });
    if (out.length >= SITEMAP_MAX) break;
  }
  return out;
}

/** XML — /sitemap-products.xml */
async function sitemapHandler(req, res) {
  const list = await indexableProducts();
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  cachePublic(res, SITEMAP_CACHE_S);
  const body = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    .concat(list.map(p => `  <url><loc>${esc(pageUrl(p.pid))}</loc>${p.lastmod ? `<lastmod>${esc(p.lastmod)}</lastmod>` : ''}<changefreq>daily</changefreq></url>`))
    .concat(['</urlset>'])
    .join('\n');
  return res.status(200).end(body);
}

module.exports = {
  productHandler, pageHandler, sitemapHandler,
  // 테스트용 순수 함수
  _internal: { esc, safeUrl, cleanPid, pageUrl, sparkSvg, renderPage, render404, describeForMeta, buildView, indexableProducts,
    observedDays, isIndexableProduct, INDEX_MIN_DAYS, SITE }
};
