const { AsyncLocalStorage } = require('async_hooks');

let client = null;
const aiReadOnlyContext = new AsyncLocalStorage();
const WRITE_METHODS = new Set(['insert', 'upsert', 'update', 'delete']);

/*
 * Trust only Vercel's server-side deployment environment. Request headers are
 * never consulted, so a caller cannot disable Preview's AI read-only scope.
 */
function isPreviewDeployment() {
  return String(process.env.VERCEL_ENV || '').trim().toLowerCase() === 'preview';
}

function isAiReadOnly() {
  return isPreviewDeployment() && !!aiReadOnlyContext.getStore();
}

function readOnlyMetrics() {
  const state = aiReadOnlyContext.getStore();
  return state ? { writeAttempts: state.writeAttempts, rpcBlocked: state.rpcBlocked } : null;
}

function blockAiReadOnlyRpc() {
  if (!isAiReadOnly()) return false;
  const state = aiReadOnlyContext.getStore();
  state.rpcBlocked++;
  return true;
}

function runAiReadOnly(task) {
  if (!isPreviewDeployment()) return task();
  const state = { writeAttempts: 0, rpcBlocked: 0 };
  return aiReadOnlyContext.run(state, async () => {
    try {
      return await task();
    } finally {
      console.info(`[ai:preview-db] writes_blocked=${state.writeAttempts} rpc_blocked=${state.rpcBlocked}`);
    }
  });
}

function guardQuery(query, wrapped = new WeakMap()) {
  if (!query || (typeof query !== 'object' && typeof query !== 'function')) return query;
  if (wrapped.has(query)) return wrapped.get(query);
  let proxy;
  proxy = new Proxy(query, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (WRITE_METHODS.has(prop)) {
        return (...args) => {
          const state = aiReadOnlyContext.getStore();
          if (isAiReadOnly()) {
            state.writeAttempts++;
            throw new Error(`AI Preview database write blocked (${String(prop)})`);
          }
          return guardQuery(value.apply(target, args), wrapped);
        };
      }
      if (prop === 'then') return value.bind(target);
      return (...args) => {
        const result = value.apply(target, args);
        return result === target ? proxy : guardQuery(result, wrapped);
      };
    }
  });
  wrapped.set(query, proxy);
  return proxy;
}

function getClient() {
  if (client) return client;

  const missing = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'].filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Supabase 환경변수 누락: ${missing.join(', ')}. ` +
      'Vercel > Settings > Environment Variables에 추가한 뒤 재배포하세요.'
    );
  }

  const { createClient } = require('@supabase/supabase-js');
  client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return client;
}

// 클라이언트를 모듈 로드 시점이 아니라 첫 사용 시점에 만든다.
// 로드 중에 throw하면 핸들러의 try/catch를 우회하기 때문에 Vercel이
// 원인을 알 수 없는 FUNCTION_INVOCATION_FAILED로 처리해버린다.
module.exports = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'then') return undefined;   // await 시 thenable로 오인되는 것 방지
    if (prop === 'isPreviewDeployment') return isPreviewDeployment;
    if (prop === 'isAiReadOnly') return isAiReadOnly;
    if (prop === 'readOnlyMetrics') return readOnlyMetrics;
    if (prop === 'blockAiReadOnlyRpc') return blockAiReadOnlyRpc;
    if (prop === 'runAiReadOnly') return runAiReadOnly;
    const c = getClient();
    if (prop === 'from') {
      return (...args) => {
        const query = c.from(...args);
        return isAiReadOnly() ? guardQuery(query) : query;
      };
    }
    if (prop === 'rpc') {
      return (...args) => {
        if (blockAiReadOnlyRpc()) throw new Error('AI Preview database RPC blocked');
        return c.rpc(...args);
      };
    }
    const value = c[prop];
    return typeof value === 'function' ? value.bind(c) : value;
  }
});
