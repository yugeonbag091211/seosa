'use strict';
/*
 * 계정 삭제 — POST /api/account/delete
 *
 * vercel.json 이 /api/account/delete → /api/auth?action=delete-account 로 보낸다.
 * 새 서버리스 함수를 만들지 않는 이유는 Vercel Hobby 함수 12개 상한이다
 * (지금 정확히 12개 — api/history.js · api/sync.js 가 같은 이유로 여러 경로를 겸한다).
 *
 * ── 누구를 지우는가 ────────────────────────────────────────────────
 *
 *   신원은 서명 검증된 토큰에서만 꺼낸다(_auth.identify). body·query 의 email 은
 *   삭제 대상을 정하는 데 쓰지 않는다. 다른 이메일이 적혀 오면 403 으로 거절한다 —
 *   무시하고 토큰 주인을 지우면, 호출한 쪽은 남을 지웠다고 믿거나 자기를 지운 줄
 *   모른다. 둘 다 조용히 넘기면 안 되는 일이다.
 *
 * ── 무엇을 지우는가 (supabase/*.sql 확인, 2026-09-30) ───────────────
 *
 *   이메일로 묶인 표는 아래가 전부다. 표 사이에 외래키·ON DELETE CASCADE 가
 *   하나도 없어서, 여기서 지운 행 말고는 아무것도 함께 지워지지 않는다.
 *
 *     alerts         가격 알림 (이메일·상품·목표가)
 *     profiles       닉네임·관심 카테고리·예산·성별 (data jsonb)
 *     user_data      찜·최근 본 상품·검색 기록 동기화본
 *     ai_usage       이메일별 일일 AI 사용 횟수 (지금은 새로 쌓이지 않는 옛 기록)
 *     subscriptions  PRO 구독 상태 (자동결제 billing_key 포함)
 *     auth_codes     로그인 인증 코드 해시 (이메일은 소문자로 저장된다)
 *
 *   지우지 않는 것:
 *     payments       결제 기록. 전자상거래법 시행령 제6조 — 대금결제·재화 공급
 *                    기록 5년 보관 의무. 법이 정한 기간 뒤에 따로 파기한다.
 *     funnel_events · visitors · daily_metrics · search_stats · conversions
 *                    이메일과 연결되지 않는 익명 집계(브라우저 난수 id 또는 합계).
 *
 * ── 대소문자 ───────────────────────────────────────────────────────
 *
 *   저장 행의 이메일은 입력한 대소문자 그대로다(_http.readEmail). 소유권은
 *   대소문자를 무시하고 판단하므로(_auth.authorize), 삭제도 같은 기준이어야
 *   "User@x.com 으로 저장한 찜" 이 남지 않는다. ilike 로 후보를 읽은 뒤
 *   소문자 비교가 정확히 같은 값만 골라서 지운다 — 패턴이 넓게 걸려도 남의
 *   행을 지우지 않는다.
 *
 * ── 토큰 ───────────────────────────────────────────────────────────
 *
 *   토큰은 서버에 세션이 없는 HMAC 서명이라(_auth.js) 서버가 무효화할 수 없다.
 *   삭제 뒤 그 토큰으로 다시 저장하면 새 빈 계정이 생길 뿐 지운 데이터는 돌아오지
 *   않는다. 앱은 성공 즉시 기기에서 토큰을 지운다.
 *
 * ── 진행 중인 자동결제 ─────────────────────────────────────────────
 *
 *   PRO 자동결제(billing_key)가 살아 있는 상태에서 지우면 결제 주체는 사라지고
 *   청구 경로의 흔적만 남는다. 그 경우만 409 로 멈추고 해지를 먼저 안내한다.
 *   해지(billing_key 제거)된 구독은 남은 기간과 함께 지운다.
 */
const { readBody, noStore, fail } = require('./_http');
const { guard } = require('./_ratelimit');
const { identify } = require('./_auth');
const { isMissingObject } = require('./_dberror');

const CONFIRM = 'delete-account';

const USER_TABLES = ['alerts', 'profiles', 'user_data', 'ai_usage', 'subscriptions', 'auth_codes'];
const RETAINED_TABLES = ['payments'];

/** LIKE 패턴의 와일드카드(% _)와 이스케이프 문자를 글자 그대로 만든다. */
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, m => '\\' + m);
}

function dbMessage(error) {
  return String((error && (error.message || error.code)) || error || '');
}

