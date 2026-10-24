'use strict';
const assert = require('node:assert/strict');
const { rankItems } = require('../api/_shopintent');
const { laptopEvidence, compareLaptopEvidence } = require('../api/_laptop-evidence');

let checked = 0;
function test(name, fn) {
  fn();
  checked++;
  console.log('PASS ' + name);
}
function item(title, price) { return { title, price, hist: null, trust: null }; }
function ranked(rows, priority = 'quality', extra = {}) {
  return rankItems(rows.map(x => item(x.title, x.price)), { priority, ...extra }, '', {});
}

const oldGram = { title: 'LG전자 그램15 15ZB95N i5-1135G7 8G NVMe 512G', price: 645000 };
const newGram = { title: 'LG전자 그램15 i5-1335U RAM16GB SSD512GB', price: 845000 };

test('gram 11th generation and 8GB memory extracted from title', () => {
  assert.deepEqual(laptopEvidence(oldGram.title), { ramGb: 8, intel: { tier: 5, generation: 11 } });
});
test('gram 13th generation and 16GB memory extracted from title', () => {
  assert.deepEqual(laptopEvidence(newGram.title), { ramGb: 16, intel: { tier: 5, generation: 13 } });
});
test('the more expensive laptop wins only with comparable spec evidence', () => {
  const out = ranked([oldGram, newGram]);
  assert.equal(out[0].title, newGram.title);
  assert.ok(out[0].notes.some(n => /메모리 16GB/.test(n)));
  assert.ok(out[0].notes.some(n => /i5 13세대/.test(n)));
});
test('expensive without specs never receives a quality bonus', () => {
  const cheap = { title: 'LG전자 그램 15 일반형', price: 650000 };
  const expensive = { title: 'LG전자 그램 15 일반형 신상품', price: 1350000 };
  const out = ranked([cheap, expensive]);
  assert.equal(out[0].title, cheap.title);
  assert.equal(out[0]._score, out[1]._score);
});
test('price preference still favors cheaper candidate', () => {
  const out = ranked([newGram, oldGram], 'price');
  assert.equal(out[0].title, oldGram.title);
});
test('unknown memory is not treated as 16GB', () => {
  assert.equal(laptopEvidence('LG 그램 16인치 i5-1335U NVMe SSD 512G').ramGb, null);
  const got = compareLaptopEvidence([item(oldGram.title, 650000),
    item('LG 그램 16인치 i5-1335U SSD 512G', 900000)]);
  assert.equal(got[0].points, 0);
  assert.ok(got[1].points <= 4); // newer generation can receive a small non-benchmark tie-break
});
test('dedicated GPU VRAM is not mistaken for system RAM', () => {
  assert.equal(laptopEvidence('게이밍 노트북 RTX 4060 8G SSD 512G').ramGb, null);
});
test('Intel generation is never compared between i5 and i7 grades', () => {
  const got = compareLaptopEvidence([
    item('LG 그램 15 i5-1335U RAM16GB', 650000),
    item('LG 그램 15 i7-1165G7 RAM16GB', 700000)
  ]);
  assert.equal(got[0].points, 0);
  assert.equal(got[1].points, 0);
});
test('Intel CPU generation within i5 only is weak evidence', () => {
  const got = compareLaptopEvidence([
    item('LG 그램 15 i5-1135G7 RAM16GB', 650000),
    item('LG 그램 15 i5-1335U RAM16GB', 700000)
  ]);
  assert.equal(got[0].points, 0);
  assert.equal(got[1].points, 4);
});
test('Macbook and AMD not fabricated as Intel CPU grades', () => {
  assert.equal(laptopEvidence('Apple Macbook Air M3 16GB').intel, null);
  assert.equal(laptopEvidence('LG 그램 노트북 Ryzen 7 7730U RAM16GB').intel, null);
});
test('Korean word 프로그램 is not accidentally treated as 그램 laptop', () => {
  assert.equal(laptopEvidence('AI 프로그램 RAM16GB 소개 강좌'), null);
});
test('non-laptops never get notebook quality adjustment', () => {
  const got = compareLaptopEvidence([
    item('무선 이어폰 RAM16GB', 60000),
    item('무선 이어폰 RAM8GB', 35000)
  ]);
  assert.deepEqual(got.map(x => x.points), [0, 0]);
});
test('quality ranking never overrides firm budget eligibility', () => {
  const out = ranked([newGram, oldGram], 'quality', { budgetMax: 700000 });
  assert.equal(out[0].title, oldGram.title);
});
test('missing specs do not produce fake evidence notes', () => {
  const out = ranked([
    { title: 'LG전자 그램 15 노트북 A', price: 650000 },
    { title: 'LG전자 그램 15 노트북 B', price: 950000 }
  ]);
  assert.equal(out.filter(x => x.notes.some(n => /상품명 표기/.test(n))).length, 0);
});
console.log('LAPTOP_EVIDENCE_RANKING_PASS=' + checked);
