/*
 * 오류 보고 — Sentry 최소 구현.
 *
 * ── 왜 SDK 를 쓰지 않는가 ─────────────────────────────────────────
 *
 * 이 프로젝트의 런타임 의존성은 두 개(@supabase/supabase-js, dotenv)뿐이다.
 * @sentry/node 는 서버리스 콜드스타트에 얹히는 무게가 있고, 우리가 필요한
 * 것은 "잡히지 않은 예외 하나를 보낸다" 뿐이다. Sentry 의 envelope 엔드포인트는
 * HTTP POST 한 번이라 fetch 로 충분하다. 나중에 트레이싱·세션·릴리스 추적이
 * 필요해지면 그때 SDK 로 갈아탄다 — 지금은 필요 없다.
 *
 * ── 절대 지키는 것 ────────────────────────────────────────────────
 *
 *   · DSN 이 없으면 아무 일도 하지 않는다 (로컬·CI 에서 조용하다)
 *   · 여기서 절대 throw 하지 않는다. 오류 보고가 요청을 죽이면 본말전도다
 *   · 응답을 지연시키지 않는다 — 짧은 타임아웃을 둔다
 *   · 비밀값을 싣지 않는다. DSN 도, 환경변수도, 요청 본문도 보내지 않는다
 *
 * ── 환경변수 ─────────────────────────────────────────────────────
 *
 *   SENTRY_DSN          없으면 비활성. 코드에 하드코딩하지 않는다
 *   SENTRY_ENVIRONMENT  기본 'production' (Vercel 은 VERCEL_ENV 를 준다)
 *
 * ── 동작 확인 ────────────────────────────────────────────────────
 *
 *   node scripts/test-sentry.js          DSN 이 있으면 실제로 한 건 보낸다
 */
'use strict';

const SEND_TIMEOUT_MS = 2000;

/** DSN 파싱. 형식: https://<publicKey>@<host>/<projectId> */
function parseDsn(dsn) {
  const m = String(dsn || '').match(/^https:\/\/([^@]+)@([^/]+)\/(.+)$/);
  if (!m) return null;
  return { key: m[1], host: m[2], projectId: m[3] };
}

function enabled() {
  return !!parseDsn(process.env.SENTRY_DSN);
}

/**
 * 예외 한 건을 보고한다.
 *
 * @param {Error|string} err
 * @param {object} ctx  안전한 맥락만. { where, route, status, extra:{...} }
 *                      ★ 요청 본문·헤더·이메일·키를 넣지 말 것.
 * @returns {Promise<{sent:boolean, reason?:string}>} 절대 reject 하지 않는다.
 */
async function captureException(err, ctx = {}) {
  const dsn = parseDsn(process.env.SENTRY_DSN);
  if (!dsn) return { sent: false, reason: 'no-dsn' };

  try {
    const e = err instanceof Error ? err : new Error(String(err));
    const eventId = randomHex32();
    const now = new Date().toISOString();

    const event = {
      event_id: eventId,
      timestamp: now,
      platform: 'node',
      level: 'error',
      logger: String(ctx.where || 'seosa'),
      environment: process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV || 'production',
      server_name: undefined,           // 호스트명을 보내지 않는다
      exception: {
        values: [{
          type: e.name || 'Error',
          value: String(e.message || '').slice(0, 1000),
          stacktrace: { frames: parseStack(e.stack) }
        }]
      },
      tags: {
        where: String(ctx.where || 'unknown'),
        route: String(ctx.route || ''),
        runtime: process.env.GITHUB_ACTIONS ? 'github-actions' : 'vercel'
      },
      extra: safeExtra(ctx.extra)
    };

    const envelope =
      JSON.stringify({ event_id: eventId, sent_at: now }) + '\n' +
      JSON.stringify({ type: 'event' }) + '\n' +
      JSON.stringify(event) + '\n';

    const url = `https://${dsn.host}/api/${dsn.projectId}/envelope/`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=seosa/1.0`
        },
        body: envelope,
        signal: ctl.signal
      });
      return r.ok ? { sent: true, eventId } : { sent: false, reason: `http ${r.status}` };
    } finally {
      clearTimeout(t);
    }
  } catch (sendErr) {
    // 보고가 실패해도 호출부는 아무 영향을 받지 않는다.
    console.warn(`[errors] 보고 실패(무시): ${sendErr.message}`);
    return { sent: false, reason: sendErr.message };
  }
}

/** 스택을 Sentry 프레임으로. 경로는 파일명만 남긴다(절대경로를 보내지 않는다). */
function parseStack(stack) {
  const lines = String(stack || '').split('\n').slice(1, 31);
  const frames = [];
  for (const line of lines) {
    const m = line.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
    if (!m) continue;
    frames.push({
      function: m[1] || '?',
      filename: String(m[2]).split(/[\\/]/).slice(-2).join('/'),
      lineno: Number(m[3]),
      colno: Number(m[4])
    });
  }
  return frames.reverse();   // Sentry 는 가장 최근 프레임이 마지막이다
}

/** extra 는 문자열·숫자·불리언만 통과시킨다. 객체를 통째로 실어 비밀값이 새지 않게. */
function safeExtra(extra) {
  const out = {};
  if (!extra || typeof extra !== 'object') return out;
  for (const [k, v] of Object.entries(extra)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = typeof v === 'string' ? v.slice(0, 500) : v;
    }
  }
  return out;
}

function randomHex32() {
  return require('crypto').randomBytes(16).toString('hex');
}

module.exports = { captureException, enabled, parseDsn, parseStack, safeExtra };
