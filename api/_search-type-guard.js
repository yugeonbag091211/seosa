/*
 * 검색 결과 «상품 유형» 가드.
 *
 * ── 무엇을 고치는가 ────────────────────────────────────────────────
 *
 *   "마우스"   → 마우스패드 · 마우스 발 피트 · 손목받침
 *   "키보드"   → 키스킨 · 보호필름 · 키캡 · 청소 브러쉬
 *   "노트북"   → 백팩가방 · 강의
 *   "아이폰"   → 액정수리 키트 · 아이폰스냅 촬영 서비스
 *
 * 전부 낱말은 맞지만 «팔리는 물건» 이 다르다. _shop.matchesKeyword 는
 * 토큰 하나만 걸려도 통과시키므로 이것들이 그대로 올라온다.
 *
 * 마우스를 치면 마우스가 나와야 한다. 그게 가격비교 서비스의 최소 조건이다.
 *
 * ── 왜 판정기를 새로 만들지 않는가 ────────────────────────────────
 *
 * api/_aiidentity.js 가 이미 이 판정을 한다. 2026-10-22 레드팀 이후로
 * 책·여행/강의/서비스·가방/부품·데스크톱/그래픽카드를 유형으로 가르고,
 * 수천 건의 회귀 테스트가 걸려 있다. AI 채팅은 이미 이걸 통과한 것만
 * 추천한다 — 검색 결과 페이지만 쓰지 않고 있었다. 두 벌로 두지 않는다.
 *
 * ── 왜 «버리지 않는다» 는 기존 원칙을 깨는가 ──────────────────────
 *
 * api/search.js 의 rankItems 는 minScore 0 으로 한 건도 버리지 않는다.
 * 그 주석의 근거는 "관련도가 낮은 것은 아래로 내려갈 뿐" 이었고, 그건
 * 옳다 — «관련도가 낮은 마우스» 는 여전히 마우스다.
 *
 * 그러나 MISMATCH 는 관련도가 낮은 것이 아니라 «다른 물건» 이다.
 * 마우스패드는 순위가 낮은 마우스가 아니다. 그리고 그것이 목록에 남으면
 * 화면 최상단의 「결과 중 최저」·「가격대」가 그 가격으로 계산된다
 * (2026-11-20 "노트북" 실측: 최저가가 32,170원짜리 강의였다).
 *
 * 그래서 유형이 다른 것만 버린다. 등급이 낮은 것은 그대로 둔다.
 *
 * ── 안전장치 ──────────────────────────────────────────────────────
 *
 * ★ 전부 MISMATCH 면 아무것도 버리지 않는다.
 *
 *   _aiidentity 의 계약은 «노트북 가방» 같은 두 낱말 부속 질의에서
 *   wantsAccessory 를 세우지 못해 후보 전체를 MISMATCH 로 떨어뜨린다
 *   (2026-11-21 확인: 가방 3건이 모두 MISMATCH). 그 상태에서 그대로
 *   버리면 검색 결과가 0건이 된다.
 *
 *   판정기가 전부를 거부한다는 것은 상품이 전부 틀렸다는 뜻보다
 *   질의를 잘못 읽었다는 뜻일 때가 많다. 그럴 때는 가드를 통째로
 *   포기하고 지금까지의 동작(전부 보여주기)으로 돌아간다.
 *   이 가드 때문에 «결과 없음» 이 되는 일은 없다.
 *
 * ★ 판정기가 터지면 통과시킨다. 검색이 가드 때문에 실패하면 안 된다.
 */
'use strict';

const AIID = require('./_aiidentity');

/**
 * 유형이 다른 상품을 걸러낸다.
 *
 * @param {string} keyword  사용자가 친 검색어
 * @param {Array}  items    후보 상품
 * @returns {{kept: Array, dropped: Array, applied: boolean, reason: string}}
 *   applied=false 면 kept 는 입력 그대로다 (한 건도 버리지 않았다).
 */
function filterByProductType(keyword, items) {
  const list = Array.isArray(items) ? items : [];

  // 비교할 것이 없으면 판단하지 않는다.
  if (list.length < 2 || !String(keyword || '').trim()) {
    return { kept: list, dropped: [], applied: false, reason: 'too-few' };
  }

  let verdicts;
  try {
    const contract = AIID.buildContract({
      query: keyword,
      titles: list.map(it => String((it && it.title) || ''))
    });
    verdicts = list.map(it => {
      const v = AIID.verdict(contract, it);
      return Number(v && v.tier);
    });
  } catch (e) {
    // 판정기 사고로 검색이 망가지면 안 된다. 통과시키고 로그만 남긴다.
    console.warn(`[type-guard:${keyword}] 판정 실패(가드 생략): ${e.message}`);
    return { kept: list, dropped: [], applied: false, reason: 'error' };
  }

  const kept = [], dropped = [];
  list.forEach((it, i) => {
    (verdicts[i] === AIID.TIER.MISMATCH ? dropped : kept).push(it);
  });

  if (!dropped.length) {
    return { kept: list, dropped: [], applied: false, reason: 'nothing-to-drop' };
  }

  /*
   * ★ 전부 걸러지면 가드를 포기한다 (위 «안전장치» 주석 참고).
   *   판정기가 질의를 잘못 읽은 쪽이 상품이 전부 틀린 쪽보다 흔하다.
   */
  if (!kept.length) {
    console.warn(
      `[type-guard:${keyword}] 후보 ${list.length}건이 모두 유형 불일치 — 가드를 적용하지 않습니다`
      + ` (예: ${String(list[0].title || '').slice(0, 40)})`
    );
    return { kept: list, dropped: [], applied: false, reason: 'would-empty' };
  }

  console.log(
    `[type-guard:${keyword}] 유형이 다른 상품 ${dropped.length}건 제외 (${kept.length}건 유지)`
    + ` — ${dropped.slice(0, 3).map(d => String(d.title || '').slice(0, 24)).join(' | ')}`
  );
  return { kept, dropped, applied: true, reason: 'filtered' };
}

module.exports = { filterByProductType };
