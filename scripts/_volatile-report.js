'use strict';

/*
 * 점심·저녁 가격 재확인 운영 리포트. 기존 아침 수집 메일과 같은
 * PRICE_REPORT_EMAIL / Resend 발송 경로를 공유한다.
 * 이 모듈을 require해도 전송은 일어나지 않는다 (테스트 안전).
 */

const MALLS = ['쿠팡', 'ADPICK'];
const num = v => Math.max(0, Number(v) || 0);
const won = v => num(v).toLocaleString('ko-KR');
const esc = v => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function slotName(slot) {
  return slot === 'noon' ? '점심' : slot === 'evening' ? '저녁' : '추가';
}
function statusName(status) {
  return status === 'completed' ? '완료' : status === 'skipped' ? '건너뜀' : '실패';
}

function totals(results = {}) {
  const fields = ['candidates', 'groups', 'spent', 'checked', 'saved', 'observedDifferences',
    'changedApplied', 'suspect', 'rejected', 'optionMiss', 'cacheSkip', 'failed'];
  const sum = Object.fromEntries(fields.map(k => [k, 0]));
  for (const mall of MALLS) {
    for (const k of fields) sum[k] += num(results[mall]?.[k]);
  }
  return sum;
}
function subjectFor(report) {
  const prefix = `[SEOSA] ${report.day || '-'} ${slotName(report.slot)} 가격 재확인 ${statusName(report.status)}`;
  if (report.status !== 'completed') return prefix;
  const t = totals(report.results);
  return `${prefix} — 실제 가격 변경 ${t.changedApplied}건 / 확인 ${t.checked}건`;
}

