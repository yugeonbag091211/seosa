#!/usr/bin/env node
'use strict';

/*
 * 판매 대상이 «그 물건» 이 아닌 글을 본품 아래로 내린다 (2026-11-24).
 *
 *   책·음반   상품명 맨 앞 서점 분류 태그 — «[국내도서] 고추장 심부름»
 *   체험·여행 ADPICK 판매처가 여행·체험 플랫폼 — «… 규탄노 레몬 | 좌석 예약 전용» (KKday)
 *   기기 가방 «기기+가방» 짝이 있고 기기가 따로 팔리지 않는 글 — «… 14ZD95U 노트북 가방»
 *   리퍼 경계 «슬리퍼»·«드리퍼» 의 «리퍼» 를 리퍼(재생품)로 읽지 않는다
 *
 * 운영 공급자 캐시 검색어 4,416개(개발용) 재생: 짧은 검색어 3,787개 중 1위가 책인 것
 * 90 → 3, 체험인 것 49 → 6. 상품명·판매처는 그 캐시에서 그대로 가져왔다(평가용 봉인
 * 세트의 상품명은 쓰지 않았다). 외부 호출 0 · DB 조회 0.
 */

const S = require('../api/_search');


let pass = 0;
let fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); return; }
  fail++;
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`);
}
function item(title, mall, mallLabel, lprice, id) {
  return { title, mall: mall || '쿠팡', mallLabel: mallLabel || '', lprice: lprice || 10000, productId: id || title };
}
function rank(query, items) {
  const input = items.map(it => ({ ...it }));
  const res = S.rankItems(query, input, { minScore: 0 });
  return { ranked: S.sortByRelevance(res.items), input, res };
}
const idx = (ranked, fragment) => ranked.findIndex(it => it.title.indexOf(fragment) > -1);
const show = ranked => ranked.map(it => `${it.relevance}:${(it.relevanceWhy || '-')}:${it.title.slice(0, 26)}`);

console.log('\n책: 서점 분류 태그가 붙은 글은 본품 아래다');
{
  const { ranked, res } = rank('고추장', [
    item('[국내도서] 고추장 심부름', 'ADPICK', '교보문고', 9000),
    item('순창궁 태양초 고추장', '쿠팡', '', 12000),
    item('아주존 순창우리식품 상황버섯 태양초고추장, 2kg, 1개', '쿠팡', '', 15000)
  ]);
  check(idx(ranked, '심부름') === ranked.length - 1, '고추장: 「[국내도서] 고추장 심부름」 이 진짜 고추장 아래다', show(ranked));
  check(res.items.length === 3, '고추장: 아무것도 빠지지 않는다(내릴 뿐이다)', res.items.length);
  const g = rank('어쿠스틱 기타', [
    item('[국내도서] 기초 어쿠스틱 기타 트레이닝 365일', 'ADPICK', '교보문고', 15000),
    item('고퍼우드 어쿠스틱 기타', '쿠팡', '', 190000),
    item('[기타] 야마하 어쿠스틱 기타 LL6 ARE 점보 바디. 인글만 스프루스 단판. A.R.E[이마트몰] [LL6 ARE]', 'ADPICK', 'SSG', 1400000)
  ]).ranked;
  check(idx(g, '트레이닝') === g.length - 1, '어쿠스틱 기타: 더 비싼 진짜 기타들이 교본보다 위다', show(g));
}

console.log('\n책을 찾는 검색은 건드리지 않는다');
{
  const { ranked } = rank('수학 도서', [
    item('[국내도서] 쎈 고등 공통수학1(2026)', 'ADPICK', '교보문고', 15000),
    item('북마트 쎈 고등 공통수학1(2026)  ISBN-9788928347919', '쿠팡', '', 16000),
    item('디딤돌 초등수학 기본+응용', '쿠팡', '', 14000)
  ]);
  check(ranked.every(it => !/sold-form/.test(it.relevanceWhy || '')), '수학 도서: 검색어에 «도서» 가 있으면 감점이 없다', show(ranked));
  const hp = rank('해리포터', [
    item('[국내도서] 해리 포터와 마법사의 돌', 'ADPICK', '교보문고'),
    item('[eBook] 해리 포터와 비밀의 방', 'ADPICK', '교보문고'),
    item('[국내도서] 해리포터 미나리마 에디션', 'ADPICK', '교보문고'),
    item('해리포터 호그와트 머그컵', '쿠팡', '')
  ]).ranked;
  check(hp.every(it => !/sold-form/.test(it.relevanceWhy || '')), '해리포터: 후보 절반 이상이 책이면 책 검색으로 보고 감점하지 않는다', show(hp));
}

console.log('\n체험: 여행·체험 판매처 글은 본품 아래다');
{
  /* 목록은 운영 응답처럼 여러 건이다 — 후보 절반 이상이 체험이면 «체험을 찾는 검색» 으로 보고 걸지 않는다. */
  for (const [q, exp, reals] of [
    ['레몬', '도쿄 신주쿠 | 야키니쿠 신주쿠 야키니쿠 규탄노 레몬(신주쿠 야키니쿠 규탄노 레몬 본점) | 좌석 예약 전용',
      ['곰곰 칠레산 레몬', '상큼한 레모니아 미국산 칠레산 레몬, 120g 내외, 40개']],
    ['소금', '비엘리치카 소금 광산 투어', ['미원 맛소금', '백설 맛소금 250g']],
    ['마늘', '도쿄도 에비스 | 마늘 요리 Ninnikuya(にんにくや)| 좌석 예약 전용',
      ['국내산 햇 다진 마늘 물0% 첨가물 0%', '다진 마늘 (260g)']]
  ]) {
    const r = rank(q, [item(exp, 'ADPICK', 'KKday', 5000), ...reals.map((t, i) => item(t, '쿠팡', '', 9000 + i))]).ranked;
    check(idx(r, exp.slice(0, 10)) === r.length - 1, `${q}: 체험 글이 진짜 ${q} 아래다`, show(r));
  }
  const m = rank('꿀', [
    item('브라티슬라바 벌꿀술 및 꿀 시음회', 'ADPICK', 'KKday', 30000),
    item('천연 아카시아 벌꿀 꿀스틱 선물세트 [숙성 스틱 꿀 상견례 명절 추석 설날 설 교수님 선생님 선물 짜먹는 자연 토종 허니]', 'ADPICK', '예스이십사', 25000),
    item('1+ 등급 프리미엄 아카시아꿀 (500g)', 'ADPICK', '#풀무원', 25000)
  ]).ranked;
  check(m[0].title.indexOf('꿀스틱') > -1, '꿀: 시음회보다 진짜 꿀이 위다', show(m));
}

console.log('\n여행·체험을 찾는 검색과 실물을 파는 여행 판매처 글은 건드리지 않는다');
{
  const t = rank('오사카 투어', [
    item('[오사카] 10시간 전세 차량: 교토, 나라, 고베 맞춤 여행', 'ADPICK', 'KKday'),
    item('오사카 여행 가이드북 2026', '쿠팡', '')
  ]).ranked;
  check(t.every(it => !/sold-form/.test(it.relevanceWhy || '')), '오사카 투어: 검색어에 «투어» 가 있으면 감점이 없다', show(t));
  check(S.soldForm(item('[무료배송] 베라지 로마 여행용 기내/수하물 캐리어 (19/24/28인치)', 'ADPICK', '마이리얼트립')) === '',
    '마이리얼트립의 실물(캐리어)은 체험으로 보지 않는다');
  check(S.soldForm(item('[서울/중구] 내 손으로 직접 가죽공예 소품 만들기 (지갑, 여권케이스)', 'ADPICK', '마이리얼트립')) === 'experience',
    '마이리얼트립의 공방 체험은 체험으로 본다');
  check(S.soldForm(item('[기프트] 펜텔 0.5mm 메탈팁 슬림중성펜 에너겔', 'ADPICK', '교보문고')) === '',
    '교보문고의 [기프트] 상품은 책으로 보지 않는다');
}

console.log('\n기기 가방: «노트북 가방» 은 노트북 검색에서 부속이다');
{
  const { ranked } = rank('LG전자 LG그램 14ZD95U', [
    item('LG전자 2026 그램15 14ZD95U 노트북 가방 서류 초경량 방수 대용량', '쿠팡', '', 39000),
    item('(LG전자) LG 그램 AI AMD 14ZD95U-GX79K (Ryzen AI 7 450/32GB/256GB/FD) (Win11 Home FPP 설치)', '쿠팡', '', 1590000)
  ]);
  check(ranked[0].title.indexOf('GX79K') > -1, 'LG그램 14ZD95U: 노트북이 같은 모델명을 단 노트북 가방보다 위다', show(ranked));
  const dell = rank('델 XPS 15', [item('델 XPS 15인치 7590 i9 9세대 GTX1650 고성능 노트북 노트북가방+마우스', '쿠팡', '', 900000)]).ranked;
  check(!/device-bag/.test(dell[0].relevanceWhy || ''), '델 XPS 15: 가방이 «구성품» 인 노트북(따로 «노트북» 이 있다)은 내리지 않는다', show(dell));
  const bagQ = rank('노트북 가방', [item('LG전자 2026 그램15 14ZD95U 노트북 가방 서류 초경량 방수 대용량', '쿠팡', '')]).ranked;
  check(!/device-bag/.test(bagQ[0].relevanceWhy || ''), '노트북 가방: 가방을 찾는 검색에서는 내리지 않는다', show(bagQ));
  const vague = rank('남녀공용 방수 대용량', [item('남성 노트북 백팩 방수 대용량 여행', '쿠팡', '')]).ranked;
  check(!/device-bag/.test(vague[0].relevanceWhy || ''), '남녀공용 방수 대용량: 기기를 가리키지 않는 검색에서는 내리지 않는다', show(vague));
  const camBag = S.analyzeTitle('클레버250 카메라가방 DSLR백팩[헤이즐넛브라운]');
  check(S.deviceBagRelation('캐논 카메라', camBag, S.analyzeQuery('캐논 카메라')).factor < 1,
    '캐논 카메라: 「카메라가방 DSLR백팩」 은 부속이다');
  check(S.deviceBagRelation('카메라백 추천', camBag, S.analyzeQuery('카메라백 추천')).factor === 1,
    '카메라백 추천: 낱말 끝의 «백» 도 가방을 찾는 검색으로 읽는다');
}

console.log('\n«책상»·«책장» 은 책을 찾는 검색이 아니다');
{
  const book = item('[국내도서] 책상 위의 고양이', 'ADPICK', '교보문고');
  const desk = item('리바트 책상 1200', '쿠팡', '');
  check(S.soldFormContext('책상', [book, desk, desk]).has('book'), '책상: 책 감점이 켜진다');
  check(!S.soldFormContext('동화책', [book, desk, desk]).has('book'), '동화책: 책 감점이 꺼진다');
}

console.log('\n리퍼: «슬리퍼»·«드리퍼» 는 리퍼(재생품)가 아니다');
{
  check(S.stripConditionTerms('실내 슬리퍼') === '실내 슬리퍼', '«실내 슬리퍼» 검색어가 «실내 슬» 로 잘리지 않는다', S.stripConditionTerms('실내 슬리퍼'));
  check(S.stripConditionTerms('콜드브루 드리퍼') === '콜드브루 드리퍼', '«콜드브루 드리퍼» 검색어가 잘리지 않는다', S.stripConditionTerms('콜드브루 드리퍼'));
  check(S.conditionState('슬루나 층간소음 EVA 거실화 슬리퍼') === '', '슬리퍼 상품은 리퍼 상태가 아니다');
  check(S.conditionState('하리오 V60 드리퍼') === '' && S.conditionState('헤어 클리퍼 케이스') === '', '드리퍼·클리퍼 상품은 리퍼 상태가 아니다');
  check(S.conditionState('네이처리퍼블릭 알로에') === '' && S.conditionState('바나나 리퍼블릭 셔츠') === '', '리퍼블릭은 리퍼가 아니다');
  for (const t of ['[리퍼] LG 그램 15인치', 'S급리퍼 갤럭시 S24', '보증리퍼 아이패드', '공식리퍼 맥북', '갤럭시 리퍼폰']) {
    check(S.conditionState(t) === 'refurbished', `진짜 리퍼는 그대로 읽는다: 「${t}」`, S.conditionState(t));
  }
  const r = rank('실내 슬리퍼', [
    item('바나코 비비드 테리 룸 슬리퍼, Orange + Blue, 1개', '쿠팡', ''),
    item('슬루나 층간소음 EVA 거실화 슬리퍼', '쿠팡', '')
  ]);
  check(r.res.items.length === 2 && r.ranked.every(it => it.relevance > 0.3), '실내 슬리퍼: 슬리퍼가 0점으로 떨어지거나 빠지지 않는다', show(r.ranked));
}

console.log('\n화면 «리퍼» 뱃지도 같은 경계다 (_shop.detectCondition)');
{
  // detectCondition 은 fetchCoupang/fetchAdpick 안에서만 쓰여 export 되지 않는다 — 같은 식을 소스에서 읽어 확인한다.
  const src = require('fs').readFileSync(require('path').join(__dirname, '../api/_shop.js'), 'utf8');
  const m = /const REFURB_PATTERN\s*=\s*(\/.+\/i);/.exec(src);
  check(!!m, 'REFURB_PATTERN 을 찾았다');
  const re = m ? new Function(`return ${m[1]};`)() : /$^/;
  for (const t of ['도림 푹신한 EVA 슬리퍼', '하리오 V60 드리퍼', '헤어 클리퍼 케이스', '바나나 리퍼블릭 셔츠', '네이처리퍼블릭 알로에']) {
    check(!re.test(t), `뱃지 없음: 「${t}」`);
  }
  for (const t of ['[리퍼] LG 그램 15인치', 'S급리퍼 갤럭시', '[리퍼상품] 보랄 약탕기', 'refurbished iPad']) {
    check(re.test(t), `뱃지 있음: 「${t}」`);
  }
}

console.log(`\nSold-form ranking: ${pass}/${pass + fail} PASS, ${fail} FAIL. External calls: 0. DB queries: 0.`);
process.exit(fail ? 1 : 0);
