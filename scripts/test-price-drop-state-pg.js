#!/usr/bin/env node
'use strict';
/*
 * 가격 하락 상태표 — 연결이 여럿인 «실제» PostgreSQL 에서만 시험할 수 있는 것.
 * (PGlite 로 도는 scripts/test-price-drop-state.js 는 연결이 하나라 동시성을 못 본다.)
 *
 *   PG_TEST_URL=postgres://user:pass@host:port/db node scripts/test-price-drop-state-pg.js
 *
 * PG_TEST_URL 이 없으면 건너뛴다(exit 0). CI 는 러너 안의 일회용 postgres:17 서비스로 돈다
 * (.github/workflows/tests.yml 의 price-drop-state-pg 잡). 운영·테스트 Supabase 에 붙이지 않는다 —
 * 시작할 때 새 데이터베이스를 만들고 끝나면 지운다.
 *
 * 여기서 고정하는 것
 *   A. 원자적 재구성: 재구성 중에는 다른 연결이 늘 «직전 공개 결과 그대로» 를 본다. 빈 표에서
 *      시작해도 공개 전에는 0행이지 반쪽이 아니다. 공개 뒤 기존 뷰와 양방향 EXCEPT ALL 0.
 *   B. 동시 실행: 재구성 도중 수집기 쓰기(오늘 기록 · 같은 날 재수집 · 과거 날짜 가져오기),
 *      증분 갱신 두 개 동시(중복 크론), 재구성 배치와 증분의 동시 실행.
 *   C. 장애: 배치 도중 연결이 끊기면 롤백되고 커서가 그대로다 → 같은 소유자가 이어서 완료.
 *      소유자가 사라지면 10분 뒤 다른 실행이 인수하고, 옛 소유자의 다음 배치는 거부된다.
 *   D. 공개 게이트: 행 수가 크게 줄어든 세대는 공개하지 않는다 · 값이 틀어진 세대는 다시 계산해 고친 뒤 공개.
 *   E. 증분이 못 보는 변경의 탐지: 삭제(pg_stat) · 과거 행 가격 정정 · 옵션 번호 변경 → needs_rebuild
 *      → 재구성으로 복구. 과거 날짜 INSERT 는 id 워터마크로 증분이 정확히 반영.
 *   F. 되돌리기: rollback_publish 는 직전 세대를 그대로 다시 보여 준다.
 */

const fs = require('fs');
const path = require('path');

const URL_ = process.env.PG_TEST_URL;
if (!URL_) {
  console.log('[test-price-drop-state-pg] SKIP — PG_TEST_URL 없음 (CI 의 postgres 서비스에서 돈다)');
  process.exit(0);
}
const { Client, types } = require('pg');
// date 는 문자열 그대로 (로컬 자정 Date 로 바꾸면 KST·UTC 가 섞인다). DB 시간대는 UTC 로 만든다.
types.setTypeParser(1082, v => v);
const ROOT = path.resolve(__dirname, '..');
const DB = `pds_test_${process.pid}_${Date.now().toString(36)}`;

let pass = 0;
let fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 500))); }
}
function section(t) { console.log('\n── ' + t); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function latestViewFile() {
  const key = f => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(f); return m ? m[1] + m[2] + m[3] : '00000000'; };
  return fs.readdirSync(path.join(ROOT, 'supabase')).filter(f => f.endsWith('.sql'))
    .filter(f => /create\s+or\s+replace\s+view\s+price_drop_top\b(?!_)/i.test(fs.readFileSync(path.join(ROOT, 'supabase', f), 'utf8')))
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)).pop();
}
const ALL = 'product_id, mall, title, current_price, prev_price, all_time_low, drop_amount, drop_pct, is_all_time_low, link, image, mall_label';

