#!/usr/bin/env node
/*
 * 검색 «상품 유형» 가드 회귀 테스트 — 외부 호출 0회 / Supabase 접근 0회.
 *
 *   node scripts/test-search-type-guard.js
 *
 * ── 지켜야 할 것 한 줄 ────────────────────────────────────────────
 *
 *   마우스를 치면 마우스가 나온다. 마우스패드가 아니라.
 *   키보드를 치면 키보드가 나온다. 키스킨·키캡·팜레스트가 아니라.
 *
 * ── 무엇을 고정하는가 ─────────────────────────────────────────────
 *   ① 본품을 찾을 때 부속·서비스·다른 유형이 결과에서 빠진다
 *   ② 본품은 한 건도 사라지지 않는다 (오탐이 미탐보다 나쁘다)
 *   ③ 부속을 «일부러» 찾으면 부속이 남는다 ("마우스패드", "키보드 키캡")
 *   ④ ★ 가드 때문에 «결과 없음» 이 되는 일은 없다 — 전부 걸러지면 물러난다
 *   ⑤ 판정기가 터져도 검색은 살아 있다
 */
'use strict';

const { filterByProductType } = require('../api/_search-type-guard');

let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : '  — ' + JSON.stringify(detail, null, 1)}`); }
}
function section(name) { console.log(`\n${name}`); }

const items = titles => titles.map((t, i) => ({ title: t, lprice: 10000 + i * 1000 }));
const titlesOf = list => list.map(x => x.title);

/**
 * @param q      검색어
 * @param keep   결과에 반드시 남아야 할 제목 조각
 * @param drop   결과에서 반드시 빠져야 할 제목 조각
 */
function expect(q, all, keep, drop) {
  const r = filterByProductType(q, items(all));
  const kept = titlesOf(r.kept).join(' ||| ');
  keep.forEach(frag => check(kept.includes(frag), `"${q}" → 남는다: ${frag}`, titlesOf(r.kept)));
  drop.forEach(frag => check(!kept.includes(frag), `"${q}" → 빠진다: ${frag}`, titlesOf(r.kept)));
  return r;
}

/* ------------------------------------------------------------------ */
section('1. 마우스를 치면 마우스가 나온다');

expect('마우스',
  [
    '로지텍 MX Master 3S 무선 마우스',
    '마우스패드 장패드 게이밍 데스크매트 800x300',
    '마우스 발 피트 테프론 교체용 스케이트',
    '유선 광마우스 사무용 USB 3버튼',
    '마우스 손목받침대 쿠션 메모리폼',
    '마우스 클리너 먼지제거 브러쉬',
  ],
  ['MX Master 3S', '유선 광마우스'],
  ['마우스패드', '발 피트', '손목받침대', '클리너']
);

/* ------------------------------------------------------------------ */
section('2. 키보드를 치면 키보드가 나온다');

expect('키보드',
  [
    '한성컴퓨터 GK898B 기계식 키보드 적축',
    '키보드 덮개 실리콘 키스킨 커버',
    '노트북 키보드 보호필름',
    '로지텍 K380 무선 블루투스 키보드',
    '키보드 손목받침 팜레스트 우드',
    '기계식 키보드 키캡 세트 PBT 108키',
    '키보드 청소 브러쉬 키캡 리무버',
  ],
  ['GK898B', 'K380'],
  ['키스킨', '보호필름', '팜레스트', '키캡 세트', '청소 브러쉬']
);

/* ------------------------------------------------------------------ */
section('3. 다른 품목에서도 같은 규칙이 선다');

expect('노트북',
  [
    '삼성전자 갤럭시북6 14인치 노트북 NT740VJQ',
    'AI 비서 제미나이LM(노트북LM) 완전 정복 강의',
    '생활더봄 노트북 출장용 캐리어백팩 도난방지',
    'LG 그램 Pro 16Z95U 노트북',
  ],
  ['갤럭시북6', '그램 Pro'],
  ['완전 정복', '백팩']
);

expect('최신 아이폰',
  [
    'Apple 아이폰 16 Pro 256GB 자급제',
    '(아이폰스냅) 사진 못 찍는 남자친구 대신 인생사진 남겨드려요',
    '아이폰 액정수리 자가수리 키트',
  ],
  ['16 Pro'],
  ['인생사진', '액정수리']
);

expect('RTX 5090 노트북',
  [
    'ASUS ROG 스트릭스 RTX 5090 게이밍 노트북 32GB',
    '지포스 RTX 5090 D7 32GB 그래픽카드',
    '게이밍 데스크탑 본체 RTX 3050 조립PC',
  ],
  ['ROG 스트릭스'],
  ['그래픽카드', '조립PC']
);

/* ------------------------------------------------------------------ */
section('4. 부속을 일부러 찾으면 부속이 남는다');

expect('마우스패드',
  ['마우스패드 장패드 게이밍 데스크매트', '로지텍 MX Master 3S 무선 마우스', '스틸시리즈 QcK 마우스패드'],
  ['장패드', 'QcK'],
  []
);

expect('키보드 키캡',
  ['기계식 키보드 키캡 세트 PBT 108키', '한성 GK898B 기계식 키보드 적축', '키캡 리무버 공구'],
  ['키캡 세트'],
  []
);

expect('아이폰 케이스',
  ['아이폰16 프로 투명 범퍼 케이스', 'Apple 아이폰 16 Pro 256GB 자급제'],
  ['범퍼 케이스'],
  []
);

/* ------------------------------------------------------------------ */
section('5. ★ 가드 때문에 결과가 0건이 되지 않는다');

/*
 * «노트북 가방» 은 _aiidentity 의 계약이 wantsAccessory 를 세우지 못해
 * 후보 전체를 MISMATCH 로 떨어뜨린다 (2026-11-21 확인). 그대로 버리면
 * 검색 결과가 0건이 된다. 그럴 때 가드는 스스로 물러나야 한다.
 */
const bagQuery = filterByProductType('노트북 가방', items([
  '생활더봄 노트북 출장용 캐리어백팩 도난방지',
  '삼성 갤럭시북6 14인치 노트북',
  'targus 15.6 노트북 슬리브 파우치',
]));
check(bagQuery.applied === false, '전부 불일치면 가드를 적용하지 않는다', bagQuery.reason);
check(bagQuery.reason === 'would-empty', '이유가 would-empty 로 기록된다', bagQuery.reason);
check(bagQuery.kept.length === 3, '후보 3건이 그대로 남는다', bagQuery.kept.length);
check(bagQuery.dropped.length === 0, '버린 것이 없다고 보고한다', bagQuery.dropped.length);

/* 어떤 입력에서도 빈 배열을 돌려주지 않는다. */
[
  ['마우스', ['마우스패드', '마우스 발 피트', '마우스 클리너']],
  ['키보드', ['키스킨 커버', '키캡 세트']],
  ['에어팟', ['에어팟 케이스', '에어팟 이어팁']],
].forEach(([q, ts]) => {
  const r = filterByProductType(q, items(ts));
  check(r.kept.length > 0, `"${q}" 부속만 있어도 결과가 비지 않는다`, r);
});

/* ------------------------------------------------------------------ */
section('6. 입력이 이상해도 터지지 않는다');

check(filterByProductType('마우스', []).kept.length === 0, '빈 목록');
check(filterByProductType('', items(['아무거나', '또 아무거나'])).applied === false, '빈 검색어면 판단하지 않는다');
check(filterByProductType('마우스', null).kept.length === 0, 'null 목록');
check(filterByProductType('마우스', items(['마우스 하나뿐'])).applied === false, '1건이면 비교하지 않는다');
check(filterByProductType('마우스', [{ title: null }, { title: undefined }]).kept.length === 2,
  '제목이 없어도 버리지 않는다');

/* ------------------------------------------------------------------ */
section('7. 본품이 섞여 있으면 본품은 전부 살아남는다');

/*
 * 오탐이 미탐보다 나쁘다. 부속을 한둘 놓치는 것보다 멀쩡한 상품이
 * 사라지는 쪽이 훨씬 큰 사고다 — 사용자는 그것이 없는 줄 안다.
 */
const mixed = filterByProductType('무선 이어폰', items([
  '삼성 갤럭시 버즈3 프로 무선이어폰',
  '애플 에어팟 프로 2세대 무선 이어폰',
  '소니 WF-1000XM5 완전 무선 이어폰',
  'QCY T13 블루투스 무선 이어폰',
  '무선 이어폰 실리콘 케이스 커버',
]));
['버즈3', '에어팟 프로', 'WF-1000XM5', 'QCY T13'].forEach(frag =>
  check(titlesOf(mixed.kept).join(' ').includes(frag), `본품 유지: ${frag}`, titlesOf(mixed.kept)));

/* ------------------------------------------------------------------ */
console.log('\n' + '='.repeat(66));
console.log(`검색 유형 가드 테스트:  ${pass} PASS / ${fail} FAIL`);
console.log('='.repeat(66));
process.exit(fail ? 1 : 0);
