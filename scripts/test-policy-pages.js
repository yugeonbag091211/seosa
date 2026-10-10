#!/usr/bin/env node
/*
 * /privacy · /terms · /support 정책·고객지원 페이지 테스트 — 파일·라우팅·«코드와 맞는가».
 *
 *   node scripts/test-policy-pages.js
 *
 * 정책 문서는 코드가 바뀌면 조용히 거짓이 된다. 그래서 문구 하나하나가 아니라
 * «코드에 있는 사실이 문서에 빠지지 않았는가 / 문서가 코드에 없는 것을 약속하지
 * 않았는가» 를 코드에서 직접 읽어 대조한다.
 *   · AI 모델 제공사 (api/ 전체에서 찾은 호스트 — _llm.js · _llm-free.js · _openai-provider.js 로
 *     나뉘어도 빠지지 않게) · 메일 발송 (api/_channel/email.js)
 *   · Google Analytics (index.html 의 gtag) · 결제 (api/_toss.js)
 *   · 계정 삭제 대상 표 (api/_account.js USER_TABLES) 와 보관 표(payments)
 *   · 토큰 30일 · 인증 코드 10분 (api/_auth.js)
 *   · 통계가 IP·이메일을 저장하지 않는다는 문장 (api/_funnel.js 의 저장 행)
 */
'use strict';
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-only-secret';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'test';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}
const text = html => html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

console.log('\n정책·고객지원 페이지 (/privacy · /terms · /support)\n');

const privacyHtml = read('public/privacy.html');
const termsHtml = read('public/terms.html');
const supportHtml = read('public/support.html');
const privacy = text(privacyHtml);
const terms = text(termsHtml);
const support = text(supportHtml);

