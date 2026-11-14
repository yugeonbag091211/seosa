#!/usr/bin/env node
/*
 * SEOSA AI 100문항 평가 하네스 (2026-11-14 개편).
 *
 *   node scripts/test-100-questions.js                          드라이런: 계획·호출량·비용 추정만 (호출 0회)
 *   node scripts/test-100-questions.js --offline --snapshot=<catalog.jsonl>
 *        실제 v3 라우트·엔진(createEngine + searchCatalog)을 동결 카탈로그 위에서 돌린다.
 *        GPT 는 결정적 대역(scripts/ai-100/planner.js), 판매처 API·DB·네트워크 0회.
 *   node scripts/test-100-questions.js --live [--base=https://seosa.ai.kr] [--require-v3]
 *        실서버에 실제 요청(유료 AI·판매처 검색·Neon 전송 발생) — 사용자 승인 뒤에만.
 *
 * 옵션: --max=N  --only=Q001,Q046  --delay-ms=7000  --timeout-ms=40000  --review-file=<json>
 *       --price-in=<$/1M>  --price-out=<$/1M>  --label=before|after  --out=<file.json>
 *
 * 판정(scripts/ai-100/grade.js): HTTP 200 은 전송 성공일 뿐이다. 카드 유형·예산·브랜드·모델·
 * 중고·낡은 가격·링크·후속 문맥을 hard 로 보고(FAIL), 판단이 필요한 문항은 UNVERIFIED 로 남긴다.
 * 후속 질문(Q046–Q055)은 seed 질문과 «같은 세션» 에서 웹과 같은 요청 모양으로 순서대로 보낸다:
 * chatHistory(이번 질문을 끝에 넣고, 받은 답은 turnSig 와 함께) · state(받은 그대로) · convState.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CASES, CATEGORY_LABELS } = require('./ai-100/cases');
const { gradeCase, summarize, cardsOf, answerOf } = require('./ai-100/grade');

const argv = process.argv.slice(2);
const has = f => argv.includes('--' + f);
const opt = (name, fallback) => {
  const a = argv.find(x => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : fallback;
};
const MODE = has('live') ? 'live' : has('offline') ? 'offline' : 'dry-run';
const BASE = String(opt('base', argv.find(a => /^https:\/\//.test(a)) || 'https://seosa.ai.kr')).replace(/\/+$/, '');
const ENDPOINT = BASE + '/api/ai?v=3';
const REQUIRE_V3 = has('require-v3');
const DELAY_MS = Math.max(MODE === 'live' ? 5500 : 0, Number(opt('delay-ms', MODE === 'live' ? 7000 : 0)) || 0);
const TIMEOUT_MS = Math.max(5000, Number(opt('timeout-ms', 40000)) || 40000);
const ONLY = opt('only', '') ? new Set(opt('only', '').split(',').map(s => s.trim()).filter(Boolean)) : null;
const MAX = Math.max(1, Math.min(100, Number(opt('max', 100)) || 100));
const LABEL = String(opt('label', 'run')).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'run';
const PRICES = opt('price-in') && opt('price-out') ? { input: Number(opt('price-in')), output: Number(opt('price-out')) } : null;
const REVIEW = opt('review-file') ? JSON.parse(fs.readFileSync(opt('review-file'), 'utf8')) : null;

const selected = CASES.filter(c => (!ONLY || ONLY.has(c.id)) && c.n <= MAX);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sessionId = () => 'h100_' + crypto.randomBytes(12).toString('hex');
const gitSha = () => { try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_) { return null; } };

/* ── 전송: live(HTTP) · offline(라우트 직접) 같은 모양 { status, version, gate, elapsedMs, error, data } ── */
function liveClient() {
  return async body => {
    const t0 = Date.now();
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'seosa-ai-100-harness/2026-11-14' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
      const raw = await res.text();
      let data, error = null;
      try { data = JSON.parse(raw); } catch (_) { data = {}; error = 'non_json_response'; }
      return { status: res.status, version: res.headers.get('x-ai-version') || 'unknown', gate: res.headers.get('x-ai-v3-gate') || null,
        elapsedMs: Date.now() - t0, error: error || (data && data.error) || null, data };
    } catch (e) {
      return { status: 0, version: 'network-error', gate: null, elapsedMs: Date.now() - t0, error: String(e && e.name === 'TimeoutError' ? 'timeout' : (e.message || e)).slice(0, 200), data: {} };
    }
  };
}

