#!/usr/bin/env node
'use strict';
/*
 * Production /api/ai 실검증 러너 (재개 가능, 동시성 1).
 *
 *   node scripts/production-ai-5000/run.js --until 50 [--gap-ms 20000] [--max-usd 18]
 *
 * 웹 클라이언트(public/index.html Chat.send · Api.call)와 같은 요청을 보낸다.
 *   · chatHistory: 이번 발화를 먼저 넣고 보내고, 응답 뒤 {role:'assistant',text,sig} 를 넣어 10개로 자른다.
 *   · prevTop / prevTopRef / convState: 응답값을 클라이언트와 같은 규칙으로 이어 간다.
 * 로그인은 하지 않는다(게스트 경로). IP·식별 헤더는 위조하지 않고 User-Agent 로 검증임을 밝힌다.
 *
 * 저장 (reports/production-ai-5000):
 *   responses.jsonl   응답 원문·카드. 서명값(convState·turnSig·ref)은 저장하지 않고 길이만 남긴다.
 *   server-logs.jsonl 이 검증 요청의 서버 로그에서 뽑은 지표. 다른 이용자 요청은 수만 센다.
 *   .state/           진행 중 세션의 서명값. git 에 넣지 않는다.
 *
 * 중단 조건: 5xx·네트워크 연속 3회, 429 10분 내 5회, 최근 p95 30초 초과, 비용 상한, STOP 파일.
 * 판매처를 직접 부르지 않는다. 상품 링크는 절대 열지 않는다(제휴 클릭·전환 오염 방지).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { harvest, neonSnapshot, readCost } = require('./harvest');

const DIR = path.resolve(__dirname, '../../reports/production-ai-5000');
const Q_PATH = path.join(DIR, 'questions.jsonl');
const R_PATH = path.join(DIR, 'responses.jsonl');
const RUN_LOG = path.join(DIR, 'run-log.jsonl');
const STATE_DIR = path.join(DIR, '.state');
const STOP = path.join(DIR, 'STOP');
const ORIGIN = process.env.SEOSA_ORIGIN || 'https://seosa.ai.kr';
const CLIENT_TIMEOUT_MS = 35000; // CONST.CHAT_TIMEOUT_MS
const HISTORY_LIMIT = 10;        // CONST.LIMIT.CHAT_HISTORY
const CHAT_TTL_MS = 30 * 60 * 1000;
const UA = 'SEOSA-QA-Production-5000/1.0';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const UNTIL = Number(arg('--until', 50));
const GAP_MS = Number(arg('--gap-ms', 20000));
const MAX_USD = Number(arg('--max-usd', 18));
const NO_UI = process.argv.includes('--no-ui');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const log = o => { const l = JSON.stringify(Object.assign({ at: new Date().toISOString() }, o)); fs.appendFileSync(RUN_LOG, l + '\n'); console.log(l.slice(0, 260)); };

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

/* 상품 링크에서 추적값은 빼고 식별값만 남긴다. 이미지 본문 URL 은 길고 판정에 안 쓴다. */
function cleanLink(u) {
  try {
    const x = new URL(u);
    const keep = ['itemId', 'vendorItemId', 'pageKey'];
    const q = keep.filter(k => x.searchParams.get(k)).map(k => `${k}=${x.searchParams.get(k)}`).join('&');
    return `${x.origin}${x.pathname}${q ? '?' + q : ''}`;
  } catch (_) { return ''; }
}
function sanitize(j) {
  const o = Object.assign({}, j);
  for (const k of ['convState', 'turnSig', 'topRecommendationRef']) if (o[k]) { o[k + 'Len'] = String(o[k]).length; delete o[k]; }
  if (Array.isArray(o.items)) o.items = o.items.map(it => {
    const c = Object.assign({}, it);
    if (c.link) c.link = cleanLink(c.link);
    if (c.image) c.image = (() => { try { return new URL(c.image).host; } catch (_) { return ''; } })();
    return c;
  });
  return o;
}

