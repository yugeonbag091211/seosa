'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
const live=html.replace(/<!--[\s\S]*?-->/g,'');

assert.equal((live.match(/<h1 class="hero-title">/g)||[]).length,1,'hero has one page-level H1');
assert.equal((live.match(/<h2 class="hero-title">/g)||[]).length,3,'other carousel headlines are H2');
assert.equal((live.match(/aria-roledescription="슬라이드" aria-label=/g)||[]).length,4,'all hero slides have accessible labels');

assert(!live.includes('<span class="hc-ans-p">248,000원</span>'),'fictional demo price is not shown next to a live affiliate link');
assert(live.includes('<span class="hc-ans-p">실시간 가격 확인</span>'),'demo affiliate card asks the user to verify live price');
assert(!live.includes('<span class="hc-rank">추천 1위</span>'),'static demo does not make a live ranking claim');
assert(live.includes('<span class="hc-rank">상품 예시</span>'),'static affiliate card is explicitly an example');

for (const [id,title] of [
  ['privacyOverlay','privacyTitle'],
  ['termsOverlay','termsTitle'],
  ['businessOverlay','businessTitle'],
  ['veteranOverlay','vetTitle']
]) {
  const openTag=new RegExp('<div class="overlay" id="'+id+'"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="'+title+'"');
  assert(openTag.test(live),id+' is an accessible dialog');
}
assert(live.includes("o.classList.add('open');"),'policy dialog open path makes overlays visible');
assert(live.includes("o.classList.remove('open');"),'policy dialog close path removes visible state');
assert(live.includes("Focus.enter(id);"),'policy dialogs move focus inside');
assert(live.includes("Focus.leave();"),'policy dialogs restore focus on close');

assert(live.includes('nearHistoricalLow: !!s.nearHistoricalLow'),'near-low signal keeps its real meaning');
assert(!live.includes('isAllTimeLow: !!s.nearHistoricalLow'),'near-low is never relabeled as exact all-time low');
assert(live.includes('수집 최저가 근처'),'near-low user label is qualified');
assert(!live.includes('>수집 이후 최저</span>'),'exact-low wording is not used for a ±2% signal');

assert(!live.includes('역대 최저가 수준 · 지금이 기회'),'local fallback never overstates a range position as all-time low');
assert(!live.includes('평균보다 저렴 · 사기 좋은 시점'),'local fallback does not make a buy recommendation without server verdict');
assert(live.includes('수집 가격대 하단 · 현재는 낮은 편이에요'),'local fallback uses descriptive price language');

console.log('PASS site UI audit: headings, dialogs, demo honesty, price-claim semantics');
