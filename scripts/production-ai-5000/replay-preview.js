#!/usr/bin/env node
'use strict';
/*
 * 대표 오류를 수정된 Vercel Preview 에서 다시 재현한다.
 *
 *   node scripts/production-ai-5000/replay-preview.js --deployment https://<...>.vercel.app \
 *     --ids-file <top20.json> --questions <questions.jsonl> --out <replay.jsonl> [--gap-ms 20000]
 *
 * 보호된 Preview 이므로 `vercel curl --deployment` 로 보낸다(배포 범위 우회 토큰은 CLI 가 붙인다).
 * 세션 오류는 앞 턴부터 순서대로 보내야 재현되므로, 해당 세션의 필요한 턴을 모두 보낸다.
 * 웹 클라이언트와 같은 요청·상태 규칙을 쓴다(run.js 와 동일: chatHistory 10개, convState, prevTopRef).
 *
 * 멈추는 조건: 5xx·네트워크 연속 2회, 429 1회, STOP 파일.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const DEPLOY = arg('--deployment', '');
const IDS_FILE = arg('--ids-file', '');
const Q_FILE = arg('--questions', '');
const OUT = arg('--out', '');
const GAP_MS = Number(arg('--gap-ms', 20000));
const MAIN = arg('--cwd', 'C:/Users/yugeo/seosa');
const VC = arg('--vc', 'C:/nvm4w/nodejs/node_modules/vercel/dist/vc.js');
if (!DEPLOY || !IDS_FILE || !Q_FILE || !OUT) throw new Error('--deployment --ids-file --questions --out 가 모두 필요하다');

const HISTORY_LIMIT = 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rd = p => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

function hostnameShim() {
  const p = path.join(os.tmpdir(), 'seosa-qa-ascii-host.js');
  if (!fs.existsSync(p)) fs.writeFileSync(p, "require('os').hostname = () => 'seosa-qa';\n");
  return p;
}

/* vercel curl 로 한 번 보낸다. 한글 본문은 파일로 넘긴다(Windows 에서 argv 인코딩이 깨진다). */
function callPreview(body) {
  const bodyFile = path.join(os.tmpdir(), 'seosa-preview-body.json');
  fs.writeFileSync(bodyFile, JSON.stringify(body), 'utf8');
  const env = Object.assign({}, process.env, { NODE_OPTIONS: `--require ${hostnameShim()}`, MSYS_NO_PATHCONV: '1' });
  // --cwd 는 쓰지 않는다 — vercel curl 이 그 플래그를 curl 로 그대로 넘겨 거부한다.
  // 프로젝트 연결(.vercel)은 메인 체크아웃에만 있으므로 그 폴더에서 실행한다(execFile cwd).
  const args = [VC, 'curl', '/api/ai', '--deployment', DEPLOY, '--yes', '--',
    '-s', '-X', 'POST', '-H', 'Content-Type: application/json',
    '-H', 'User-Agent: SEOSA-QA-Preview-Replay/1.0', '--data-binary', '@' + bodyFile,
    '-w', '\\n__HTTP__%{http_code} %{time_total}'];
  const t0 = Date.now();
  return new Promise(resolve => {
    // 셸을 거치지 않는다 — Windows 셸은 한글 argv 와 @파일 경로를 깨뜨린다. hostname 은 shim 이 ASCII 로 덮는다.
    execFile(process.execPath, ['--require', hostnameShim()].concat(args), { env, cwd: MAIN, maxBuffer: 64 * 1024 * 1024, timeout: 90000 }, (e, out, err) => {
      const text = String(out || '');
      const m = text.match(/__HTTP__(\d+)\s+([\d.]+)\s*$/);
      const status = m ? Number(m[1]) : 0;
      const payload = m ? text.slice(0, m.index) : text;
      let json = null;
      const brace = payload.indexOf('{');
      if (brace >= 0) { try { json = JSON.parse(payload.slice(brace)); } catch (_) { json = null; } }
      resolve({ status, ms: Date.now() - t0, json, raw: json ? '' : payload.slice(-400), stderr: json ? '' : String(err || '').slice(-300) });
    });
  });
}