// ── 1. 라우팅 ───────────────────────────────────────────────────────
const vercel = JSON.parse(read('vercel.json'));
const catchAll = vercel.rewrites.findIndex(r => r.source.startsWith('/((?!api/)'));
for (const [src, dest, file] of [['/privacy', '/public/privacy.html', 'public/privacy.html'], ['/terms', '/public/terms.html', 'public/terms.html'], ['/support', '/public/support.html', 'public/support.html']]) {
  const i = vercel.rewrites.findIndex(r => r.source === src);
  check(i >= 0 && vercel.rewrites[i].destination === dest, `vercel.json: ${src} → ${dest}`);
  check(i >= 0 && i < catchAll, `${src} rewrite 가 catch-all 앞에 있다`);
  check(fs.existsSync(path.join(ROOT, file)), `${file} 존재`);
}
const dev = read('scripts/dev-server.js');
check(/'\/privacy':\s*\{\s*path:\s*'\/privacy\.html'/.test(dev) && /'\/terms':\s*\{\s*path:\s*'\/terms\.html'/.test(dev) && /'\/support':\s*\{\s*path:\s*'\/support\.html'/.test(dev), '로컬 dev-server 도 같은 rewrite');
check(/'\/api\/account\/delete':\s*\{\s*path:\s*'\/api\/auth'/.test(dev), '로컬 dev-server: /api/account/delete');

// ── 2. 페이지 자체 ─────────────────────────────────────────────────
for (const [name, html] of [['privacy', privacyHtml], ['terms', termsHtml], ['support', supportHtml]]) {
  check(!/<script/i.test(html), `${name}: 스크립트 없음 (분석 태그·외부 JS 없이 읽힌다)`);
  const external = [...html.matchAll(/<(?:link|img|iframe|source)[^>]+(?:href|src)="(https?:\/\/[^"]+)"/gi)].map(m => m[1])
    .filter(u => !/^https:\/\/seosa\.ai\.kr\//.test(u));
  check(external.length === 0, `${name}: 외부 리소스를 불러오지 않는다`, external.join(', '));
  check(/<meta name="viewport"/.test(html) && /lang="ko"/.test(html), `${name}: 모바일 viewport · lang=ko`);
  check(/285-34-01658/.test(html), `${name}: 사업자 정보가 index.html 과 같다`);
}
check(read('public/index.html').includes('285-34-01658'), 'index.html 사업자등록번호와 대조 가능');
check(privacyHtml.includes('href="/terms"') && termsHtml.includes('href="/privacy"'), '개인정보처리방침·이용약관이 서로 연결된다');
check(privacyHtml.includes('href="/support"') && termsHtml.includes('href="/support"') && supportHtml.includes('href="/privacy"') && supportHtml.includes('href="/terms"'), '정책 문서와 고객지원 페이지가 서로 연결된다');
check(/support@seosa\.ai\.kr/.test(privacy) && /support@seosa\.ai\.kr/.test(terms) && /support@seosa\.ai\.kr/.test(support), '공식 고객지원 이메일이 세 페이지에 동일하다');
check(/고객지원 문의/.test(privacy) && /이메일 주소/.test(privacy) && /문의 내용/.test(privacy), '고객지원 문의의 개인정보 처리가 방침에 기재됨');

// 고객지원 페이지는 스토어의 Support URL 로 쓴다 — 혼자서 문의·삭제 안내가 끝나야 한다.
check(/href="mailto:support@seosa\.ai\.kr/.test(supportHtml), 'support: 이메일을 누르면 메일 앱이 열린다 (mailto)');
check(/<link rel="canonical" href="https:\/\/seosa\.ai\.kr\/support">/.test(supportHtml), 'support: canonical https://seosa.ai.kr/support');
check(/prefers-color-scheme:\s*dark/.test(supportHtml), 'support: 다크 모드');
check(/계정 삭제/.test(support) && supportHtml.includes('href="/privacy#delete-account"') && /id="delete-account"/.test(privacyHtml), 'support: 계정 삭제 안내 → 방침의 #delete-account 로 연결된다');
check(/href="\/"/.test(supportHtml) && /홈으로/.test(support), 'support: 홈으로 돌아가기');
check(/판매자가 아닙니다/.test(support), 'support: 거래(배송·환불) 문의는 판매처로 — SEOSA 가 판매자가 아님을 밝힌다');

// 사용자에게 보이는 연락처는 공식 주소 하나다. 개인 메일함 주소를 다시 싣지 않는다.
for (const [name, html] of [['privacy', privacyHtml], ['terms', termsHtml], ['support', supportHtml]]) {
  const personal = (html.match(/[A-Za-z0-9._%+-]+@(?:gmail|naver|daum|hanmail|kakao)\.[a-z.]+/gi) || []);
  check(personal.length === 0, `${name}: 개인 메일 주소를 노출하지 않는다`, personal.join(', '));
}
// Instagram 공식 계정은 2026-10 에 seosakorea → seosashop 으로 바뀌었다 (main 6b8dc3e). 세 문서가 같은 계정을 가리킨다.
const igHandles = [privacyHtml, termsHtml, supportHtml].map(h => (h.match(/instagram\.com\/([A-Za-z0-9._]+)/) || [])[1] || '');
check(igHandles.every(h => h === 'seosashop'), '정책·고객지원 문서의 Instagram 이 공식 계정(@seosashop)으로 같다', igHandles.join(' / '));

// ── 3. 코드에 있는 처리 → 문서에 있다 ─────────────────────────────────
// AI 호출은 여러 파일로 나뉘어 있다(main: _llm.js 라우터 + _llm-free.js + _openai-provider.js).
// 한 파일만 읽으면 호스트가 옮겨간 순간 검사가 조용히 건너뛰어진다 — api/ 전체에서 찾는다.
function apiSources(dir = path.join(ROOT, 'api'), out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) apiSources(p, out);
    else if (name.endsWith('.js')) out.push(fs.readFileSync(p, 'utf8'));
  }
  return out;
}
const apiCode = apiSources().join('\n');
const providers = [
  ['api.openai.com', /OpenAI/], ['openrouter.ai', /OpenRouter/], ['generativelanguage.googleapis.com', /Gemini/],
  ['api.groq.com', /Groq/], ['api.anthropic.com', /Anthropic/]
];
const providersInCode = providers.filter(([host]) => apiCode.includes(host));
check(providersInCode.length > 0, 'AI 제공사 호스트를 코드에서 찾았다 (못 찾으면 이 검사가 낡은 것)', providersInCode.map(p => p[0]).join(', '));
for (const [host, re] of providersInCode) {
  check(re.test(privacy), `AI 제공사 ${host} → 개인정보처리방침에 기재`);
}
// 반대 방향(문서에만 있는 제공사)은 이 브랜치가 운영(main)보다 오래됐을 때 생길 수 있어 경고로만 알린다.
const docOnly = providers.filter(([host, re]) => re.test(privacy) && !apiCode.includes(host)).map(p => p[0]);
if (docOnly.length) console.log(`  WARN  문서에는 있지만 이 트리의 코드에 없는 AI 제공사: ${docOnly.join(', ')} — 운영(main) 코드와 대조할 것`);
if (/support@seosa\.ai\.kr/.test(privacy)) check(/ImprovMX/.test(privacy), '고객지원 메일의 전달 경로(ImprovMX)가 처리 위탁에 기재');
if (read('api/_channel/email.js').includes('api.resend.com')) check(/Resend/.test(privacy), '메일 발송 Resend 기재');
if (/googletagmanager\.com\/gtag/.test(read('public/index.html'))) check(/Google Analytics/.test(privacy) && /쿠키/.test(privacy), '웹의 Google Analytics(쿠키) 기재');
if (fs.existsSync(path.join(ROOT, 'api/_toss.js'))) check(/토스페이먼츠/.test(privacy), '결제대행 토스페이먼츠 기재');
check(/Supabase/.test(privacy) && /Vercel/.test(privacy), '호스팅 Vercel · DB Supabase 기재');
check(/GDELT/.test(privacy) && /쿠팡 파트너스/.test(privacy) && /ADPICK/.test(privacy), '개인정보 없이 부르는 외부 연동(쿠팡·ADPICK·GDELT) 기재');

// ── 4. 보관 기간 = 코드의 상수 ───────────────────────────────────────
const { TOKEN_TTL_MS, CODE_TTL_MS } = require('../api/_auth');
check(TOKEN_TTL_MS === 30 * 864e5 && /최대 30일/.test(privacy), '토큰 30일 (api/_auth.js TOKEN_TTL_MS)', String(TOKEN_TTL_MS));
check(CODE_TTL_MS === 10 * 60e3 && /최대 10분/.test(privacy), '인증 코드 10분 (api/_auth.js CODE_TTL_MS)', String(CODE_TTL_MS));
check(/30분/.test(privacy) && /CHAT_TTL_MS:\s*30 \* 60 \* 1000/.test(read('public/index.html')), '웹 AI 대화 30분 보관 (index.html CHAT_TTL_MS)');

// ── 5. 계정 삭제 = api/_account.js ───────────────────────────────────
const account = require('../api/_account');
const LABEL = { alerts: '가격 알림', profiles: '취향 프로필', user_data: '찜·기록 동기화', ai_usage: 'AI 사용 기록', subscriptions: '구독 정보', auth_codes: '인증 코드' };
const section6 = (privacy.match(/마이 → 계정 삭제[\s\S]{0,400}/) || [''])[0];
for (const t of account.USER_TABLES) {
  check(!!LABEL[t] && section6.includes(LABEL[t]), `삭제 대상 ${t} → 문서의 «${LABEL[t] || '?'}»`);
}
check(JSON.stringify(account.RETAINED_TABLES) === '["payments"]' && /결제 기록/.test(section6) && /5년/.test(privacy), '보관 대상 payments → «결제 기록 5년»');
check(/자동결제/.test(section6), 'PRO 자동결제 중 409 규칙이 문서에 있다');
check(/마이 → 계정 삭제/.test(terms), '이용약관에 탈퇴 방법');

// ── 6. «저장하지 않는다» 문장이 코드와 맞는가 ─────────────────────────
const funnel = read('api/_funnel.js');
const rowBlock = (funnel.match(/const row = \{[\s\S]*?\};/) || [''])[0];
check(rowBlock && !/\b(ip|user_?agent|email)\s*:/i.test(rowBlock), '통계 행(funnel_events)에 IP·UA·이메일 필드가 없다');
check(!/require\('\.\/_supabase'\)/.test(read('api/_ratelimit.js')), '요청 제한(IP)은 DB 에 쓰지 않는다 (_ratelimit 가 supabase 를 쓰지 않음)');
const aiSrc = read('api/ai.js');
check(!/\.from\('[a-z_]+'\)\.(insert|upsert)\([^)]*question/i.test(aiSrc), 'AI 질문을 DB 에 insert 하는 코드가 없다');
check(/SEOSA 데이터베이스에 저장하지 않습니다/.test(privacy), '문서: AI 질문 미저장');

// ── 7. 약관이 코드와 어긋난 옛 문장을 되살리지 않는다 ─────────────────
check(!/모든 상품 정보는 쿠팡 검색 API에서 실시간으로/.test(terms), '옛 문장(쿠팡 실시간 단일 출처) 없음');
check(/로그인 없이[\s\S]{0,80}AI/.test(terms), '비로그인 AI 이용(게스트 모드) 반영');

// ── 8. 코드로 확정할 수 없어 운영자가 채워야 하는 항목 (실패가 아니라 목록) ─────
const todos = [privacyHtml, termsHtml, supportHtml].flatMap(h => [...h.matchAll(/<!--\s*TODO\(운영자[^)]*\):\s*([\s\S]*?)-->/g)].map(m => m[1].trim()));
console.log(`\n운영자 확인 필요 ${todos.length}건 (문서 소스의 TODO 주석):`);
todos.forEach(t => console.log(`  - ${t}`));

console.log(`\n결과: ${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
