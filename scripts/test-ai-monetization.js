'use strict';
/* AI 무제한 정책과 abuse 방어 회귀 테스트 — 외부 호출 0회. */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

console.log('=== AI 무제한 정책 / abuse protection ===\n');
const ai = fs.readFileSync(path.join(ROOT, 'api', 'ai.js'), 'utf8');
const plan = fs.readFileSync(path.join(ROOT, 'api', '_plan.js'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

check(!/ai_quota_reserve|plan\.reserve\(|AI_DAILY_LIMIT_REACHED/.test(ai),
  '★ /api/ai에 product quota 차단 경로가 없다');
check(!/\breserve\s*\(|\brelease\s*\(|usagePayload\s*\(|FREE_DAILY_AI_LIMIT|PRO_DAILY_AI_LIMIT/.test(plan),
  '★ _plan은 질문 횟수를 계산하거나 차감하지 않는다');
check(!/남은 횟수|오늘의 AI 사용량|AI_DAILY_LIMIT_REACHED|하루 3회 무료/.test(ui),
  '★ UI에 질문 잔여량·업그레이드 유도 문구가 없다');
check(/name: 'ai-ip-flood', limit: 300/.test(ai) && /name: 'ai', limit: 30[\s\S]{0,100}key: aiRateKey/.test(ai),
  '★ gross IP flood + 로그인 사용자별 rate limit을 함께 둔다', 'IP 300회/분 + 사용자 30회/분');
check(/identify\(req\)/.test(ai) && /status\(401\)/.test(ai),
  '깨진 인증 토큰은 계속 거절한다');

const rl = require('../api/_ratelimit');
const req = { headers: { 'x-forwarded-for': '203.0.113.77' }, socket: {} };
let allowed = 0;
for (let i = 0; i < 31; i++) if (rl.check(req, { name: 'ai-unlimited-test', limit: 30, windowMs: 60000 }).ok) allowed++;
check(allowed === 30, '게스트/IP 정상 연속 30회는 허용하고 31회째 폭주는 차단한다', String(allowed));

// 같은 NAT라도 로그인 사용자는 서로의 30회/분을 태우지 않아야 한다.
let userA = 0, userB = 0;
for (let i = 0; i < 30; i++) {
  if (rl.check(req, { name: 'ai-user-scope-test', limit: 30, windowMs: 60000, key: 'user:a@example.test' }).ok) userA++;
  if (rl.check(req, { name: 'ai-user-scope-test', limit: 30, windowMs: 60000, key: 'user:b@example.test' }).ok) userB++;
}
check(userA === 30 && userB === 30, '★ 같은 IP의 로그인 사용자 두 명은 rate quota를 공유하지 않는다',
  `A=${userA}, B=${userB}`);

const otherIp = { headers: { 'x-forwarded-for': '198.51.100.8' }, socket: {} };
const sameUser31 = rl.check(otherIp, {
  name: 'ai-user-scope-test', limit: 30, windowMs: 60000, key: 'user:a@example.test'
});
check(sameUser31.ok === false, '★ 로그인 rate limit은 IP를 바꿔도 같은 계정에 이어진다');

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
