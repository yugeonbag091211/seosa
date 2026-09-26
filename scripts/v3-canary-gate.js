#!/usr/bin/env node
/*
 * V3 카나리 게이트 — daily-prices.yml 의 수집 단계 «앞» 에서 돈다. 읽기 전용.
 *
 *   node scripts/v3-canary-gate.js
 *
 * 결정(PRICE_COLLECTOR_V3=1 또는 0)은 $GITHUB_ENV 파일에 «직접» 한 줄 덧붙인다.
 * stdout 으로 넘기지 않는 이유: scripts/_env.js 가 환경변수 진단을 stdout 에 찍는다.
 * `>> "$GITHUB_ENV"` 로 받으면 그 줄들이 섞여 GitHub 가 형식 오류로 단계를 실패시키고,
 * 그러면 수집 단계가 통째로 건너뛰어진다. $GITHUB_ENV 가 없으면(로컬) stdout 에 낸다.
 *
 * 켜는 조건 (넷 다):
 *   0) 운영자 끄기 스위치(저장소 변수 PRICE_V3_OFF=1)가 없다 — 배포 없이 즉시 레거시로 돌린다
 *   1) 오늘(KST)이 PRICE_V3_CANARY_DATES(쉼표 구분 YYYY-MM-DD)에 들어 있거나,
 *      PRICE_V3_ON_FROM(YYYY-MM-DD) 이후다 — 둘 다 비면 레거시
 *   2) 오늘 V3 비활성화 표식(price_job_state.last_result.v3Kill)이 없다
 *      — 수집기가 429·차단·불변조건 위반·잠금 상실·저장 0행을 보면 남긴다
 *   3) 상태를 읽을 수 있다 — 못 읽으면 표식이 있는지 알 수 없으므로 끈다
 *
 * ★ ON_FROM 을 둔 근거 (2026-09-26 감사): 09-24 하루 카나리가 킬 0 · 429 0 · 중복 0 ·
 *   옵션 자기모순 0 · 잠금 상실 0 이었다. 리포트가 «미충족» 으로 찍은 추적옵션불일치 3건은
 *   셋 다 기록 시점에는 추적 옵션과 같았고 뒤에(09-24 ai · 09-25 cron/collect) 추적 옵션이
 *   바뀐 재등록 착시였다. 같은 날 레거시(09-26)는 ADPICK 을 실행당 8분만 받아 7,674개 중
 *   17.5% 만 시도했다. 자동 비활성화(2)는 그대로라 이상이 보이면 그날 남은 칸은 레거시다.
 *
 * ★ 이 스크립트는 절대 실패(exit≠0)하지 않는다. 실패하면 수집 단계가 통째로
 *   건너뛰어진다. 어떤 오류든 «레거시로 수집» 이 안전한 쪽이다.
 */
'use strict';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {{today:string, dates:string, from?:string, off?:string,
 *          state:object|null, stateError:string|null}} a
 * @returns {{on:boolean, reason:string}}
 */
function canaryDecision(a) {
  if (String(a.off || '').trim() === '1') return { on: false, reason: '운영자 끄기 스위치(PRICE_V3_OFF=1) — 레거시로 수집' };
  const dates = String(a.dates || '').split(',').map(s => s.trim()).filter(Boolean);
  const from = String(a.from || '').trim();
  // 형식이 틀린 from 은 무시한다(문자열 비교가 엉뚱한 날짜를 켜지 않게).
  const fromOk = DATE_RE.test(from) && DATE_RE.test(String(a.today || ''));
  const byDate = dates.includes(a.today);
  const byFrom = fromOk && a.today >= from;
  if (!byDate && !byFrom) {
    return { on: false, reason: `오늘(${a.today})은 V3 날짜가 아니다 [${dates.join(', ') || '없음'}${fromOk ? ` · ${from} 이후` : ''}]` };
  }
  if (a.stateError) return { on: false, reason: `상태를 읽지 못해 비활성화 표식을 확인할 수 없다 — 레거시로 수집: ${a.stateError}` };
  const kill = a.state && a.state.last_result && a.state.last_result.v3Kill;
  if (kill && kill.date === a.today) return { on: false, reason: `오늘 V3 가 비활성화됐다 (${kill.at}, ${kill.reason})` };
  return { on: true, reason: byDate ? `카나리 날짜 ${a.today} — V3 로 수집` : `${from} 부터 V3 — 오늘(${a.today}) V3 로 수집` };
}

async function main() {
  let decision;
  try {
    require('./_env');
    const { kstToday } = require('../api/_price');
    const today = kstToday();
    let state = null, stateError = null;
    try {
      const supabase = require('../api/_supabase');
      const { data, error } = await supabase.from('price_job_state')
        .select('job_date, last_result->v3Kill').eq('id', 1).maybeSingle();
      if (error) stateError = error.message;
      else state = data ? { job_date: data.job_date, last_result: { v3Kill: data.v3Kill } } : null;
    } catch (e) { stateError = e.message; }
    decision = canaryDecision({ today, dates: process.env.PRICE_V3_CANARY_DATES,
      from: process.env.PRICE_V3_ON_FROM, off: process.env.PRICE_V3_OFF, state, stateError });
  } catch (e) {
    decision = { on: false, reason: `게이트 오류 — 레거시로 수집: ${e.message}` };
  }
  console.log(`[V3 카나리 게이트] ${decision.on ? 'ON' : 'OFF'} — ${decision.reason}`);
  emit(decision.on);
}

/** GITHUB_ENV 파일에 한 줄 덧붙인다. 실패하면 아무것도 쓰지 않는다 = 기본 OFF(레거시). */
function emit(on) {
  const line = `PRICE_COLLECTOR_V3=${on ? '1' : '0'}\n`;
  const file = process.env.GITHUB_ENV;
  if (!file) { process.stdout.write(line); return; }
  try { require('fs').appendFileSync(file, line); }
  catch (e) { console.log(`[V3 카나리 게이트] GITHUB_ENV 에 쓰지 못함 — 레거시로 수집: ${e.message}`); }
}

module.exports = { canaryDecision };

if (require.main === module) {
  main().then(() => process.exit(0), () => { emit(false); process.exit(0); });
}
