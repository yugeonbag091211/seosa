'use strict';
const assert = require('node:assert/strict');
const AIID = require('../api/_aiidentity');
const title = '[블라우풍트] 부모님 선물추천! 무선 이어폰/음성증폭기/헤어드라이기 外 인기템 핫딜';
const contract = AIID.buildContract({query:'무선 이어폰',userText:'15만원 이하 무선 이어폰 추천해줘',titles:[title]});
const promo = AIID.verdict(contract,{title});
assert.equal(promo.tier,AIID.TIER.MISMATCH,'multi-category roundup must never become an exact priced product');
assert.ok(promo.reasons.some(x=>x.kind==='product-type'),'fail must name the product-type discrepancy');
for (const accepted of [
 '아이리버 오픈형 무선 이어폰 IBO-OPENRING3 런닝 귀찌형',
 '블루투스 이어폰 USB-C/3.5mm 변환 패키지',
 'Apple AirPods Pro 3 USB-C/라이트닝',
 '무선 이어폰 오픈형 단일 상품 특별 구성'
]) {
  const c=AIID.buildContract({query:'무선 이어폰',userText:'무선 이어폰 추천해줘',titles:[accepted]});
  const v=AIID.verdict(c,{title:accepted});
  assert.ok(!v.reasons.some(x=>x.label.includes('프로모션 모음')),'not a multi-category roundup: '+accepted);
}
console.log('PASS mixed-category merchant promotions are not treated as a verified SKU: 5 cases');
