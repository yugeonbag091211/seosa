const { readBody, applyCors, readEmail, noStore } = require('./_http');
const { guard } = require('./_ratelimit');
const { createCode, consumeCode, issueToken, TOKEN_TTL_MS, CODE_TTL_MS } = require('./_auth');
const notify = require('./_notify');
// 표가 «없을» 때만 마이그레이션 안내를 한다. DB 일시 장애에 "테이블이 없습니다" 를 말하지 않는다.
const { isMissingObject } = require('./_dberror');

/*
 * 이메일 인증 코드 발급 / 확인.
 *
 *   POST /api/auth  { email, ageConfirmed: true }  → 코드 메일 발송
 *   POST /api/auth  { email, code }                → { token, email, expiresAt }
 *   POST /api/account/delete                       → 계정 삭제 (api/_account.js)
 *
 * 발급된 토큰은 /api/sync, /api/profile, /api/alerts 에
 * Authorization: Bearer <token> 으로 넣어 쓴다.
 *
 * ── 만 14세 미만 (2026-10-11) ──────────────────────────────────────
 *
 *   SEOSA 는 법정대리인 동의 절차를 두지 않는다. 그래서 만 14세 미만은 로그인(계정)을
 *   쓸 수 없게 한다. 이메일을 받는 기능(가격 알림·동기화·프로필·결제·계정 삭제)은
 *   전부 여기서 발급한 토큰을 요구하므로, 코드 발급 한 곳에서 막으면 계정과 그에
 *   딸린 개인정보 처리가 모두 막힌다. 로그인 없는 검색·가격 확인은 건드리지 않는다.
 *
 *   ageConfirmed 는 정확히 true 여야 한다("true"·1 은 거절). 확인이 없으면 인증 코드를
 *   만들지도(auth_codes 에 이메일이 남지 않는다), 메일을 보내지도 않는다.
 *   2단계(코드 확인)는 1단계에서 발급한 코드가 있어야만 통과하므로 따로 묻지 않는다.
 */

const AGE_REQUIRED_MESSAGE = '만 14세 이상만 로그인할 수 있어요. 만 14세 이상인지 확인해 주세요.';

const MIN_MINUTES = Math.round(CODE_TTL_MS / 60000);

function codeEmailText(code) {
  return {
    subject: `[SEOSA] 인증 코드 ${code}`,
    // _channel/email.js 는 가격 알림 서식이라 그대로 쓰기 어렵다.
    // 인증 메일은 본문이 짧아 별도 HTML 을 넘긴다.
    html: `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:32px 0;background:#f5f5f4;font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
  <table width="440" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;max-width:440px;width:100%;overflow:hidden">
    <tr><td style="background:#111;padding:20px 28px">
      <div style="font-size:18px;font-weight:800;letter-spacing:.12em;color:#fff">SEOSA</div>
    </td></tr>
    <tr><td style="padding:28px">
      <div style="font-size:15px;color:#222;line-height:1.7">
        찜 목록·취향·가격 알림을 이 이메일로 불러오려면 아래 코드를 입력해 주세요.
      </div>
      <div style="margin:24px 0;text-align:center">
        <span style="display:inline-block;font-family:'IBM Plex Mono',monospace;font-size:34px;
          font-weight:700;letter-spacing:.22em;color:#111;background:#f5f5f4;
          padding:16px 24px;border-radius:10px">${code}</span>
      </div>
      <div style="font-size:12px;color:#888;line-height:1.7">
        유효 시간 ${MIN_MINUTES}분. 본인이 요청하지 않았다면 이 메일은 무시하셔도 됩니다.<br>
        SEOSA는 이 코드를 절대 먼저 묻지 않습니다.
      </div>
    </td></tr>
    <tr><td style="background:#f8f8f7;padding:14px 28px;text-align:center">
      <div style="font-size:11px;color:#aaa">SEOSA · 최저가도 고급스럽게</div>
    </td></tr>
  </table>
</td></tr></table></body></html>`
  };
}

module.exports = async function handler(req, res) {
  if (!applyCors(req, res, 'private')) return;
  noStore(res);

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원' });

  /*
   * 계정 삭제 — POST /api/account/delete (vercel.json rewrite → ?action=delete-account).
   * 새 함수를 만들 수 없어(Vercel Hobby 12개 상한) 인증과 같은 함수에 둔다.
   * 신원·삭제 범위·레이트리밋은 전부 api/_account.js 가 따로 정한다 —
   * 아래 코드 발급 흐름(이메일 입력·auth 한도)과는 아무것도 공유하지 않는다.
   */
  if (String((req.query && req.query.action) || '') === 'delete-account') {
    return require('./_account').deleteAccountHandler(req, res);
  }

  // 메일 발송 비용과 스팸을 막는다. 코드 확인은 조금 더 넉넉히 잡는다.
  if (!guard(req, res, { name: 'auth', limit: 12, windowMs: 10 * 60 * 1000 })) return;

  const body = readBody(req);
  const email = readEmail(body.email);
  if (!email) return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다' });

  const code = String(body.code || '').trim();

  try {
    /* ── 2단계: 코드 확인 → 토큰 발급 ───────────────────────────── */
    if (code) {
      const r = await consumeCode(email, code);
      if (!r.ok) {
        // 테이블이 없으면 원인을 알 수 있게 안내한다.
        if (isMissingObject(r.error || '')) {
          return res.status(500).json({
            error: 'auth_codes 테이블이 없습니다. supabase/2026-08-hardening.sql을 Supabase SQL Editor에서 실행하세요.'
          });
        }
        return res.status(400).json({ error: r.error });
      }
      return res.json({
        token: issueToken(email),
        email,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString()
      });
    }

    /* ── 1단계: 코드 발급 → 메일 발송 ───────────────────────────── */
    if (body.ageConfirmed !== true) {
      return res.status(400).json({ error: AGE_REQUIRED_MESSAGE, needsAgeConfirm: true });
    }

    if (!process.env.RESEND_API_KEY) {
      // 여기서 조용히 성공하면 사용자는 오지 않을 메일을 기다린다.
      console.error('[auth] RESEND_API_KEY 미설정 — 인증 코드를 보낼 수 없습니다.');
      return res.status(503).json({
        error: '지금은 인증 메일을 보낼 수 없어요. 잠시 후 다시 시도해 주세요.'
      });
    }

    const made = await createCode(email);
    if (!made.ok) {
      if (isMissingObject(made.error || '')) {
        return res.status(500).json({
          error: 'auth_codes 테이블이 없습니다. supabase/2026-08-hardening.sql을 Supabase SQL Editor에서 실행하세요.'
        });
      }
      if (made.retryAfter) {
        res.setHeader('Retry-After', String(made.retryAfter));
        return res.status(429).json({ error: made.error });
      }
      return res.status(500).json({ error: made.error });
    }

    const mail = codeEmailText(made.code);
    const sent = await notify.send('email', { to: email, subject: mail.subject, html: mail.html });
    if (!sent.ok) {
      console.error('[auth] 코드 메일 발송 실패:', sent.error);
      return res.status(502).json({ error: '인증 메일을 보내지 못했어요. 잠시 후 다시 시도해 주세요.' });
    }

    // 코드 자체는 절대 응답에 담지 않는다.
    return res.json({ sent: true, expiresInSec: Math.round(CODE_TTL_MS / 1000) });
  } catch (e) {
    console.error('[auth]', e.message);
    res.status(500).json({ error: e.message });
  }
};
