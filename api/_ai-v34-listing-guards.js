'use strict';
// AI v3.4 — listing integrity guards. Each guard is GENERIC (no question,
// product ID or title is special-cased) and each was added for a failure
// class found on the frozen V001-V100 run (docs/ai-v34-failure-analysis.md):
//   implausibly cheap device  — «노트북» at 12,590 won was an HDMI cable,
//                               at 12,500 won a laptop bag
//   carrier contract price    — «기기변경 완납 (공통지원)» 505,000 won is not
//                               the purchase price of a Galaxy S25 Ultra
//   mixed / bundle listing    — «G325 헤드셋 + G304 마우스» is not a G304 price
//   category store page       — «공기청정기/가습기/건조기 …브랜드!» is not one SKU
//   publication               — «기계식 키보드 처음 한 대를 고릅니다» is a book
//   colour option             — «버즈3 프로 화이트» must not show another colour
// They only REJECT candidates; they never add one.
const { explicitType } = require('./_ai-v31-taxonomy');
const { BRANDS, aliasRegex } = require('./_ai-v32-brands');
const { brandsFromUser } = require('./_ai-v31-retrieval');

// Minimum plausible price (KRW) of the DEVICE itself — far below real retail
// so that genuine cheap/old models pass; only accessories and junk fail.
const DEVICE_PRICE_FLOOR = { 노트북: 100000, 태블릿: 50000, 스마트폰: 50000, 모니터: 40000, 시계: 10000, 공기청정기: 10000,
  청소기: 15000, 헤드폰: 8000, 이어폰: 3000, 외장하드: 15000, 스피커: 3000, 키보드: 3000, 마우스: 2000 };
function implausiblyCheap(price, category) {
  const floor = DEVICE_PRICE_FLOOR[category];
  return floor != null && Number(price) > 0 && Number(price) < floor;
}

// (+ V070: «번호 그대로 통신사 유심 변경 특가» is a carrier-switch condition)
const CARRIER = /(?:기기\s*변경|번호\s*이동|신규\s*가입|요금제|공통\s*지원|선택\s*약정|약정\s*할인|완납|통신사\s*(?:유심\s*)?(?:변경|이동|전환)|유심\s*변경|(?<![a-z0-9])(?:kt|skt|sk\s*텔레콤|lg\s*u\s*\+|lgu\s*\+|유플러스)(?![a-z0-9]))/i;
const CARRIER_TYPES = new Set(['스마트폰', '태블릿', '시계']);
function carrierContract(title, category, userText = '') {
  return CARRIER_TYPES.has(category) && CARRIER.test(String(title || '')) && !CARRIER.test(String(userText || ''));
}

