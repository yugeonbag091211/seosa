'use strict';
/*
 * 이메일 소유 확인 기반 인증.
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────
 * /api/sync, /api/profile, /api/alerts 는 ?email= 하나만 보고 데이터를 내줬다.
 * CORS 는 브라우저만 막을 뿐이라, curl 한 줄이면 남의 이메일로 찜 목록·취향·
 * 알림 목록을 읽고 덮어쓸 수 있었다. 계정 시스템이 없는 서비스이므로
 * "그 이메일을 실제로 받아볼 수 있는 사람인가"만 확인하는 방식을 쓴다.
 *
 * ── 흐름 ───────────────────────────────────────────────────────────
 *   1. POST /api/auth { email }        → 6자리 코드를 메일로 발송
 *   2. POST /api/auth { email, code }  → 서명 토큰 발급 (기본 30일)
 *   3. 이후 요청은 Authorization: Bearer <token>
 *
 * ── 토큰 ───────────────────────────────────────────────────────────
 * 서버에 세션을 저장하지 않는다. payload(이메일·만료)에 HMAC 서명을 붙인
 * 문자열이라 서버리스 인스턴스가 몇 개든 검증이 된다.
 *
 * 서명 키는 AUTH_SECRET 이 있으면 그걸 쓰고, 없으면 SUPABASE_SECRET_KEY 에서
 * 파생한다. 환경변수를 하나 더 요구하지 않으려는 것이고, 용도 문자열을 섞어
 * 파생하므로 원래 키를 되돌릴 수는 없다.
 * (Supabase 키를 교체하면 기존 토큰이 전부 무효가 된다 — 사용자는 다시 인증하면 된다)
 */

const crypto = require('crypto');
const supabase = require('./_supabase');

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30일
const CODE_TTL_MS  = 10 * 60 * 1000;             // 10분
const MAX_ATTEMPTS = 5;                          // 코드 오입력 허용 횟수
const RESEND_COOLDOWN_MS = 60 * 1000;            // 재발송 최소 간격

function signingKey() {
  if (process.env.AUTH_SECRET) return Buffer.from(process.env.AUTH_SECRET, 'utf8');
  const base = process.env.SUPABASE_SECRET_KEY;
  if (!base) throw new Error('AUTH_SECRET 또는 SUPABASE_SECRET_KEY 가 필요합니다.');
  return crypto.createHmac('sha256', base).update('seosa-auth-v1').digest();
}

const b64u = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/* ------------------------------------------------------------------ *
 *  토큰
 * ------------------------------------------------------------------ */
function issueToken(email, ttlMs = TOKEN_TTL_MS) {
  const payload = b64u(JSON.stringify({ e: email, x: Date.now() + ttlMs }));
  const sig = b64u(crypto.createHmac('sha256', signingKey()).update(payload).digest());
  return `v1.${payload}.${sig}`;
}

/**
 * @returns {{email: string}|null} 유효하면 이메일, 아니면 null
 */
function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;

  const [, payload, sig] = parts;
  const expected = crypto.createHmac('sha256', signingKey()).update(payload).digest();
  let given;
  try { given = unb64u(sig); } catch (e) { return null; }

  // 길이가 다르면 timingSafeEqual 이 예외를 던진다. 먼저 걸러낸다.
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;

  let data;
  try { data = JSON.parse(unb64u(payload).toString('utf8')); } catch (e) { return null; }
  if (!data || !data.e || !data.x || Date.now() > data.x) return null;
  return { email: String(data.e) };
}

/**
 * 요청에 실린 토큰이 이 이메일의 것인지 확인한다.
 *
 * 대소문자만 다른 이메일은 같은 것으로 본다. 저장된 행은 입력한 대소문자
 * 그대로라 조회 키를 바꾸지는 않지만(_http.readEmail 주석 참고),
 * 소유권 판단까지 대소문자를 따지면 사용자가 이유 없이 막힌다.
 */
