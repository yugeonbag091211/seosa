'use strict';
// Shared, bounded five-minute circuit state: no prompts, IDs or user data stored.
const WINDOW_MS = 5 * 60 * 1000;
const MIN_SAMPLES = 10;
const TIMEOUT_MS = 400;
function deadline(promise) {
  let timer;
  return Promise.race([Promise.resolve(promise), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('monitor timeout')), TIMEOUT_MS);
  })]).finally(() => clearTimeout(timer));
}
async function record(version, success, db) {
  console.log(JSON.stringify({ event: 'ai_request', version, success: !!success }));
  try {
    const source = db || require('./_supabase');
    const r = await deadline(source.from('ai_v3_monitor_events').insert({ version, success: !!success }));
    if (r.error) throw r.error;
    return true;
  } catch (e) { console.warn('[ai-monitor] write unavailable'); return false; }
}
/*
 * 회로 판정 + 이유 (2026-11-14). 예전에는 healthy() 가 «회로 열림» 과 «측정 표를 못 읽음» 을 같은
 * false 로 돌려줘서, 운영에서 v3 가 왜 한 번도 안 도는지 보이지 않았다 — 11-14 실측으로
 * ai_v3_monitor_events 표가 운영 DB 에 없다(마이그레이션 20261113000001 미적용). 판정은 그대로
 * fail-closed(측정 못 하면 v3 를 열지 않는다)이고, 이유만 함께 준다:
 *   ok | circuit_open | monitor_unavailable
 */
async function check(db, now = Date.now()) {
  try {
    const source = db || require('./_supabase');
    const since = new Date(now - WINDOW_MS).toISOString();
    const query = success => {
      let q = source.from('ai_v3_monitor_events').select('*', { count: 'exact', head: true })
        .eq('version', 'v3').gte('created_at', since);
      return success === null ? q : q.eq('success', success);
    };
    const [all, errors] = await deadline(Promise.all([query(null), query(false)]));
    if (all.error || errors.error || !Number.isFinite(all.count) || !Number.isFinite(errors.count)) {
      console.warn('[ai-monitor] circuit unavailable');
      return { ok: false, reason: 'monitor_unavailable' };
    }
    const ok = all.count < MIN_SAMPLES || errors.count / all.count <= 0.10;
    return { ok, reason: ok ? 'ok' : 'circuit_open', samples: all.count, errors: errors.count };
  } catch (e) { console.warn('[ai-monitor] circuit unavailable'); return { ok: false, reason: 'monitor_unavailable' }; }
}
async function healthy(db, now = Date.now()) {
  return (await check(db, now)).ok;
}
module.exports = { record, healthy, check, WINDOW_MS, MIN_SAMPLES };
