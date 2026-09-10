#!/usr/bin/env node
/**
 * 히어로 책등 11권 → 쿠팡 파트너스 제휴 링크 자동 연결.
 *
 * ★ 제휴 링크를 «만들지» 않는다. 만드는 곳은 쿠팡이다.
 *   api/_coupang.js 의 searchCoupang() 은 COUPANG_ACCESS_KEY 로 서명한
 *   파트너스 검색 API(affiliate_open_api)를 부르고, 그 응답의 productUrl 이
 *   이미 그 계정에 귀속된 link.coupang.com/re/... 딥링크다. SEOSA 의 모든
 *   상품 링크가 여태 이 한 경로에서 나왔다(products.link 200/200 동일 도메인).
 *   여기서는 그 값을 «고르기만» 한다 — 문자열을 조합하지 않는다.
 *
 * 사용법
 *   node scripts/resolve-shelf-books.js           후보만 보여준다(파일 안 건드림)
 *   node scripts/resolve-shelf-books.js --write   확정된 책만 index.html 에 넣는다
 *
 * 애매하면 연결하지 않는다. 빈 채로 두는 것이 틀린 상품에 연결하는 것보다 낫다.
 */
'use strict';

require('./_env.js');
const fs = require('fs');
const path = require('path');
const { searchCoupang } = require('../api/_coupang');
const { isRelevant } = require('../api/_search');

const HTML = path.join(__dirname, '..', 'public', 'index.html');
const WRITE = process.argv.includes('--write');

/* index.html 의 SHELF_BOOKS 와 «순서까지» 같아야 한다. */
const BOOKS = [
  { i: 0,  title: '코스모스',            author: '칼 세이건' },
  { i: 1,  title: '이기적 유전자',        author: '리처드 도킨스' },
  { i: 2,  title: '워런 버핏의 주주 서한', author: '워런 버핏' },
  { i: 3,  title: '돈의 속성',            author: '김승호' },
  { i: 4,  title: '아주 작은 습관의 힘',   author: '제임스 클리어' },
  { i: 5,  title: '진보를 위한 주식투자',  author: '이광수' },
  { i: 6,  title: '내면근력',             author: '짐 머피' },
  { i: 7,  title: '윤슬의 바다',          author: '' },
  { i: 8,  title: '수족관',              author: '유래혁' },
  { i: 9,  title: '시한부',              author: '백은별' },
  { i: 10, title: '나의 사탄',            author: 'wefic' }
];

/*
 * 오매칭 방지 목록.
 *
 * 책등에 그려진 것은 «종이책 단권» 이다. 아래에 걸리면 같은 작품이어도
 * 다른 물건이므로 연결하지 않는다. (리커버·개정판은 같은 단권이라 뺐다)
 */
const REJECT = [
  '전자책', 'ebook', 'e북', '이북', '오디오북', '중고', '대여',
  '세트', '합본', '전집', '박스', '굿즈', '다이어리', '캘린더',
  '영문판', '원서', '영어원서', '만화', '그림책판', '워크북', '필사'
];

/*
 * 합본 판정.
 *
 * ★ 1차 실행에서 실제로 이것 때문에 3권이 «다른 책» 에 연결될 뻔했다.
 *   "(모건 하우절) 돈의 심리학 + (제임스 클리어) 아주 작은 습관의 힘" 같은
 *   묶음 상품은 제목도 저자도 들어 있어서 제목/저자 검사만으로는 통과한다.
 *   책등 그림은 «그 책 한 권» 이므로 묶음은 다른 물건이다.
 */
const BUNDLE = /\+|전\s*\d\s*권|\d\s*권\s*세트|2권|3권/;

const norm = s => String(s || '').toLowerCase().replace(/[\s·:*,.\-—–_'"“”‘’()[\]]/g, '');

/**
 * 판촉 문구를 걷어내고 «상품명의 알맹이» 만 남긴다.
 * 쿠팡 도서 리스팅은 앞뒤에 사은품·증정·괄호 홍보가 겹겹이 붙는다.
 */
function core(title) {
  let t = String(title || '');
  for (let k = 0; k < 6; k++) {
    const before = t;
    t = t.replace(/^\s*[[(（][^\])）]*[\])）]\s*/, '')      // 앞쪽 괄호 홍보
         .replace(/^\s*(사은품|증정|추천도서|베스트셀러|ㅁ)\s*/i, '')
         .replace(/\s*[[(（][^\])）]*(증정|사은품|수첩|책갈피|볼펜|포장|기프트|랜덤)[^\])）]*[\])）]\s*/g, ' ');
    if (t === before) break;
  }
  return t.trim();
}

