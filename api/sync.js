const supabase = require('./_supabase');
const { readBody, dbError, applyCors, readEmail, tooLarge, noStore } = require('./_http');
const { guard } = require('./_ratelimit');
const { requireAuth } = require('./_auth');

/*
 * 개인 데이터 저장 — 두 리소스가 한 핸들러에 모여 있다.
 *
 *   ?resource=profile   → profiles 테이블 (닉네임·카테고리·예산·성별)
 *   ?resource=sync 또는 없음 → user_data 테이블 (위시·조회기록·검색기록)
 *
 * ── 왜 파일 하나로 합쳤나 ────────────────────────────────────────────
 * Vercel Hobby 는 서버리스 함수 12개가 상한이고, AI 유료화로 /api/payment
 * 를 추가하면서 13개가 됐다. 두 라우트가 사실상 같은 preamble(CORS/rate
 * limit/이메일 확인/토큰 검증) 을 쓰기 때문에 함수 하나에 넣는 게 자연스럽다.
 *
 * ── 기존 /api/profile URL 은 어떻게 되나 ────────────────────────────
 * vercel.json 의 rewrite 가 /api/profile → /api/sync?resource=profile 로
 * 넘긴다. 프론트도 새 URL 로 직접 부르도록 index.html 에서 바꿨다. 두 경로
 * 모두 작동하므로 배포 순간 캐시된 옛 페이지를 열어둔 사용자도 안전하다.
 *
 * user_data 테이블 컬럼 구성 관련 배경은 아래 SYNC_FIELDS 주석 참고.
 */

/*
 * user_data 테이블은 { email, wish, viewed, searches, updated_at } 형태다.
 *
 * 코드는 예전에 data 라는 jsonb 컬럼 하나에 통째로 넣고 있었는데 그런 컬럼이
 * 없다. 그래서 "☁️ 다른 기기와 동기화" 저장·불러오기가 한 번도 성공한 적이 없다
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

/**
 * 요청의 resource 를 정한다.
 *
 * 우선순위:
 *   1) ?resource=profile|sync (명시적)
 *   2) URL 이 /api/profile 로 들어왔으면 profile (rewrite 되기 전 원본 경로가
 *      x-forwarded-uri 나 headers['x-vercel-original-path'] 로 남지 않으므로
 *      req.url 을 본다)
 *   3) 기본값 sync
 *
 * 모르는 값이 오면 sync 로 떨어진다 — 안전한 기본값이다 (profile 는 다른
 * 테이블이라 이 경로로 잘못 오면 사용자 취향 데이터가 위시로 저장될 위험이
 * 있다). 기본이 sync 라 오탐이 있어도 사용자 데이터가 섞이지는 않는다.
 */
function resourceOf(req) {
  const q = String((req.query && req.query.resource) || '').toLowerCase();
  if (q === 'profile' || q === 'sync') return q;
  const url = String(req.url || '');
  if (url.startsWith('/api/profile')) return 'profile';
  return 'sync';
}

/** 리소스별 정책. table / 필드 / 최대 크기 / 응답 형태가 다르다. */
const RESOURCE = {
  profile: {
    table: 'profiles',
    // 닉네임/카테고리/예산/성별이면 충분
    maxBytes: 16 * 1024,
    // profiles 는 data jsonb 컬럼 하나에 통째로 넣는다
    readShape: async (email) => {
      const { data, error } = await supabase
        .from('profiles').select('data').eq('email', email).maybeSingle();
      return { data: (data && data.data) || {}, error };
    },
    writeShape: async (email, body) => {
      const { error } = await supabase.from('profiles').upsert({
        email, data: body, updated_at: new Date().toISOString()
      }, { onConflict: 'email' });
      return { error };
    }
  },
  sync: {
    table: 'user_data',
    // 위시 + 조회기록 + 검색기록이면 충분한 크기
    maxBytes: 256 * 1024,
    readShape: async (email) => {
      const { data, error } = await supabase
        .from('user_data').select(SYNC_FIELDS.join(', ')).eq('email', email).maybeSingle();
      if (error) return { data: null, error };
      // 저장된 게 하나라도 있어야 success. 빈 행이면 프론트가 "저장된 데이터가
      // 없어요"를 띄우고 로컬 데이터를 덮어쓰지 않는다.
      const saved = pickSyncable(data);
      const has = SYNC_FIELDS.some(f => saved[f].length);
      // 프론트는 { success, data } 를 기대하고 data 를 다시 JSON 문자열로 감싼다.
      return { data: { success: has, data: saved }, error: null };
    },
    writeShape: async (email, body) => {
      const { error } = await supabase.from('user_data').upsert(
        Object.assign({ email, updated_at: new Date().toISOString() }, pickSyncable(body)),
        { onConflict: 'email' }
      );
      return { error };
    }
  }
};

module.exports = async function handler(req, res) {
  // 개인 데이터라 Access-Control-Allow-Origin: * 를 붙이지 않는다.
  if (!applyCors(req, res, 'private')) return;
  noStore(res);   // 개인 데이터 — 중간 캐시에 남으면 안 된다

  const resource = resourceOf(req);
  const spec = RESOURCE[resource];

  // 레이트리미터 버킷은 리소스별로 나눈다. profile 요청이 sync 쿼터를 태우지 않도록.
  // (이메일 주소를 바꿔가며 훑는 것을 늦추기 위해서다)
  if (!guard(req, res, { name: resource, limit: 40, windowMs: 60 * 1000 })) return;

  const email = readEmail(req.query && req.query.email);
  if (!email) return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다' });

  // 이 이메일의 소유자인지 확인한다. 예전에는 주소만 알면 남의 데이터를 읽고
  // 덮어쓸 수 있었다 (CORS 는 브라우저만 막는다).
  if (!requireAuth(req, res, email)) return;

  try {
    if (req.method === 'GET') {
      const { data, error } = await spec.readShape(email);
      const msg = dbError(error, spec.table);
      if (msg) throw new Error(msg);
      return res.json(data);
    }

    if (req.method === 'POST') {
      const body = readBody(req);
      if (tooLarge(body, spec.maxBytes)) {
        return res.status(413).json({ error: '저장할 데이터가 너무 큽니다' });
      }
      const { error } = await spec.writeShape(email, body);
      const msg = dbError(error, spec.table);
      if (msg) throw new Error(msg);
      return res.json({ success: true });
    }

    res.status(405).json({ error: 'GET / POST만 지원' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// 테스트에서 개별 부품을 직접 검증할 수 있게 노출한다.
module.exports.resourceOf = resourceOf;
module.exports.RESOURCE = RESOURCE;
