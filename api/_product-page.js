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
 *   · Product/Offer 구조화 데이터를 넣지 않는다. SEOSA 는 판매자가 아니고 링크는
 *     제휴 링크다 (public/index.html 머리말의 판단과 같다). BreadcrumbList 와
 *     WebPage 만 넣고, 가격 사실은 본문 텍스트로 낸다.
 *   · 상품명·링크·이미지는 판매자 문자열이다. 전부 이스케이프하고 URL 은
 *     http(s) 만 통과시킨다.
 *   · 읽기 전용. 아무것도 쓰지 않는다.
 */

const supabase = require('./_supabase');
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
const SIBLINGS = 6;
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

/** 같은 검색어의 다른 상품 — 내부 링크. 현재가로 쓸 수 있는 행만. */
async function loadSiblings(row, limit) {
  if (!row || !row.keyword) return [];
  try {
    const { data } = await supabase
      .from('products')
      .select('product_id, mall, keyword, title, lprice, image, link, collected_at')
      .eq('keyword', row.keyword)
      .neq('product_id', row.product_id)
      .limit(40);
    return preferLive(freshRows(relevantRows(data || [])))
      .filter(r => r.link)
      .slice(0, limit == null ? SIBLINGS : limit);
  } catch (e) {
    return [];
  }
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
  const indexable = life.state === LIFECYCLE.LIVE && points.length >= INDEX_MIN_DAYS && !!safeUrl(row.link);

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
  'h2{font-size:1rem;margin:34px 0 10px}.sib{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(3,1fr);gap:12px}',
  '@media(max-width:560px){.sib{grid-template-columns:repeat(2,1fr)}}',
  '.sib li a{display:block;text-decoration:none;border:1px solid var(--line);border-radius:6px;padding:10px;font-size:.8rem;min-height:100%}',
  '.sib .t{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--soft);margin-bottom:6px}.sib .p{font-weight:700;font-variant-numeric:tabular-nums}',
  'footer{margin:48px 0 32px;font-size:.74rem;color:var(--soft);border-top:1px solid var(--line);padding-top:16px}',
  '.trust{font-size:.78rem;color:var(--soft);margin-top:10px}'
].join('');

function mallName(product) {
  return product.mallLabel || product.mall || '';
}

function describeForMeta(v) {
  const { product, stat, deal, points } = v;
  const parts = [];
  parts.push(`${mallName(product)} ${won(v.price)}원`);
  if (stat) {
    parts.push(`SEOSA 기록 ${points.length}일`);
    if (stat.low > 0) parts.push(`최저 ${won(stat.low)}원`);
    if (stat.avg30 > 0) parts.push(`30일 평균 ${won(stat.avg30)}원`);
  }
  if (deal && deal.verdict !== 'UNKNOWN') parts.push(`판정: ${deal.label}`);
  return parts.join(' · ').slice(0, 155);
}

function renderPage(v, siblings) {
  const { product, points, stat, deal, price, indexable, row } = v;
  const title = String(product.title || '').slice(0, 200);
  const img = safeUrl(product.image);
  const link = safeUrl(product.link);
  const url = pageUrl(product.productId);
  const last = points.length ? points[points.length - 1].date : '';
  const desc = describeForMeta(v);
  const mall = mallName(product);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'SEOSA', item: `${SITE}/` },
          row.keyword
            ? { '@type': 'ListItem', position: 2, name: String(row.keyword), item: `${SITE}/?q=${encodeURIComponent(row.keyword)}` }
            : null,
          { '@type': 'ListItem', position: row.keyword ? 3 : 2, name: title, item: url }
        ].filter(Boolean)
      },
      {
        '@type': 'WebPage',
        '@id': url,
        url,
        name: `${title} 가격 기록`,
        description: desc,
        inLanguage: 'ko-KR',
        isPartOf: { '@id': `${SITE}/#website` },
        dateModified: last ? `${last}T00:00:00+09:00` : undefined,
        primaryImageOfPage: img ? { '@type': 'ImageObject', url: img } : undefined
      }
    ]
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

  const spark = sparkSvg(points);
  const trust = product.trust && product.trust.label
    ? `<div class="trust">가격 신뢰도 · ${esc(product.trust.label)}${product.trust.summary ? ` — ${esc(product.trust.summary)}` : ''}</div>`
    : '';

  const sibHtml = siblings.length ? `
    <h2>「${esc(row.keyword)}」의 다른 상품</h2>
    <ul class="sib">${siblings.map(s => `
      <li><a href="/p/${encodeURIComponent(s.product_id)}">
        <div class="t">${esc(s.title)}</div>
        <div class="p">${won(s.lprice)}원</div>
      </a></li>`).join('')}
    </ul>` : '';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} 가격 기록 · SEOSA</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="${indexable ? 'index,follow' : 'noindex,follow'}">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta property="og:type" content="website">
