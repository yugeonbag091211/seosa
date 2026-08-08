const supabase = require('./_supabase');
const { readBody, dbError, applyCors, readEmail, tooLarge, noStore } = require('./_http');
const { guard } = require('./_ratelimit');
const { requireAuth } = require('./_auth');

const MAX_PAYLOAD_BYTES = 256 * 1024;   // 위시 + 조회기록 + 검색기록이면 충분한 크기

/*
 * user_data 테이블은 { email, wish, viewed, searches, updated_at } 형태다.
 *
 * 코드는 data 라는 jsonb 컬럼 하나에 통째로 넣고 있었는데 그런 컬럼이 없다.
 * 그래서 "☁️ 다른 기기와 동기화" 저장·불러오기가 한 번도 성공한 적이 없다
 * (저장을 누르면 "user_data 테이블이 없습니다" 안내가 떴다. 실제로는 테이블은
 *  있고 컬럼 구성이 달랐던 것이다 — 행 0개라 눈치채기 어려웠다).
 *
 * 프론트가 보내는 { wish, viewed, searches } 가 컬럼과 1:1로 맞으므로
 * 마이그레이션 없이 실제 스키마에 맞춰 읽고 쓴다.
 */
const SYNC_FIELDS = ['wish', 'viewed', 'searches'];

/** 배열만 통과. 프론트가 뭘 보내든 컬럼 타입(jsonb 배열)에 맞는 값만 저장한다. */
function pickSyncable(body) {
  const out = {};
  SYNC_FIELDS.forEach(f => { out[f] = Array.isArray(body && body[f]) ? body[f] : []; });
  return out;
}

module.exports = async function handler(req, res) {
  // 개인 데이터라 Access-Control-Allow-Origin: * 를 붙이지 않는다.
  if (!applyCors(req, res, 'private')) return;
  noStore(res);   // 개인 데이터 — 중간 캐시에 남으면 안 된다

  // 이메일 주소를 바꿔가며 훑는 것을 늦춘다.
  if (!guard(req, res, { name: 'sync', limit: 40, windowMs: 60 * 1000 })) return;

  const email = readEmail(req.query && req.query.email);
  if (!email) return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다' });

  // 이 이메일의 소유자인지 확인한다. 예전에는 주소만 알면 남의 데이터를 읽고
  // 덮어쓸 수 있었다 (CORS 는 브라우저만 막는다).
  if (!requireAuth(req, res, email)) return;

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('user_data')
        .select(SYNC_FIELDS.join(', '))
        .eq('email', email)
        .maybeSingle();
      const msg = dbError(error, 'user_data');
      if (msg) throw new Error(msg);

      // 저장된 게 하나라도 있어야 success. 빈 행이면 프론트가 "저장된 데이터가
      // 없어요"를 띄우고 로컬 데이터를 덮어쓰지 않는다.
      const saved = pickSyncable(data);
      const has = SYNC_FIELDS.some(f => saved[f].length);

      // 프론트는 { success, data }를 기대하고 data를 다시 JSON 문자열로 감싼다.
      return res.json({ success: has, data: saved });
    }

    if (req.method === 'POST') {
      const body = readBody(req);
      if (tooLarge(body, MAX_PAYLOAD_BYTES)) {
        return res.status(413).json({ error: '저장할 데이터가 너무 큽니다' });
      }

      const { error } = await supabase.from('user_data').upsert(
        Object.assign({ email, updated_at: new Date().toISOString() }, pickSyncable(body)),
        { onConflict: 'email' }
      );
      const msg = dbError(error, 'user_data');
      if (msg) throw new Error(msg);

      return res.json({ success: true });
    }

    res.status(405).json({ error: 'GET / POST만 지원' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
