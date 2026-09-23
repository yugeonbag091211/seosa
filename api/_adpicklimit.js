/*
 * ADPICK 호출 리미터 — 프로세스 안(실제 시작 시각 기준) + 프로세스 사이(DB 예약).
 *
 * ── 공식 한도 (ADPICK BIZ API 가이드, 2026-09-23 확인) ─────────────────
 *   상품 검색  /search      분당 10회 (API 키 기준)
 *   성과 조회  /conversion  분당 60회 (API 키 기준)
 *   공통       분당 60회 초과 시 403
 *   쇼핑메이트 핫딜 JSON API  1분 1회 이하 (api/_adpickhot.js 가 따로 지킨다)
 *
 * ── 왜 다시 만드는가 (2026-09-23 운영 실측) ─────────────────────────────
 *   ① 2026-09-01 이후 429 22건이 «전부» 직전 60초의 11·12번째 호출이었다.
 *      Vercel cron 이 매일 18:12Z 에 11~12회를 몰아 부르고, 09-23 01:50Z 에는
 *      수집기 5회 + external-hotdeal 6회가 합쳐 11회가 됐다. 일일 한도가 아니라
 *      «여러 경로의 분당 합» 이 원인이다. 리미터가 프로세스마다 따로라 합을 못 막는다.
 *   ② 예전 리미터는 «예약 시각» 으로 간격·창을 계산했고, DB 에는 sleep 뒤 «실제
 *      시작 시각» 을 적었다. 타이머가 몇 ms 늦으면 기록상 6회가 59.99초 안에
 *      들어갔다 (설정 5회/분). 여기서는 실제 시작 시각으로 계산하고 그 값을 그대로
 *      기록에 넘긴다 — 기록이 곧 증명이 된다.
 *
 * ── 보장 ───────────────────────────────────────────────────────────────
 *   프로세스 안: 기록된 시작 시각 기준으로
 *     · 연속 두 호출 간격 ≥ minGapMs
 *     · 임의의 연속 60초(양 끝 포함)에 maxPerMin 회 이하
 *   프로세스 사이: adpick_acquire(supabase/2026-09-23-adpick-rate-limiter.sql)가
 *     모든 경로의 예약을 한 줄로 세운다. 함수가 없으면(마이그레이션 전) 이 단계는
 *     건너뛰고 프로세스 안 보장만 남는다 — 그 사실을 한 번 경고한다.
 */
'use strict';

const realSleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

/**
 * 프로세스 안 리미터.
 * 호출은 체인 하나로 줄 서고, «앞 호출이 실제로 시작한 뒤» 에 다음 슬롯을 계산한다.
 */