async function main() {
  const admin = new Client({ connectionString: URL_ });
  await admin.connect();
  await admin.query(`create database ${DB}`);
  await admin.query(`alter database ${DB} set timezone to 'UTC'`);
  await admin.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if; end $$`);
  const u = new URL(URL_); u.pathname = '/' + DB;
  const conns = [];
  // 일부러 끊는 연결(장애 시험)의 error 이벤트가 프로세스를 죽이지 않게 받는다.
  const connect = async () => { const c = new Client({ connectionString: u.toString() }); c.on("error", () => {}); await c.connect(); conns.push(c); return c; };
  const c = await connect();       // 운영자·갱신 스크립트 역할
  const reader = await connect();  // /api/init 역할
  const writer = await connect();  // 가격 수집기 역할
  const one = async (cl, s, p) => (await cl.query(s, p)).rows[0];

  try {
    await c.query(`
      create table products (id bigserial primary key, product_id text not null, mall text not null,
        title text, link text, image text, mall_label text, unique (product_id, mall));
      create table price_history (id bigserial primary key, product_id text not null, mall text not null,
        vendor_item_id text, price integer, recorded_date date, recorded_at timestamptz default now(), source text,
        unique (product_id, mall, vendor_item_id, recorded_date));
      create index on price_history (product_id, mall, vendor_item_id, recorded_date desc);
      create index on price_history (product_id, mall, vendor_item_id, price) where vendor_item_id <> '__LEGACY__';
      create index on price_history (recorded_date);`);
    await c.query(fs.readFileSync(path.join(ROOT, 'supabase', latestViewFile()), 'utf8'));
    const mig = fs.readFileSync(path.join(ROOT, 'supabase', '2026-09-25-price-drop-state.sql'), 'utf8');
    await c.query(mig);
    await c.query(mig);

    // 원장: 1,500 상품 · 옵션 1~2 · 관측 1~12 · 최근 45일 (30일 경계 · 미래 라벨 · 레거시 · NULL 포함)
    await c.query(`insert into products (product_id, mall, title, link, image, mall_label)
      select 'P' || lpad(g::text, 5, '0'), case when g % 3 = 0 then '쿠팡' else 'ADPICK' end, 't' || g, 'https://l/' || g, '', ''
        from generate_series(1, 1470) g`);
    await c.query(`insert into price_history (product_id, mall, vendor_item_id, price, recorded_date, source)
      select 'P' || lpad(g::text, 5, '0'), case when g % 3 = 0 then '쿠팡' else 'ADPICK' end,
             case when g % 97 = 0 then '__LEGACY__' when g % 89 = 0 then null else 'o' || o end,
             5000 + ((g * 7919 + d * 104729 + o * 31) % 400) * 50,
             case when (g + d) % 211 = 0 then null else current_date - d + case when g % 53 = 0 then 1 else 0 end end, 'seed'
        from generate_series(1, 1500) g, generate_series(0, 1) o, generate_series(0, 45) d
       where (o = 0 or g % 4 = 0) and ((g * 13 + d * 7 + o) % 9 < 1 + g % 3 or d in (29, 30, 31) and g % 17 = 0)
      on conflict do nothing`);
    await c.query('analyze');

    const diff = async cl => one(cl || c, `select
        (select count(*) from (select ${ALL} from price_drop_top except all select ${ALL} from price_drop_top_fast) x)::int a,
        (select count(*) from (select ${ALL} from price_drop_top_fast except all select ${ALL} from price_drop_top) x)::int b,
        (select count(*) from price_drop_top)::int n`);
    const snapshot = async () => (await reader.query(`select ${ALL} from price_drop_top_fast order by 1, 2, 4, 5, 6`)).rows.map(r => JSON.stringify(r)).join('\n');
    const meta = () => one(c, 'select * from price_drop_state_meta where id = 1');
    const start = async owner => (await one(c, 'select price_drop_state_rebuild_start($1) r', [owner])).r;
    const step = async (gen, owner, limit, cl) => (await one(cl || c, 'select price_drop_state_rebuild_step($1, $2, $3) r', [gen, owner, limit])).r;
    const publish = async (gen, owner, ratio, overlap) => (await one(c, 'select price_drop_state_publish($1, $2, $3, $4) r',
      [gen, owner, ratio == null ? 0.9 : ratio, overlap == null ? 10000 : overlap])).r;
    // 이 시험 원장은 1만 행 남짓이라 기본 겹침(1만 행)이 원장 전체를 덮는다 — 경계를 시험할 때는 0 으로 준다.
    const recent = async (cl, overlap) => (await one(cl || c, 'select price_drop_state_refresh_recent(2, $1) r', [overlap == null ? 0 : overlap])).r;
    const pubKeys = async (where, limit) => (await c.query(`select product_id, mall, vendor_item_id, latest_date, latest_price, prev_date, prev_price
        from price_drop_state where gen = (select published_gen from price_drop_state_meta where id = 1) and ${where} order by drop_pct desc, product_id limit ${limit}`)).rows;
    const writeRows = async rows => { for (const r of rows) await writer.query(`insert into price_history (product_id, mall, vendor_item_id, price, recorded_date, source)
        values ($1, $2, $3, $4, $5, 'test') on conflict (product_id, mall, vendor_item_id, recorded_date) do update set price = excluded.price, recorded_at = now()`, r); };
    async function rebuildAll(owner, limit, between) {
      const s = await start(owner);
      if (!s.started) return { busy: true, s };
      let n = 0;
      for (;;) { const r = await step(s.gen, owner, limit); n++; if (between) await between(n); if (r.done) break; }
      return { gen: s.gen, steps: n, published: await publish(s.gen, owner) };
    }

    section('A. 원자적 재구성 — 빈 표에서 시작해도 공개 전에는 0행');
    {
      const s = await start('owner-a');
      const seen = [];
      for (;;) {
        const r = await step(s.gen, 'owner-a', 150);
        seen.push((await one(reader, 'select count(*)::int n from price_drop_top_fast')).n);
        if (r.done) break;
      }
      check(seen.length > 5 && seen.every(n => n === 0), `재구성 배치 ${seen.length}개 동안 다른 연결은 0행만 본다 (반쪽 노출 없음)`, seen.slice(0, 12));
      const pub = await publish(s.gen, 'owner-a');
      const d = await diff();
      check(pub.gen === s.gen && d.a === 0 && d.b === 0 && d.n > 0, `공개 뒤 기존 뷰와 양방향 EXCEPT ALL 0 (${d.n}행)`, { d, verify: pub.verify });
      check(pub.verify && pub.verify.ok === true && pub.verify.mismatches === 0, '공개 게이트의 표본 검증 통과', pub.verify);
    }

    section('A. 재구성 중에는 직전 공개 결과 그대로 · 수집기 동시 쓰기');
    {
      const before = await snapshot();
      let same = 0;
      let steps = 0;
      const r = await rebuildAll('owner-b', 120, async n => {
        steps = n;
        if ((await snapshot()) === before) same++;
        // 수집기: 오늘 기록 · 같은 날 재수집(가격 수정) · 과거 날짜 가져오기
        await writer.query(`insert into price_history (product_id, mall, vendor_item_id, price, recorded_date, source)
          select product_id, mall, vendor_item_id, greatest(100, price - 700 + $1::int * 3), current_date, 'collector'
            from price_history where vendor_item_id = 'o0' and recorded_date = current_date - 1 and product_id like $2
          on conflict (product_id, mall, vendor_item_id, recorded_date) do update set price = excluded.price, recorded_at = now()`,
          [n, `P0${n % 10}%`]);
        if (n === 3) {
          await writer.query(`insert into price_history (product_id, mall, vendor_item_id, price, recorded_date, source)
            select product_id, mall, vendor_item_id, 111, recorded_date - 60, 'import'
              from price_history where recorded_date = current_date - 5 and vendor_item_id = 'o0' and product_id like 'P01%'
            on conflict do nothing`);
        }
      });
      check(same === steps, `재구성 배치 ${steps}개 동안 공개 결과가 한 행도 바뀌지 않았다`, { same, steps });
      const d = await diff();
      check(r.published && d.a === 0 && d.b === 0, '공개(따라잡기 포함) 뒤 동시 쓰기까지 반영 — 기존 뷰와 0/0', { d, catchup: r.published && r.published.catchup });
      const m = await meta();
      check(Number(m.published_gen) === r.gen && Number(m.previous_gen) > 0 && m.building_gen === null, '공개 세대가 바뀌고 직전 세대가 남는다', m);
    }

    section('B. 중복 크론 — 증분 둘을 동시에');
    {
      const ks = await pubKeys('latest_date < current_date', 30);
      await writeRows(ks.map(k => [k.product_id, k.mall, k.vendor_item_id, Math.max(100, (k.latest_price || 5000) - 1300), new Date().toISOString().slice(0, 10)]));
      const stale = await diff();
      check(ks.length === 30 && stale.a + stale.b > 0, '오늘 기록 30건 — 갱신 전에는 어긋난다 (대조가 차이를 잡는다)', stale);
      const c2 = await connect();
      const t0 = Date.now();
      const [r1, r2] = await Promise.all([
        recent(c),
        recent(c2)
      ]);
      const d = await diff();
      check(r1.refreshed && r2.refreshed && d.a === 0 && d.b === 0, `두 증분이 차례로(권고 잠금) 끝나고 결과 0/0 (${Date.now() - t0}ms)`, { r1, r2, d });
      check(r1.published.upserted + r2.published.upserted > 0 && Math.min(r1.published.upserted, r2.published.upserted) === 0,
        '같은 변경을 두 번 쓰지 않는다 (두 번째는 0행)', [r1.published, r2.published]);
    }

    section('B. 재구성 배치와 증분의 동시 실행');
    {
      const s = await start('owner-c');
      const c3 = await connect();
      let n = 0;
      for (;;) {
        await writer.query(`insert into price_history (product_id, mall, vendor_item_id, price, recorded_date, source)
          select product_id, mall, vendor_item_id, greatest(100, price - 50 * $1::int), current_date, 'collector'
            from price_history where vendor_item_id = 'o0' and recorded_date = current_date - 3 and product_id like $2
          on conflict (product_id, mall, vendor_item_id, recorded_date) do update set price = excluded.price, recorded_at = now()`,
          [n + 1, `P03${n % 10}%`]);
        const [r] = await Promise.all([step(s.gen, 'owner-c', 200), one(c3, 'select price_drop_state_refresh_recent(2) r')]);
        n++;
        if (r.done) break;
      }
      await publish(s.gen, 'owner-c');
      await one(c, 'select price_drop_state_refresh_recent(2) r');
      const d = await diff();
      check(d.a === 0 && d.b === 0, `배치 ${n}개와 증분 ${n}개를 동시에 돌려도 공개·증분 뒤 0/0`, d);
    }

    section('C. 배치 도중 연결 끊김 → 롤백 · 같은 소유자가 이어서');
    {
      const before = await snapshot();
      const s = await start('owner-d');
      await step(s.gen, 'owner-d', 200);
      const cur1 = (await meta()).building_cursor;
      const victim = await connect();
      const pid = (await one(victim, 'select pg_backend_pid() p')).p;
      await victim.query('begin');
      await victim.query('select price_drop_state_rebuild_step($1, $2, 200)', [s.gen, 'owner-d']);
      await c.query('select pg_terminate_backend($1)', [pid]);
      await sleep(300);
      const cur2 = (await meta()).building_cursor;
      check(cur1 === cur2, '끊긴 배치는 롤백돼 커서가 그대로다', { cur1, cur2 });
      check((await snapshot()) === before, '공개 결과는 그대로다');
      const again = await start('owner-d');
      check(again.started && again.resumed && Number(again.gen) === Number(s.gen), '같은 소유자는 같은 세대·커서에서 이어받는다', again);
      for (;;) { const r = await step(s.gen, 'owner-d', 200); if (r.done) break; }
      await publish(s.gen, 'owner-d');
      const d = await diff();
      check(d.a === 0 && d.b === 0, '이어서 끝낸 재구성의 공개 결과 0/0', d);
    }

    section('C. 소유자가 사라짐 → 중복 실행은 busy · 10분 뒤 인수 · 옛 소유자 거부');
    {
      const s = await start('owner-e');
      await step(s.gen, 'owner-e', 300);
      const busy = await start('owner-f');
      check(busy.started === false && busy.busy === true, '하트비트가 살아 있으면 두 번째 재구성은 busy', busy);
      await c.query(`update price_drop_state_meta set building_heartbeat = now() - interval '11 minutes' where id = 1`);
      const take = await start('owner-f');
      check(take.started && take.takeover && Number(take.gen) === Number(s.gen), '10분 넘게 조용하면 커서에서 인수', take);
      let rejected = false;
      try { await step(s.gen, 'owner-e', 300); } catch (e) { rejected = /lost build ownership/.test(e.message); }
      check(rejected, '옛 소유자의 다음 배치는 거부된다');
      for (;;) { const r = await step(s.gen, 'owner-f', 300); if (r.done) break; }
      await publish(s.gen, 'owner-f');
      const d = await diff();
      check(d.a === 0 && d.b === 0, '인수한 재구성의 공개 결과 0/0', d);
    }

    section('D. 공개 게이트');
    {
      const before = await snapshot();
      const pubBefore = (await meta()).published_gen;
      const s = await start('owner-g');
      for (;;) { const r = await step(s.gen, 'owner-g', 500); if (r.done) break; }
      // 따라잡기(최근 창 · 새 id)가 되살리지 못하는 오래된 상품의 행을 지워 «반쪽 세대» 를 만든다
      const del = await c.query(`delete from price_drop_state d where d.gen = $1 and d.product_id not in (
          select product_id from price_history where recorded_date >= current_date - 2)`, [s.gen]);
      const counts = await one(c, `select (select count(*) from price_drop_state where gen = $1)::int nw,
          (select count(*) from price_drop_state where gen = (select published_gen from price_drop_state_meta))::int old`, [s.gen]);
      let refused = '';
      try { await publish(s.gen, 'owner-g', 0.9, 0); } catch (e) { refused = e.message; }
      check(counts.nw < counts.old * 0.9 && /publish refused — rows/.test(refused),
        `행 수가 크게 줄어든 세대(${counts.nw}/${counts.old}, 지운 ${del.rowCount}행)는 공개하지 않는다`, refused);
      check((await meta()).published_gen === pubBefore && (await snapshot()) === before, '거부되면 공개 세대·결과는 그대로');
      const ab = (await one(c, 'select price_drop_state_abort_build() r')).r;
      check(ab.aborted && (await meta()).building_gen === null, 'abort_build 로 재구성 세대를 버린다', ab);

      const s2 = await start('owner-h');
      for (;;) { const r = await step(s2.gen, 'owner-h', 500); if (r.done) break; }
      await c.query(`update price_drop_state set latest_price = latest_price + 1, drop_pct = drop_pct + 5
                      where gen = $1 and (product_id, mall, vendor_item_id) in (
                        select product_id, mall, vendor_item_id from price_drop_state
                         where gen = $1 and prev_date >= current_date - 30 order by drop_pct desc limit 20)`, [s2.gen]);
      const pub = await publish(s2.gen, 'owner-h');
      const d = await diff();
      check(pub.verify && pub.verify.ok && d.a === 0 && d.b === 0, '값이 틀어진 상위 20행은 게이트가 찾아 다시 계산한 뒤 공개 — 0/0', { verify: pub.verify, d });
    }

    section('E. 증분이 정확히 따라가는 변경 — 과거 날짜 INSERT · 중복 · 레거시');
    {
      const old = await pubKeys('latest_date < current_date - 2 and prev_date >= current_date - 30', 20);
      await writeRows(old.map(k => [k.product_id, k.mall, k.vendor_item_id, 42, new Date(Date.parse(k.latest_date) - 90 * 86400000).toISOString().slice(0, 10)]));
      const dup = await writer.query(`insert into price_history (product_id, mall, vendor_item_id, price, recorded_date, source)
        select product_id, mall, vendor_item_id, 1, recorded_date, 'dup' from price_history
         where recorded_date = current_date - 1 and vendor_item_id = 'o0' limit 30 on conflict do nothing`);
      await writer.query(`insert into price_history (product_id, mall, vendor_item_id, price, recorded_date, source)
        values ('P00006', 'ADPICK', '__LEGACY__', 1, current_date, 'legacy'), ('P00006', 'ADPICK', null, 1, current_date, 'nullvid')`);
      const stale = await diff();
      const r = await recent(c, 0);
      const d = await diff();
      check(old.length === 20 && stale.a + stale.b > 0 && d.a === 0 && d.b === 0 && !r.needs_rebuild,
        '과거 날짜 가져오기는 id 워터마크로 증분이 정확히 반영 (재구성 불필요)', { stale, d, needs: r.needs_rebuild });
      check(dup.rowCount === 0, '같은 키·같은 날 중복 기록은 원장 UNIQUE 가 막는다 (상태표도 그대로)');
    }

    section('E. 증분이 못 보는 변경 — 탐지 → needs_rebuild → 재구성 복구');
    {
      // 1) 삭제
      await writer.query(`delete from price_history where id in (select id from price_history where recorded_date = current_date - 12 limit 40)`);
      await writer.query('select pg_stat_force_next_flush()');
      await sleep(1200);
      const r = await recent(c, 0);
      check(r.needs_rebuild === true && /삭제/.test(r.needs_rebuild_reason), '삭제는 pg_stat 로 탐지돼 needs_rebuild', r);
      const rb = await rebuildAll('owner-i', 400);
      let d = await diff();
      check(rb.published && d.a === 0 && d.b === 0 && (await meta()).needs_rebuild === false, '원자적 재구성으로 복구 · 플래그 해제', d);

      // 2) 과거 행 가격 정정 (사용자에게 보이는 상위 키의 직전 관측)
      // 최근 기록이 없는(증분이 고르지 않는) 상품의 직전 관측 가격을 고친다 — 원장에 새 id·최근 날짜 흔적이 없다
      const [top] = await pubKeys('latest_date < current_date - 2 and prev_date >= current_date - 30', 1);
      await writer.query(`update price_history set price = price + 3000 where product_id = $1 and mall = $2 and vendor_item_id = $3 and recorded_date = $4`,
        [top.product_id, top.mall, top.vendor_item_id, top.prev_date]);
      const inc = await recent(c, 0);
      const stillStale = await diff();
      check(stillStale.a + stillStale.b > 0 && !inc.needs_rebuild, '증분만으로는 과거 행 정정을 볼 수 없다 (설계상 — 탐지의 몫)', { stillStale, inc: inc.products });
      const v = (await one(c, 'select price_drop_state_verify(null, 1000) r')).r;
      check(v.ok === false && v.mismatches > 0 && (await meta()).needs_rebuild === true, '과거 행 정정은 표본 검증(상위 키)이 찾아 needs_rebuild', v.kinds);

      // 3) 옵션 번호 변경 (과거 행의 vendor_item_id 를 바꿈) — 같은 재구성에서 같이 복구된다
      await writer.query(`update price_history set vendor_item_id = 'o9' where product_id = 'P00300' and vendor_item_id = 'o0' and recorded_date < current_date - 3`);
      await rebuildAll('owner-j', 400);
      d = await diff();
      const v2 = (await one(c, 'select price_drop_state_verify(null, 100) r')).r;
      check(d.a === 0 && d.b === 0 && v2.ok, '재구성 뒤 정정·옵션 변경까지 0/0, 검증 ok', { d, v2: v2.kinds });
    }

    section('F. 되돌리기');
    {
      const cur = await snapshot();
      const m0 = await meta();
      const rb = (await one(c, 'select price_drop_state_rollback_publish() r')).r;
      const m1 = await meta();
      check(Number(m1.published_gen) === Number(m0.previous_gen) && Number(m1.previous_gen) === Number(m0.published_gen),
        'rollback_publish 는 공개·직전 세대를 맞바꾼다', rb);
      await one(c, 'select price_drop_state_rollback_publish() r');
      check((await snapshot()) === cur, '다시 되돌리면 원래 결과 그대로');
    }

    section('권한 · 계획 · 크기');
    {
      const priv = await one(c, `select has_table_privilege('anon','price_drop_state','select') a,
        has_table_privilege('authenticated','price_drop_top_fast','select') b,
        has_function_privilege('anon','price_drop_state_rebuild_start(text)','execute') c,
        has_function_privilege('service_role','price_drop_state_publish(bigint,text,numeric,integer)','execute') d`);
      check(!priv.a && !priv.b && !priv.c && priv.d, 'anon/authenticated 는 읽기·실행 불가, service_role 만', priv);
      const src = fs.readFileSync(path.join(ROOT, 'supabase', '2026-09-25-price-drop-state.sql'), 'utf8').replace(/--[^\n]*/g, ' ');
      const verifyBody = /function public\.price_drop_state_verify[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(src);
      check(verifyBody && !/price_drop_top\b(?!_)/.test(verifyBody[1]), '검증 함수는 기존 뷰 price_drop_top 을 부르지 않는다');
      const gens = (await c.query('select gen, count(*)::int n from price_drop_state group by gen order by gen')).rows;
      check(gens.length <= 2, `남은 세대는 공개·직전 둘 이하 (${gens.map(g => g.gen + ':' + g.n).join(', ')})`);
    }
  } finally {
    for (const cl of conns) { try { await cl.end(); } catch (e) { /* 끊긴 연결 */ } }
    await admin.query(`drop database if exists ${DB} with (force)`);
    await admin.end();
  }
  console.log(`\n[test-price-drop-state-pg] PASS ${pass} / FAIL ${fail}`);
  if (fail) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
