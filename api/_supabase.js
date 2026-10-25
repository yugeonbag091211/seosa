const { createClient } = require('@supabase/supabase-js');

let client = null;

function getClient() {
  if (client) return client;

  /*
   * Neon 전환 스위치 (docs/migration/neon-cutover-env.md).
   *   SEOSA_DB_BACKEND=neon + SEOSA_NEON_EXPERIMENTAL=1 일 때만 Neon 호환 계층(_neonpg)을 쓴다.
   *   Vercel Production 은 SEOSA_NEON_PRODUCTION_APPROVED=1 까지 있어야 한다 — 실수로 Preview 값이
   *   Production 에 복사돼도 전환되지 않게.
   *   셋 다 없으면 지금까지와 똑같이 Supabase 를 쓴다(기본값).
   */
  if (process.env.SEOSA_DB_BACKEND === 'neon') {
    if (process.env.SEOSA_NEON_EXPERIMENTAL !== '1') {
      throw new Error('Neon 환경변수 누락: SEOSA_NEON_EXPERIMENTAL=1 이 필요합니다.');
    }
    if (process.env.VERCEL_ENV === 'production' && process.env.SEOSA_NEON_PRODUCTION_APPROVED !== '1') {
      throw new Error('Neon 환경변수 누락: Production 전환은 SEOSA_NEON_PRODUCTION_APPROVED=1 이 필요합니다.');
    }
    client = require('./_neonpg').client;
    return client;
  }

  const missing = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'].filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Supabase 환경변수 누락: ${missing.join(', ')}. ` +
      'Vercel > Settings > Environment Variables에 추가한 뒤 재배포하세요.'
    );
  }

  client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return client;
}

/*
 * 읽기 전용 모드 — 격리 검증 환경 (docs/ai-verification-preview.md, 2026-10-23 감사 CO-10).
 *
 * ── 왜 생겼나 ──────────────────────────────────────────────────────
 *
 * Preview 에서 실제 AI·실제 검색을 한 번 돌리면 api/ai.js searchProducts 가 _shop.saveProducts 를
 * 불러 products·price_history 에 쓴다. Preview 와 Production 이 같은 DB 변수를 쓰는 동안에는
 * 그 한 번이 운영 원장에 들어간다. 그래서 Codex 감사는 실호출 검증 자체를 중단했다.
 *
 * ── 무엇을 하나 ────────────────────────────────────────────────────
 *
 * SEOSA_DB_READONLY=1 이면 이 모듈이 내보내는 클라이언트의 쓰기 길을 모두 막는다. 막는 곳이
 * 한 군데라 «어느 호출 경로가 쓰는지» 를 일일이 찾지 않아도 된다(그게 이 가드의 요점이다).
 *
 *   insert · upsert · update · delete   → 즉시 예외 (DbReadOnlyError)
 *   rpc                                 → 기본 차단. 읽기 전용 함수만 SEOSA_DB_READONLY_RPC 로 허용
 *   select · 그 밖의 읽기               → 그대로 통과
 *
 * ★ 쓰기를 «조용히 넘기지» 않는다. 저장된 척하면 검증 결과를 잘못 읽는다. 호출한 쪽이 삼키면
 *   blockedWrites 가 올라가므로 scripts/verify-ai-readonly.js 가 그 수를 센다.
 * ★ Production 에서는 켜지지 않는다 — 운영 쓰기를 막으면 수집·결제가 멈춘다. 실수로 Preview 값이
 *   Production 에 복사되는 경로를 Neon 스위치와 같은 방식으로 막는다.
 */
const WRITE_METHODS = ['insert', 'upsert', 'update', 'delete'];
const guard = { blockedWrites: 0, blockedRpc: 0, allowedRpc: 0 };

function readOnly() {
  if (process.env.SEOSA_DB_READONLY !== '1') return false;
  if (process.env.VERCEL_ENV === 'production') {
    throw new Error('SEOSA_DB_READONLY=1 은 Production 에서 쓸 수 없습니다 (운영 쓰기가 멈춥니다). '
      + 'Preview·로컬 검증 배포에만 설정하세요.');
  }
  return true;
}

function readOnlyRpcAllowed() {
  return new Set(String(process.env.SEOSA_DB_READONLY_RPC || '').split(',').map(s => s.trim()).filter(Boolean));
}

class DbReadOnlyError extends Error {
  constructor(what) {
    super(`읽기 전용 검증 환경입니다 — DB 쓰기를 막았습니다: ${what} (SEOSA_DB_READONLY=1)`);
    this.name = 'DbReadOnlyError';
    this.readOnlyBlocked = true;
  }
}

/** 질의 빌더의 쓰기 메서드만 막는다. 체이닝(select().eq()…)은 그대로 둔다. */
function guardBuilder(builder, table) {
  if (!builder || typeof builder !== 'object') return builder;
  return new Proxy(builder, {
    get(target, prop) {
      const value = target[prop];
      if (typeof prop === 'string' && WRITE_METHODS.includes(prop)) {
        return () => { guard.blockedWrites++; throw new DbReadOnlyError(`${table}.${prop}`); };
      }
      if (typeof value !== 'function') return value;
      return (...args) => {
        const out = value.apply(target, args);
        // 빌더는 자기 자신을 돌려준다 — 되돌려받은 것도 같은 가드로 싼다.
        return out === target || (out && typeof out === 'object' && typeof out.select === 'function')
          ? guardBuilder(out, table) : out;
      };
    }
  });
}

function guardClient(c) {
  const allowed = readOnlyRpcAllowed();
  return new Proxy(c, {
    get(target, prop) {
      if (prop === 'from') return table => guardBuilder(target.from(table), String(table));
      if (prop === 'rpc') {
        return (name, ...rest) => {
          if (!allowed.has(String(name))) {
            guard.blockedRpc++;
            throw new DbReadOnlyError(`rpc ${name} (읽기 전용 함수라면 SEOSA_DB_READONLY_RPC 에 추가)`);
          }
          guard.allowedRpc++;
          return target.rpc(name, ...rest);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

let guardedClient = null;
function guarded() {
  if (!guardedClient) guardedClient = guardClient(getClient());
  return guardedClient;
}

// 클라이언트를 모듈 로드 시점이 아니라 첫 사용 시점에 만든다.
// 로드 중에 throw하면 핸들러의 try/catch를 우회하기 때문에 Vercel이
// 원인을 알 수 없는 FUNCTION_INVOCATION_FAILED로 처리해버린다.
module.exports = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'then') return undefined;   // await 시 thenable로 오인되는 것 방지
    // 검증용 계측 — 막힌 쓰기 수 (scripts/verify-ai-readonly.js). DB 연결 없이도 읽을 수 있다.
    if (prop === '__readOnlyGuard') return { enabled: process.env.SEOSA_DB_READONLY === '1', ...guard };
    const c = readOnly() ? guarded() : getClient();
    const value = c[prop];
    return typeof value === 'function' ? value.bind(c) : value;
  }
});
