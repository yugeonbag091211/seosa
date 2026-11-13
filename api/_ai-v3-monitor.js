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
async function healthy(db, now = Date.now()) {
  try {
    const source = db || require('./_supabase');
    const since = new Date(now - WINDOW_MS).toISOString();
    const query = success => {
      let q = source.from('ai_v3_monitor_events').select('*', { count: 'exact', head: true })
        .eq('version', 'v3').gte('created_at', since);
      return success === null ? q : q.eq('success', success);
    };
    const [all, errors] = await deadline(Promise.all([query(null), query(false)]));
    if (all.error || errors.error || !Number.isFinite(all.count) || !Number.isFinite(errors.count)) return false;
    return all.count < MIN_SAMPLES || errors.count / all.count <= 0.10;
  } catch (e) { console.warn('[ai-monitor] circuit unavailable'); return false; }
}
module.exports = { record, healthy, WINDOW_MS, MIN_SAMPLES };