/* 저장 — 서명값은 길이만 남긴다 (run.js 와 같은 규칙). */
function sanitize(j) {
  const o = Object.assign({}, j);
  for (const k of ['convState', 'turnSig', 'topRecommendationRef']) if (o[k]) { o[k + 'Len'] = String(o[k]).length; delete o[k]; }
  if (Array.isArray(o.items)) o.items = o.items.map(it => {
    const c = Object.assign({}, it);
    delete c.link; delete c.image;
    return c;
  });
  return o;
}

function advance(cs, q, j) {
  cs.chatHistory.push({ role: 'user', text: q });
  if (!j) return;
  if (j.topProductId) cs.prevTop = String(j.topProductId);
  if (j.topRecommendationRef) cs.prevTopRef = String(j.topRecommendationRef);
  else if (j.topProductId && j.items && j.items.length) cs.prevTopRef = '';
  if (j.convState) cs.convState = String(j.convState);
  const turn = { role: 'assistant', text: j.text || '' };
  if (j.turnSig) turn.sig = String(j.turnSig);
  cs.chatHistory.push(turn);
  if (cs.chatHistory.length > HISTORY_LIMIT) cs.chatHistory = cs.chatHistory.slice(-HISTORY_LIMIT);
}

(async () => {
  const ids = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
  const all = rd(Q_FILE);
  const byId = new Map(all.map(q => [q.id, q]));
  const target = new Set(ids);

  // 보낼 순서: 세션은 1턴부터 필요한 턴까지, 단일 질문은 그대로.
  const need = [];
  const maxTurn = {};
  for (const id of ids) {
    const q = byId.get(id);
    if (q.session) maxTurn[q.session] = Math.max(maxTurn[q.session] || 0, q.turn);
    else need.push(q);
  }
  for (const [sid, upto] of Object.entries(maxTurn)) {
    all.filter(q => q.session === sid && q.turn <= upto).sort((a, b) => a.turn - b.turn).forEach(q => need.push(q));
  }
  console.log(`[시작] 배포 ${DEPLOY} · 요청 ${need.length}건(대표 ${ids.length}건 재현) · 간격 ${GAP_MS}ms`);

  const stop = path.join(path.dirname(OUT), 'STOP');
  const sessions = new Map();
  let fails = 0, sent = 0;
  const out = fs.createWriteStream(OUT, { flags: 'a' });
  for (const q of need) {
    if (fs.existsSync(stop)) { console.log('[중단] STOP 파일'); break; }
    if (sent) await sleep(GAP_MS);
    let cs = q.session ? sessions.get(q.session) : null;
    if (!cs) { cs = { chatHistory: [], prevTop: '', prevTopRef: '', convState: '' }; if (q.session) sessions.set(q.session, cs); }
    const body = {
      question: q.text, contextProducts: [], chatHistory: cs.chatHistory.concat([{ role: 'user', text: q.text }]),
      profile: { nickname: '', cats: [], budget: '', gender: '' },
      view: { source: 'none', keyword: '', sort: 'default', mallFilter: 'all' },
      prevTop: cs.prevTop || '', prevTopRef: cs.prevTopRef || '', convState: cs.convState || ''
    };
    const res = await callPreview(body);
    sent++;
    advance(cs, q.text, res.json);
    const rec = {
      id: q.id, representative: target.has(q.id), stage: 'preview-replay', deployment: DEPLOY,
      category: q.category, session: q.session || null, turn: q.turn || null, step: q.step || null,
      at: new Date().toISOString(), status: res.status, ms: res.ms,
      error: res.json ? undefined : (res.raw || res.stderr || 'no json'),
      response: res.json ? sanitize(res.json) : null
    };
    out.write(JSON.stringify(rec) + '\n');
    const cards = (res.json && res.json.items || []).length;
    console.log(`${target.has(q.id) ? '★' : ' '} ${q.id}${q.session ? ' ' + q.session + '#' + q.turn : ''} s=${res.status} ${res.ms}ms cards=${cards} ${q.text.slice(0, 30)}`);
    if (res.status === 0 || res.status >= 500) fails++; else fails = 0;
    if (res.status === 429) { console.log('[중단] 429'); break; }
    if (fails >= 2) { console.log('[중단] 5xx·네트워크 연속 2회'); break; }
  }
  out.end();
  console.log(`[끝] 보낸 요청 ${sent}건 → ${OUT}`);
})().catch(e => { console.error(String(e.stack || e).slice(0, 500)); process.exit(1); });
