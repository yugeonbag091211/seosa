const supabase = require('./_supabase');
const { readBody, dbError, applyCors, readEmail, tooLarge, noStore, fail } = require('./_http');
const { guardGlobal } = require('./_ratelimit');
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
const MAX_WISH = 200;
const MAX_VIEWED = 8;
const MAX_SEARCHES = 10;

function text(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}
function safeUrl(v) {
  const u = text(v, 2000);
  return /^https?:\/\//i.test(u) ? u : '';
}
function int(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 2147483647 ? n : 0;
}
function optionalInt(v) {
  if (v === null || v === undefined || v === '') return null;
  return int(v);
}

/**
 * 클라우드 데이터는 브라우저가 만든 JSON이라도 신뢰하지 않는다.
 * 알려진 상품 필드만, 실제 UI가 다룰 수 있는 길이/개수만 저장한다.
 *
 * vendorItemId · targetPrice · savedAt · mallLabel은 특히 중요하다.
 * 예전 동기화는 이 값을 버려 다른 기기에서 옵션 동일성이 사라지고,
 * Radar 목표가/저장 시점/실제 판매처 이름도 함께 유실됐다.
 */
function cleanItem(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const title = text(o.title, 300);
  if (!title) return null;
  const savedAt = Math.round(Number(o.savedAt));
  return {
    title,
    price: int(o.price),
    lprice: int(o.lprice),
    currentPrice: int(o.currentPrice),
    savedPrice: int(o.savedPrice),
    targetPrice: optionalInt(o.targetPrice),
    savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : 0,
    mall: text(o.mall, 100),
    mallLabel: text(o.mallLabel, 100),
    productId: text(o.productId, 120),
    vendorItemId: text(o.vendorItemId, 120),
    link: safeUrl(o.link),
    image: safeUrl(o.image),
    glyph: text(o.glyph, 4)
  };
}
function cleanList(v, max) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, max).map(cleanItem).filter(Boolean);
}
function cleanSearches(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const q = text(raw, 80);
    if (!q || seen.has(q)) continue;
    seen.add(q);
    out.push(q);
    if (out.length >= MAX_SEARCHES) break;
  }
  return out;
}
function cleanProfile(body) {
  const p = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const catSet = new Set(['테크','패션','홈리빙','뷰티','아웃도어','식품']);
  const budgetSet = new Set(['','3만원 이하','10만원 이하','30만원 이하','30만원 이상']);
  const genderSet = new Set(['','남성','여성']);
  const cats = Array.isArray(p.cats)
    ? [...new Set(p.cats.map(v => text(v, 20)).filter(v => catSet.has(v)))].slice(0, 6)
    : [];
  const budget = text(p.budget, 30);
  const gender = text(p.gender, 10);
  return {
    nickname: text(p.nickname, 10),
    cats,
    budget: budgetSet.has(budget) ? budget : '',
    gender: genderSet.has(gender) ? gender : ''
  };
}

/** DB 왕복 양쪽 모두 같은 정규화를 적용한다. */
function pickSyncable(body) {
  return {
    wish: cleanList(body && body.wish, MAX_WISH),
    viewed: cleanList(body && body.viewed, MAX_VIEWED),
    searches: cleanSearches(body && body.searches)
  };
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
      return { data: cleanProfile((data && data.data) || {}), error };
    },
    writeShape: async (email, body) => {
      const { error } = await supabase.from('profiles').upsert({
        email, data: cleanProfile(body), updated_at: new Date().toISOString()
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
  if (!(await guardGlobal(req, res, { name: resource, limit: 40, windowMs: 60 * 1000 }))) return;

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
    return fail(res, e, { where: 'sync', route: '/api/sync', message: '데이터를 동기화하지 못했어요. 잠시 후 다시 시도해 주세요.' });
  }
};

// 테스트에서 개별 부품을 직접 검증할 수 있게 노출한다.
module.exports.resourceOf = resourceOf;
module.exports.RESOURCE = RESOURCE;
module.exports.cleanItem = cleanItem;
module.exports.pickSyncable = pickSyncable;
module.exports.cleanProfile = cleanProfile;
