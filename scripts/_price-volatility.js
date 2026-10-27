'use strict';

/*
 * 점심·저녁 가격 재확인의 «시간대 판정 · 슬롯 원장 · 상태» 를 담는 순수 모듈.
 * DB 도 네트워크도 건드리지 않는다 (scripts/test-price-volatility.js 가 고정한다).
 *
 * ── 왜 이 파일이 커졌는가 (2026-10-27 장애) ─────────────────────────
 *
 * 2026-10-26, 점심(12:05)·저녁(19:05) 재확인이 둘 다 가격을 한 건도
 * 기록하지 못했는데 GitHub 은 두 번 다 SUCCESS 를 찍었다. 실측:
 *
 *   점심 run 40294712378  예약 03:05Z → 생성 08:47:21Z  (+5시간 42분)
 *   저녁 run 40361090304  예약 10:05Z → 생성 16:38:42Z  (+6시간 33분)
 *
 * createdAt 과 startedAt 이 같다 — 러너 대기가 아니라 GitHub 이 schedule
 * 이벤트를 «만들어 주지 않은» 시간이다. 두 실행 모두 19초 만에 끝났고 로그는
 * "[adaptive] 점심/저녁 수집 시간대 밖 — 외부 호출 0" 한 줄이었다. 즉 코드는
 * 설계대로 동작했다. 설계가 트리거를 과신했다.
 *
 * ── GitHub schedule 은 이 저장소에서 2~6시간 밀린다 (실측) ───────────
 *
 * daily-prices.yml 은 30분마다 칸을 깔아 하루 48칸이다. 그런데 실제로 발화한
 * 실행은 하루 17~23회뿐이고, KST 시간대별 분포가 극단적으로 갈린다
 * (291개 실행 / 14일, gh run list 로 측정):
 *
 *   KST 01~08 (UTC 16~23)  →  하루 칸 대비 약 91% 발화. 100% 의 날 커버
 *   KST 09~24 (UTC 00~15)  →  약 17% 발화
 *
 * 같은 측정에서 «하루에 한 번이라도 그 창 안에 실행이 있었는가» 는:
 *
 *   KST 12:00~15:00 (점심 창)   13/14일  93%
 *   KST 19:00~22:00 (저녁 창)    4/14일  29%   ← 여기가 구멍이다
 *   KST 18:00~22:00             13/14일  93%
 *   KST 00:00~08:00             14/14일 100%
 *
 * 그래서 이 파일은 «칸을 더 깐다» 로 끝내지 않는다.
 *   · GitHub 칸은 창 안에 촘촘히 깔아 점심 93% 를 확보한다 (백업 경로)
 *   · 저녁은 GitHub 로 29% 밖에 안 되므로 Vercel Cron → workflow_dispatch
 *     라는 «다른 스케줄러» 를 1차 경로로 둔다 (api/cron.js)
 *   · 두 경로가 겹쳐도 같은 (KST 날짜, 슬롯) 은 한 번만 수집한다 — 슬롯 원장
 *   · 어느 경로도 발화하지 않은 날은 조용히 넘어가지 않고 MISSED 로 남긴다
 *
 * ── 늦게 실행하는 것은 해결이 아니다 ────────────────────────────────
 *
 * 창을 없애면 점심 재확인이 저녁 6시에, 저녁 재확인이 다음 날 새벽 1시에
 * 돌아간다. 그건 «점심·저녁 가격» 이 아니다. 창은 그대로 두고, 창을 놓친
 * 날은 MISSED 로 보고한다.
 */

// 가격 이력의 동일 판매 단위(product_id + mall + vendor_item_id)별 변동 횟수.
const keyOf = r => [r.product_id, r.mall, r.vendor_item_id || ''].join('|');

/** 운영 상태. GitHub Summary·이메일·종료코드가 모두 이 값을 쓴다. */
const STATUS = {
  COMPLETED: 'COMPLETED',               // 실제로 가격을 확인하고 변경을 반영했다
  NO_CHANGE: 'NO_CHANGE',               // 확인은 했고 바뀐 가격이 없었다
  SKIPPED: 'SKIPPED',                   // 정상적인 조건으로 건너뜀 (중복·대상없음·스위치)
  MISSED: 'MISSED',                     // 예약 시각이 지나 실행 기회를 잃었다
  LOCKED: 'LOCKED',                     // 기존 수집기와 잠금 충돌
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',   // 하루 API 예산 소진
  FAILED: 'FAILED'                      // 실행 실패
};