<meta property="og:site_name" content="SEOSA">
<meta property="og:locale" content="ko_KR">
<meta property="og:title" content="${esc(title)} · ${won(price)}원">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
${img ? `<meta property="og:image" content="${esc(img)}">` : `<meta property="og:image" content="${SITE}/og.png">`}
<meta name="twitter:card" content="summary">
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
<style>${CSS}</style>
</head>
<body>
<header><div class="wrap">
  <a class="logo" href="/">SEO<b>SA</b></a>
  <a href="/?q=${encodeURIComponent(row.keyword || title.split(' ').slice(0, 2).join(' '))}" style="font-size:.82rem;color:var(--soft);text-decoration:none">비슷한 상품 더 보기 →</a>
</div></header>
<main class="wrap">
  <nav class="crumb" aria-label="경로"><a href="/">홈</a> › ${row.keyword ? `<a href="/?q=${encodeURIComponent(row.keyword)}">${esc(row.keyword)}</a> › ` : ''}가격 기록</nav>
  <h1>${esc(title)}</h1>
  <div class="meta"><span>${esc(mall)}</span>${last ? `<span>${esc(last)} 관측</span>` : ''}${row.keyword ? `<span>검색어 ${esc(row.keyword)}</span>` : ''}</div>

  <section class="hero">
    <div class="thumb">${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer">` : '<span style="color:var(--soft)">이미지 없음</span>'}</div>
    <div>
      <div class="price">${price > 0 ? `${won(price)}<small> 원</small>` : '가격 미확인'}</div>
      <div class="verdict">
        <b>${esc(deal.label)}</b>
        ${reasons.length ? `<ul>${reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        ${cautions.length ? `<ul>${cautions.map(c => `<li class="warn">${esc(c)}</li>`).join('')}</ul>` : ''}
      </div>
      ${trust}
    </div>
  </section>

  ${statsHtml}
  ${spark ? `<div class="spark">${spark}</div><div class="note">${PRICE_SOURCE_NOTE}</div>` : (points.length ? `<div class="note">기록 ${points.length}일치 — 그래프를 그릴 만큼 값이 움직이지 않았어요. ${PRICE_SOURCE_NOTE}</div>` : '<div class="note">아직 가격 기록이 없어요. 내일부터 쌓입니다.</div>')}

  <div class="cta">
    ${link ? `<a class="btn primary" href="${esc(link)}" target="_blank" rel="nofollow sponsored noopener">${esc(mall)}에서 보기 →</a>` : '<span class="btn off">판매처 링크 없음</span>'}
    <a class="btn" href="/?p=${encodeURIComponent(product.productId)}">SEOSA에서 가격 추이 보기</a>
  </div>

  ${sibHtml}
</main>
<footer class="wrap">
  SEOSA 는 상품을 직접 팔지 않아요. 위 가격은 SEOSA 가 그 시점에 <b>관측한 값</b>이고 판매처의 실제 결제 금액과 다를 수 있어요.
  판매처로 이동하면 제휴 수수료를 받을 수 있어요.
  판정은 SEOSA 가 수집한 기록만을 근거로 계산한 것이고 미래 가격을 예측하지 않아요.
</footer>
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
  const siblings = await loadSiblings(v.row);
  if (!v.indexable) res.setHeader('X-Robots-Tag', 'noindex');
  cachePublic(res, PAGE_CACHE_S);
  return res.status(200).end(renderPage(v, siblings));
}

/**
 * 색인할 만한 상품만 고른다 — live 이고 링크가 있고 최근 30일 기록이 INDEX_MIN_DAYS 이상.
 * price_history 30일치를 훑어 상품별 관측 일수를 센다 (PostgREST 1,000행 페이지).
 */
async function indexableProducts() {
  const PAGE = 1000;
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const days = new Map();
  for (let from = 0, pages = 0; pages < 40; from += PAGE, pages++) {
    const { data, error } = await supabase
      .from('price_history')
      .select('product_id, mall, recorded_date, recorded_at')
      .gte('recorded_at', since)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    (data || []).forEach(r => {
      const k = `${r.product_id}|${r.mall}`;
      if (!days.has(k)) days.set(k, new Set());
      days.get(k).add(observedKstDate(r));
    });
    if (!data || data.length < PAGE) break;
  }

  const out = [];
  for (let from = 0, pages = 0; pages < 10; from += PAGE, pages++) {
    const { data, error } = await supabase
      .from('products')
      .select('product_id, mall, keyword, title, lprice, link, collected_at')
      .order('collected_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    (data || []).forEach(p => {
      if (productLifecycle(p).state !== LIFECYCLE.LIVE) return;
      if (!safeUrl(p.link) || !cleanPid(p.product_id)) return;
      const d = days.get(`${p.product_id}|${p.mall}`);
      if (!d || d.size < INDEX_MIN_DAYS) return;
      out.push({ pid: p.product_id, lastmod: String(p.collected_at || '').slice(0, 10) });
    });
    if (!data || data.length < PAGE) break;
    if (out.length >= SITEMAP_MAX) break;
  }
  return out.slice(0, SITEMAP_MAX);
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
  _internal: { esc, safeUrl, cleanPid, pageUrl, sparkSvg, renderPage, render404, describeForMeta, buildView, indexableProducts, INDEX_MIN_DAYS, SITE }
};