/** 표 하나에서 이 사람의 이메일 표기(대소문자 변형 포함)를 모은다. 표가 없으면 null. */
async function variantsIn(db, table, email) {
  const lower = email.toLowerCase();
  const { data, error } = await db.from(table).select('email').ilike('email', escapeLike(email)).limit(1000);
  if (error) {
    if (isMissingObject(error)) return null;
    throw new Error(`${table} 조회 실패: ${dbMessage(error)}`);
  }
  const out = new Set();
  (data || []).forEach(r => {
    const e = String((r && r.email) || '');
    if (e && e.toLowerCase() === lower) out.add(e);
  });
  return out;
}

/** 자동결제가 걸린 PRO 구독이 아직 살아 있는가 (_plan.resolvePlanFromRow 와 같은 활성 판정 + billing_key). */
function renewingPro(row, now) {
  if (!row || row.plan !== 'pro' || row.status !== 'active' || !row.billing_key) return false;
  if (!row.expires_at) return true;
  const exp = Date.parse(row.expires_at);
  return Number.isFinite(exp) && exp > now;
}

/**
 * @returns {Promise<{ok:true, deleted:Object<string,number>, retained:string[]} | {ok:false, code:string}>}
 */
async function deleteAccount(email, deps = {}) {
  const db = deps.db || require('./_supabase');
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const base = String(email || '').trim();
  if (!base) throw new Error('삭제할 계정이 없습니다');

  // 1) 표마다 실제로 쓰인 표기를 모은다. 정확한 값과 소문자는 늘 포함한다.
  const variants = new Set([base, base.toLowerCase()]);
  const present = [];
  for (const table of USER_TABLES) {
    const found = await variantsIn(db, table, base);
    if (found === null) continue;          // 이 환경에 없는 표 — 지울 것도 없다
    present.push(table);
    found.forEach(v => variants.add(v));
  }
  const list = [...variants];

  // 2) 자동결제가 살아 있으면 멈춘다.
  if (present.includes('subscriptions')) {
    const { data, error } = await db.from('subscriptions').select('*').in('email', list);
    if (error) throw new Error(`subscriptions 조회 실패: ${dbMessage(error)}`);
    if ((data || []).some(r => renewingPro(r, now))) return { ok: false, code: 'ACTIVE_SUBSCRIPTION' };
  }

  // 3) 지운다. 외래키가 없어 순서는 결과에 영향이 없다. 실패하면 멈추고 알린다 —
  //    같은 요청을 다시 보내면 남은 표부터 다시 지워진다(멱등).
  const deleted = {};
  for (const table of present) {
    const { error, count } = await db.from(table).delete({ count: 'exact' }).in('email', list);
    if (error) throw new Error(`${table} 삭제 실패: ${dbMessage(error)}`);
    deleted[table] = count || 0;
  }
  return { ok: true, deleted, retained: RETAINED_TABLES.slice() };
}

/** POST /api/account/delete — CORS 는 api/auth.js 가 이미 처리했다. */
async function deleteAccountHandler(req, res, deps = {}) {
  noStore(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원' });
  if (!guard(req, res, { name: 'account-delete', limit: 5, windowMs: 10 * 60 * 1000 })) return;

  const who = identify(req);
  if (!who.ok) return res.status(401).json({ error: who.reason, needsAuth: true });

  const body = readBody(req);
  const q = req.query || {};
  const claimed = [body.email, q.email].filter(v => v !== undefined && v !== null && String(v).trim() !== '');
  if (claimed.some(v => String(v).trim().toLowerCase() !== String(who.email).toLowerCase())) {
    return res.status(403).json({ error: '로그인한 계정만 삭제할 수 있어요' });
  }
  if (body.confirm !== CONFIRM) {
    return res.status(400).json({ error: '삭제 확인이 필요해요', confirm: CONFIRM });
  }

  try {
    const r = await deleteAccount(who.email, deps);
    if (!r.ok) {
      return res.status(409).json({
        error: 'PRO 자동결제가 켜져 있어요. 구독 해지 후 다시 시도해 주세요.',
        code: r.code
      });
    }
    // 이메일은 로그에 남기지 않는다. 표별 삭제 행 수만 남긴다.
    console.log(`[account] 계정 삭제 완료 ${JSON.stringify(r.deleted)}`);
    return res.json({ deleted: true, tables: Object.keys(r.deleted), retained: r.retained });
  } catch (e) {
    return fail(res, e, {
      where: 'account-delete', route: '/api/account/delete', status: 503,
      message: '계정을 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.'
    });
  }
}

module.exports = { deleteAccount, deleteAccountHandler, CONFIRM, USER_TABLES, RETAINED_TABLES, _internal: { escapeLike, renewingPro } };
