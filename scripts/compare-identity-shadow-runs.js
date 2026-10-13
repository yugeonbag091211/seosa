#!/usr/bin/env node
'use strict';
/*
 * shadow run 두 개를 비교한다 — 읽기 전용.
 *
 *   node scripts/compare-identity-shadow-runs.js                 최근 completed 두 개
 *   node scripts/compare-identity-shadow-runs.js --base 12 --head 15
 *   ... --json                                                   기계용 출력
 *
 * ── 무엇을 보려고 만드나 ───────────────────────────────────────────
 *
 * matcher 를 고친 뒤 «무엇이 달라졌는가» 를 숫자가 아니라 묶음 단위로 봐야 한다.
 * 특히 위험한 변화는 하나다 — **새로 생긴 MATCH**. 묶이지 않던 두 상품이 묶이기
 * 시작한 것이므로, 그것만 따로 모아 맨 앞에 보여 준다. 사라진 묶음(missed merge)은
 * 안전한 방향이라 그 뒤에 둔다.
 *
 * ★ 쓰기는 하지 않는다. SELECT 뿐이다.
 * ★ 상품명은 products 에서 조인해 콘솔로만 보여 준다 (저장소에 넣지 않는다).
 */

require('./_env.js');

const supabase = require('../api/_supabase');

const argv = process.argv.slice(2);
const JSON_OUT = argv.indexOf('--json') > -1;
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const SHOW = Math.max(0, Number(arg('--show', 20)) || 20);

async function latestCompleted(limit) {
  const { data, error } = await supabase.from('identity_shadow_runs')
    .select('id, started_at, finished_at, matcher_version, stored_group_count, match_pair_count, review_pair_count')
    .eq('status', 'completed').order('started_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

async function loadRun(runId) {
  const { data: run, error: runErr } = await supabase.from('identity_shadow_runs')
    .select('*').eq('id', runId).maybeSingle();
  if (runErr) throw new Error(runErr.message);
  if (!run) throw new Error(`run ${runId} 이 없습니다`);

  const groups = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('identity_shadow_groups')
      .select('id, group_key, confidence_tier, member_count, merchant_count, canonical_identity')
      .eq('run_id', runId).order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    groups.push(...data);
    if (data.length < 1000) break;
  }

  const members = new Map();   // group_id → [offer_key]
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('identity_shadow_group_members')
      .select('group_id, offer_key').eq('run_id', runId).order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    data.forEach(m => {
      if (!members.has(m.group_id)) members.set(m.group_id, []);
      members.get(m.group_id).push(m.offer_key);
    });
    if (data.length < 1000) break;
  }

  // offer_key → group_key, group_key → 구성원
  const byOffer = new Map();
  const byGroupKey = new Map();
  groups.forEach(g => {
    const keys = (members.get(g.id) || []).slice().sort();
    byGroupKey.set(g.group_key, { group: g, members: keys });
    keys.forEach(k => byOffer.set(k, g.group_key));
  });
  return { run, byGroupKey, byOffer };
}

/** 한쪽에만 있는 MATCH 쌍 — «새로 묶인 것» 과 «풀린 것». */
function pairSet(byGroupKey) {
  const pairs = new Set();
  byGroupKey.forEach(({ members }) => {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) pairs.add(`${members[i]}\u0000${members[j]}`);
    }
  });
  return pairs;
}

function diff(base, head) {
  const added = [], removed = [], changed = [];
  head.byGroupKey.forEach((h, key) => { if (!base.byGroupKey.has(key)) added.push(h); });
  base.byGroupKey.forEach((b, key) => { if (!head.byGroupKey.has(key)) removed.push(b); });

  /*
   * group_key 는 구성원 집합의 지문이라 «구성원이 하나 바뀐 그룹» 은 added + removed 로
   * 나타난다. 사람이 읽을 때는 그 둘을 이어 주는 편이 낫다 — 겹치는 구성원이 있으면
   * 같은 묶음이 변한 것으로 본다.
   */
  const removedByOffer = new Map();
  removed.forEach(r => r.members.forEach(k => { if (!removedByOffer.has(k)) removedByOffer.set(k, r); }));
  const stillAdded = [];
  added.forEach(a => {
    const prev = a.members.map(k => removedByOffer.get(k)).find(Boolean);
    if (prev) {
      changed.push({
        before: prev, after: a,
        memberAdded: a.members.filter(k => !prev.members.includes(k)),
        memberRemoved: prev.members.filter(k => !a.members.includes(k))
      });
    } else stillAdded.push(a);
  });
  const changedBefore = new Set(changed.map(c => c.before.group.group_key));

  const basePairs = pairSet(base.byGroupKey);
  const headPairs = pairSet(head.byGroupKey);
  const newMatchPairs = [...headPairs].filter(p => !basePairs.has(p));
  const lostMatchPairs = [...basePairs].filter(p => !headPairs.has(p));

  return {
    addedGroups: stillAdded,
    removedGroups: removed.filter(r => !changedBefore.has(r.group.group_key)),
    changedGroups: changed,
    newMatchPairs, lostMatchPairs
  };
}

