#!/usr/bin/env node
/*
 * 오류 보고(api/_errors.js) 검증.
 *
 *   node scripts/test-sentry.js          DSN 이 있으면 실제로 한 건 보낸다
 *   node scripts/test-sentry.js --dry    보내지 않고 형식만 검사한다
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────
 *
 * "Sentry 를 붙였다" 와 "오류가 실제로 Sentry 에 도착한다" 는 다른 말이다.
 * DSN 오타·프로젝트 불일치·네트워크 차단은 조용히 실패한다. 그러면
 * 장애가 났을 때 아무 알림도 오지 않는데 붙였다고 믿게 된다.
 *
 * 이 스크립트는 의도적으로 예외를 만들어 실제 전송까지 확인한다.
 * 전송 성공하면 Sentry Issues 에 "SEOSA 전송 확인용 테스트 오류" 가 뜬다.
 */
'use strict';

require('./_env');
const errors = require('../api/_errors');

const dry = process.argv.includes('--dry');
let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : '  — ' + detail}`); }
}

(async () => {
  console.log('=== 오류 보고 검증 ===\n');

  /* 1. DSN 파싱 */
  const p = errors.parseDsn('https://abc123@o123.ingest.sentry.io/456');
  check(p && p.key === 'abc123' && p.host === 'o123.ingest.sentry.io' && p.projectId === '456',
    'DSN 을 key/host/projectId 로 나눈다', JSON.stringify(p));
  check(errors.parseDsn('') === null && errors.parseDsn('not-a-dsn') === null,
    '잘못된 DSN 은 null (비활성으로 떨어진다)');

  /* 2. 비밀값이 새지 않는다 */
  const extra = errors.safeExtra({
    ok: 'value', n: 1, b: true, nested: { secret: 'LEAK' }, fn: () => {}, arr: ['LEAK']
  });
  check(!JSON.stringify(extra).includes('LEAK'),
    '★ extra 는 문자열·숫자·불리언만 통과 (객체를 통째로 싣지 않는다)', JSON.stringify(extra));

  /* 3. 스택 경로에 절대경로가 남지 않는다 */
  const frames = errors.parseStack(new Error('x').stack);
  check(frames.length > 0, '스택 프레임을 파싱한다', String(frames.length));
  check(!frames.some(f => /^[A-Za-z]:\\|^\//.test(f.filename)),
    '★ 파일 경로는 마지막 2단계만 남긴다 (절대경로를 보내지 않는다)',
    JSON.stringify(frames[frames.length - 1] || {}));

  /* 4. DSN 이 없으면 조용히 no-op */
  const saved = process.env.SENTRY_DSN;
  delete process.env.SENTRY_DSN;
  const off = await errors.captureException(new Error('무시되어야 한다'));
  check(off.sent === false && off.reason === 'no-dsn',
    '★ DSN 이 없으면 아무것도 보내지 않고 조용히 끝난다', JSON.stringify(off));
  if (saved) process.env.SENTRY_DSN = saved;

  /* 5. 실제 전송 */
  console.log('');
  if (!errors.enabled()) {
    console.log('  SENTRY_DSN 이 없어 실제 전송은 건너뜁니다.');
    console.log('  설정 후 다시 실행하면 Sentry Issues 에 테스트 오류가 뜹니다:');
    console.log('    SENTRY_DSN=https://<key>@<host>/<project> node scripts/test-sentry.js');
  } else if (dry) {
    console.log('  --dry 이므로 실제 전송은 건너뜁니다.');
  } else {
    const err = new Error('SEOSA 전송 확인용 테스트 오류 (무시해도 됩니다)');
    const r = await errors.captureException(err, {
      where: 'test-sentry', route: 'scripts/test-sentry.js', extra: { intentional: true }
    });
    check(r.sent === true, '★★ 실제로 Sentry 에 도착했다', JSON.stringify(r));
    if (r.sent) console.log(`  → Sentry Issues 에서 event ${r.eventId} 를 확인하세요.`);
  }

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 오류:', e); process.exit(1); });