async function callApi(cs, q) {
  const history = cs.chatHistory.concat([{ role: 'user', text: q }]);
  const body = {
    question: q, contextProducts: [], chatHistory: history,
    profile: { nickname: '', cats: [], budget: '', gender: '' },
    view: { source: 'none', keyword: '', sort: 'default', mallFilter: 'all' },
    prevTop: cs.prevTop || '', prevTopRef: cs.prevTopRef || '', convState: cs.convState || ''
  };
  const ac = new AbortController();
  const t0 = Date.now();
  const timer = setTimeout(() => ac.abort(), CLIENT_TIMEOUT_MS);
  try {
    const r = await fetch(`${ORIGIN}/api/ai`, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Referer: ORIGIN + '/', 'User-Agent': UA },
      body: JSON.stringify(body)
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) { /* HTML 오류 페이지 */ }
    return { status: r.status, ms: Date.now() - t0, vercelId: r.headers.get('x-vercel-id') || '', retryAfter: r.headers.get('retry-after') || '', json, rawHead: json ? '' : text.slice(0, 300) };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, vercelId: '', error: e.name === 'AbortError' ? 'client_timeout' : String(e.message).slice(0, 200), json: null };
  } finally { clearTimeout(timer); }
}

/* 응답 뒤 클라이언트 상태 갱신 (index.html 10000~10030 과 같은 규칙) */
function advance(cs, q, j) {
  cs.chatHistory.push({ role: 'user', text: q });
  if (!j) { cs.at = Date.now(); return; }
  if (j.topProductId) cs.prevTop = String(j.topProductId);
  if (j.topRecommendationRef) cs.prevTopRef = String(j.topRecommendationRef);
  else if (j.topProductId && j.items && j.items.length) cs.prevTopRef = '';
  if (j.convState) cs.convState = String(j.convState);
  const turn = { role: 'assistant', text: j.text || '' };
  if (j.turnSig) turn.sig = String(j.turnSig);
  cs.chatHistory.push(turn);
  if (cs.chatHistory.length > HISTORY_LIMIT) cs.chatHistory = cs.chatHistory.slice(-HISTORY_LIMIT);
  cs.at = Date.now();
}

