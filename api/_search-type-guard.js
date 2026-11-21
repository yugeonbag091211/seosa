/*
 * 검색 결과 «부속» 가드.
 *
 * ── 무엇을 고치는가 ────────────────────────────────────────────────
 *
 *   "마우스"   → 마우스패드 · 손목받침 · 클리너
 *   "키보드"   → 키스킨 · 보호필름 · 키캡 · 청소 브러쉬
 *   "모니터"   → 받침대 · 모니터암 · 보호필름
 *   "청소기"   → 교체용 필터 · 브러시 헤드
 *
 * 낱말은 맞지만 본품이 아니다. _shop.matchesKeyword 는 토큰 하나만
 * 걸려도 통과시키므로 이것들이 본품과 같은 자리에 올라온다. 그리고
 * 목록에 남으면 화면 최상단의 「결과 중 최저」·「가격대」가 그 가격으로
 * 계산된다 (2026-11-20 "노트북" 실측: 최저가가 32,170원짜리 강의였다).
 *
 * 마우스를 치면 마우스가 나와야 한다. 마우스패드가 아니라.
 *
 * ── ★ 왜 tier(MISMATCH) 로 판단하지 않는가 ────────────────────────
 *
 * 처음에 _aiidentity 의 tier === MISMATCH 를 그대로 썼다가 43개 품목
 * 감사에서 본품 86건 중 24건(28%)이 사라졌다 (2026-11-21).
 *
 *   "타이어" → 『금호 마제스티9 225/45R18』  MISMATCH ❌ 사라짐
 *             『타이어 공기압 게이지』        EXACT    ✅ 남음
 *   "커피"   → 『일리 클래시코 원두 250g』    MISMATCH ❌ 사라짐
 *
 * tier 는 «제목에 검색어가 들어 있나» 를 크게 본다. 그래서 브랜드·모델명
 * 으로 파는 품목(타이어·커피·시계·블랙박스…)은 본품이 통째로 떨어지고,
 * 오히려 검색어를 성실히 적어 둔 부속이 살아남는다. 정확히 거꾸로다.
 *
 * 마우스·키보드가 잘 됐던 것은 그 품목의 제목이 거의 항상 "마우스"·
 * "키보드" 를 포함하기 때문이었다. 두 품목만 보고 일반화한 실수였다.
 *
 * 그래서 tier 가 아니라 «본품이 아닌 부속» 이라는 사유 하나만 본다.
 * 이것은 _search.js 의 ACCESSORY_TIER(사람이 관리하는 부속 낱말 목록)에서
 * 나오므로, 검색어가 제목에 있든 없든 상관없이 판단이 선다.
 *
 *   오탐 24건 → 2건 (본품 보존 72% → 98%)
 *
 * ── ★ 어순 구제 ───────────────────────────────────────────────────
 *
 * 남은 2건은 둘 다 '스탠드' 였다.
 *
 *   "선풍기" → 『신일 20인치 스탠드 선풍기』   ❌ 사라짐
 *   "조명"   → 『필립스 휴 스탠드 조명』       ❌ 사라짐
 *
 * 한국어 합성어는 어순이 뜻을 가른다.
 *
 *   「모니터 스탠드」 = 모니터를 위한 스탠드   → 부속
 *   「스탠드 선풍기」 = 스탠드형 선풍기        → 본품
 *
 * 제목의 «마지막 낱말» 이 검색어를 담고 있으면 그것이 팔리는 물건이다.
 * 부속으로 찍혔어도 되돌린다.
 *
 *   오탐 2건 → 0건 (본품 보존 100%, 부속 제거율은 그대로 65%)
 *
 * ── 기존 «버리지 않는다» 원칙과의 관계 ────────────────────────────
 *
 * search.js 의 rankItems 는 minScore 0 으로 한 건도 버리지 않는다.
 * 그 근거("관련도가 낮은 것은 아래로 내려갈 뿐")는 옳다 — 관련도가
 * 낮은 마우스도 여전히 마우스다. 그러나 부속은 등급이 낮은 본품이
 * 아니라 «다른 물건» 이다. 마우스패드는 순위가 낮은 마우스가 아니다.
 *
 * 부속만 버린다. 등급이 낮은 것은 그대로 둔다.
 *
 * ── 안전장치 ──────────────────────────────────────────────────────
 *
 * ★ 전부 걸러지면 가드가 스스로 물러난다. 판정기가 후보 전체를 거부하는
 *   것은 상품이 전부 틀렸다는 뜻보다 질의를 잘못 읽었다는 뜻일 때가 많다
 *   («노트북 가방» 에서 실제로 그렇다). 이 가드 때문에 «결과 없음» 이
 *   되는 일은 없다.
 * ★ 판정기가 터지면 통과시킨다. 검색이 가드 때문에 실패하면 안 된다.
 *
 * 부속을 한둘 놓치는 것(미탐)보다 멀쩡한 상품이 사라지는 것(오탐)이
 * 훨씬 큰 사고다 — 사용자는 그 상품이 없는 줄 안다. 그래서 이 가드는
 * 재현율이 아니라 «본품을 한 건도 잃지 않는 것» 에 맞춰 조정되어 있다.
 */