function buildVolatileReportHtml(report) {
  const t = totals(report.results);
  const slot = slotName(report.slot);
  const state = statusName(report.status);
  const reason = report.reason
    ? `<div style="margin-top:16px;padding:12px 16px;border-radius:8px;background:#faf4ed;color:#68431c;font-size:13px">사유: ${esc(String(report.reason).slice(0, 600))}</div>`
    : '';

  const infoRows = [
    ['매칭되어 가격을 확인한 상품', won(t.checked)],
    ['실제로 현재 표시가가 변경된 상품', won(t.changedApplied)],
    ['기존 표시가와 다른 응답 (적용 전)', won(t.observedDifferences)],
    ['현재가 저장 성공 상품', won(t.saved)],
    ['이상 가격으로 현재가 반영 보류', won(t.suspect)],
    ['유효하지 않아 저장 거부', won(t.rejected)]
  ].map(([name, val]) => `<tr><td style="padding:9px 0;border-bottom:1px solid #eee;color:#666">${name}</td>
    <td style="text-align:right;padding:9px 0;border-bottom:1px solid #eee;font-weight:700">${val}</td></tr>`).join('');

  const mallRows = MALLS.map(mall => {
    const m = report.results?.[mall] || {};
    return `<tr>
      <td style="padding:10px 6px;border-bottom:1px solid #eee">${esc(mall)}</td>
      <td style="padding:10px 6px;border-bottom:1px solid #eee;text-align:right">${won(m.candidates)}</td>
      <td style="padding:10px 6px;border-bottom:1px solid #eee;text-align:right">${won(m.spent)}</td>
      <td style="padding:10px 6px;border-bottom:1px solid #eee;text-align:right">${won(m.checked)}</td>
      <td style="padding:10px 6px;border-bottom:1px solid #eee;text-align:right;font-weight:700">${won(m.changedApplied)}</td>
    </tr>`;
  }).join('');

  const diagnostics = MALLS.map(mall => {
    const m = report.results?.[mall] || {};
    return `<tr><td style="padding:8px 0;color:#666">${esc(mall)} — 옵션 불일치 / 캐시·호출 실패 / 기타 거부</td>
      <td style="padding:8px 0;text-align:right">${won(m.optionMiss)} / ${won(m.cacheSkip)} / ${won(m.failed)}</td></tr>`;
  }).join('');

  const apiUsage = MALLS.map(mall => {
    const m = report.results?.[mall] || {};
    const before = report.usage?.[mall];
    const cap = report.caps?.[mall];
    return `<tr><td style="padding:8px 0;color:#666">${esc(mall)} — 하루 수집 API 호출 (이번 실행 포함)</td>
      <td style="padding:8px 0;text-align:right">${before == null ? '확인 불가' : won(num(before) + num(m.spent))}
      ${cap == null ? '' : ' / ' + won(cap)}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SEOSA ${esc(slot)} 가격 재확인 리포트</title></head>
<body style="margin:0;background:#f5f5f4;padding:20px 8px;font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif">
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;width:100%;max-width:640px;background:white;border-radius:12px">
  <tr><td style="background:#111;padding:24px 28px;color:white">
    <div style="font-size:22px;font-weight:800;letter-spacing:.14em">SEOSA</div>
    <div style="margin-top:5px;font-size:12px;color:#ccc">INTRADAY PRICE RECHECK · ${esc(slot)}</div>
  </td></tr>
  <tr><td style="padding:26px 28px 12px">
    <div style="font-size:12px;color:#777">기준 날짜(KST)</div>
    <div style="font-size:26px;font-weight:800">${esc(report.day || '-')}</div>
    <div style="margin-top:6px;font-size:13px;color:#666">${esc(slot)} 가격 재확인 — ${esc(state)}</div>
    <div style="margin-top:4px;font-size:11px;color:#999">완료 시각(KST): ${esc(report.finishedAt || '-')}</div>
    ${reason}
  </td></tr>
  <tr><td style="padding:12px 28px"><div style="font-size:15px;font-weight:700;margin-bottom:8px">수집 결과</div>
    <table style="border-collapse:collapse;width:100%;font-size:13px">${infoRows}</table>
    <div style="font-size:11px;color:#888;margin-top:9px;line-height:1.6">
      확인한 상품은 공식 검색 응답에서 동일 상품·옵션이 매칭된 건수입니다.
      실제 가격 변경은 재확인 후 products 현재 표시가가 이전과 달라진 것으로 재조회된 건수입니다.
      저장 성공은 변경 여부와 관계없이 현재가로 반영한 상품 수입니다.
      기존 표시가 차이에는 최종 반영을 보류한 이상 가격도 포함될 수 있습니다.
    </div>
  </td></tr>
  <tr><td style="padding:12px 28px">
    <div style="font-size:15px;font-weight:700;margin-bottom:8px">판매처별 결과</div>
    <table style="border-collapse:collapse;width:100%;font-size:12px">
      <thead><tr style="color:#777;text-align:right;background:#f8f8f7">
      <th style="text-align:left;padding:8px 6px">판매처</th>
      <th style="padding:8px 6px">후보</th><th style="padding:8px 6px">API 호출</th>
      <th style="padding:8px 6px">확인</th><th style="padding:8px 6px">가격변경</th></tr></thead>
      <tbody>${mallRows}</tbody>
    </table>
  </td></tr>
  <tr><td style="padding:12px 28px">
    <div style="font-size:15px;font-weight:700;margin-bottom:8px">API 사용량 및 오류</div>
    <table style="border-collapse:collapse;width:100%;font-size:12px">${apiUsage}${diagnostics}</table>
    <div style="font-size:11px;color:#888;margin-top:8px">
      위 API 사용량은 수집기 source=collect 기준이며, 사이트 검색·AI 등 다른 경로의 호출은 포함하지 않습니다.
      시간대별 재확인 작업의 실제 발화 시각은 GitHub Actions 지연에 따라 달라질 수 있습니다.
    </div>
  </td></tr>
  <tr><td style="padding:18px 28px;background:#f8f8f7;color:#999;font-size:11px">
    SEOSA · 가격에도 서사가 있습니다. 이 메일은 점심/저녁 가격 재확인 작업 결과입니다.
    아침 정기 수집 리포트와는 별개로 발송됩니다.
  </td></tr>
</table></body></html>`;
}

/** 메일 실패로 가격 수집 결과를 덮어쓰지 않는다. */
async function sendVolatileReport(report, opts = {}) {
  const to = opts.to || process.env.PRICE_REPORT_EMAIL || 'yugeonbag091211@gmail.com';
  if (!opts.send && !process.env.RESEND_API_KEY) {
    console.warn('[adaptive-report] RESEND_API_KEY 없음 — 리포트를 발송하지 못했습니다.');
    return { ok: false, error: 'RESEND_API_KEY 없음' };
  }
  try {
    const send = opts.send || require('../api/_channel/email').send;
    const result = await send({ to, subject: subjectFor(report), html: buildVolatileReportHtml(report) });
    if (result.ok) {
      console.log(`[adaptive-report] ${slotName(report.slot)} 리포트 발송 완료 → ${to} (id=${result.id || '?'})`);
    } else console.error('[adaptive-report] 리포트 발송 실패:', result.error);
    return result;
  } catch (error) {
    console.error('[adaptive-report] 메일 전송 중 오류:', error.message);
    return { ok: false, error: error.message };
  }
}
module.exports = { totals, slotName, statusName, subjectFor, buildVolatileReportHtml, sendVolatileReport };