const SOLD = t => String(t || '').split(/\/(?:디지털기기|pc\/주변기기|생활\/가전)/i)[0];
const COLOR_WORD = /^(?:블랙|화이트|실버|그레이|블루|핑크|민트|퍼플|그린|레드|베이지|네이비|골드|라벤더|크림|아이보리|black|white|silver|gray|grey|blue|pink|mint|purple|green|red|beige|navy|gold)$/i;
// A bundle («A + B») or store page («A/B/C») of different product types.
function mixedListing(title, category, userText = '') {
  if (/(?:세트|번들|bundle|콤보|combo|패키지|구성)/i.test(String(userText || ''))) return false;
  const t = SOLD(title);
  const plusParts = t.split(/\s\+\s|(?<=[가-힣a-z0-9)\]])\s*\+\s*(?=[가-힣a-z])/i).map(s => s.trim()).filter(s => s.length >= 2);
  if (plusParts.length >= 2) {
    const types = new Set(plusParts.map(s => explicitType(s)).filter(Boolean));
    // keyboard+mouse sets are handled by the taxonomy's own combo rules
    if (types.size >= 2 && !(types.size === 2 && types.has('키보드') && types.has('마우스'))) return true;
  }
  // A slash joining two different manufacturer names describes a choice,
  // collection or promotion, not one verifiable SKU. Do not treat the
  // price of '삼성핏3/마샬 블루투스 스피커' as the price of either product.
  const chunks=t.split(/\s*\/\s*/).map(x=>x.trim()).filter(Boolean);
  // A compatibility tail ("Sony headphones / Samsung phone compatible")
  // is not evidence of two products being sold together.
  if(chunks.length>=2 && chunks.length<=5 &&
      !chunks.slice(1).some(part=>/(?:호환|전용|연결|지원|compatible|for\s+)/i.test(part))){
    const manufacturers=new Set(chunks.map(part=>{
      const match=BRANDS.find(([,aliases])=>aliases.some(alias=>aliasRegex(alias).test(part)));
      return match ? match[0] : '';
    }).filter(Boolean));
    if(manufacturers.size>=2)return true;
  }
  // «공기청정기/가습기/건조기 믿고사는 …»: three short category words in a row
  const m = t.match(/([가-힣]{2,6})\s*\/\s*([가-힣]{2,6})\s*\/\s*([가-힣]{2,6})/);
  if (m && ![m[1], m[2], m[3]].every(w => COLOR_WORD.test(w)) && [m[1], m[2], m[3]].some(w => explicitType(w) === category))
    return new Set([m[1], m[2], m[3]].map(w => explicitType(w) || w)).size >= 3;
  return false;
}
const PUBLICATION = /(?:도서|서적|교재|교본|입문서|가이드북|안내서|매거진|잡지|e-?book|이북|고릅니다|하는\s*법|의\s*모든\s*것|완벽\s*가이드|따라\s*하기|체험\s*(?:키트|클래스)|원데이\s*클래스)/i;
function publication(title) { return PUBLICATION.test(SOLD(title)); }
// A seller can keyword-stuff an unrelated device with a sought-after brand:
// '스마트헤드셋 V1000 ... 1위 헤드셋 소니 블루투스 헤드셋'.
// Only reject when an actual device+model is named BEFORE the promotional
// separator, while the requested maker appears ONLY in the keyword tail.
function promotionalKeywordStuffing(title, category, userText='') {
  const t=SOLD(title);
  const marker=/(?:\b\d+\s*위(?=\s|$)|최저\s*가|추천\s*키워드|인기\s*검색어|태그\s*:)/i.exec(t);
  if(!marker || marker.index<8)return false;
  const head=t.slice(0,marker.index),tail=t.slice(marker.index+marker[0].length);
  if(!explicitType(head)||!/(?<![a-z0-9])[a-z]{1,5}\d{2,5}(?![a-z0-9])/i.test(head))return false;
  const brands=brandsFromUser(userText,category);
  return brands.length>0 && brands.some(a=>aliasRegex(a).test(tail)) &&
    !brands.some(a=>aliasRegex(a).test(head));
}

// Colour the user asked for (positively). Synonym groups.
const COLORS = [
  ['white', /(?:화이트|흰색|하얀|white)/i], ['black', /(?:블랙|검정|검은색|black)/i], ['silver', /(?:실버|은색|silver)/i],
  ['gray', /(?:그레이|회색|gray|grey|그라파이트|graphite)/i], ['blue', /(?:블루|파란색|파랑|blue|네이비|navy)/i],
  ['pink', /(?:핑크|분홍|pink)/i], ['mint', /(?:민트|mint)/i], ['purple', /(?:퍼플|보라|purple|라벤더|lavender|라일락|lilac)/i],
  ['green', /(?:그린|초록|green)/i], ['red', /(?:레드|빨간|red)/i], ['gold', /(?:골드|gold)/i], ['beige', /(?:베이지|beige|크림|cream)/i]
];
function requestedColors(userText = '') {
  const s = String(userText || '');
  const out = [];
  for (const [name, re] of COLORS) {
    const m = re.exec(s);
    if (!m) continue;
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 8);
    if (/^\s*(?:은|는|이|가)?\s*(?:제외|말고|빼고|아닌|싫)/.test(after)) continue;
    out.push(name);
  }
  return out;
}
function colorMismatch(title, colors) {
  if (!colors || !colors.length) return false;
  const t = SOLD(title);
  return !colors.some(name => COLORS.find(([n]) => n === name)[1].test(t));
}
// One entry point for the engine/catalog. Returns a rejection reason or ''.
function listingGuard(item, { category, userText = '', checkColor = true } = {}) {
  const title = item && item.title;
  const price = item && (item.price == null ? item.lprice : item.price);
  if (publication(title)) return 'publication_not_device';
  if (carrierContract(title, category, userText)) return 'carrier_contract_price';
  if (mixedListing(title, category, userText)) return 'mixed_or_bundle_listing';
  if (promotionalKeywordStuffing(title, category, userText)) return 'promotional_keyword_stuffing';
  if (implausiblyCheap(price, category)) return 'implausible_device_price';
  if (checkColor && colorMismatch(title, requestedColors(userText))) return 'color_unverified';
  return '';
}
module.exports = { listingGuard, implausiblyCheap, carrierContract, mixedListing, promotionalKeywordStuffing, publication, requestedColors, colorMismatch, DEVICE_PRICE_FLOOR };