/** 저자 이름이 상품명에 들어 있는가. 없다고 틀린 책인 것은 아니다(가산점일 뿐). */
function authorHit(title, author) {
  if (!author) return null;
  const t = norm(title);
  if (t.includes(norm(author))) return true;
  const parts = author.split(/\s+/).filter(Boolean);
  return parts.length > 1 && parts.every(p => t.includes(norm(p))) ? true : false;
}

/*
 * 국내 단행본 정가대. 이 밖은 묶음이거나 굿즈다.
 * (1차 실행 실측: 정상 단권 11,700~19,800원 / 묶음 27,200~54,720원)
 */
const PRICE_MIN = 7000, PRICE_MAX = 33000;

function judge(book, it) {
  const raw = it.title || '';
  const c = core(raw);
  const bad = REJECT.find(w => norm(raw).includes(norm(w)));
  if (bad) return { ok: false, why: `제외어(${bad})` };
  if (BUNDLE.test(raw)) return { ok: false, why: '묶음/전N권' };
  if (!(it.lprice >= PRICE_MIN && it.lprice <= PRICE_MAX)) return { ok: false, why: `가격대 이탈(${it.lprice})` };

  /*
   * 알맹이가 «책 제목으로 시작» 해야 한다. 포함만으로는 부족하다 —
   * "시한부 + 윤슬의 바다" 나 액세서리 상품명이 그 검사를 통과한다.
   */
  const nb = norm(book.title), nc = norm(c);
  if (!nc.startsWith(nb)) return { ok: false, why: nc.includes(nb) ? '제목이 앞머리가 아님' : '제목 불일치' };
  if (!isRelevant(book.title, raw)) return { ok: false, why: '관련성 미달' };

  /*
   * 저자 가산점. 단, 저자 이름이 제목 «안에» 들어 있는 책은 제외한다 —
   * 「워런 버핏의 주주 서한」은 어느 리스팅이든 '워런 버핏'을 포함하므로
   * 그 가산점이 아무것도 구분해 주지 못한다.
   */
  const trivial = norm(book.title).includes(norm(book.author || ' '));
  const a = !trivial && authorHit(raw, book.author) === true;

  // 알맹이가 제목보다 얼마나 더 긴가 — 짧을수록 «그 책 자체» 인 리스팅이다.
  const noise = nc.length - nb.length;
  // 판매자 홍보 문구로 시작하지 않는, 제목이 맨 앞인 리스팅이 그 책의 대표 리스팅이다.
  const headline = norm(raw).startsWith(nb);
  const promo = /사은품|gift|증정|추천도서|베스트셀러/i.test(raw);
  return { ok: true, why: a ? '제목+저자' : '제목 일치', noise, author: a, headline, promo };
}

