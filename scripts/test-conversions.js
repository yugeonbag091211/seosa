#!/usr/bin/env node
'use strict';
/*
 * 전환(conversion) · GMV — 완전 오프라인.
 *
 * ★ 외부 호출 0회. ADPICK·쿠팡·운영 Supabase 를 한 번도 부르지 않는다.
 *
 * ★ 여기서 지키는 것은 회계다.
 *     1) 클릭은 절대 구매가 되지 않는다
 *     2) '정상' 은 확정이 아니다
 *     3) 취소는 매출에서 빠진다
 *     4) 일부 provider 만 연결됐으면 전체 GMV 를 숫자로 말하지 않는다
 *     5) API 키가 어떤 출력에도 남지 않는다
 */

const path = require('path');
const Module = require('module');

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;

/* ── 가짜 Supabase ─────────────────────────────────────────────── */
const db = { conversions: [], funnel_events: [] };
let missingColumns = [];

function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a == null && b == null) return 0;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

const fakeSupabase = {
  from(table) {
    const filters = [];
    let cols = '*', inserted = null, upserted = null, conflict = '';
    let limitN = null, missing = '';
    const q = {
      select(c) {
        cols = c || '*';
        String(cols).split(',').forEach(x => {
          const n = x.trim();
          if (missingColumns.indexOf(n) > -1 && !missing) missing = n;
        });
        return q;
      },
      insert(r) { inserted = r; return q; },
      upsert(r, o) { upserted = r; conflict = (o && o.onConflict) || ''; return q; },
      eq(c, v) { filters.push(r => String(r[c]) === String(v)); return q; },
      gte(c, v) { filters.push(r => cmp(r[c], v) >= 0); return q; },
      in(c, vs) { filters.push(r => vs.map(String).indexOf(String(r[c])) > -1); return q; },
      order() { return q; },
      limit(n) { limitN = n; return q; },
      then(resolve) {
        if (missing) {
          return resolve({ data: null, error: { message: `column conversions.${missing} does not exist` } });
        }
        if (inserted) { db[table].push(Object.assign({}, inserted)); return resolve({ data: null, error: null }); }
        if (upserted) {
          const keys = conflict.split(',').map(s => s.trim()).filter(Boolean);
          const rows = Array.isArray(upserted) ? upserted : [upserted];
          rows.forEach(row => {
            const i = db[table].findIndex(x => keys.every(k => String(x[k]) === String(row[k])));
            if (i > -1) db[table][i] = Object.assign({}, db[table][i], row);   // 갱신 — 행이 늘지 않는다
            else db[table].push(Object.assign({}, row));
          });
          return resolve({ data: null, error: null });
        }
        let rows = (db[table] || []).filter(r => filters.every(f => f(r)));
        if (limitN != null) rows = rows.slice(0, limitN);
        return resolve({ data: rows.map(r => Object.assign({}, r)), error: null });
      }
    };
    return q;
  },
  rpc() { return Promise.resolve({ data: null, error: null }); }
};

const supabasePath = path.resolve(__dirname, '..', 'api', '_supabase.js');
const realLoad = Module._load;
Module._load = function(request) {
  if (request === './_supabase' || request === '../api/_supabase' || request === supabasePath) return fakeSupabase;
  return realLoad.apply(this, arguments);
};

/* ★ 이 파일은 네트워크를 한 번도 타지 않는다 (test-release SAFE 검사 관례). */
global.fetch = async url => { throw new Error(`오프라인 테스트에서 외부 호출: ${url}`); };

const C = require('../api/_conversion');
const AC = require('../api/_adpickconv');
const funnel = require('../api/_funnel');

/* ── 도구 ───────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  — ${detail}` : ''}`); }
}
function eq(a, b, name) { ok(a === b, name, a === b ? String(a) : `기대 ${b} / 실제 ${a}`); }
function section(t) { console.log(`\n[${t}]`); }

/** ADPICK 공식 계약 모양의 행 하나. */
const row = (over) => Object.assign({
  idx: '1001', cp_code: 'CP1', cp_name: '11번가', o_cd: 'ORDER-1', trlog_id: 'TRL-1',
  p_cd: 'PROD-1', p_nm: '상품명', regdate: '2026-09-05 12:00:00', confirm_date: '',
  qty: 1, sales: 50000, commission: 2500, commission_rate: '5',
  status: '정상', trans_comment: '', p_data: 'hotdeal-ab12cd34',
  link_id: 'LNK1', api_date: '2026-09-05'
}, over || {});