function authorize(req, email) {
  const raw = String(req.headers.authorization || '');
  const m = raw.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, reason: '인증이 필요합니다' };

  /*
   * 여기서 던지면 안 된다.
   *
   * 호출부(sync/profile)는 requireAuth 를 try 블록 앞에서 부른다. 서명 키를
   * 만들 수 없는 환경(AUTH_SECRET 도 SUPABASE_SECRET_KEY 도 없음)에서 예외가
   * 나가면 핸들러의 try/catch 를 지나쳐 Vercel 이 원인을 알 수 없는
   * FUNCTION_INVOCATION_FAILED 로 처리한다. 무엇이 잘못됐는지 로그에도 안 남는다.
   */
  let t;
  try {
    t = verifyToken(m[1].trim());
  } catch (e) {
    console.error('[auth] 토큰 검증 불가 —', e.message);
    return { ok: false, reason: '서버 인증 설정에 문제가 있어요. 잠시 후 다시 시도해 주세요' };
  }

  if (!t) return { ok: false, reason: '인증이 만료되었거나 올바르지 않습니다' };
  if (t.email.toLowerCase() !== String(email).toLowerCase()) {
    return { ok: false, reason: '다른 이메일의 인증입니다' };
  }
  return { ok: true, email: t.email };
}

/**
 * 요청에 실린 토큰 하나만으로 "누구인가"를 확정한다.
 *
 * authorize() 와의 차이 — authorize 는 호출부가 넘긴 email 과 토큰이 일치하는지
 * 확인한다(소유권 확인). 그건 이미 "이 이메일의 데이터"를 다루는 것이 정해진
 * 엔드포인트용이다.
 *
 * AI 사용량 차감은 다르다. 클라이언트가 보낸 이메일을 기준으로 삼으면 남의
 * 이메일을 적어 보내는 것만으로 그 사람의 quota 를 태우거나, 아직 quota 가
 * 남은 다른 계정으로 갈아타며 무한히 쓸 수 있다. 그래서 신원은 오직 서명이
 * 검증된 토큰에서만 꺼낸다 — body 는 쳐다보지 않는다.
 *
 * @returns {{ok: true, email: string} | {ok: false, reason: string}}
 */
function identify(req) {
  const raw = String(req.headers.authorization || '');
  const m = raw.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, reason: '로그인이 필요합니다' };

  let t;
  try {
    t = verifyToken(m[1].trim());
  } catch (e) {
    // authorize() 와 같은 이유로 여기서 던지지 않는다.
    console.error('[auth] 토큰 검증 불가 —', e.message);
    return { ok: false, reason: '서버 인증 설정에 문제가 있어요. 잠시 후 다시 시도해 주세요' };
  }

  if (!t) return { ok: false, reason: '인증이 만료되었거나 올바르지 않습니다' };
  return { ok: true, email: t.email };
}

/**
 * 핸들러에서:  if (!requireAuth(req, res, email)) return;
 */
function requireAuth(req, res, email) {
  const r = authorize(req, email);
  if (r.ok) return true;
  res.status(401).json({ error: r.reason, needsAuth: true });
  return false;
}

/* ------------------------------------------------------------------ *
 *  인증 코드
 * ------------------------------------------------------------------ */
/** 000000~999999. Math.random 이 아니라 CSPRNG 를 쓴다. */
function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/** 코드는 평문으로 저장하지 않는다 (DB가 새면 그대로 로그인 수단이 된다). */
function hashCode(email, code) {
  return crypto.createHmac('sha256', signingKey())
    .update(`${String(email).toLowerCase()}|${code}`).digest('hex');
}

/**
 * 코드 발급 후 저장. 같은 이메일의 이전 코드는 덮어쓴다.
 * @returns {{ok: boolean, code?: string, error?: string, retryAfter?: number}}
 */
async function createCode(email) {
  const key = String(email).toLowerCase();

  const { data: prev } = await supabase
    .from('auth_codes').select('created_at').eq('email', key).maybeSingle();

  if (prev && prev.created_at) {
    const since = Date.now() - new Date(prev.created_at).getTime();
    if (since < RESEND_COOLDOWN_MS) {
      return { ok: false, error: '잠시 후 다시 요청해 주세요', retryAfter: Math.ceil((RESEND_COOLDOWN_MS - since) / 1000) };
    }
  }

  const code = newCode();
  const { error } = await supabase.from('auth_codes').upsert({
    email: key,
    code_hash: hashCode(key, code),
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    attempts: 0,
    created_at: new Date().toISOString()
  }, { onConflict: 'email' });

  if (error) return { ok: false, error: error.message };
  return { ok: true, code };
}

/*
 * 마이그레이션(2026-08-24-payment-pending-and-auth-attempts.sql)이 아직
 * 적용되지 않은 환경 대비. 한 번 없다고 확인되면 그 뒤로는 예전 방식으로 간다.
 * (api/_shop.js 의 컬럼 폴백과 같은 방식)
 */
let attemptRpc = true;

function missingRpc(msg) {
  return /could not find|does not exist|schema cache|function .* not/i.test(msg || '');
}