(async () => {
  if (!process.env.COUPANG_ACCESS_KEY || !process.env.COUPANG_SECRET_KEY) {
    console.error('BLOCKED: COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY 가 없습니다.');
    process.exit(2);
  }

  const resolved = [];
  for (const b of BOOKS) {
    /*
     * 질의는 두 번까지. "제목 저자" 가 0건이면 제목만으로 한 번 더 본다 —
     * 1차 실행에서 「시한부 백은별」이 엉뚱한 필사책만 물어 왔다.
     */
    const queries = b.author ? [`${b.title} ${b.author}`, b.title] : [b.title];
    let r = null, cands = [], hit = [], used = '';
    for (const kw of queries) {
      used = kw;
      r = await searchCoupang(kw, { limit: 10, source: 'diag', maxWaitMs: 4000 });
      cands = (r.items || []).map(it => ({ it, v: judge(b, it) }));
      hit = cands.filter(c => c.v.ok);
      if (hit.length) break;
    }

    console.log(`\n[${b.i}] ${b.title} — ${b.author || '(저자 미표기)'}   질의="${used}"  from=${r.from}${r.error ? '  err=' + r.error : ''}`);
    if (!r.items || !r.items.length) console.log('     후보 없음');
    cands.forEach(c => console.log(
      `     ${c.v.ok ? '○' : '×'} ${String(c.it.lprice).padStart(7)}원  ${String(c.v.why).padEnd(18)} ${c.it.title.slice(0, 56)}`));

    /*
     * 통과한 것 중 «가장 군더더기 없는» 리스팅을 고른다. 저자가 적힌 쪽을
     * 먼저 보고, 그다음 알맹이가 제목에 가까운 쪽이다. 같은 책의 다른
     * 판매 리스팅들이므로 어느 것을 골라도 같은 책이고, 그중 제목이 가장
     * 깨끗한 것이 그 책의 대표 리스팅이다.
     */
    hit.sort((x, y) =>
      (y.v.headline - x.v.headline)     // 제목이 맨 앞인 리스팅
      || (x.v.promo - y.v.promo)        // 판촉 문구가 없는 쪽
      || (y.v.author - x.v.author)      // 저자가 적힌 쪽
      || (x.v.noise - y.v.noise));      // 그다음 군더더기가 적은 쪽
    let pick = hit[0] || null;
    let reason = pick ? (hit.length > 1 ? `통과 ${hit.length}건 — 군더더기 최소 채택` : '단독 통과') : '조건을 통과한 후보 없음';

    if (pick && !/^https:\/\/link\.coupang\.com\//.test(pick.it.link || '')) {
      console.log(`     ⚠ 제휴 도메인이 아니라 채택 취소: ${String(pick.it.link).slice(0, 40)}`);
      pick = null; reason = '제휴 도메인 아님';
    }
    console.log(`     → ${pick ? '채택: ' + pick.it.title.slice(0, 50) + `  [${pick.it.lprice}원]` : '연결 안 함'}  (${reason})`);
    resolved.push({ b, url: pick ? pick.it.link : '', picked: pick ? pick.it : null });
  }

  const ok = resolved.filter(r => r.url);
  console.log(`\n───── 성공 ${ok.length} / 실패 ${resolved.length - ok.length}`);
  if (!WRITE) { console.log('(--write 없이 실행 — 파일은 건드리지 않았습니다)'); return; }

  /*
   * index.html 쓰기.
   *
   * 정규식을 쓰지 않는다 — 제목에 특수문자가 들어오는 순간 이스케이프가 곧
   * 버그가 된다. SHELF_BOOKS 블록 «안에서» 그 제목이 있는 줄을 찾아, 그 줄의
   * 빈 coupangUrl 만 바꾼다. 이미 값이 있는 줄은 건드리지 않는다.
   */
  const src = fs.readFileSync(HTML, 'utf8');
  const nl = src.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = src.split(nl);
  const from = lines.findIndex(l => l.includes('var SHELF_BOOKS = ['));
  const to = from >= 0 ? lines.findIndex((l, i) => i > from && l.trim() === '];') : -1;
  if (from < 0 || to < 0) { console.error('BLOCKED: SHELF_BOOKS 블록을 찾지 못했습니다'); process.exit(3); }

  let n = 0;
  for (const r of resolved) {
    if (!r.url) continue;
    const marker = "title: '" + r.b.title + "',";
    const at = lines.findIndex((l, i) => i > from && i < to && l.includes(marker));
    if (at < 0) { console.log(`  ! [${r.b.i}] ${r.b.title} 줄을 찾지 못했습니다`); continue; }
    let line = lines[at];
    if (!line.includes("coupangUrl: ''")) { console.log(`  ! [${r.b.i}] 이미 값이 있어 건너뜁니다`); continue; }
    line = line.replace("coupangUrl: ''", "coupangUrl: '" + r.url + "'");
    // productId 는 계측용이다 — funnel_events 에 «어느 책이 눌렸는지» 를 남긴다.
    line = line.replace("productId: ''", "productId: '" + String(r.picked.productId) + "'");
    lines[at] = line;
    n++;
  }
  fs.writeFileSync(HTML, lines.join(nl));
  console.log(`public/index.html 에 ${n}권 반영`);
})();
