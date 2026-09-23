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
 * 켜는 조건 (셋 다):
 *   1) 오늘(KST)이 PRICE_V3_CANARY_DATES(쉼표 구분 YYYY-MM-DD)에 들어 있다
 *      — 날짜가 지나면 저절로 레거시로 돌아간다
 *   2) 오늘 V3 비활성화 표식(price_job_state.last_result.v3Kill)이 없다
 *      — 수집기가 429·차단·불변조건 위반·잠금 상실·저장 0행을 보면 남긴다
 *   3) 상태를 읽을 수 있다 — 못 읽으면 표식이 있는지 알 수 없으므로 끈다
 *
 * ★ 이 스크립트는 절대 실패(exit≠0)하지 않는다. 실패하면 수집 단계가 통째로
 *   건너뛰어진다. 어떤 오류든 «레거시로 수집» 이 안전한 쪽이다.
 */
'use strict';

/**
 * @param {{today:string, dates:string, state:object|null, stateError:string|null}} a
 * @returns {{on:boolean, reason:string}}
 */
function canaryDecision(a) {
  const dates = String(a.dates || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!dates.includes(a.today)) return { on: false, reason: `오늘(${a.today})은 카나리 날짜가 아니다 [${dates.join(', ') || '없음'}]` };
  if (a.stateError) return { on: false, reason: `상태를 읽지 못해 비활성화 표식을 확인할 수 없다 — 레거시로 수집: ${a.stateError}` };
  const kill = a.state && a.state.last_result && a.state.last_result.v3Kill;
  if (kill && kill.date === a.today) return { on: false, reason: `오늘 V3 가 비활성화됐다 (${kill.at}, ${kill.reason})` };
  return { on: true, reason: `카나리 날짜 ${a.today} — V3 로 수집` };
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
    decision = canaryDecision({ today, dates: process.env.PRICE_V3_CANARY_DATES, state, stateError });
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