const statePath = sid => path.join(STATE_DIR, sid + '.json');
const fresh = () => ({ chatHistory: [], prevTop: '', prevTopRef: '', convState: '', at: Date.now(), run: 1 });

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const all = readJsonl(Q_PATH);
  if (all.length !== 5000) throw new Error('questions.jsonl 이 5,000개가 아니다');
  const targets = all.slice(0, UNTIL);
  const prior = readJsonl(R_PATH);
  const done = new Set();
  const sessionRun = {};
  for (const r of prior) if (r.session) sessionRun[r.session] = Math.max(sessionRun[r.session] || 1, r.sessionRun || 1);
  for (const r of prior) {
    if (r.final !== true) continue;
    if (r.session && (r.sessionRun || 1) !== sessionRun[r.session]) continue;
    done.add(r.id);
  }
  const pending = targets.filter(q => !done.has(q.id));
  log({ event: 'start', until: UNTIL, done: done.size, pending: pending.length, gapMs: GAP_MS, maxUsd: MAX_USD });

  let ui = null;
  const needsUi = !NO_UI && pending.some(q => q.channel === 'ui');
  if (needsUi) ui = await require('./ui').launch();

  const rolling = [];
  let net5xx = 0;
  const r429 = [];
  let lastStart = 0, lastHarvest = 0, lastNeon = 0, stopReason = '';
  const sessions = new Map();
  let uiSession = null;

  const doHarvest = async () => { try { await harvest(DIR); } catch (e) { log({ event: 'harvest_error', error: String(e.message).slice(0, 200) }); } };
  await doHarvest();
  const neon0 = await neonSnapshot(DIR).catch(() => null);
  if (neon0) log({ event: 'neon', ...neon0 });

  for (let idx = 0; idx < pending.length; idx++) {
    const q = pending[idx];
    if (fs.existsSync(STOP)) { stopReason = 'STOP 파일'; break; }

    // 예산·외부 상태
    if (Date.now() - lastHarvest > 180000) { lastHarvest = Date.now(); await doHarvest(); }
    if (Date.now() - lastNeon > 1800000) {
      lastNeon = Date.now();
      const n = await neonSnapshot(DIR).catch(() => null);
      if (n) {
        log({ event: 'neon', ...n });
        if (n.computeHours > 90 || n.transferGB > 4.5) { stopReason = `Neon 사용량 경계 ${JSON.stringify(n)}`; break; }
      }
    }
    const cost = readCost(DIR);
    if (cost.usd >= MAX_USD) { stopReason = `비용 상한 ${cost.usd.toFixed(3)} ≥ ${MAX_USD}`; break; }

    const wait = lastStart + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();

    // 세션 상태
    let cs;
    let run = 1;
    if (q.session) {
      if (sessions.has(q.session)) cs = sessions.get(q.session);
      else if (fs.existsSync(statePath(q.session))) { try { cs = JSON.parse(fs.readFileSync(statePath(q.session), 'utf8')); } catch (_) { cs = null; } }
      const resumed = cs && q.turn > 1 && Date.now() - cs.at < CHAT_TTL_MS * 0.8;
      if (q.turn > 1 && !resumed) {
        // 실제 클라이언트도 30분이면 대화가 지워진다. 이어 붙이면 기억 실패로 오판하므로 세션을 처음부터 다시 한다.
        run = (sessionRun[q.session] || 1) + 1;
        sessionRun[q.session] = run;
        log({ event: 'session_restart', session: q.session, run });
        const first = all.filter(x => x.session === q.session);
        pending.splice(idx, 0, ...first.filter(x => x.turn < q.turn));
        cs = null; idx--; sessions.delete(q.session);
        if (fs.existsSync(statePath(q.session))) fs.unlinkSync(statePath(q.session));
        uiSession = null;
        lastStart = 0;
        continue;
      }
      if (!cs || q.turn === 1) cs = Object.assign(fresh(), { run: sessionRun[q.session] || 1 });
      sessions.set(q.session, cs);
      run = cs.run;
    } else cs = fresh();

    // 호출 (INFRA 는 한 번만 재시도한다 — 같은 발화라 조건 오염 없음, 호출 수는 attempts 로 남긴다)
    let res, attempts = 0;
    const useUi = !!ui && q.channel === 'ui';
    do {
      attempts++;
      if (useUi) {
        if (q.session) {
          if (uiSession !== q.session) { await ui.reset(); uiSession = q.session; }
        } else { await ui.reset(); uiSession = null; }
        res = await ui.ask(q.text);
      } else res = await callApi(cs, q.text);
      const retryable = res.status === 0 || res.status === 429 || res.status >= 500;
      if (!retryable || attempts >= 2) break;
      if (res.status === 429) r429.push(Date.now());
      await sleep(res.status === 429 ? Math.min(90000, (Number(res.retryAfter) || 30) * 1000) : 15000);
    } while (attempts < 2);

    if (!useUi) advance(cs, q.text, res.json);
    else { cs.at = Date.now(); }
    if (q.session) { try { fs.writeFileSync(statePath(q.session), JSON.stringify(cs)); } catch (_) { /* 다음 저장에서 */ } }

    const rec = {
      id: q.id, final: true, stage: q.stage, category: q.category, channel: useUi ? 'ui' : 'api', session: q.session || null, turn: q.turn || null, sessionRun: q.session ? run : undefined,
      at: new Date(lastStart).toISOString(), status: res.status, ms: res.ms, attempts, requestId: (res.vercelId || '').split('::').pop(), error: res.error || undefined, rawHead: res.rawHead || undefined,
      domText: res.domText, domCards: res.domCards, promptSha: sha(q.text), response: res.json ? sanitize(res.json) : null
    };
    fs.appendFileSync(R_PATH, JSON.stringify(rec) + '\n');

    // 가드
    rolling.push(res.ms); if (rolling.length > 20) rolling.shift();
    const p95 = rolling.slice().sort((a, b) => a - b)[Math.floor(rolling.length * 0.95)] || 0;
    if (res.status === 0 || res.status >= 500) net5xx++; else net5xx = 0;
    if (res.status === 429) r429.push(Date.now());
    while (r429.length && Date.now() - r429[0] > 600000) r429.shift();
    console.log(`${q.id} ${q.category.padEnd(9)} ${rec.channel} s=${res.status} ${res.ms}ms cards=${(res.json && res.json.items && res.json.items.length) || 0} cost=$${cost.usd.toFixed(3)} p95=${p95} ${q.text.slice(0, 34)}`);
    if (net5xx >= 3) { stopReason = `5xx/네트워크 연속 ${net5xx}회`; break; }
    if (r429.length >= 5) { stopReason = `429 ${r429.length}회/10분`; break; }
    if (rolling.length >= 20 && p95 > 30000) { stopReason = `최근 20건 p95 ${p95}ms`; break; }
  }

  if (ui) await ui.close().catch(() => {});
  await sleep(45000); // 로그 적재 지연
  await doHarvest();
  const n = await neonSnapshot(DIR).catch(() => null);
  log({ event: 'end', until: UNTIL, stopReason: stopReason || 'done', cost: readCost(DIR), neon: n });
  console.log(stopReason ? `STOPPED: ${stopReason}` : `DONE up to ${UNTIL}`);
  process.exit(stopReason ? 2 : 0);
}
main().catch(e => { log({ event: 'crash', error: String(e.stack).slice(0, 500) }); process.exit(1); });