/**
 * 코드 검증. 성공하면 그 코드는 즉시 폐기한다(재사용 방지).
 *
 * ── 왜 RPC 인가 ─────────────────────────────────────────────────────
 * 예전에는 이렇게 돼 있었다.
 *
 *   select attempts        // 읽고
 *   if (attempts >= 5)     // 비교하고
 *   update attempts + 1    // 쓴다
 *
 * 요청 100개가 거의 동시에 들어오면 100개 전부 attempts=0 을 읽고 전부 통과한
 * 뒤 전부 1 을 쓴다. MAX_ATTEMPTS 가 사실상 없는 것과 같고, 6자리 코드를
 * 병렬로 긁으면 뚫린다. 그 토큰은 찜·취향·알림에 더해 PRO 권한까지 준다.
 *
 * api/_plan.js 의 ai_quota_reserve 가 같은 함정을 한 문장으로 풀었다.
 * 여기서도 "증가 + 한도 검사 + 코드 대조" 를 한 문장에 맡긴다 —
 * UPDATE ... WHERE attempts < max 가 행 잠금을 잡으므로 동시 요청은
 * 직렬화되고, 한도를 넘는 순간부터 아무 행도 반환되지 않는다.
 *
 * 대조를 밖에서 하면 "증가" 와 "판정" 이 다시 갈라져 같은 문제가 생긴다.
 * 그래서 해시까지 함수 안에서 비교한다.
 *
 * @returns {{ok: boolean, error?: string}}
 */
async function consumeCode(email, code) {
  const key = String(email).toLowerCase();
  const hash = hashCode(key, String(code || '').trim());

  if (attemptRpc) {
    const { data, error } = await supabase.rpc('auth_code_attempt', {
      p_email: key, p_hash: hash, p_max: MAX_ATTEMPTS
    });

    if (error && missingRpc(error.message)) {
      attemptRpc = false;
      console.warn('[auth] auth_code_attempt RPC 없음 — 예전 방식으로 계속합니다 '
        + '(supabase/2026-08-24-payment-pending-and-auth-attempts.sql 을 실행하세요). '
        + '이 상태에서는 동시 요청으로 시도 횟수 제한을 우회할 수 있습니다.');
    } else if (error) {
      /*
       * 판정할 수 없으면 통과시키지 않는다. 인증은 확실할 때만 연다.
       */
      console.error(`[auth] 코드 검증 실패(거절): ${error.message}`);
      return { ok: false, error: '인증을 처리하지 못했어요. 잠시 후 다시 시도해 주세요' };
    } else {
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return { ok: false, error: '인증을 처리하지 못했어요. 잠시 후 다시 시도해 주세요' };
      if (row.expired) return { ok: false, error: '코드가 만료되었습니다. 다시 요청해 주세요' };
      if (!row.allowed) return { ok: false, error: '시도 횟수를 초과했습니다. 코드를 다시 요청해 주세요' };
      if (!row.matched) return { ok: false, error: '코드가 일치하지 않습니다' };
      return { ok: true };
    }
  }

  /* ── 폴백: 마이그레이션 전 환경 ─────────────────────────────────── */
  const { data, error } = await supabase
    .from('auth_codes').select('code_hash, expires_at, attempts').eq('email', key).maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: '먼저 인증 코드를 요청해 주세요' };

  if (new Date(data.expires_at).getTime() < Date.now()) {
    await supabase.from('auth_codes').delete().eq('email', key);
    return { ok: false, error: '코드가 만료되었습니다. 다시 요청해 주세요' };
  }
  if ((data.attempts || 0) >= MAX_ATTEMPTS) {
    await supabase.from('auth_codes').delete().eq('email', key);
    return { ok: false, error: '시도 횟수를 초과했습니다. 코드를 다시 요청해 주세요' };
  }

  const given = Buffer.from(hash, 'utf8');
  const want  = Buffer.from(String(data.code_hash || ''), 'utf8');
  const match = given.length === want.length && crypto.timingSafeEqual(given, want);

  if (!match) {
    await supabase.from('auth_codes')
      .update({ attempts: (data.attempts || 0) + 1 }).eq('email', key);
    return { ok: false, error: '코드가 일치하지 않습니다' };
  }

  await supabase.from('auth_codes').delete().eq('email', key);
  return { ok: true };
}

module.exports = {
  issueToken, verifyToken, authorize, identify, requireAuth,
  createCode, consumeCode,
  TOKEN_TTL_MS, CODE_TTL_MS, MAX_ATTEMPTS
};
