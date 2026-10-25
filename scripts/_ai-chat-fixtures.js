'use strict';
/*
 * 대화형 AI 시나리오의 고정 상품 (scripts/_ai-chat-harness.js addProduct 로 등록).
 *
 * 가격 기록은 상대 날짜(daysAgo)로만 적는다 — 굴러가는 KST 창 때문에 고정 날짜는 시한폭탄이다.
 * 같은 상품의 두 옵션(블랙·화이트)은 같은 productId 에 다른 vendorItemId 로 두고 가격도 다르게 둔다.
 */
function flat(n, price, dip) {
  const out = [];
  for (let d = 0; d < n; d++) out.push([d, dip && dip[d] ? dip[d] : price]);
  return out;
}

const GRAM_15 = {
  pid: 'G15', vid: 'G15-V1', mall: '쿠팡', title: 'LG전자 그램15 15ZB95N 인텔 i5 16GB 512GB 노트북',
  price: 645000, oprice: 899000, keys: ['그램', 'gram', '노트북'],
  history: flat(30, 699000, { 0: 645000, 1: 645000, 7: 659000, 14: 642000 })
};
const GRAM_16 = {
  pid: 'G16', vid: 'G16-V1', mall: '쿠팡', title: 'LG전자 그램16 16Z90S 인텔 울트라7 32GB 1TB 노트북',
  price: 1590000, oprice: 2190000, keys: ['그램', 'gram', '노트북'],
  history: flat(30, 1690000, { 0: 1590000, 3: 1620000 })
};
const GRAM_PRO = {
  pid: 'G17', vid: 'G17-V1', mall: '쿠팡', title: 'LG전자 그램 프로 17Z90SP RTX3050 32GB 1TB 노트북',
  price: 2190000, oprice: 2690000, keys: ['그램', 'gram', '노트북'],
  history: flat(20, 2290000, { 0: 2190000 })
};

const BUDS_BLACK = {
  pid: 'B3', vid: 'B3-BLACK', mall: '쿠팡', title: '삼성 갤럭시 버즈3 프로 블랙',
  price: 139000, oprice: 179000, keys: ['버즈', '이어폰', 'buds'],
  history: flat(20, 145000, { 0: 139000, 10: 135000, 11: 135000 })
};
const BUDS_WHITE = {
  pid: 'B3', vid: 'B3-WHITE', mall: '쿠팡', title: '삼성 갤럭시 버즈3 프로 화이트',
  price: 99000, oprice: 179000, keys: ['버즈', '이어폰', 'buds'],
  history: flat(12, 105000, { 0: 99000, 1: 99000 })
};
const QCY = {
  pid: 'Q13', vid: '', mall: 'ADPICK', mallLabel: '알리', title: 'QCY T13 ANC 무선 이어폰 블루투스 5.3',
  price: 25900, oprice: 25900, keys: ['이어폰', 'qcy'],
  history: flat(10, 25900)
};
const JBL = {
  pid: 'J2', vid: 'J2-V1', mall: '쿠팡', title: 'JBL 튠 비즈2 노이즈캔슬링 무선 이어폰',
  price: 89000, oprice: 129000, keys: ['이어폰', 'jbl'],
  history: flat(15, 95000, { 0: 89000 })
};
const SONY = {
  pid: 'S5', vid: 'S5-V1', mall: '쿠팡', title: '소니 WF-1000XM5 노이즈캔슬링 무선 이어폰',
  price: 289000, oprice: 359000, keys: ['이어폰', '소니', 'sony'],
  history: flat(20, 299000, { 0: 289000 })
};
const AIRPODS = {
  pid: 'AP2', vid: 'AP2-V1', mall: '쿠팡', title: 'Apple 에어팟 프로 2세대 USB-C',
  price: 329000, oprice: 359000, keys: ['에어팟', 'airpods'],
  history: flat(20, 339000, { 0: 329000 })
};

/*
 * 이름이 거의 같은 두 판매 글 (2026-10-24 Preview 실호출의 ADPICK 결과 모양). 한 문장에 이름과 가격을 함께
 * 적으면 그 금액이 어느 글의 것인지 가를 수 없다 — 그 문장이 빠져도 답이 추천 상품 이름을 잃지 않아야 한다.
 */
const OPENRING_A = {
  pid: 'OR3A', vid: '', mall: 'ADPICK', mallLabel: '11번가', title: '아이리버 오픈형 무선 이어폰 IBO-OPENRING3 러닝 귀찌형 오픈링3',
  price: 40410, oprice: 40410, keys: ['오픈형'], history: flat(10, 42000, { 0: 40410, 1: 40410 })
};
const OPENRING_B = {
  pid: 'OR3B', vid: '', mall: 'ADPICK', mallLabel: 'G마켓', title: '아이리버 오픈형 무선 이어폰 IBO-OPENRING3',
  price: 41900, oprice: 41900, keys: ['오픈형'], history: flat(10, 41900)
};

const ALL = [GRAM_15, GRAM_16, GRAM_PRO, BUDS_BLACK, BUDS_WHITE, QCY, JBL, SONY, AIRPODS, OPENRING_A, OPENRING_B];

module.exports = { GRAM_15, GRAM_16, GRAM_PRO, BUDS_BLACK, BUDS_WHITE, QCY, JBL, SONY, AIRPODS, OPENRING_A, OPENRING_B, ALL };
