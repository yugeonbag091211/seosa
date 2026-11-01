'use strict';
const assert = require('node:assert/strict');
const { filterVerifiedLaptopSpecs, requestedExactScreenSize } = require('../api/_ai-laptop-hard-constraints');
const rows = [
  { title:'LG gram 15 노트북 16GB 512GB',lprice:1390000 },
  { title:'삼성전자 갤럭시북4 노트북 15인치 16GB',lprice:899000 },
  { title:'노트북 대여 렌탈 15인치',lprice:39000 },
  { title:'LG전자 그램14 14ZD90 노트북 16GB',lprice:999000 },
  { title:'LG gram 14 14ZD90 노트북 16GB',lprice:999000 }
];
const asked='학생용 가벼운 14인치 노트북 16GB, 삼성 말고 LG, 100만원 이하';
const matched=filterVerifiedLaptopSpecs(rows,asked);
assert.equal(matched.length,2,'exact 14 inch + requested LG must suppress 15 inch, Samsung and rental');
assert.ok(matched.every(x=>/14/.test(x.title)));
assert.equal(filterVerifiedLaptopSpecs(rows.slice(0,3),asked).length,0,'catalog without matching LG 14-inch laptop produces no candidate cards');
assert.deepEqual(filterVerifiedLaptopSpecs(rows,'15인치 이하 노트북 추천'),rows,'size range remains existing behavior');
assert.deepEqual(filterVerifiedLaptopSpecs(rows,'LG 노트북 100만원 이하 추천'),rows,'no exact diagonal means no additional filtering');
assert.equal(requestedExactScreenSize('LG 그램 14인치 추천')?.inches,14);
assert.equal(filterVerifiedLaptopSpecs([{title:'HP notebook i5 16GB'}],'HP 14인치 노트북 추천').length,0,'unverified screen size cannot be claimed');
console.log('PASS verified laptop screen size and affirmative brand: 6 checks');