function createLimiter(o) {
  const now = o.now || Date.now;
  const sleep = o.sleep || realSleep;
  const maxPerMin = Math.max(1, Math.floor(o.maxPerMin || 1));
  const defaultGap = Math.max(0, o.minGapMs || 0);
  /*
   * 프로세스 안에서는 여유가 필요 없다 — 실제 시작 시각으로 계산하고 그 값을
   * 기록하므로 기록 기준으로 정확하다. 여유는 네트워크 지연까지 덮고 싶을 때만 준다.
   */
  const marginMs = Math.max(0, o.marginMs || 0);
  /*
   * 전역 예약을 받은 호출이 이만큼 넘게 늦게 깨면 부르지 않는다. 전역 쪽 여유
   * (adpick_acquire 의 p_margin_ms, 기본 1초)의 절반 — 나머지 절반은 응답 왕복 몫이다.
   * 프로세스 안 여유(marginMs, 기본 0)와 섞으면 안 된다: 그걸 쓰면 1ms 만 늦어도 전부 건너뛴다.
   */
  const stallMs = Math.max(1, o.stallMs == null ? 500 : o.stallMs);
  const starts = [];
  let chain = Promise.resolve();
  let pendingSlot = 0;

  function earliest(t, gap) {
    while (starts.length > maxPerMin && starts[0] < t - 120000) starts.shift();
    let s = t;
    if (starts.length) s = Math.max(s, starts[starts.length - 1] + gap + marginMs);
    // 창 안(양 끝 포함)에 maxPerMin 개가 이미 있으면 그중 가장 이른 것이 60초 밖으로 나가야 한다.
    if (starts.length >= maxPerMin) s = Math.max(s, starts[starts.length - maxPerMin] + 60000 + marginMs + 1);
    return s;
  }

  /**
   * @param {object} a
   *   maxWaitMs   이 호출이 기다릴 수 있는 최대 시간 (0 = 즉시 아니면 거절)
   *   minGapMs    이 호출에 적용할 최소 간격 (없으면 인스턴스 기본값)
   *   global      ({notBeforeMs, maxWaitMs}) => {ok, waitMs, skipped, reason} — 프로세스 사이 예약
   *   isBlocked   () => string|'' — 서킷 차단 사유 (대기 중에 열리면 부르지 않는다)
   * @returns {{ok:true, startMs, waitMs} | {ok:false, reason, kind}}
   */
  function acquire(a = {}) {
    const gap = a.minGapMs == null ? defaultGap : Math.max(0, a.minGapMs);
    const entered = now();
    const deadline = entered + Math.max(0, a.maxWaitMs || 0);
    /*
     * 줄에 서기 전에 빨리 거절한다. 사용자 요청(maxWaitMs=0)이 앞 호출의
     * 12초 대기 뒤에 서서 기다리다 거절당하면 그 12초가 곧 응답 지연이다.
     */
    const est = Math.max(earliest(entered, gap), pendingSlot ? pendingSlot + gap + marginMs : 0);
    if (est > deadline) {
      return Promise.resolve(denyLocal(est - entered));
    }
    const p = chain.then(async () => {
      let t = now();
      let slot = earliest(t, gap);
      /*
       * 줄에 서 있던 사이 시계가 흘렀다. 지금 바로 부를 수 있으면(slot ≤ t) 허용한다 —
       * «entered + maxWaitMs» 와 비교하면 maxWaitMs=0 호출이 1ms 늦었다는 이유로
       * «0ms 대기 필요» 를 받고 거절된다 (test-adpick-observability 에서 간헐 재현).
       */
      if (slot > Math.max(deadline, t)) return denyLocal(slot - t);
      let usedGlobal = false;
      if (a.global) {
        const g = await a.global({ notBeforeMs: slot - t, maxWaitMs: deadline - t });
        const after = now();
        if (!g.ok) return { ok: false, kind: 'global', reason: g.reason || '전역 한도', waitMs: g.waitMs || 0 };
        if (!g.skipped) {
          usedGlobal = true;
          // 응답을 받은 시각을 기준으로 잡는다 — 실제보다 늦게 잡는 쪽이라 안전하다.
          slot = Math.max(slot, after + Math.max(0, g.waitMs || 0));
        }
        t = after;
      }
      pendingSlot = slot;
      try {
        while (now() < slot) await sleep(slot - now());
      } finally {
        pendingSlot = 0;
      }
      const blocked = a.isBlocked ? a.isBlocked() : '';
      const start = now();
      if (blocked) return { ok: false, kind: 'blocked', reason: `대기 중 차단됨: ${blocked}` };
      /*
       * 전역 예약을 받은 뒤 프로세스가 멈춰(이벤트 루프 정지 등) 한참 늦게 깨면
       * 다른 경로의 예약과 겹칠 수 있다. 여유(marginMs)를 넘겨 늦었으면 부르지 않는다.
       */
      if (usedGlobal && start - slot > stallMs) {
        return { ok: false, kind: 'stall', reason: `예약 시각보다 ${start - slot}ms 늦게 깼다 — 이번 호출은 건너뛴다` };
      }
      starts.push(start);
      return { ok: true, startMs: start, waitMs: start - entered };
    });
    chain = p.then(() => {}, () => {});
    return p;
  }

  function denyLocal(waitMs) {
    const windowFull = starts.length >= maxPerMin;
    return {
      ok: false, kind: windowFull ? 'window' : 'gap', waitMs,
      reason: windowFull
        ? `인스턴스 분당 한도 ${Math.min(starts.length, maxPerMin)}/${maxPerMin} — ${Math.round(waitMs)}ms 대기 필요`
        : `간격 제한 — ${Math.round(waitMs)}ms 대기 필요`
    };
  }

  return {
    acquire,
    /** 최근 60초(양 끝 포함) 안의 시작 수 — 로그용. */
    inWindow() { const t = now(); return starts.filter(s => s >= t - 60000).length; },
    starts,
    maxPerMin
  };
}

