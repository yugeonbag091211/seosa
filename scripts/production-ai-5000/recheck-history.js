#!/usr/bin/env node
'use strict';
/*
 * «기록상 최저가» 주장 재판정. 공개 읽기 API(/api/history-batch)의 실제 관측으로 대조한다.
 *
 *   TRIVIAL  관측이 1일치 — 최저가와 같다는 말이 아무 정보도 아니다 (주장은 산술적으로 참, 근거로는 거짓).
 *   THIN     관측 2~6일 — 참일 수 있지만 «수준» 이라 부르기엔 약하다.
 *   TRUE     관측 7일 이상, 카드 가격이 그 관측 최저 이하.
 *   FALSE    관측 어느 쪽이든 더 낮은 가격이 실제로 있었다 — 명백한 거짓.
 *   UNKNOWN  이 키로 조회한 관측이 없음(옵션 키 불일치 등).
 *
 * 질문 시점과 재조회 시점이 다르므로, 답변 시각 이후 관측은 제외한다.
 */
const fs = require('fs');
const path = require('path');
const DIR = path.resolve(__dirname, '../../reports/production-ai-5000');
const ORIGIN = 'https://seosa.ai.kr';
const rd = p => fs.readFileSync(path.join(DIR, p), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const key = it => {
  const base = `${it.productId}|${it.mall || ''}`;
  return it.vendorItemId ? `${base}|${it.vendorItemId}` : base;
};
const kstDay = iso => new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 10);

(async () => {
  const R = rd('responses.jsonl').filter(r => r.response && /기록상\s*최저가?\s*수준/.test(r.response.text || '') && (r.response.items || []).length);
  const out = [];
  for (let i = 0; i < R.length; i += 8) {
    const batch = R.slice(i, i + 8);
    const keys = [...new Set(batch.map(r => key(r.response.items[0])))];
    const u = `${ORIGIN}/api/history-batch?keys=${encodeURIComponent(JSON.stringify(keys))}`;
    const res = await fetch(u, { headers: { 'User-Agent': 'SEOSA-QA-Production-5000/1.0', Referer: ORIGIN + '/' } });
    const map = res.ok ? await res.json() : {};
    for (const r of batch) {
      const it = r.response.items[0];
      const pts = (map[key(it)] || []).filter(p => !p.date || p.date <= kstDay(r.at));
      const prices = pts.map(p => Number(p.price)).filter(v => v > 0);
      const low = prices.length ? Math.min(...prices) : null;
      const price = Number(it.lprice);
      let judge = 'UNKNOWN';
      if (prices.length) {
        if (price > low) judge = 'FALSE';
        else if (prices.length === 1) judge = 'TRIVIAL';
        else if (prices.length < 7) judge = 'THIN';
        else judge = 'TRUE';
      }
      out.push({ id: r.id, top: String(it.title).slice(0, 60), mall: it.mall, price, days: prices.length, low, judge, admitsThin: /하루치|이틀치|기록이?\s*(부족|짧)|판단하기\s*어렵|확신이\s*낮/.test(r.response.text) });
    }
    await sleep(1200);
  }
  fs.writeFileSync(path.join(DIR, 'history-recheck.jsonl'), out.map(o => JSON.stringify(o)).join('\n') + '\n');
  const c = {}; out.forEach(o => { c[o.judge] = (c[o.judge] || 0) + 1; });
  console.log(JSON.stringify({ claims: out.length, judge: c, admitsThin: out.filter(o => o.admitsThin).length }));
  out.filter(o => ['FALSE', 'THIN', 'TRUE'].includes(o.judge)).slice(0, 25).forEach(o => console.log(o.id, o.judge, o.price, 'low', o.low, 'days', o.days, o.top));
})().catch(e => { console.error(e); process.exit(1); });
