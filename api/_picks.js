'use strict';
/*
 * 홈 "오늘의 셀렉션" 키워드 — 수요(실제 검색어) 우선, 큐레이션은 보충.
 *
 * ── 왜 바꿨나 (2026-09-02 감사) ──────────────────────────────────
 *
 * api/_shop.TODAY_PICKS 는 7월 큐레이션과 똑같은 하드코딩 목록이다
 * (수영복·쿨토시·아이스크림 …). 9월 2일 운영 `/api/init` 이 그 목록을
 * 그대로 냈다. 반면 search_stats 상위는 무선 이어폰·노트북·마우스·키보드·
 * 아이폰이다 — 사용자가 치는 말과 첫 화면이 서로 다른 계절, 다른 카테고리였다.
 *
 * 이달의 큐레이션 섹션이 계절 키워드를 이미 맡고 있으므로, 셀렉션은
 * "사람들이 실제로 찾는 것"을 맡는다. 두 섹션이 같은 말을 하지 않게 된다.
 *
 * ── 지키는 선 ────────────────────────────────────────────────────
 *   · 입력은 api/init.js popularChips 가 이미 거른 행이다 — 형태 검사
 *     (isValidSuggestion) 와 실적 검사(products 에 상품이 있는가)를 통과했다.
 *     여기서 다시 검증하지 않는다. 규칙이 두 벌이 되면 갈라진다.
 *   · 수요 키워드가 모자라면 큐레이션(fallback)으로 채운다. 첫 방문자가
 *     빈 셀렉션을 보게 하지 않는다.
 *   · 결정적이다. 같은 입력이면 같은 순서.
 */

const DEFAULT_MAX = 8;

/**
 * @param {Array<{keyword:string,count?:number}>} popularRows  검증된 인기 검색어 행 (count 내림차순)
 * @param {string[]} fallback  큐레이션 키워드 (api/_shop.TODAY_PICKS)
 * @param {number} [max]
 * @returns {string[]} 셀렉션 키워드. 비어 있지 않다(fallback 이 있는 한).
 */
function demandPicks(popularRows, fallback, max) {
  const limit = Math.max(1, Number(max) || DEFAULT_MAX);
  const out = [];
  const seen = new Set();
  // "무선 이어폰" 과 "무선이어폰" 은 같은 칩이다 — 띄어쓰기·대소문자를 접어 겹침을 본다.
  const keyOf = s => s.replace(/\s+/g, '').toLowerCase();
  const push = k => {
    const s = String(k == null ? '' : k).trim();
    if (!s || out.length >= limit) return;
    const key = keyOf(s);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  (Array.isArray(popularRows) ? popularRows : []).forEach(r => push(r && r.keyword));
  (Array.isArray(fallback) ? fallback : []).forEach(push);
  return out;
}

module.exports = { demandPicks, DEFAULT_MAX };