function offlineClient(snapshotPath) {
  // 오프라인은 네트워크를 쓰지 않는다 — 쓰려는 순간 실패시킨다.
  global.fetch = async url => { throw new Error('offline harness: network call blocked: ' + String(url).slice(0, 80)); };
  process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'offline-harness-turn-secret';
  process.env.AI_V3_STATE_SECRET = process.env.AI_V3_STATE_SECRET || 'offline-harness-state-secret';
  delete process.env.SEOSA_DB_READONLY;
  const { loadSnapshot, createSnapshotDb } = require('./ai-v31-rootcause/snapshot-db');
  const rows = loadSnapshot(snapshotPath);
  const asOfMs = Math.max(...rows.map(r => Date.parse(r.collected_at)).filter(Number.isFinite));
  const db = createSnapshotDb(rows);
  const catalog = require('../api/_ai-v3-catalog');
  const route = require('../api/_ai-v3-route');
  const { planFor } = require('./ai-100/planner');
  const mapRow = r => ({ productId: r.product_id, title: r.title, lprice: r.lprice, mall: r.mall, link: r.link, image: '',
    vendorItemId: r.vendor_item_id || '', collectedAt: r.collected_at });
  let ip = 0;
  const send = body => new Promise((resolve, reject) => {
    const usage = { model: 'offline-scripted', calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const adapter = {
      now: asOfMs,   // 엔진 시계 = 스냅숏 시각(가격 신선도 판정이 스냅숏 기준이 된다)
      getUsage: () => ({ ...usage }),
      planModel: async ({ message }) => { usage.calls++; return planFor(message); },
      decideModel: async ({ candidates, message }) => {
        usage.calls++;
        return { productIds: candidates.slice(0, /하나만|한\s*개만|딱\s*하나/.test(message) ? 1 : 4).map(c => c.id) };
      },
      chatResponse: async () => { usage.calls++; return '(오프라인 대역) 일반 질문에 대한 답 자리입니다. 상품이 필요하면 말씀해 주세요.'; }
    };
    const deps = { testMode: true, adapter,
      searchProducts: (query, o) => catalog.searchCatalog(query, { ...o, db, mapRow, liveSearch: null, searchStrategy: 'db-first' }),
      loadDisplayed: ids => catalog.loadProductsByIds(ids, { db, mapRow }) };
    ip++;
    const req = { method: 'POST', headers: {}, query: { v: '3' }, body, socket: { remoteAddress: `10.100.${(ip >> 8) & 255}.${ip & 255}` } };
    const t0 = Date.now();
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
      getHeader(k) { return headers[String(k).toLowerCase()]; },
      status(n) { this.statusCode = n; return this; },
      json(data) { resolve({ status: this.statusCode, version: headers['x-ai-version'] || 'unknown', gate: headers['x-ai-v3-gate'] || null,
        elapsedMs: Date.now() - t0, error: (data && data.error) || null, data }); return this; },
      end() { resolve({ status: this.statusCode, version: headers['x-ai-version'] || 'unknown', gate: headers['x-ai-v3-gate'] || null,
        elapsedMs: Date.now() - t0, error: 'empty_body', data: {} }); return this; }
    };
    Promise.resolve(route._handler(req, res, deps)).catch(reject);
  });
  send.meta = { snapshot: path.basename(snapshotPath), rows: rows.length, asOf: new Date(asOfMs).toISOString(),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex') };
  send.nowMs = asOfMs;
  return send;
}

/* ── 웹과 같은 대화 한 칸 ── */
function newConversation() {
  return { sessionId: sessionId(), chatHistory: [], state: {}, convState: '', prevTop: '', prevTopRef: '' };
}
async function ask(send, conv, question) {
  conv.chatHistory.push({ role: 'user', text: question });   // 웹 Chat.send 처럼 보내기 전에 넣는다
  const body = { question, contextProducts: [], chatHistory: conv.chatHistory.slice(-10), profile: {}, view: { source: 'home' },
    prevTop: conv.prevTop, prevTopRef: conv.prevTopRef, convState: conv.convState, state: conv.state, sessionId: conv.sessionId };
  const r = await send(body);
  const d = r.data || {};
  if (r.status === 200 && !d.error) {
    if (typeof d.answer === 'string' && d.state && typeof d.state === 'object' && !Array.isArray(d.state)) conv.state = d.state;
    if (typeof d.convState === 'string' && d.convState) conv.convState = d.convState;
    if (d.topProductId) conv.prevTop = String(d.topProductId);
    if (d.topRecommendationRef) conv.prevTopRef = String(d.topRecommendationRef);
    const turn = { role: 'assistant', text: answerOf(d) };
    if (typeof d.turnSig === 'string' && d.turnSig) turn.sig = d.turnSig;
    conv.chatHistory.push(turn);
  }
  return r;
}

function projectTurn(t) {
  if (!t) return null;
  const d = t.data || {};
  const st = d.stats || {};
  return { status: t.status, version: t.version, gate: t.gate, elapsedMs: t.elapsedMs, error: t.error,
    answer: answerOf(d).slice(0, 600),
    cards: cardsOf(d).map(c => ({ id: c.id, title: c.title.slice(0, 160), price: c.price, mall: c.mall, url: c.url.slice(0, 200),
      observedAt: c.observedAt || null, freshness: c.freshness })),
    stats: { state: st.state, conversation: st.conversation, searched: st.searched, accepted: st.accepted,
      noResult: st.noResult, rejectedReasons: st.rejectedReasons, modelUsage: st.modelUsage, intent: st.intent } };
}

function dryRun() {
  const seeds = selected.filter(c => c.expect.seed).length;
  const requests = selected.length + seeds;
  const shopping = selected.filter(c => !['knowledge', 'smalltalk'].includes(c.category)).length + seeds;
  console.log('SEOSA AI 100문항 — 드라이런 (요청 0회)');
  console.log(`  대상: ${ENDPOINT}`);
  console.log(`  채점 문항 ${selected.length} + 후속 seed ${seeds} = 요청 ${requests}회 (같은 세션 순서 실행)`);
  console.log(`  예상 시간: 요청 간격 ${DELAY_MS || 7000}ms + 응답 5~20초 → 약 ${Math.round(requests * ((DELAY_MS || 7000) + 10000) / 60000)}분`);
  console.log(`  v3 가 답하면 OpenAI 호출 ≈ 쇼핑 질문당 2~3회(분류·계획·선택) → 최대 ≈ ${shopping * 3 + (requests - shopping)}회`);
  console.log(`  판매처 검색(쿠팡·ADPICK) 상한 ≈ 쇼핑 질문당 각 1회 → 각 ≤ ${shopping}회 (분당 ≈ ${Math.round(60000 / ((DELAY_MS || 7000) + 5000))}회 — ADPICK 공식 10회/분 이하)`);
  console.log('  Neon 전송: 요청마다 카탈로그·가격 이력 조회 발생(수십~수백 KB) — 무료 한도 소진 임박 시 실행 금지');
  console.log('  비용: 응답 stats.modelUsage 토큰으로 계산 — --price-in/--price-out($/1M 토큰)을 주면 달러로 환산');
  console.log('\n실행하려면: --offline --snapshot=<catalog.jsonl> (비용 0) 또는 --live (사용자 승인 뒤)');
}

async function run() {
  if (MODE === 'dry-run') return dryRun();
  if (MODE === 'offline' && !opt('snapshot')) throw new Error('--offline 에는 --snapshot=<catalog.jsonl> 이 필요합니다');
  const send = MODE === 'live' ? liveClient() : offlineClient(opt('snapshot'));
  const nowMs = () => (MODE === 'offline' ? send.nowMs : Date.now());
  console.log(`SEOSA AI 100문항 — ${MODE} | ${MODE === 'live' ? ENDPOINT : 'in-process v3 route + frozen catalog ' + send.meta.snapshot}`
    + ` | ${selected.length}문항${REQUIRE_V3 ? ' | require-v3' : ''}`);
  const rows = [];
  const t0 = Date.now();
  for (let i = 0; i < selected.length; i++) {
    const c = selected[i];
    const conv = newConversation();
    let seedTurn = null;
    if (c.expect.seed) {
      seedTurn = await ask(send, conv, c.expect.seed);
      if (DELAY_MS) await sleep(DELAY_MS);
    }
    const seedOk = !c.expect.seed || (seedTurn && seedTurn.status === 200 && !(seedTurn.data || {}).error);
    const turn = seedOk ? await ask(send, conv, c.question) : null;
    const g = gradeCase(c, turn, { seed: c.expect.seed ? seedTurn : undefined, requireV3: REQUIRE_V3, nowMs: nowMs(), review: REVIEW });
    const row = { id: c.id, n: c.n, category: c.category, categoryLabel: CATEGORY_LABELS[c.category], question: c.question,
      seedQuestion: c.expect.seed || null, expectCards: c.expect.cards || 'optional', ...g,
      turn: projectTurn(turn), seedTurn: projectTurn(seedTurn) };
    rows.push(row);
    const t = row.turn || {};
    console.log(`${c.id} ${row.verdict.padEnd(10)} ${String(t.status || '-').padEnd(3)} [${t.version || '-'}${t.gate ? '/' + t.gate : ''}] `
      + `${t.elapsedMs != null ? t.elapsedMs + 'ms' : '-'} cards=${row.cardCount} ${row.reasons.concat(row.soft).slice(0, 4).join(',')}  ${c.question}`);
    if (DELAY_MS && i !== selected.length - 1) await sleep(DELAY_MS);
  }
  const summary = summarize(rows, { prices: PRICES });
  const report = {
    meta: { harness: 'scripts/test-100-questions.js@2026-11-14', mode: MODE, label: LABEL, createdAt: new Date().toISOString(),
      gitSha: gitSha(), endpoint: MODE === 'live' ? ENDPOINT : null, offline: MODE === 'offline' ? send.meta : null,
      requireV3: REQUIRE_V3, delayMs: DELAY_MS, timeoutMs: TIMEOUT_MS, runMs: Date.now() - t0, prices: PRICES,
      caveats: [
        'HTTP 200 은 전송 성공이지 추천 정확도가 아니다 — verdict 를 본다.',
        MODE === 'offline' ? '오프라인: 실제 v3 서버 파이프라인 + 동결 카탈로그, GPT 는 결정적 대역(분류는 정규식·폴백만). GPT 계획 품질·실시간 재고·오늘 가격은 재지 않는다.' : '라이브: 실제 응답. x-ai-v3-gate 로 v3/legacy 를 가른다.',
        'UNVERIFIED 는 사람이 근거를 적어 --review-file 로 확정하기 전까지 통과가 아니다.'
      ] },
    summary, results: rows
  };
  const out = opt('out') || path.join(__dirname, '..', 'reports', 'ai-100',
    `${LABEL}-${MODE}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 1) + '\n', 'utf8');
  const s = summary;
  console.log(`\nPASS ${s.verdicts.PASS} · FAIL ${s.verdicts.FAIL} · UNVERIFIED ${s.verdicts.UNVERIFIED}  (HTTP 200 ${s.transport.http200}/${s.transport.requests}, 오류율 ${s.transport.errorRate}%)`);
  console.log(`추천률 ${s.accuracy.recommendationRate}% · 카드 정확도 ${s.accuracy.cardPrecision}% (${s.accuracy.cardsShown}장 중 위반 ${s.accuracy.cardsViolatingConstraints})`);
  console.log(`지연 avg ${s.latencyMs.scored.avg}ms · p50 ${s.latencyMs.scored.p50}ms · p95 ${s.latencyMs.scored.p95}ms · 버전 ${JSON.stringify(s.versions)} · 게이트 ${JSON.stringify(s.v3Gates)}`);
  console.log(`비용: 모델 호출 ${s.cost.modelCalls} · 토큰 in ${s.cost.inputTokens}/out ${s.cost.outputTokens} · USD ${s.cost.usd == null ? '미산정' : s.cost.usd}`);
  console.log(`FAIL 사유: ${JSON.stringify(s.failReasons)}`);
  console.log('결과: ' + path.relative(process.cwd(), out));
  return report;
}

if (require.main === module) run().catch(err => { console.error(err && err.stack || err); process.exitCode = 1; });
module.exports = { run, ask, newConversation, projectTurn };
