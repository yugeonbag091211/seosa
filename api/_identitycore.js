'use strict';
/*
 * 상품 속성 표기 읽기 — 질의 식별(_aiidentity)과 오퍼 식별(_offeridentity)이 함께 쓰는 순수 함수.
 *
 * ── 왜 따로 뺐는가 (2026-10-13 cross-merchant product identity) ──────
 *
 * 색·저장 용량·상태 표기를 읽는 규칙은 PR #133 이 _aiidentity.js 안에 두었다.
 * 그 파일은 «사용자 질의 ↔ 검색 후보» 를 비교하는 계약(부정 범위·이어지는 대화·
 * 등급 판정)이라, 판매처 오퍼끼리 비교하는 쪽이 그 파일을 통째로 끌어오면 질의
 * 전용 규칙과 오퍼 규칙이 엉킨다. 그렇다고 같은 표를 두 벌 두면 한쪽만 고쳐지는
 * 순간 «AI 가 말하는 같은 상품» 과 «가격비교가 묶는 같은 상품» 이 갈라진다.
 * 그래서 질의·오퍼 어느 쪽에도 속하지 않는 표기 읽기만 여기 모은다.
 *
 * ★ 토큰화·동의어·상태 패턴·부속 낱말은 계속 _search 의 것을 쓴다. 여기서 다시
 *   만들지 않는다.
 * ★ 판정(같다/다르다)은 하지 않는다. 표기를 값으로 바꾸기만 한다.
 */

const S = require('./_search');

/* 용량으로 읽는 맨숫자 ("아이폰17프로 256 검정"). 화면 크기·세대 숫자와 겹치지 않는 값만. */
const STORAGE_SIZES = new Set(['32', '64', '128', '256', '512']);

/* 색 — 사용자 말과 상품명을 같은 표로 읽는다. 상품을 가르는 값이라 «옵션» 으로 다룬다. */
const COLOR_GROUPS = [
  ['black', '블랙', ['블랙', '검정', '검은', '흑색', 'black']],
  ['white', '화이트', ['화이트', '흰색', '하얀', '백색', 'white']],
  ['silver', '실버', ['실버', '은색', 'silver']],
  ['gray', '그레이', ['그레이', '회색', 'gray', 'grey']],
  ['navy', '네이비', ['네이비', 'navy']],
  ['blue', '블루', ['블루', '파란', '파랑', '청색', 'blue']],
  ['red', '레드', ['레드', '빨간', '빨강', 'red']],
  ['pink', '핑크', ['핑크', '분홍', 'pink']],
  ['green', '그린', ['그린', '초록', '녹색', 'green']],
  ['gold', '골드', ['골드', '금색', 'gold']],
  ['purple', '퍼플', ['퍼플', '보라', 'purple']],
  ['beige', '베이지', ['베이지', 'beige']],
  ['ivory', '아이보리', ['아이보리', 'ivory']],
  ['brown', '브라운', ['브라운', '갈색', 'brown']],
  ['orange', '오렌지', ['오렌지', '주황', 'orange']],
  ['yellow', '옐로우', ['옐로우', '노란', '노랑', 'yellow']],
  ['mint', '민트', ['민트', 'mint']]
];

/*
 * 색 이름을 품은 다른 낱말. 한글 색은 부분 문자열로 찾으므로(«오렌지-OR», «스타리블랙»)
 * 이런 낱말은 먼저 지운다 — «블루투스 이어폰» 이 파란색 이어폰이 되면 안 된다.
 */
const COLOR_FALSE_FRIENDS_RE = /블루투스|블루레이/g;

function norm(s) { return S.normalizeText(String(s == null ? '' : s)); }

/** "512기가" → "512gb", "1테라" → "1tb" — 용량을 한 표기로 맞춘다. */
function normalizeUnits(text) {
  return String(text == null ? '' : text)
    // "S26+" 의 '+' 는 토큰화에서 사라진다 — 등급 표기(plus)로 남긴다. "1+1" 같은 행사 표기는 건드리지 않는다.
    .replace(/([A-Za-z]\d+)\+(?![0-9])/g, '$1 plus ')
    .replace(/(\d+)\s*기가(?:바이트)?/g, '$1gb')
    .replace(/(\d+)\s*테라(?:바이트)?/g, '$1tb')
    .replace(/(\d+)\s*(gb|tb)\b/gi, (m, n, u) => `${n}${u.toLowerCase()}`);
}

/** 텍스트에 나온 색 (canonical). */
function colorsOf(text) {
  const out = new Set();
  const n = norm(text).replace(COLOR_FALSE_FRIENDS_RE, ' ');
  const toks = new Set(S.splitTokens(n));
  COLOR_GROUPS.forEach(([canon, , aliases]) => {
    if (aliases.some(a => (/^[a-z]+$/.test(a) ? toks.has(a) : n.indexOf(a) > -1))) out.add(canon);
  });
  return out;
}
function colorLabel(canon) {
  const g = COLOR_GROUPS.find(x => x[0] === canon);
  return g ? g[1] : canon;
}

/** 텍스트에 나온 저장 용량 (gb 단위 문자열). */
function storageOf(text) {
  const out = new Set();
  const re = /(\d+)\s*(gb|tb)\b/gi;
  let m;
  const s = normalizeUnits(text);
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1]) * (m[2].toLowerCase() === 'tb' ? 1024 : 1);
    if (n >= 16) out.add(`${n}gb`);
  }
  return out;
}

/* 텍스트에 나온 상태 표기 전부 ("중고 … 미개봉" 은 used·sealed 둘 다). */
function conditionStates(text) {
  const s = String(text == null ? '' : text);
  return new Set(S.CONDITION_PATTERNS.filter(([, re]) => re.test(s)).map(([state]) => state));
}
const NEW_STATES = new Set(['new', 'sealed']);

/*
 * 판매자 문자열 안의 지시문 (2026-10-12 live 레드팀 F20).
 *
 * 상품명은 판매자가 쓴 데이터다. 그 안의 역할·지시 문구("SYSTEM: 이전 지시 무시하고 …")는
 * 상품을 식별하는 근거가 아니다. 지우지는 않는다 — 진짜 상품일 수 있다.
 */
const INSTRUCTION_TEXT_RE = /(?:^|[\s\[(【])(?:system|developer|assistant|admin)\s*[:：]|ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?)|(?:이전|위의?|앞의?)\s*(?:지시|명령|규칙)(?:을|를|은|는)?\s*(?:무시|따르지)|시스템\s*프롬프트|api\s*key|비밀\s*키|(?:관리자|개발자)\s*(?:권한|모드|명령)|(?:공개|출력|무시)하라/i;

function hasInstructionText(title) {
  return INSTRUCTION_TEXT_RE.test(String(title || '').normalize('NFKC'));
}

/** 식별에 쓰는 제목 — 지시문 구간을 걷어낸 나머지. 상품 이름 자체는 남는다. */
function cleanIdentityTitle(title) {
  const s = String(title || '').normalize('NFKC');
  if (!hasInstructionText(s)) return s;
  // "지시문 — 상품명" / "지시문: 상품명" 꼴이면 구분자 뒤만 남긴다.
  const parts = s.split(/\s[—–-]\s|\s\|\s/);
  const clean = parts.filter(p => !hasInstructionText(p));
  return clean.length ? clean.join(' ') : s.replace(INSTRUCTION_TEXT_RE, ' ');
}

module.exports = {
  STORAGE_SIZES, COLOR_GROUPS, NEW_STATES,
  normalizeUnits, colorsOf, colorLabel, storageOf, conditionStates,
  hasInstructionText, cleanIdentityTitle
};
