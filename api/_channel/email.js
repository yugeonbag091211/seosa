'use strict';
/*
 * 이메일 채널 — Resend API
 * 나중에 kakao.js / push.js / discord.js 를 같은 인터페이스로 추가하면 됩니다.
 *
 * export: { send(payload) → Promise<{ok, error}> }
 * payload: { to, subject, product, analysis, alerts }
 */

const RESEND_KEY = process.env.RESEND_API_KEY || '';
const FROM       = process.env.RESEND_FROM    || 'SEOSA <alert@seosa.kr>';

function won(n) {
  return Number(n).toLocaleString('ko-KR');
}

function verdictColor(type) {
  if (type === 'target')  return '#0b7a4b';
  if (type === 'atl')     return '#0b7a4b';
  if (type === 'drop')    return '#1a6bb5';
  return '#555';
}

function verdictLabel(type) {
  if (type === 'target') return '🎯 목표가 달성';
  if (type === 'atl')    return '🏆 역대 최저가 갱신';
  if (type === 'drop')   return '📉 급격한 가격 하락';
  return '가격 알림';
}

function buildHtml(payload) {
  const { product, analysis, alerts } = payload;
  const primaryAlert = alerts[0];
  const color = verdictColor(primaryAlert.type);

  const alertBadges = alerts.map(a =>
    `<span style="display:inline-block;background:${verdictColor(a.type)};color:#fff;
      font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;margin:2px 4px 2px 0">
      ${verdictLabel(a.type)}
    </span>`
  ).join('');

  const avgRow = analysis.avg30 > 0
    ? `<tr><td style="padding:6px 0;color:#888;font-size:13px">30일 평균</td>
        <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600">${won(analysis.avg30)}원</td></tr>`
    : '';

  const diffRow = analysis.diffPct !== null
    ? `<tr><td style="padding:6px 0;color:#888;font-size:13px">평균 대비</td>
        <td style="padding:6px 0;text-align:right;font-size:13px;font-weight:700;color:${analysis.diffPct < 0 ? '#0b7a4b' : '#c9362b'}">
          ${analysis.diffPct < 0 ? '▼ ' : '▲ '}${Math.abs(analysis.diffPct).toFixed(1)}%
        </td></tr>`
    : '';

  const minRow = analysis.min30 > 0
    ? `<tr><td style="padding:6px 0;color:#888;font-size:13px">30일 최저</td>
        <td style="padding:6px 0;text-align:right;font-size:13px">${won(analysis.min30)}원</td></tr>`
    : '';

  const targetRow = primaryAlert.targetPrice > 0
    ? `<tr><td style="padding:6px 0;color:#888;font-size:13px">목표가</td>
        <td style="padding:6px 0;text-align:right;font-size:13px;color:#0b7a4b;font-weight:700">${won(primaryAlert.targetPrice)}원 ✓</td></tr>`
    : '';

  const timingBox = `
    <div style="background:#f8f8f7;border-left:3px solid ${color};padding:14px 18px;margin:24px 0;border-radius:0 8px 8px 0">
      <div style="font-size:11px;font-weight:700;color:#888;letter-spacing:.08em;margin-bottom:6px">SEOSA 구매 타이밍 분석</div>
      <div style="font-size:14px;line-height:1.7;color:#222">${analysis.timing}</div>
    </div>`;

  const imageBlock = product.image
    ? `<img src="${product.image}" alt="" style="width:100%;max-width:240px;height:180px;object-fit:contain;display:block;margin:0 auto 20px">`
    : '';

  return `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SEOSA 가격 알림</title></head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;padding:32px 0">
  <tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:560px;width:100%">

    <!-- 헤더 -->
    <tr><td style="background:#111;padding:24px 32px">
      <div style="font-size:20px;font-weight:800;letter-spacing:.12em;color:#fff">SEOSA</div>
      <div style="font-size:10px;color:#888;letter-spacing:.15em;margin-top:2px">PREMIUM CURATION</div>
    </td></tr>

    <!-- 알림 배지 -->
    <tr><td style="padding:24px 32px 8px">
      <div>${alertBadges}</div>
    </td></tr>

    <!-- 상품 -->
    <tr><td style="padding:8px 32px 24px">
      ${imageBlock}
      <div style="font-size:16px;font-weight:700;line-height:1.5;color:#111;margin-bottom:16px">${product.title}</div>
      <div style="font-size:32px;font-weight:800;color:${color};letter-spacing:-.02em">${won(product.currentPrice)}<span style="font-size:16px;font-weight:400;color:#888"> 원</span></div>
      <div style="font-size:12px;color:#888;margin-top:4px">${product.mall}</div>
    </td></tr>

    <!-- 통계 테이블 -->
    <tr><td style="padding:0 32px">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;border-bottom:1px solid #eee">
        <tbody>
          ${targetRow}${avgRow}${diffRow}${minRow}
        </tbody>
      </table>
    </td></tr>

    <!-- 타이밍 분석 -->
    <tr><td style="padding:0 32px">${timingBox}</td></tr>

    <!-- CTA -->
    <tr><td style="padding:8px 32px 32px;text-align:center">
      <a href="${product.link}" style="display:inline-block;background:#111;color:#fff;font-size:14px;font-weight:700;
        padding:14px 36px;border-radius:8px;text-decoration:none;letter-spacing:.04em">
        지금 최저가 구매 →
      </a>
      <div style="margin-top:12px;font-size:11px;color:#aaa">알림은 조건이 충족될 때 다시 발송됩니다.</div>
    </td></tr>

    <!-- 푸터 -->
    <tr><td style="background:#f8f8f7;padding:16px 32px;text-align:center">
      <div style="font-size:11px;color:#aaa">SEOSA · 최저가도 고급스럽게</div>
      <div style="font-size:11px;color:#ccc;margin-top:4px">본 메일은 가격 알림 신청 시 자동 발송됩니다.</div>
    </td></tr>

  </table>
  </td></tr>
</table>
</body></html>`;
}

async function send(payload) {
  if (!RESEND_KEY) return { ok: false, error: 'RESEND_API_KEY 없음' };

  const html = buildHtml(payload);
  const subject = payload.subject
    || `[SEOSA] ${payload.product.title.slice(0, 30)} 가격 알림`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_KEY },
      body: JSON.stringify({ from: FROM, to: [payload.to], subject, html })
    });
    const body = await res.json();
    if (!res.ok) return { ok: false, error: body.message || res.status };
    return { ok: true, id: body.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { send };