/*
 * 슬롯 정의. target 은 «목표 시작 시각», window 는 «그 시각의 재확인으로
 * 인정할 수 있는 범위» 다. 창 밖이면 수집하지 않는다.
 *
 * minChanges — 점심은 지난 30일 3회 이상 변동한 옵션만, 저녁은 1회 이상.
 *   점심 창은 쿠팡 아침 수집이 끝난 직후라 후보가 넘치고, 저녁은 하루 예산이
 *   남아 더 넓게 본다.
 */
const SLOT_DEF = {
  noon: { targetHour: 12, targetMinute: 5, fromHour: 12, toHour: 15, minChanges: 3 },
  evening: { targetHour: 19, targetMinute: 5, fromHour: 19, toHour: 22, minChanges: 1 }
};
const SLOT_NAMES = Object.keys(SLOT_DEF);

/** KST 달력 날짜 'YYYY-MM-DD'. api/_kst.kstToday 와 같은 기준(UTC+9 고정). */
function kstDay(now) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  return new Date((Number.isFinite(t) ? t : Date.now()) + 9 * 3600000).toISOString().slice(0, 10);
}

/** 해당 KST 날짜의 슬롯 경계를 UTC epoch ms 로. */
function slotWindow(day, slot) {
  const def = SLOT_DEF[slot];
  if (!def || !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return null;
  const midnightUtc = Date.parse(day + 'T00:00:00Z') - 9 * 3600000; // KST 00:00 의 UTC
  if (!Number.isFinite(midnightUtc)) return null;
  return {
    slot,
    day,
    targetMs: midnightUtc + def.targetHour * 3600000 + def.targetMinute * 60000,
    startMs: midnightUtc + def.fromHour * 3600000,
    endMs: midnightUtc + def.toHour * 3600000,
    minChanges: def.minChanges
  };
}

/**
 * 지금 수집해도 되는 슬롯 계획. 창 밖이면 null.
 * 반환값의 startMs 는 «창 시작»(12:00/19:00)이다 — 같은 창에서 이미 재확인한
 * 상품을 products.collected_at 으로 걸러내는 기준이라 목표 시각이 아니다.
 */
function slotPlan(now, wantedSlot) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(ms)) return null;
  const day = kstDay(ms);
  const candidates = wantedSlot ? [wantedSlot] : SLOT_NAMES;
  for (const slot of candidates) {
    const w = slotWindow(day, slot);
    // GitHub cron 이 늦게 발화했다고 밤중에 점심 재확인을 실행하지 않는다.
    if (w && ms >= w.startMs && ms < w.endMs) return w;
  }
  return null;
}

/** 목표 시각 대비 지연(분). 창보다 이른 실행은 음수가 아니라 0 으로 본다. */
function delayMinutes(window, now) {
  if (!window) return 0;
  const ms = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.round((ms - window.targetMs) / 60000));
}

/* ─── 슬롯 원장 ─────────────────────────────────────────────────────
 *
 * price_job_state.last_result.volatileSlots 에 그대로 얹는다.
 *   { 'YYYY-MM-DD': { noon: { status, at, attempts, notifiedMissAt }, evening: {...} } }
 *
 * ★ 새 테이블도 새 컬럼도 만들지 않는다 — last_result 는 이미 JSONB 이고
 *   lock · V3 체크포인트가 같은 방식으로 살고 있다. 운영 DB 스키마 변경은
 *   사용자 승인 사항이라, 승인 없이 할 수 있는 방식을 택했다.
 *
 * ★ 원장 쓰기는 «수집기 잠금을 쥐고 있을 때만» 한다. 두 러너가 같은 순간에
 *   깨어나면 acquireLock 의 CAS 가 하나만 통과시키고, 통과한 쪽이 원장을
 *   쓴다. 그래서 외부 API 를 부르기 전에 슬롯 권한이 원자적으로 갈린다.
 * ------------------------------------------------------------------ */

const LEDGER_DAYS = 4;              // KST 4일분만 남긴다 (어제 누락 감지에 2일로 충분)
const MAX_SLOT_ATTEMPTS = 3;        // 실패 재시도 상한 — 실패 루프가 API 예산을 태우지 않게

/** 이 상태면 같은 슬롯을 다시 수집하지 않는다. */
function isServed(entry) {
  if (!entry || !entry.status) return false;
  if ([STATUS.COMPLETED, STATUS.NO_CHANGE, STATUS.SKIPPED,
    STATUS.QUOTA_EXHAUSTED, STATUS.MISSED].includes(entry.status)) return true;
  // FAILED·LOCKED 는 창이 아직 열려 있으면 다시 시도한다. 단 무한 재시도는 금지.
  return Number(entry.attempts) >= MAX_SLOT_ATTEMPTS;
}

