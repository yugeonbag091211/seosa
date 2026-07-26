/** Vercel이 body를 파싱하지 못한 경우(문자열/누락)까지 안전하게 처리한다. */
function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch (e) { return {}; }
  }
  return b;
}

/** 아직 만들지 않은 테이블에 접근했을 때 PostgREST 메시지를 실행 가능한 안내로 바꾼다. */
function dbError(error, table) {
  if (!error) return null;
  if (/schema cache|does not exist/i.test(error.message)) {
    return `${table} 테이블이 없습니다. supabase/schema.sql을 Supabase SQL Editor에서 실행하세요.`;
  }
  return error.message;
}

module.exports = { readBody, dbError };