/**
 * 프로세스 사이 예약 (adpick_acquire RPC).
 *   함수가 없으면 skipped — 마이그레이션 전에도 수집·검색은 그대로 돈다.
 *   함수는 있는데 DB 가 답하지 못하면 «거절» — 전역 합을 확인할 수 없을 때 부르지 않는다.
 */
function createGlobalAcquire(o) {
  const isMissing = o.isMissingObject || (() => false);
  let missing = false;
  let warned = false;
  return async ({ notBeforeMs, maxWaitMs, source }) => {
    if (missing || o.disabled) return { ok: true, skipped: true };
    let res;
    let call;
    try {
      call = o.rpc('adpick_acquire', {
        p_bucket: o.bucket,
        p_max_per_min: o.maxPerMin,
        p_margin_ms: o.marginMs,
        p_not_before_ms: Math.max(0, Math.round(notBeforeMs || 0)),
        p_max_wait_ms: Math.max(0, Math.round(maxWaitMs || 0)),
        p_source: String(source || o.source || '').slice(0, 40)
      });
    } catch (e) {
      /*
       * rpc() 가 «요청을 보내기도 전에» 던졌다 — DB 설정이 없는 환경(단위 테스트·
       * 로컬 도구)이다. DB 가 답을 준 오류와 다르므로 리미터가 없는 것으로 본다.
       */
      missing = true;
      if (!warned) { warned = true; console.warn(`[adpick] 전역 리미터를 쓸 수 없는 환경 — 프로세스 안 한도만 적용: ${e.message}`); }
      return { ok: true, skipped: true };
    }
    try {
      res = await call;
    } catch (e) {
      res = { data: null, error: { message: e.message } };
      return { ok: false, reason: `전역 리미터 응답 실패 — 이번 호출은 건너뛴다: ${String(e.message).slice(0, 120)}` };
    }
    if (res.error) {
      const msg = String(res.error.message || res.error);
      if (isMissing(msg)) {
        missing = true;
        if (!warned) {
          warned = true;
          console.warn('[adpick] 전역 리미터 없음 — supabase/2026-09-23-adpick-rate-limiter.sql 을 적용하면'
            + ' 모든 경로의 분당 합이 묶인다. 지금은 프로세스 안 한도만 적용한다.');
        }
        return { ok: true, skipped: true };
      }
      return { ok: false, reason: `전역 리미터 응답 실패 — 이번 호출은 건너뛴다: ${msg.slice(0, 120)}` };
    }
    /*
     * 실제 함수는 테이블을 돌려주므로 data 는 언제나 배열이다. null 은 «이 클라이언트에
     * 그런 함수가 없다» (테스트 가짜·구형 클라이언트) — 없는 것으로 보고 건너뛴다.
     */
    if (res.data == null) { missing = true; return { ok: true, skipped: true }; }
    const row = Array.isArray(res.data) ? res.data[0] : res.data;
    if (!row) return { ok: false, reason: '전역 리미터 응답 없음' };
    if (!row.allowed) {
      return { ok: false, waitMs: Number(row.wait_ms) || 0,
        reason: `전역 분당 한도 ${row.used}/${o.maxPerMin} — ${row.wait_ms}ms 대기 필요` };
    }
    return { ok: true, waitMs: Number(row.wait_ms) || 0 };
  };
}

/**
 * 기록된 시작 시각 목록에서 «임의의 연속 60초(양 끝 포함)» 최대 호출 수와 최소 간격.
 * 운영 검증 스크립트와 테스트가 같은 정의를 쓴다.
 */
function rollingStats(timesMs) {
  const t = [...timesMs].sort((a, b) => a - b);
  let max = 0, j = 0, minGap = Infinity;
  for (let i = 0; i < t.length; i++) {
    while (t[i] - t[j] > 60000) j++;
    max = Math.max(max, i - j + 1);
    if (i) minGap = Math.min(minGap, t[i] - t[i - 1]);
  }
  return { count: t.length, maxIn60s: max, minGapMs: t.length > 1 ? minGap : null };
}

module.exports = { createLimiter, createGlobalAcquire, rollingStats };
