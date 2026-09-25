#!/usr/bin/env node
'use strict';
/*
 * 가격 하락 상태표 (supabase/2026-09-25-price-drop-state.sql) — 실제 Postgres(PGlite, 오프라인)에서
 * 기존 뷰 price_drop_top 과 «같은 결과» 인지 대조한다.
 *
 * 여기서 고정하는 것
 *   1) 초기 적재(전체 재구성) 뒤 price_drop_top_fast 와 price_drop_top 의 전체 결과가
 *      양방향 EXCEPT ALL 로 0행 차이다 — 30일 경계, 미래 라벨, __LEGACY__/NULL 옵션,
 *      날짜 없는 관측, 가격 NULL, 고아 이력, 한 상품 여러 옵션을 포함한다
 *   2) 수집(오늘 날짜 신규 + 같은 날 재수집)은 증분 갱신으로 다시 0행 차이가 된다
 *   3) 오래된 날짜 수정·삭제는 증분이 못 본다(설계상) → 전체 재구성이 복구한다
 *   4) 배치 경계에서 원장에서 사라진 상품의 상태 행이 지워진다 (작은 배치로 커서를 여러 번 넘긴다)
 *   5) 마이그레이션은 원장·상품·기존 뷰를 바꾸지 않고, anon/authenticated 에 열리지 않는다
 *   6) /api/init 은 PRICE_DROP_SOURCE=state 일 때만 새 뷰를 읽는다
 */

const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION = path.join(ROOT, 'supabase', '2026-09-25-price-drop-state.sql');

let pass = 0;
let fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 400))); }
}
function section(t) { console.log('\n── ' + t); }

/** 기존 뷰의 «현재» 정의 = price_drop_top 을 재정의한 마지막 마이그레이션 (test-regression O1 과 같은 규칙). */
function latestViewFile() {
  const key = f => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(f);
    if (m) return m[1] + m[2] + m[3];
    const ym = /^(\d{4})-(\d{2})/.exec(f);
    return ym ? ym[1] + ym[2] + '00' : '00000000';
  };
  const defs = fs.readdirSync(path.join(ROOT, 'supabase'))
    .filter(f => f.endsWith('.sql'))
    .filter(f => /create\s+or\s+replace\s+view\s+price_drop_top\b(?!_)/i.test(fs.readFileSync(path.join(ROOT, 'supabase', f), 'utf8')))
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return defs[defs.length - 1];
}

const ALL = 'product_id, mall, title, current_price, prev_price, all_time_low, drop_amount, drop_pct, is_all_time_low, link, image, mall_label';