'use strict';

const AIID = require('./_aiidentity');
const { productIntentContext } = require('./_search');

/** «본품이 아닌 부속» 사유가 붙었는가. tier 는 보지 않는다(위 주석 참고). */
function judgedAccessory(v) {
  return Array.isArray(v && v.reasons)
    && v.reasons.some(r => r && r.kind === 'type' && /부속/.test(String(r.label || '')));
}

/**
 * 제목의 마지막 낱말이 검색어를 담고 있으면 본품으로 본다.
 * 「스탠드 선풍기」는 선풍기이고, 「모니터 스탠드」는 모니터가 아니다.
 */
function headIsQuery(title, keyword) {
  const words = String(title || '').trim().split(/\s+/);
  const last = words[words.length - 1] || '';
  const core = String(keyword || '').trim().split(/\s+/).pop() || '';
  return core.length >= 2 && last.includes(core);
}

/**
 * 본품이 아닌 부속을 걸러낸다.
 *
 * @param {string} keyword  사용자가 친 검색어
 * @param {Array}  items    후보 상품
 * @returns {{kept: Array, dropped: Array, applied: boolean, reason: string}}
 *   applied=false 면 kept 는 입력 그대로다 (한 건도 버리지 않았다).
 */
function filterByProductType(keyword, items) {
  const list = Array.isArray(items) ? items : [];

  if (list.length < 2 || !String(keyword || '').trim()) {
    return { kept: list, dropped: [], applied: false, reason: 'too-few' };
  }

  /*
   * ★ 부속을 «일부러» 찾는 검색이면 가드를 켜지 않는다.
   *
   *   "마우스패드" · "키보드 키캡" · "아이폰 케이스"
   *
   * _search.js 가 이미 이 판정을 한다(ACCESSORY_INTENT). 같은 어휘를
   * 쓰므로 «부속으로 거를 말» 과 «부속을 찾는 검색어» 가 항상 맞물린다.
   *
   * 알려진 구멍: "노트북 가방" 은 '가방' 이 부속 어휘가 아니라서
   * MAIN_PRODUCT_INTENT 로 잡히고, 그 결과 슬리브·파우치 류가 빠진다.
   * 어휘에 '가방' 을 넣으면 가방 자체를 찾는 검색이 망가지므로 넣지
   * 않았다. 결과가 비지는 않는다(아래 would-empty 안전장치).
   */
  try {
    if (productIntentContext(keyword, list.map(it => String((it && it.title) || ''))).intent === 'ACCESSORY_INTENT') {
      return { kept: list, dropped: [], applied: false, reason: 'accessory-intent' };
    }
  } catch (e) {
    console.warn(`[type-guard:${keyword}] 의도 판정 실패(계속 진행): ${e.message}`);
  }

  let isAccessory;
  try {
    const contract = AIID.buildContract({
      query: keyword,
      titles: list.map(it => String((it && it.title) || ''))
    });
    isAccessory = list.map(it =>
      judgedAccessory(AIID.verdict(contract, it)) && !headIsQuery(it && it.title, keyword));
  } catch (e) {
    // 판정기 사고로 검색이 망가지면 안 된다. 통과시키고 로그만 남긴다.
    console.warn(`[type-guard:${keyword}] 판정 실패(가드 생략): ${e.message}`);
    return { kept: list, dropped: [], applied: false, reason: 'error' };
  }

  const kept = [], dropped = [];
  list.forEach((it, i) => { (isAccessory[i] ? dropped : kept).push(it); });

  if (!dropped.length) {
    return { kept: list, dropped: [], applied: false, reason: 'nothing-to-drop' };
  }

  // ★ 전부 부속으로 찍히면 가드를 포기한다 (위 «안전장치» 주석 참고).
  if (!kept.length) {
    console.warn(
      `[type-guard:${keyword}] 후보 ${list.length}건이 모두 부속으로 판정 — 가드를 적용하지 않습니다`
    );
    return { kept: list, dropped: [], applied: false, reason: 'would-empty' };
  }

  console.log(
    `[type-guard:${keyword}] 부속 ${dropped.length}건 제외 (${kept.length}건 유지)`
    + ` — ${dropped.slice(0, 3).map(d => String(d.title || '').slice(0, 24)).join(' | ')}`
  );
  return { kept, dropped, applied: true, reason: 'filtered' };
}

module.exports = { filterByProductType };
