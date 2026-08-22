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

/* ------------------------------------------------------------------ *
 *  CORS
 *  개인 데이터를 다루는 엔드포인트(sync / profile / alerts)에까지
 *  Access-Control-Allow-Origin: * 를 붙이면 아무 사이트나 남의 데이터를
 *  읽어갈 수 있다. 공개 데이터와 개인 데이터를 구분해서 적용한다.
 * ------------------------------------------------------------------ */
const DEFAULT_ORIGINS = [
  'https://seosa.ai.kr',
  'https://www.seosa.ai.kr',
  'https://seosa-chi.vercel.app'
];

function allowedOrigins() {
  const fromEnv = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_ORIGINS;
}

/**
 * @param {'public'|'private'} scope
 *   public  — 누구나 읽어도 되는 상품/시세 데이터
 *   private — 특정 사용자에게 귀속된 데이터. 허용된 오리진만.
 * @returns {boolean} 계속 처리해도 되면 true (OPTIONS면 이미 응답을 끝냈으므로 false)
 */
function applyCors(req, res, scope) {
  const origin = req.headers.origin;

  if (scope === 'public') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins().indexOf(origin) > -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  // origin이 없으면(같은 출처 요청·서버 간 호출) 헤더 자체가 필요 없다.

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 *  캐시 헤더
 *
 *  /api/init 은 방문자 한 명당 한 번씩 호출되고 그때마다 Supabase 쿼리가
 *  네 번 나간다. 공개 데이터(상품·시세·인기검색어)는 개인화된 부분이 없으므로
 *  Vercel Edge 에 잠깐 세워두면 방문자가 늘어도 DB 호출은 그대로다.
 *
 *  max-age=0 은 일부러다. 브라우저에 오래 물려두면 사용자가 새로고침해도
 *  옛 가격이 남는다. 재검증은 브라우저가 하고, 실제 캐시는 CDN 이 맡는다.
 * ------------------------------------------------------------------ */
function cachePublic(res, seconds, swrSeconds) {
  const swr = swrSeconds || seconds * 4;
  res.setHeader('Cache-Control',
    `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${swr}`);
}

/** 개인 데이터. 중간 캐시에 절대 남지 않게 한다. */
function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

/* ------------------------------------------------------------------ *
 *  입력 검증
 * ------------------------------------------------------------------ */
const MAX_EMAIL_LEN = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 이메일 형식이 아니면 null.
 *
 * 일부러 소문자로 바꾸지 않는다. 이미 저장된 행이 입력한 대소문자 그대로 들어가 있어서,
 * 여기서 정규화하면 예전에 대문자로 신청한 알림/동기화 데이터를 못 찾게 된다.
 * 정규화하려면 profiles / user_data / alerts를 함께 마이그레이션해야 한다.
 */
function readEmail(value) {
  const email = String(value || '').trim();
  if (!email || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) return null;
  return email;
}

/** jsonb 컬럼에 무제한으로 밀어 넣지 못하게 크기를 제한한다. */
function tooLarge(obj, maxBytes) {
  try {
    return Buffer.byteLength(JSON.stringify(obj || {}), 'utf8') > maxBytes;
  } catch (e) {
    return true;   // 순환 참조 등 직렬화 불가 → 거부
  }
}

/**
 * '["a","b"]' 형태의 쿼리 파라미터 → 문자열 배열.
 * 파싱 실패·배열 아님이면 null (호출부가 400 을 낼 수 있게 빈 배열과 구분한다).
 */
function readStringList(raw, max) {
  let arr;
  try { arr = JSON.parse(raw || '[]'); } catch (e) { return null; }
  if (!Array.isArray(arr)) return null;
  return arr.filter(v => typeof v === 'string' && v).slice(0, max);
}

module.exports = {
  readBody, dbError, applyCors, readEmail, tooLarge,
  cachePublic, noStore, readStringList
};