async function main() {
  const sqlRaw = fs.readFileSync(MIGRATION, 'utf8');
  const sql = sqlRaw.replace(/--[^\n]*/g, ' ');

  section('정적 — 무엇을 바꾸지 않는가');
  check(!/\b(insert\s+into|update|delete\s+from|truncate|alter\s+table|drop\s+\w+)\s+(public\.)?(price_history|products|hotdeals)\b/i.test(sql),
    '원장·상품·핫딜 표에 쓰거나 구조를 바꾸지 않는다');
  check(!/create\s+(or\s+replace\s+)?trigger/i.test(sql), '트리거를 만들지 않는다 (가격 수집 쓰기 경로에 아무것도 걸지 않는다)');
  check(!/create\s+or\s+replace\s+view\s+(public\.)?price_drop_top\s/i.test(sql), '기존 뷰 price_drop_top 은 재정의하지 않는다');
  check(/set\s+local\s+lock_timeout\s*=\s*'2s'/i.test(sql), '2초 lock_timeout 트랜잭션 안에서 적용한다');
  const fnCount = (sql.match(/create\s+or\s+replace\s+function/gi) || []).length;
  check(fnCount === 9 && (sql.match(/security\s+invoker/gi) || []).length === fnCount && !/security\s+definer/i.test(sql),
    `함수 ${fnCount}개 모두 SECURITY INVOKER`);
  check((sql.match(/set\s+search_path\s*=\s*public,\s*pg_temp/gi) || []).length === fnCount, '함수 모두 search_path 고정');
  check(/pg_advisory_xact_lock\(hashtext\('price_drop_state'\)/.test(sql), '증분·재구성 배치·공개는 같은 권고 잠금으로 한 번에 하나');
  check(/where\s+s\.gen\s*=\s*\(select\s+m\.published_gen/i.test(sql), '읽기(price_drop_top_fast)는 공개 세대만 본다 — 재구성 중인 세대는 보이지 않는다');
  const verifySql = fs.readFileSync(path.join(ROOT, 'supabase', '2026-09-25-price-drop-state.VERIFY.sql'), 'utf8').replace(/--[^\n]*/g, ' ');
  check(!/price_drop_top\b(?!_)/.test(verifySql) && !/statement_timeout/i.test(verifySql) && /price_drop_state_verify\(null,\s*\d+,\s*false\)/.test(verifySql),
    '운영 VERIFY.sql 은 기존 뷰를 부르지 않고 timeout 을 올리지 않으며 아무것도 쓰지 않는다');
  const verifyFn = /function public\.price_drop_state_verify[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(sql);
  check(verifyFn && !/price_drop_top\b(?!_)/.test(verifyFn[1]), '표본 검증 함수는 기존 뷰 price_drop_top 을 부르지 않는다');
  // 운영 규모 합성 데이터(원장 26만 행)에서 NOT EXISTS (… from calc) 반연결은 증분 갱신을
  // 0.3초 → 13초로 만들었다(CTE 행 수 오추정 → 중첩 루프). 지울 키는 EXCEPT 로 구한다.
  check(/\bexcept\b[\s\S]{0,120}from\s+calc\b/i.test(sql) && !/not\s+exists\s*\(\s*select[\s\S]{0,40}from\s+calc\b/i.test(sql),
    '지울 키는 EXCEPT(해시)로 구한다 — CTE 반연결(NOT EXISTS) 금지');
  check(/create\s+or\s+replace\s+view\s+public\.price_drop_top_fast[\s\S]*?\bs\.prev_date\s*>=\s*current_date\s*-\s*30\b/i.test(sql), '30일 창은 조회 시점에 prev_date 로만 건다');
  check(/revoke\s+all\s+on\s+table\s+public\.price_drop_state\s+from\s+public,\s*anon,\s*authenticated/i.test(sql)
    && /revoke\s+all\s+on\s+table\s+public\.price_drop_top_fast\s+from\s+public,\s*anon,\s*authenticated/i.test(sql),
  '상태표·새 뷰는 anon/authenticated 에 열지 않는다');
  const init = fs.readFileSync(path.join(ROOT, 'api', 'init.js'), 'utf8');
  check(/process\.env\.PRICE_DROP_SOURCE === 'state'/.test(init) && init.includes("supabase.from('price_drop_top_fast')")
    && init.includes("supabase.from('price_drop_top')"), '/api/init 은 PRICE_DROP_SOURCE=state 일 때만 새 뷰, 기본은 기존 뷰');

  /* ── 실제 Postgres ─────────────────────────────────────────── */
  const db = new PGlite();
  const q = (s, p) => db.query(s, p);
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table products (
      id bigserial primary key, product_id text not null, mall text not null, title text, link text, image text,
      mall_label text, keyword text, unique (product_id, mall));
    create table price_history (
      id bigserial primary key, product_id text not null, mall text not null, vendor_item_id text,
      price integer, recorded_date date, recorded_at timestamptz, source text,
      unique (product_id, mall, vendor_item_id, recorded_date));
    create index price_history_pid_mall_vid_date_idx on price_history (product_id, mall, vendor_item_id, recorded_date desc);
    create index price_history_recorded_date_idx on price_history (recorded_date);
  `);
  const viewFile = latestViewFile();
  await db.exec(fs.readFileSync(path.join(ROOT, 'supabase', viewFile), 'utf8'));
  await db.exec(sqlRaw);
  await db.exec(sqlRaw);   // 재실행 안전

  const phBefore = (await q(`select count(*)::int n from pg_trigger where tgrelid = 'price_history'::regclass and not tgisinternal`)).rows[0].n;
  check(phBefore === 0, '마이그레이션 뒤에도 price_history 에 트리거가 없다');

  async function diff() {
    const r = (await q(`
      select (select count(*) from (select ${ALL} from price_drop_top except all select ${ALL} from price_drop_top_fast) x)::int a,
             (select count(*) from (select ${ALL} from price_drop_top_fast except all select ${ALL} from price_drop_top) x)::int b,
             (select count(*) from price_drop_top)::int n`)).rows[0];
    return r;
  }
  /** 원자적 재구성: 새 세대에 배치로 쓰고, 게이트를 통과하면 공개한다. @returns 배치 수 */
  async function rebuild(limit) {
    const st = (await q(`select price_drop_state_rebuild_start('test') r`)).rows[0].r;
    let batches = 0;
    for (;;) {
      const r = (await q(`select price_drop_state_rebuild_step($1, 'test', $2) r`, [st.gen, limit])).rows[0].r;
      batches++;
      if (r.done) break;
      if (batches > 10000) throw new Error('rebuild loop');
    }
    await q(`select price_drop_state_publish($1, 'test') r`, [st.gen]);
    return batches;
  }
  const ins = rows => Promise.all(rows.map(r => q(
    `insert into price_history (product_id, mall, vendor_item_id, price, recorded_date, recorded_at, source)
     values ($1, $2, $3, $4, current_date + $5::int, now(), 'test') on conflict do nothing`, r)));

  section('경계 사례 — 기존 뷰와 같은 행·같은 값');
  await db.exec(`
    insert into products (product_id, mall, title, link, image, mall_label) values
      ('P1','쿠팡','하락','https://l/1','https://i/1',''), ('P2','쿠팡','경계30','https://l/2','',''),
      ('P3','쿠팡','경계31','https://l/3','',''), ('P4','ADPICK','미래라벨','https://l/4','','알리'),
      ('P5','쿠팡','레거시','https://l/5','',''), ('P6','쿠팡','날짜없음최저','https://l/6','',''),
      ('P7','쿠팡','가격NULL','https://l/7','',''), ('P9','쿠팡','여러옵션','https://l/9','',''),
      ('P10','쿠팡','한번만','https://l/10','',''), ('P11','쿠팡','오른값','https://l/11','','');
  `);
  await ins([
    ['P1', '쿠팡', 'v1', 10000, -3], ['P1', '쿠팡', 'v1', 8000, 0], ['P1', '쿠팡', 'v1', 7000, -60],   // 전체 최저가는 창 밖
    ['P2', '쿠팡', 'v2', 5000, -30], ['P2', '쿠팡', 'v2', 4000, -1],                                  // prev 가 정확히 30일 전 → 포함
    ['P3', '쿠팡', 'v3', 5000, -31], ['P3', '쿠팡', 'v3', 4000, -1],                                  // 31일 전 → 제외
    ['P4', 'ADPICK', 'v4', 9000, 0], ['P4', 'ADPICK', 'v4', 8500, 1],                                 // KST 내일 라벨
    ['P5', '쿠팡', '__LEGACY__', 100, -2], ['P5', '쿠팡', '__LEGACY__', 50, -1],
    ['P5', '쿠팡', null, 100, -2], ['P5', '쿠팡', null, 50, -1],                                      // NULL 옵션
    ['P7', '쿠팡', 'v7', 3000, -2], ['P7', '쿠팡', 'v7', null, -1],
    ['P9', '쿠팡', 'a', 20000, -2], ['P9', '쿠팡', 'a', 18000, 0], ['P9', '쿠팡', 'b', 30000, -2], ['P9', '쿠팡', 'b', 31000, 0],
    ['P10', '쿠팡', 'v10', 1000, 0],
    ['P11', '쿠팡', 'v11', 1000, -2], ['P11', '쿠팡', 'v11', 1500, 0],
    ['GHOST', '쿠팡', 'g', 9000, -2], ['GHOST', '쿠팡', 'g', 1000, 0]                                // 카탈로그 없는 고아
  ]);
  await q(`insert into price_history (product_id, mall, vendor_item_id, price, recorded_date, source)
           values ('P6','쿠팡','v6',100,null,'test'), ('P6','쿠팡','v6',900,current_date - 2,'test'), ('P6','쿠팡','v6',800,current_date,'test')`);
  await rebuild(3);
  const d0 = await diff();
  check(d0.a === 0 && d0.b === 0 && d0.n > 0, `초기 적재 뒤 전체 결과 동일 (${d0.n}행, 뷰 정의 ${viewFile})`, d0);
  const fast = (await q(`select product_id, vendor_item_id from price_drop_state where gen = (select published_gen from price_drop_state_meta) order by 1, 2`)).rows;
  const ids = (await q(`select product_id from price_drop_top_fast order by 1`)).rows.map(r => r.product_id);
  check(ids.includes('P2') && !ids.includes('P3'), '30일 전 prev 는 포함, 31일 전 prev 는 제외 (기존 뷰와 같다)', ids);
  check(ids.includes('P4') && !ids.includes('P5') && !ids.includes('P10') && !ids.includes('GHOST'),
    '미래 라벨 포함 · __LEGACY__/NULL 옵션 · 관측 1개 · 고아 이력은 제외', ids);
  const p6 = (await q(`select all_time_low, is_all_time_low from price_drop_top_fast where product_id = 'P6'`)).rows[0];
  check(p6 && p6.all_time_low === 100 && p6.is_all_time_low === false, '날짜 없는 관측은 순위에서 빠지지만 최저가에는 들어간다', p6);
  check(fast.filter(r => r.product_id === 'P9').length === 2, '한 상품의 옵션마다 한 행');

  section('수집 흉내 → 증분 갱신');
  await ins([['P1', '쿠팡', 'v1', 6500, 1], ['P11', '쿠팡', 'v11', 900, 1], ['P10', '쿠팡', 'v10', 800, 1]]);
  await q(`update price_history set price = price - 100, recorded_at = now() where product_id = 'P9' and recorded_date = current_date`);
  const stale = await diff();
  check(stale.a + stale.b > 0, '갱신 전에는 어긋난다 — 대조가 차이를 실제로 잡는다', stale);
  const r1 = (await q(`select price_drop_state_refresh_recent(2) r`)).rows[0].r;
  const d1 = await diff();
  check(d1.a === 0 && d1.b === 0, '증분 갱신 뒤 다시 전체 결과 동일', { d1, r1 });
  const r2 = (await q(`select price_drop_state_refresh_recent(2) r`)).rows[0].r;
  check(r2.published.upserted === 0 && r2.published.deleted === 0, '바뀐 것이 없으면 한 행도 다시 쓰지 않는다', r2);

  section('무작위 원장 (시드 고정) — 전체 재구성 · 증분 · 복구');
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const rows = [];
  const prods = [];
  for (let i = 0; i < 400; i++) {
    const pid = 'R' + String(i).padStart(4, '0');
    const mall = rnd() < 0.4 ? '쿠팡' : 'ADPICK';
    if (rnd() > 0.03) prods.push(`('${pid}','${mall}','t${i}','https://l/${i}','','')`);
    const nOpt = rnd() < 0.8 ? 1 : 2;
    for (let o = 0; o < nOpt; o++) {
      const vid = rnd() < 0.03 ? '__LEGACY__' : 'o' + o;
      const n = 1 + Math.floor(rnd() * 8);
      let off = -Math.floor(rnd() * 45);
      let price = 10000 + Math.floor(rnd() * 90) * 100;
      for (let k = 0; k < n && off <= 1; k++) {
        price = Math.max(100, Math.round(price * (1 + (rnd() - 0.55) * 0.3)));
        rows.push([pid, mall, vid, price, off]);
        off += 1 + Math.floor(rnd() * 6);
      }
    }
  }
  await q(`insert into products (product_id, mall, title, link, image, mall_label) values ${prods.join(',')}`);
  await ins(rows);
  const batches = await rebuild(37);
  const d2 = await diff();
  check(d2.a === 0 && d2.b === 0, `전체 재구성(${batches}배치, 배치당 37개) 뒤 동일 (${d2.n}행)`, d2);

  const day = [];
  for (let i = 0; i < 150; i++) day.push(['R' + String(Math.floor(rnd() * 400)).padStart(4, '0'), rnd() < 0.4 ? '쿠팡' : 'ADPICK', 'o0', 5000 + Math.floor(rnd() * 5000), rnd() < 0.3 ? 1 : 0]);
  await ins(day);
  await q(`select price_drop_state_refresh_recent(2)`);
  const d3 = await diff();
  check(d3.a === 0 && d3.b === 0, '하루치 수집 뒤 증분 갱신으로 동일', d3);

  await q(`insert into price_history (product_id, mall, vendor_item_id, price, recorded_date, source)
           select product_id, mall, vendor_item_id, 1, recorded_date - 50, 'import'
             from price_history where recorded_date between current_date - 20 and current_date - 10
              and vendor_item_id <> '__LEGACY__' limit 40 on conflict do nothing`);
  await q(`delete from price_history where id in (select id from price_history where recorded_date between current_date - 25 and current_date - 5 order by id limit 40)`);
  await q(`delete from price_history where product_id in ('R0003','R0100','R0399')`);   // 원장에서 통째로 사라진 상품
  // 증분이 고르지 않는 키(최근 기록·새 id 없음)의 최신 관측을 지운다 — 원장에 흔적이 남지 않는 변경
  const victim = (await q(`select s.product_id, s.mall, s.vendor_item_id, s.latest_date from price_drop_state s
      where s.gen = (select published_gen from price_drop_state_meta) and s.prev_date >= current_date - 30 and s.latest_date < current_date - 2
        and not exists (select 1 from price_history h where h.product_id = s.product_id
                          and (h.id > (select id_watermark from price_drop_state_meta) or h.recorded_date >= current_date - 2))
        and exists (select 1 from products p where p.product_id = s.product_id and p.mall = s.mall)
      order by s.product_id limit 1`)).rows[0];
  await q('delete from price_history where product_id = $1 and mall = $2 and vendor_item_id = $3 and recorded_date = $4',
    [victim.product_id, victim.mall, victim.vendor_item_id, victim.latest_date]);
  await q(`select price_drop_state_refresh_recent(2, 0)`);
  const d4 = await diff();
  check(d4.a + d4.b > 0, '삭제는 증분이 볼 수 없다 (설계상 — 탐지해서 재구성으로; 동시성·탐지는 test-price-drop-state-pg)', d4);
  await rebuild(37);
  const d5 = await diff();
  check(d5.a === 0 && d5.b === 0, '전체 재구성이 복구한다', d5);
  const ghosts = (await q(`select count(*)::int n from price_drop_state where gen = (select published_gen from price_drop_state_meta) and product_id in ('R0003','R0100','R0399')`)).rows[0].n;
  check(ghosts === 0, '원장에서 사라진 상품의 상태 행은 배치 경계를 넘어서도 지워진다');
  await q('truncate price_drop_state');
  await rebuild(3000);
  const d6 = await diff();
  check(d6.a === 0 && d6.b === 0, '상태표를 비워도 재구성으로 같은 결과', d6);
  const gens = (await q('select count(distinct gen)::int n from price_drop_state')).rows[0].n;
  check(gens <= 2, `공개 뒤 남는 세대는 공개·직전 둘 이하 (${gens})`);

  section('갱신 스크립트 (scripts/refresh-price-drop-state.js) — rpc 를 같은 Postgres 로 연결');
  {
    const kit = require('./_v2-testkit');
    const { state, db: fakeDb } = kit.setup('test-price-drop-state');
    const viaPg = fn => async args => {
      try { return { data: (await q(`select ${fn}(${Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, Object.values(args))).rows[0].r, error: null }; }
      catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
    };
    for (const fn of ['rebuild_start', 'rebuild_step', 'publish', 'refresh_recent', 'verify', 'rollback_publish', 'abort_build']) {
      state.rpc['price_drop_state_' + fn] = viaPg('price_drop_state_' + fn);
    }
    // status() 는 표를 읽는다 — 가짜 DB 에 같은 Postgres 의 메타 행을 비춰 준다
    const syncMeta = async () => { fakeDb.price_drop_state_meta = (await q('select * from price_drop_state_meta')).rows; };
    const script = require('./refresh-price-drop-state');
    await ins([['R0001', '쿠팡', 'o0', 1234, 1], ['R0002', 'ADPICK', 'o0', 2345, 1]]);
    await syncMeta();
    const a1 = await script.auto({ days: 2, sample: 100 });
    const d7 = await diff();
    check(a1.ok && a1.log.some(x => x.step === 'recent') && d7.a === 0 && d7.b === 0, '자동 모드: 증분 → 표본 검증 ok, 결과 동일', { log: a1.log, d7 });
    const genBefore = (await q('select published_gen g from price_drop_state_meta')).rows[0].g;
    await syncMeta();
    const a2 = await script.auto({ full: true, batch: 50, sample: 100 });
    const m2 = (await q('select published_gen g, previous_gen p from price_drop_state_meta')).rows[0];
    const d8 = await diff();
    check(a2.ok && Number(m2.g) > Number(genBefore) && Number(m2.p) === Number(genBefore) && d8.a === 0 && d8.b === 0,
      `--full: 배치 여러 개로 새 세대를 만들고 공개 (gen ${genBefore} → ${m2.g}), 결과 동일`, { log: a2.log, d8 });
    await q(`update price_drop_state_meta set needs_rebuild = true, needs_rebuild_reason = 'test', needs_rebuild_at = now()`);
    await syncMeta();
    const a3 = await script.auto({ batch: 500, sample: 100 });
    const flag = (await q('select needs_rebuild n from price_drop_state_meta')).rows[0].n;
    check(a3.ok && a3.log[0].step === 'rebuild' && a3.log[0].why === 'test' && flag === false,
      'needs_rebuild 이면 자동 모드가 원자적 재구성으로 복구하고 플래그를 내린다', a3.log);
    // 마이그레이션 전: 메타 표도 함수도 없다
    state.missingTables.add('price_drop_state_meta');
    for (const k of Object.keys(state.rpc)) state.rpc[k] = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.' + k } });
    const log = console.log; const lines = []; console.log = (...a) => lines.push(a.join(' '));
    let threw = null;
    try { await script.main(); } catch (e) { threw = e; } finally { console.log = log; }
    check(!threw && /미적용/.test(lines.join('\n')), '마이그레이션 전(함수 없음)이면 조용히 끝낸다 — 워크플로가 붉어지지 않는다', { threw: threw && threw.message, lines });
  }

  section('읽기 · 권한');
  const top = (await q(`select product_id, drop_pct from price_drop_top_fast order by drop_pct desc limit 200`)).rows;
  check(top.length > 0 && top.every((r, i) => i === 0 || Number(top[i - 1].drop_pct) >= Number(r.drop_pct)), '홈 질의(order by drop_pct desc limit 200)가 돈다');
  await db.exec('set enable_seqscan = off');
  const plan = (await q(`explain select product_id from price_drop_top_fast order by drop_pct desc limit 200`)).rows.map(r => r['QUERY PLAN']).join('\n');
  await db.exec('reset enable_seqscan');
  check(/price_drop_state_rank_idx/.test(plan), '상위 200 은 drop_pct 인덱스로 읽을 수 있다', plan);
  const priv = (await q(`select has_table_privilege('anon','price_drop_state','select') a, has_table_privilege('authenticated','price_drop_top_fast','select') b,
                               has_table_privilege('service_role','price_drop_top_fast','select') c,
                               has_function_privilege('anon','price_drop_state_refresh_recent(integer,integer)','execute') d,
                               has_function_privilege('service_role','price_drop_state_rebuild_step(bigint,text,integer)','execute') e`)).rows[0];
  check(!priv.a && !priv.b && priv.c && !priv.d && priv.e, 'anon/authenticated 는 읽기·실행 불가, service_role 만', priv);
  const meta = (await q(`select last_recent_at is not null a, last_publish_at is not null b, building_gen, building_cursor, published_gen from price_drop_state_meta`)).rows[0];
  check(meta.a && meta.b && meta.building_gen === null && meta.building_cursor === null && meta.published_gen !== null, '갱신·공개 기록이 남고 재구성 칸은 공개 뒤 비워진다', meta);

  const rollback = fs.readFileSync(path.join(ROOT, 'supabase', '2026-09-25-price-drop-state.ROLLBACK.sql'), 'utf8');
  await db.exec(rollback);
  const left = (await q(`select count(*)::int n from pg_class where relname like 'price_drop_state%' or relname = 'price_drop_top_fast'`)).rows[0].n;
  const kept = (await q(`select (select count(*) from price_history)::int h, (select count(*) from price_drop_top)::int v`)).rows[0];
  check(left === 0 && kept.h > 0 && kept.v > 0, 'ROLLBACK 은 새 객체만 지우고 원장·기존 뷰는 남긴다', { left, kept });

  await db.close();
  console.log(`\n[test-price-drop-state] PASS ${pass} / FAIL ${fail}`);
  if (fail) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
