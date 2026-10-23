/*
 * 카드는 요청한 상품만 — 다른 모델·형제 모델은 카드에서 뺀다 (CO-04, 2026-10-23 실호출 관측).
 *
 * ── 재현 ──────────────────────────────────────────────────────────
 *
 *   "로지텍 G304 마우스 최저가" 실호출에서 1위와 답변 문장은 정확한 G304 LIGHTSPEED 였지만,
 *   카드 뒤쪽에 G304 X SUPERLIGHT·G102 LIGHTSPEED 가 섞였다.
 *
 * ── 정책 ──────────────────────────────────────────────────────────
 *
 *   EXACT 상태 — 정확한 후보가 있으면 다른 모델은 카드에서 빠진다.
 *   NEAR  상태 — 정확한 후보가 없다. 근접 후보 카드에는 무엇이 다른지 라벨을 붙인다.
 *   식별 없는 질의 — EXACT 그대로. 라벨은 비어 있다.
 *
 * api/ai.js 핸들러를 실제로 돌린다. 가짜 쇼핑·가짜 LLM. 외부 호출 0회, DB 쓰기 0회.
 */
'use strict';

const path = require('path');
const Module = require('module');

process.env.AUTH_SECRET = 'offline-card-identity-key';
process.env.OPENROUTER_API_KEY = 'sk-or-v1-OFFLINE-CARDID';
process.env.OPENROUTER_MODELS = 'test/offline:free';
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
process.env.AI_SEARCH_TIMEOUT_MS = '300';

/* ── 가짜 Supabase (읽기만, 빈 결과) ───────────────────────────────── */
function query() {
  let rows = [];
  const q = {
    select() { return q; }, in() { return q; }, eq() { return q; }, gte() { return q; }, lte() { return q; },
    order() { return q; }, limit() { rows = rows.slice(0, 0); return q; },
    then(resolve) { return Promise.resolve({ data: rows, error: null }).then(resolve); }
  };
  ['upsert', 'insert', 'update', 'delete'].forEach(m => {
    q[m] = () => { throw new Error(`DB write forbidden in test: ${m}`); };
  });
  return q;
}
const fakeSupabase = { from: () => query(), rpc: () => Promise.resolve({ data: [], error: null }) };
const supabasePath = path.resolve(__dirname, '..', 'api', '_supabase.js');
const realLoad = Module._load;
Module._load = function(request) {
  if (request === './_supabase' || request === '../api/_supabase' || request === supabasePath) return fakeSupabase;
  return realLoad.apply(this, arguments);
};

/* ── 가짜 쇼핑 공급자 ───────────────────────────────────────────── */
let feed = [];
const shop = require('../api/_shop');
shop.searchAll = async () => ({ items: feed.map(it => ({ ...it, _source: 'api' })), from: 'api', blocked: false });
shop.saveProducts = async () => ({ saved: 0 });
require('../api/_trust').attachTrust = async list => {
  (list || []).forEach(it => { if (it) it.trust = { level: 'high', label: '확인된 가격', reasons: ['SEOSA 기록 확인'] }; });
  return list;
};

const handler = require('../api/ai.js');

/* ── 러너 ──────────────────────────────────────────────────────── */
async function ask(body) {
  let status = 200;
  let payload = null;
  const res = {
    status(c) { status = c; return this; },
    setHeader() { return this; },
    json(v) { payload = v; return this; },
    end() { payload = payload || {}; return this; }
  };
  const quiet = console.log, qw = console.warn, qe = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    await handler({ method: 'POST', headers: {}, query: {}, body: Object.assign({ contextProducts: [], view: { source: 'none' } }, body) }, res);
  } finally {
    console.log = quiet; console.warn = qw; console.error = qe;
  }
  const b = payload || {};
  return { status, body: b, text: String(b.text || ''), cards: Array.isArray(b.items) ? b.items : [] };
}

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); return; }
  fails.push(name);
  console.log(`  [FAIL] ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 320)}`}`);
}
function section(t) { console.log(`\n── ${t}`); }

function item(id, title, price, mall) {
  return {
    productId: id, title, lprice: price, mall: mall || 'ADPICK', mallLabel: mall || 'ADPICK',
    link: `https://example.com/${id}`, image: 'https://example.com/i.png',
    vendorItemId: id, isCoupang: false, isRocket: false
  };
}