/** 상품명은 products 에서만 읽는다 (shadow 표에 복사해 두지 않았다). */
async function titlesFor(offerKeys) {
  const out = new Map();
  const uniq = [...new Set(offerKeys)];
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    const ids = [...new Set(chunk.map(k => k.split('|').slice(1).join('|')))];
    const { data, error } = await supabase.from('products')
      .select('product_id, mall, title, lprice').in('product_id', ids);
    if (error) throw new Error(error.message);
    (data || []).forEach(r => out.set(`${r.mall}|${r.product_id}`, { title: r.title, price: r.lprice }));
  }
  return out;
}

(async () => {
  let baseId = Number(arg('--base', 0));
  let headId = Number(arg('--head', 0));
  if (!baseId || !headId) {
    const recent = await latestCompleted(2);
    if (recent.length < 2) {
      console.error('비교할 completed run 이 두 개 필요합니다. 지금은 ' + recent.length + '개입니다.');
      process.exit(2);
    }
    headId = recent[0].id;
    baseId = recent[1].id;
  }

  const base = await loadRun(baseId);
  const head = await loadRun(headId);
  const d = diff(base, head);

  const summary = {
    base: { id: base.run.id, at: base.run.started_at, matcher: base.run.matcher_version, groups: base.byGroupKey.size },
    head: { id: head.run.id, at: head.run.started_at, matcher: head.run.matcher_version, groups: head.byGroupKey.size },
    newGroups: d.addedGroups.length,
    removedGroups: d.removedGroups.length,
    changedGroups: d.changedGroups.length,
    newMatchPairs: d.newMatchPairs.length,
    lostMatchPairs: d.lostMatchPairs.length
  };

  if (JSON_OUT) {
    console.log(JSON.stringify({
      summary,
      newMatchPairs: d.newMatchPairs.slice(0, 500).map(p => p.split('\u0000')),
      lostMatchPairs: d.lostMatchPairs.slice(0, 500).map(p => p.split('\u0000'))
    }, null, 1));
    return;
  }

  console.log(JSON.stringify(summary, null, 1));

  /* ★ 가장 위험한 변화를 맨 앞에: 전에 없던 MATCH */
  if (d.newMatchPairs.length) {
    const keys = d.newMatchPairs.slice(0, SHOW).flatMap(p => p.split('\u0000'));
    const titles = await titlesFor(keys);
    console.log(`\n=== ★ 새로 생긴 MATCH ${d.newMatchPairs.length}쌍 (앞 ${Math.min(SHOW, d.newMatchPairs.length)}개) ===`);
    d.newMatchPairs.slice(0, SHOW).forEach(p => {
      const [a, b] = p.split('\u0000');
      const ta = titles.get(a) || {}, tb = titles.get(b) || {};
      console.log(`  ${a}  ${ta.price || ''}  ${String(ta.title || '(제목 없음)').slice(0, 90)}`);
      console.log(`  ${b}  ${tb.price || ''}  ${String(tb.title || '(제목 없음)').slice(0, 90)}\n`);
    });
  } else {
    console.log('\n새로 생긴 MATCH 없음');
  }

  if (d.lostMatchPairs.length) {
    console.log(`=== 풀린 MATCH ${d.lostMatchPairs.length}쌍 (안전한 방향) ===`);
    d.lostMatchPairs.slice(0, SHOW).forEach(p => console.log('  ' + p.split('\u0000').join('  ↔  ')));
  }
  if (d.changedGroups.length) {
    console.log(`\n=== 구성원이 바뀐 그룹 ${d.changedGroups.length}개 (앞 ${Math.min(SHOW, d.changedGroups.length)}개) ===`);
    d.changedGroups.slice(0, SHOW).forEach(c => {
      console.log(`  ${c.before.group.group_key} → ${c.after.group.group_key}`);
      if (c.memberAdded.length) console.log(`    + ${c.memberAdded.join(', ')}`);
      if (c.memberRemoved.length) console.log(`    - ${c.memberRemoved.join(', ')}`);
    });
  }
})().catch(e => { console.error(e.message); process.exit(1); });
