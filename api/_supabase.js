const { createClient } = require('@supabase/supabase-js');

let client = null;

function getClient() {
  if (client) return client;

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

// 클라이언트를 모듈 로드 시점이 아니라 첫 사용 시점에 만든다.
// 로드 중에 throw하면 핸들러의 try/catch를 우회하기 때문에 Vercel이
// 원인을 알 수 없는 FUNCTION_INVOCATION_FAILED로 처리해버린다.
module.exports = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'then') return undefined;   // await 시 thenable로 오인되는 것 방지
    const c = getClient();
    const value = c[prop];
    return typeof value === 'function' ? value.bind(c) : value;
  }
});