const ENV_KEYS = ['ADPICK_API_KEY', 'COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY',
  'ADPICK_CONVERSION_WHITELISTED', 'ADPICK_CONVERSION_ID_FIELD', 'ANALYTICS_DISABLED'];
const saved = {};
ENV_KEYS.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });

(async () => {
  console.log('=== SEOSA 전환 · GMV (외부 호출 0회) ===');

  /* ───────────────────────────────────────────────────────────── */
  section('1) ADPICK status → 내부 표준');
  eq(C.canonicalStatus('adpick', '정상'), 'ORDERED', "'정상' 은 ORDERED (★ 확정 아님)");
  eq(C.canonicalStatus('adpick', '확인중'), 'PENDING', "'확인중' 은 PENDING");
  eq(C.canonicalStatus('adpick', '확정'), 'CONFIRMED', "'확정' 만 CONFIRMED");
  eq(C.canonicalStatus('adpick', '취소'), 'CANCELLED', "'취소' 는 CANCELLED");
  eq(C.canonicalStatus('adpick', '처음보는값'), 'UNKNOWN', '모르는 값은 UNKNOWN');
  eq(C.canonicalStatus('adpick', ''), 'UNKNOWN', '빈 값은 UNKNOWN');
  eq(C.canonicalStatus('coupang', '확정'), 'UNKNOWN', '★ 쿠팡은 의미 미확인이라 매핑하지 않는다');
  eq(C.countsAsRevenue('CONFIRMED'), true, 'CONFIRMED 만 매출');
  ['ORDERED', 'PENDING', 'CANCELLED', 'UNKNOWN'].forEach(s =>
    eq(C.countsAsRevenue(s), false, `${s} 은 매출이 아니다`));

  section('2) 정규화 — 공식 계약 필드만');
  {
    const r = C.fromAdpick(row({ status: '확정', confirm_date: '2026-09-07 09:00:00' }));
    eq(r.ok, true, '정상 행');
    eq(r.row.status, 'CONFIRMED', '상태');
    eq(r.row.partner_status, '확정', '★ 파트너 원문 보존');
    eq(r.row.gmv, 50000, 'sales → gmv');
    eq(r.row.commission, 2500, 'commission');
    eq(r.row.external_id, 'TRL-1', '기본 식별자 trlog_id');
    eq(r.row.source, 'adpick-report', '기존 스키마 호환 source');
    eq(r.row.order_date, '2026-09-05', 'regdate → order_date');
    ok(!!r.row.confirmed_at, 'confirm_date → confirmed_at');
    eq(r.row.cancelled_at, null, '확정이면 cancelled_at 없음');
    ok(!('p_nm' in r.row.raw_json), '★ 상품명(p_nm)을 raw_json 에 담지 않는다');
    ok(!('trans_comment' in r.row.raw_json), '★ 판매자 자유문자열을 담지 않는다');
    // 확정 아닌 건은 confirmed_at 을 만들지 않는다
    eq(C.fromAdpick(row({ status: '정상', confirm_date: '2026-09-07' })).row.confirmed_at, null,
      "★ '정상' 에는 confirmed_at 을 붙이지 않는다");
    // 취소
    const c = C.fromAdpick(row({ status: '취소', confirm_date: '2026-09-06' }));
    eq(c.row.status, 'CANCELLED', '취소 상태');
    ok(!!c.row.cancelled_at, 'cancelled_at 기록');
  }

  section('3) malformed 입력');
  eq(C.fromAdpick(null).ok, false, 'null');
  eq(C.fromAdpick('문자열').ok, false, '문자열');
  eq(C.fromAdpick({}).ok, false, '빈 객체');
  eq(C.fromAdpick(row({ trlog_id: '' })).reason, 'no-trlog_id', '식별자 없으면 skip (합성하지 않는다)');
  eq(C.fromAdpick(row({ regdate: '' })).reason, 'no-regdate', '주문일 없으면 skip');
  eq(C.fromAdpick(row({ sales: 'abc' })).row.gmv, 0, '숫자 아닌 금액은 0');
  eq(C.fromAdpick(row({ qty: 0 })).row.quantity, 1, '수량 0 은 1 로');
  {
    // 식별자 필드는 «단일 필드» 이고 환경변수로만 바꾼다 — 합성 금지
    process.env.ADPICK_CONVERSION_ID_FIELD = 'idx';
    eq(C.fromAdpick(row()).row.external_id, '1001', '환경변수로 idx 선택 가능');
    process.env.ADPICK_CONVERSION_ID_FIELD = '이상한필드';
    eq(C.adpickIdField(), 'trlog_id', '모르는 값이면 기본값으로');
    delete process.env.ADPICK_CONVERSION_ID_FIELD;
  }

  section('4) attribution — 개인정보 금지');
  eq(C.attributionToken('hotdeal', 'ab12cd34'), 'hotdeal-ab12cd34', '캠페인 + 난수');
  eq(C.attributionToken('hotdeal'), 'hotdeal', '난수 없으면 캠페인만');
  eq(C.attributionToken('없는캠페인', 'x'), '', '화이트리스트 밖은 빈 값');
  eq(C.attributionToken('hotdeal', 'user@example.com'), 'hotdeal', '★ 이메일은 붙이지 않는다');
  eq(C.safeSubId('a@b.com'), '', '★ 이메일 모양은 저장하지 않는다');
  eq(C.safeSubId('01012345678'), '', '★ 전화번호 모양은 저장하지 않는다');
  eq(C.safeSubId('x'.repeat(60)), '', `${C.SUBID_MAX}자 초과는 버린다`);
  eq(C.safeSubId('hotdeal-ab12'), 'hotdeal-ab12', '정상 토큰은 통과');
  eq(C.fromAdpick(row({ p_data: 'user@example.com' })).row.sub_id, '',
    '★ 파트너가 개인값을 돌려줘도 저장하지 않는다');

  section('5) GMV 회계 — ordered / confirmed / cancelled');
  {
    const s = C.summarize([
      { status: 'CONFIRMED', gmv: 100000, commission: 5000 },
      { status: 'CONFIRMED', gmv: 50000, commission: 2500 },
      { status: 'ORDERED', gmv: 900000, commission: 40000 },
      { status: 'PENDING', gmv: 700000, commission: 30000 },
      { status: 'CANCELLED', gmv: 300000, commission: 15000 },
      { status: 'UNKNOWN', gmv: 999999, commission: 99999 }
    ]);
    eq(s.confirmedGmv, 150000, '★ 확정만 합산');
    eq(s.commissionRevenue, 7500, '★ 확정 건의 수수료만');
    eq(s.cancelledGmv, 300000, '취소는 따로');
    eq(s.orderedGmv, 1600000, '주문/검수중은 따로 (매출 아님)');
    eq(s.byStatus.UNKNOWN, 1, 'UNKNOWN 도 세지만 어느 금액에도 안 들어간다');
    ok(s.confirmedGmv !== s.confirmedGmv + s.cancelledGmv, '★ 취소가 확정에 섞이지 않는다');
    eq(C.summarize([]).confirmedGmv, 0, '빈 입력');
    eq(C.summarize(null).total, 0, 'null 입력');
  }

  section('6) importer 멱등성 · 상태 갱신 · 취소');
  {
    db.conversions.length = 0;
    const { upsert } = require('./import-conversions.js');
    const mk = st => C.fromAdpick(row({ status: st, confirm_date: st === '정상' ? '' : '2026-09-07' })).row;

    await upsert([mk('정상')]);
    eq(db.conversions.length, 1, '첫 적재 1행');
    eq(db.conversions[0].status, 'ORDERED', '상태 ORDERED');

    await upsert([mk('정상')]);
    eq(db.conversions.length, 1, '★ 같은 전환 재적재해도 행이 늘지 않는다');

    await upsert([mk('확인중')]);
    eq(db.conversions.length, 1, '행 수 유지');
    eq(db.conversions[0].status, 'PENDING', '상태가 갱신된다');

    await upsert([mk('확정')]);
    eq(db.conversions[0].status, 'CONFIRMED', '확정으로 갱신');
    ok(!!db.conversions[0].confirmed_at, 'confirmed_at 채워짐');

    await upsert([mk('취소')]);
    eq(db.conversions.length, 1, '★ 취소도 새 행이 아니라 갱신');
    eq(db.conversions[0].status, 'CANCELLED', '★ 이전에 확정이었어도 취소로 내려간다');
    eq(C.summarize(db.conversions).confirmedGmv, 0, '★ 취소 뒤 확정 매출 0');

    // 서로 다른 전환은 각각 행이 생긴다
    await upsert([C.fromAdpick(row({ trlog_id: 'TRL-2' })).row]);
    eq(db.conversions.length, 2, '다른 전환은 새 행');
  }

  section('7) 부분 커버리지 — 가장 중요한 회계 방어선');
  {
    db.conversions.length = 0;
    db.funnel_events.length = 0;
    funnel._internal._reset();
    process.env.ADPICK_API_KEY = 'k';
    process.env.COUPANG_ACCESS_KEY = 'a'; process.env.COUPANG_SECRET_KEY = 'b';

    // ADPICK 만 whitelist 미확보 → blocked, 쿠팡 미검증
    let cov = funnel.conversionCoverage();
    eq(cov.byProvider.adpick, 'blocked', 'ADPICK whitelist 없으면 blocked');
    eq(cov.byProvider.coupang, 'not_verified', '★ 쿠팡은 not_verified');
    eq(cov.complete, false, '커버리지 불완전');

    // 확정 전환이 있어도 전체 GMV 는 null 이어야 한다
    db.conversions.push({ status: 'CONFIRMED', gmv: 500000, commission: 25000, order_date: '2026-09-07' });
    let rep = await funnel.report(7);
    eq(rep.measuredConfirmedGmv, 500000, '측정된 확정 매출은 숫자로 낸다');
    eq(rep.gmv, null, '★★ 일부만 연결됐으면 전체 GMV 는 null');
    eq(rep.coverageComplete, false, 'coverageComplete false');
    eq(rep.conversionCoverage.coupang, 'not_verified', '응답에 커버리지가 실린다');

    // 전부 연결되면 그때만 숫자
    process.env.ADPICK_CONVERSION_WHITELISTED = '1';
    delete process.env.COUPANG_ACCESS_KEY; delete process.env.COUPANG_SECRET_KEY;
    cov = funnel.conversionCoverage();
    eq(cov.byProvider.coupang, 'inactive', '자격증명 없으면 inactive (트래픽 없음)');
    eq(cov.complete, true, '활성 provider 가 전부 connected');
    rep = await funnel.report(7);
    eq(rep.gmv, 500000, '★ 전부 연결됐을 때만 전체 GMV 를 숫자로');
    process.env.COUPANG_ACCESS_KEY = 'a'; process.env.COUPANG_SECRET_KEY = 'b';
    delete process.env.ADPICK_CONVERSION_WHITELISTED;
  }

  section('8) 클릭 100개 · 전환 0 → GMV null');
  {
    db.conversions.length = 0;
    db.funnel_events.length = 0;
    funnel._internal._reset();
    for (let i = 0; i < 100; i++) {
      db.funnel_events.push({ event: 'affiliate_click', product_id: 'P1', mall: '쿠팡',
        price: 50000, event_date: '2026-09-07' });
    }
    const rep = await funnel.report(7);
    eq(rep.events.affiliate_click, 100, '클릭 100건 집계');
    eq(rep.gmv, null, '★★ 클릭이 100개여도 GMV 는 null');
    eq(rep.measuredConfirmedGmv, null, '확정 매출 없음 → null (0 아님)');
    eq(rep.conversionsPending, true, '전환 없음을 명시');
    ok(rep.topProducts[0].clicks === 100, '클릭은 클릭으로만 센다');
    ok(!('estimatedGmv' in rep) && !('projectedGmv' in rep), '★ 추정 GMV 필드가 존재하지 않는다');
  }

  section('9) pending only → confirmedGmv 0');
  {
    db.conversions.length = 0;
    db.conversions.push({ status: 'PENDING', gmv: 800000, commission: 40000, order_date: '2026-09-07' });
    db.conversions.push({ status: 'ORDERED', gmv: 200000, commission: 10000, order_date: '2026-09-07' });
    const rep = await funnel.report(7);
    eq(rep.confirmedGmv, 0, '★ 확정이 없으면 0 (주문액을 매출로 세지 않는다)');
    eq(rep.orderedGmv, 1000000, '주문액은 따로 보인다');
    eq(rep.commissionRevenue, 0, '확정 수수료 0');
    eq(rep.gmv, null, '커버리지 불완전이라 전체 GMV 는 여전히 null');
  }

  section('10) 안전 — 클릭 경로가 conversions 를 만들 수 없다');
  {
    db.conversions.length = 0;
    funnel._internal._reset();
    const before = db.conversions.length;
    for (const ev of funnel.FUNNEL_EVENTS) {
      await funnel.track({ event: ev, productId: 'P1', mall: '쿠팡', price: 9999, visitorId: 'abcd1234efgh' });
    }
    eq(db.conversions.length, before, '★★ 모든 퍼널 이벤트를 눌러도 conversions 는 0');
    const src = require('fs').readFileSync(path.resolve(__dirname, '..', 'api', '_funnel.js'), 'utf8');
    ok(!/from\(['"]conversions['"]\)\s*\.\s*(insert|upsert|update|delete)/.test(src),
      '★ _funnel.js 에 conversions 쓰기 코드가 없다');
    const cs = require('fs').readFileSync(path.resolve(__dirname, '..', 'api', '_conversion.js'), 'utf8');
    ok(!/click/i.test(cs.replace(/\/\*[\s\S]*?\*\//g, '')),
      '★ _conversion.js 코드에 click 을 읽는 경로가 없다');
  }

  section('11) ADPICK 클라이언트 — redaction · 상한 · whitelist');
  {
    process.env.ADPICK_API_KEY = 'SUPERSECRETKEY99';
    eq(AC.redact('https://biz.adpick.co.kr/api/SUPERSECRETKEY99/conversion?x=1')
      .indexOf('SUPERSECRETKEY99'), -1, '★ URL 의 키가 지워진다');
    ok(AC.redact('/api/SUPERSECRETKEY99/conversion').indexOf('***') > -1, '마스킹 표시');
    eq(AC.redact('키를 모르는 문자열 /api/otherkey/conversion').indexOf('otherkey'), -1,
      '★ 키를 몰라도 경로 패턴으로 지운다');
    ok(AC.redact(new Error('fail at /api/SUPERSECRETKEY99/conversion').message)
      .indexOf('SUPERSECRETKEY99') === -1, '★ 오류 메시지에서도 지워진다');

    eq(AC.MAX_ROWS_PER_PAGE, 200, '공식 상한 200 rows/page');
    eq(AC.MAX_RANGE_DAYS, 365, '공식 상한 365일');
    eq(AC.range(9999).days, 365, '★ 365일을 넘겨 부르지 않는다');
    eq(AC.range(0).days, 1, '최소 1일');
    ok(/^\d{8}$/.test(AC.range(7).from), '날짜 형식 YYYYMMDD');

    ok(AC.isWhitelistError(403, '{"error":"성과추적 API를 사용하려면 API 키에 Whitelist 적용이 필수입니다."}'),
      '★ whitelist 거부를 알아본다 (실측 응답 그대로)');
    eq(AC.isWhitelistError(403, '{"error":"other"}'), false, '다른 403 은 whitelist 아님');
    eq(AC.isWhitelistError(500, 'whitelist'), false, '403 이 아니면 whitelist 아님');
    delete process.env.ADPICK_API_KEY;
    eq(AC.hasKey(), false, '키 없으면 false');
  }

  section('12) 미검증 provider 는 돌지 않는다');
  {
    const { PROVIDERS } = require('./import-conversions.js');
    eq(PROVIDERS.coupang.verified, false, '★ COUPANG_CONVERSION = NOT VERIFIED');
    eq(PROVIDERS.coupang.fetch, null, '★ 쿠팡 fetch 구현 자체가 없다 (추측 금지)');
    eq(PROVIDERS.coupang.normalize, null, '★ 쿠팡 정규화도 없다');
    eq(PROVIDERS.adpick.verified, true, 'ADPICK 은 계약 확인됨');
    ok(/NOT VERIFIED/.test(PROVIDERS.coupang.note), '미검증 사유가 코드에 적혀 있다');
  }

  console.log('\n====================================================');
  console.log(`PASS ${pass}  /  FAIL ${fail}`);
  ENV_KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  if (fail) { console.log('실패: ' + failures.join(', ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