function ledgerGet(ledger, day, slot) {
  const d = ledger && ledger[day];
  return (d && d[slot]) || null;
}

/** 원장에 한 슬롯을 기록한 새 객체를 돌려준다 (입력을 바꾸지 않는다). */
function ledgerPut(ledger, day, slot, patch) {
  const src = (ledger && typeof ledger === 'object') ? ledger : {};
  const days = Object.keys(src).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
  days.push(day);
  const keep = new Set([...new Set(days)].sort().slice(-LEDGER_DAYS));
  const out = {};
  for (const k of keep) if (src[k]) out[k] = { ...src[k] };
  out[day] = { ...(out[day] || {}) };
  out[day][slot] = { ...(out[day][slot] || {}), ...patch };
  return out;
}

/**
 * 창이 닫혔는데 아무도 수집하지 않았고 아직 경고하지 않은 슬롯.
 * 예약 자체가 발화하지 않은 날을 «다음 점검» 에서 잡아내는 장치다.
 */
function missedSlots(now, ledger) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(ms)) return [];
  const today = kstDay(ms);
  const yesterday = kstDay(ms - 86400000);
  const out = [];
  for (const day of [...new Set([yesterday, today])]) {
    for (const slot of SLOT_NAMES) {
      const w = slotWindow(day, slot);
      if (!w || ms < w.endMs) continue;            // 창이 아직 열려 있다
      const entry = ledgerGet(ledger, day, slot);
      if (entry && entry.notifiedMissAt) continue; // 이미 경고했다 (하루 한 번)
      if (entry && isServed(entry)) continue;      // 수집했거나 정상 건너뜀
      out.push(w);
    }
  }
  return out;
}

/**
 * 수집 결과 수치로 운영 상태를 정한다.
 *   확인 0 · 호출 0  → SKIPPED  (대상이 없었다)
 *   확인 0 · 호출 >0 → NO_CHANGE (불렀지만 같은 상품·옵션이 매칭되지 않았다)
 *   변경 0           → NO_CHANGE
 *   변경 >0          → COMPLETED
 */
function decideStatus(totals) {
  const t = totals || {};
  const spent = Number(t.spent) || 0;
  const checked = Number(t.checked) || 0;
  const changed = Number(t.changedApplied) || 0;
  if (checked === 0 && spent === 0) return STATUS.SKIPPED;
  if (changed > 0) return STATUS.COMPLETED;
  return STATUS.NO_CHANGE;
}

/** 종료 코드 — 빨간 X 는 «실제로 잃어버린 수집» 일 때만. */
function exitCodeFor(status) {
  return (status === STATUS.FAILED || status === STATUS.MISSED) ? 1 : 0;
}

function pickSearchGroups(candidates, maxQueries) {
  const groups = new Map();
  for (const item of candidates || []) {
    const word = String(item.keyword || item.title || '').trim().slice(0, 80);
    if (!word) continue;
    const k = item.mall + '|' + word;
    if (!groups.has(k)) groups.set(k, { mall: item.mall, keyword: word, targets: [] });
    groups.get(k).targets.push(item);
  }
  return [...groups.values()].slice(0, maxQueries);
}

function volatilityRanking(rows, minChanges = 1) {
  const groups = new Map();
  for (const r of rows || []) {
    if (!r.product_id || !['쿠팡', 'ADPICK'].includes(r.mall)) continue;
    const price = Number(r.price);
    const at = Date.parse(r.recorded_at);
    if (!Number.isSafeInteger(price) || price <= 0 || !Number.isFinite(at)) continue;
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push([at, price]);
  }
  const ranked = [];
  for (const [key, values] of groups) {
    if (values.length < 2) continue;
    values.sort((a, b) => a[0] - b[0]);
    let changes = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i][1] !== values[i - 1][1]) changes++;
    }
    if (changes < minChanges) continue;
    const last = values[values.length - 1];
    ranked.push({ key, changes, observations: values.length, lastObservedMs: last[0] });
  }
  return ranked.sort((a, b) => b.changes - a.changes
    || b.lastObservedMs - a.lastObservedMs || a.key.localeCompare(b.key));
}

module.exports = {
  keyOf, volatilityRanking, slotPlan, pickSearchGroups,
  STATUS, SLOT_DEF, SLOT_NAMES, MAX_SLOT_ATTEMPTS, LEDGER_DAYS,
  kstDay, slotWindow, delayMinutes,
  isServed, ledgerGet, ledgerPut, missedSlots, decideStatus, exitCodeFor
};