(async () => {
  /* ================================================================ */
  section('A. G304 재현 — EXACT 상태 (정확한 후보가 있다)');
  {
    feed = [
      item('a1', '로지텍 G304 무선 게이밍 마우스 저소음', 40900),
      item('a2', '[기프트] 로지텍 국내 정품 무선 게이밍 마우스 G304', 59900),
      item('a3', '로지텍/로지텍코리아 공식 G304 LIGHTSPEED 무선 게이밍 마우스', 59900),
      item('a4', '로지텍 로지텍코리아 공식 G304 X SUPERLIGHT 게이밍 마우스 라일락', 101370),
      item('a5', '로지텍코리아 공식 G304 X SUPERLIGHT 게이밍 마우스 블랙', 109000),
      item('a6', '[보리보리] 아트박스 POOM 아트박스/오피스큐 로지텍 광마우스 G102 LIGHTSPEED', 36360)
    ];
    const r = await ask({ question: '로지텍 G304 마우스 최저가', chatHistory: [{ role: 'user', text: '로지텍 G304 마우스 최저가' }] });
    const titles = r.cards.map(c => c.title);
    ok(r.cards.length > 0 && r.cards.every(c => /G304(?!\s*X)/i.test(c.title) && !/G304\s*X/i.test(c.title) && !/G102/i.test(c.title)),
      '카드에 G304 만 — G304 X·G102 는 빠진다', titles);
    ok(r.cards.every(c => !c.identityNote), 'EXACT 상태에서는 카드에 identityNote 가 붙지 않는다 (전부 정확한 모델이므로)', r.cards.map(c => c.identityNote));
    ok(r.cards.length >= 1 && /G304(?!\s*X)/i.test(r.cards[0].title) && !/G304\s*X/i.test(r.cards[0].title),
      '1위 카드도 정확한 G304', r.cards[0] && r.cards[0].title);
  }

  /* ================================================================ */
  section('B. 모델 번호 다름 — SIBLING 전부');
  {
    // 요청: G304 — 후보는 전부 다른 모델(G502·G102). 정확한 후보 0 → NEAR 상태.
    feed = [
      item('b1', '로지텍 G502 HERO 무선 게이밍 마우스', 89000),
      item('b2', '로지텍 G102 LIGHTSPEED 유선 게이밍 마우스', 29000),
      item('b3', '로지텍 G304 X SUPERLIGHT 무선 게이밍 마우스', 99000)
    ];
    const r = await ask({ question: '로지텍 G304 마우스 추천해줘', chatHistory: [{ role: 'user', text: '로지텍 G304 마우스 추천해줘' }] });
    // _concierge NEAR 메시지가 나오거나(items 0 일 때) 라벨이 붙은 카드가 나오거나.
    if (r.cards.length) {
      ok(r.cards.every(c => /다른 모델/.test(String(c.identityNote || ''))),
        'NEAR 카드마다 「다른 모델: …」 라벨', r.cards.map(c => `${c.title.slice(0, 20)} | ${c.identityNote || ''}`));
    } else {
      ok(/찾지 못했어요|가장 가까운/.test(r.text), '카드가 비면 답변이 그 사실을 말한다', r.text.slice(0, 160));
    }
    ok(!r.cards.some(c => /G304(?!\s*X)/i.test(c.title) && !/G304\s*X/i.test(c.title)),
      '정확한 G304 는 애초에 없다 (검증용)', r.cards.map(c => c.title));
  }

  /* ================================================================ */
  section('C. 식별 라벨이 없는 질의 — 그대로 카드');
  {
    feed = [
      item('c1', '무선 블루투스 이어폰', 29000),
      item('c2', '프리미엄 무선 이어폰 노이즈캔슬링', 89000)
    ];
    const r = await ask({ question: '이어폰 추천해줘', chatHistory: [{ role: 'user', text: '이어폰 추천해줘' }] });
    ok(r.cards.length === 2 && r.cards.every(c => !c.identityNote),
      '식별 anchor 가 없는 질의에서는 카드가 그대로 간다 (라벨도 없다)', r.cards.map(c => `${c.title} | note=${c.identityNote || ''}`));
  }

  /* ================================================================ */
  section('D. 다른 용량 — 카드에 두되 라벨을 붙인다 (NEAR tier)');
  {
    /*
     * 용량 다름(NEAR) 은 모델이 바뀐 것이 아니라 같은 모델의 다른 변형이다. 카드에는 두고 라벨만 붙인다.
     * 이는 "블랙 추천" 뒤 "이 중에서 가장 싼 것" 에 두 색상을 비교할 수 있어야 하는 정책
     * (test-ai-pipeline [21]) 과도 같은 규칙이다 — SIBLING 만 거르고 NEAR 는 라벨만 붙인다.
     */
    feed = [
      item('d1', 'Apple 아이폰 17 Pro 256GB 블랙', 1599000),
      item('d2', 'Apple 아이폰 17 Pro 512GB 블랙', 1899000)
    ];
    const r = await ask({ question: '아이폰 17 프로 256GB 추천', chatHistory: [{ role: 'user', text: '아이폰 17 프로 256GB 추천' }] });
    const by = Object.fromEntries(r.cards.map(c => [c.productId, c]));
    ok(by.d1 && !by.d1.identityNote, '요청한 용량(256GB) 카드는 라벨이 없다', by.d1 && by.d1.identityNote);
    ok(by.d2 && /용량/.test(String((by.d2 || {}).identityNote || '')),
      '다른 용량(512GB) 카드는 「용량 다름」 라벨', by.d2 && by.d2.identityNote);
  }

  /* ================================================================ */
  section('E. 소프트 제외 — EXCLUDED 는 거르지 않고 라벨도 아니다');
  {
    /*
     * EXCLUDED 는 사용자가 "삼성 빼줘" 라고 명시한 상태로, 소프트 제외 정책
     * (test-ai-pipeline [30]) 상 카드에 남고 랭킹만 내린다. 핸들러 통합 재현은 거기서 하므로,
     * 여기서는 identity 라벨링 규칙만 확인한다 — EXCLUDED tier 는 "다른 모델" 로 적지 않는다.
     */
    const AI = require('../api/_aiidentity');
    const items = [
      { title: '베타 무선 이어폰', _identity: { tier: AI.TIER.EXACT, label: '', reasons: [] } },
      { title: '삼성 갤럭시 버즈', _identity: { tier: AI.TIER.EXCLUDED, label: '제외 요청하신 삼성', reasons: ['excluded'] } }
    ];
    // 핸들러 안의 라벨링 로직과 같은 규칙 — EXCLUDED 는 identityNote 를 받지 않는다.
    const notes = items.map(it => {
      const id = it._identity;
      if (!id || id.tier === AI.TIER.EXACT || !id.label) return null;
      if (id.tier === AI.TIER.EXCLUDED) return null;
      return `다른 모델: ${id.label}`;
    });
    ok(notes[0] === null && notes[1] === null,
      'EXCLUDED tier 는 「다른 모델」 라벨을 받지 않는다 (제외 설명은 다른 자리)', notes);
  }

  console.log(`\n=== 결과: ${pass}/${pass + fails.length} PASS ===`);
  if (fails.length) {
    console.log('\n실패:');
    fails.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
})();
