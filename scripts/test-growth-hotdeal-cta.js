'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const live = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// 홈 첫 배너는 직접 구매 관심이 높은 핫딜로 이어져야 한다.
const firstSlide = live.match(/<div class="hc-slide on"[\s\S]*?<div class="hero-art">/);
assert(firstSlide, '첫 배너가 있어야 한다');
assert(firstSlide[0].includes('data-act="scroll-drop"'), '첫 배너 CTA는 핫딜로 이동');
assert(firstSlide[0].includes('지금 가격 하락 상품 보기'), '첫 배너에 핫딜 CTA를 표기');

// 구매 버튼과 제휴 고지는 기존대로 유지한다.
assert(live.includes('data-act="ledger-buy"'), '핫딜 구매 버튼 유지');
assert(live.includes("Track.affiliate(info, 'hotdeal')"), '구매 클릭 추적 유지');
assert(live.includes('data-aff-note="priceDrop"'), '제휴 고지 유지');

// 모바일 네이티브 공유 / 데스크톱 링크 복사를 모두 지원한다.
assert(live.includes('data-act="share-hotdeals"'), '핫딜 공유 버튼');
assert(live.includes("'share-hotdeals': function()"), '공유 버튼 핸들러');
assert(live.includes('navigator.share({'), '모바일 네이티브 공유');
assert(live.includes('navigator.clipboard.writeText(url)'), '데스크톱 링크 복사');
assert(live.includes('utm_campaign=hotdeal#priceDrop'), '핫딜 공유 링크');
assert(live.includes("location.hash === '#priceDrop'"), '공유 링크로 들어왔을 때 핫딜 이동');
assert(live.includes("if (loading && loading.style.display !== 'none')"), '로드 중 핫딜로 이동');
assert(live.includes("var today = $('today');"), '핫딜이 없으면 정상 셀렉션으로 이동');
console.log('PASS: growth-hotdeal-cta (hero, share, fallback, affiliate tracking)');
