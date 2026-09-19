'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
const live=html.replace(/<!--[sS]*?-->/g,'');

assert.equal((live.match(/<h1 class="hero-title">/g)||[]).length,1,'hero has one page-level H1');
assert.equal((live.match(/<h2 class="hero-title">/g)||[]).length,3,'other carousel headlines are H2');
assert.equal((live.match(/aria-roledescription="슬라이드" aria-label=/g)||[]).length,4,'all hero slides have accessible labels');

assert(!live.includes('<span class="hc-ans-p">248,000원</span>'),'fictional demo price is not shown next to a live affiliate link');
assert(live.includes('<span class="hc-ans-p">실시간 가격 확인</span>'),'demo affiliate card asks the user to verify live price');

assert(live.includes('nearHistoricalLow: !!s.nearHistoricalLow'),'near-low signal keeps its real meaning');
assert(!live.includes('isAllTimeLow: !!s.nearHistoricalLow'),'near-low is never relabeled as exact all-time low');
assert(live.includes('수집 최저가 근처'),'near-low user label is qualified');
assert(!live.includes('>수집 이후 최저</span>'),'exact-low wording is not used for a ±2% signal');

console.log('PASS site UI audit: heading hierarchy, demo price honesty, near-low semantics');
