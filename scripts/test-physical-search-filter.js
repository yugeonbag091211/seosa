#!/usr/bin/env node
'use strict';
// Offline regression: no provider, database, or AI calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { filterPhysicalSearchResults } = require('../api/_physical-search-filter');

const rows = [
  { title: 'BIRDPLAY 노트북 15.6인치 WIN11 8GB 256GB', mall: '쿠팡', lprice: 569900 },
  { title: '노트북 하나로 3억 번 AI 바이브코딩 사업의 모든것', mall: 'ADPICK', mallLabel: '크몽', lprice: 199000 },
  { title: 'AI 비서 제미나이LM(노트북LM) 완전 정복', mall: 'ADPICK', mallLabel: '인프런', lprice: 32170 },
  { title: '노코드 RAG 끝판왕 노트북 LM으로 지식 관리 마스터하기', mall: 'ADPICK', mallLabel: '인프런', lprice: 59400 },
  { title: '삼성 중고노트북 NT501R5L 128GB 4GB WIN11 Pro', mall: '쿠팡', lprice: 219000 },
  { title: '삼성 갤럭시북6 14인치 학생용 노트북', mall: '쿠팡', lprice: 1649000 },
  { title: '대학생 인강용 노트북 16GB', mall: '쿠팡', lprice: 600000 },
  { title: 'LG 그램 Pro AI 2026 노트북', mall: 'ADPICK', mallLabel: 'Hmall', lprice: 2640000 },
  { title: '휴대용 노트북 17인치', mall: 'ADPICK', mallLabel: '알리', lprice: 460500 }
];

const filtered = filterPhysicalSearchResults('노트북', rows);
assert.equal(filtered.length, 6);
assert.equal(Math.min(...filtered.map(item => item.lprice)), 219000);
assert.ok(filtered.some(item => /인강용/.test(item.title)));
assert.ok(filtered.every(item => !['인프런', '크몽'].includes(item.mallLabel)));
assert.equal(filterPhysicalSearchResults('laptop', rows).length, 6);
for (const query of ['노트북 강의', '노트북LM', '노트북 거치대']) {
  assert.equal(filterPhysicalSearchResults(query, rows).length, rows.length, query);
}
assert.equal(filterPhysicalSearchResults('카메라', [
  { title: '카메라 온라인 강좌', mall: '도서몰' },
  { title: '카메라 본품 4K', mall: '쿠팡' }
]).length, 1);
assert.deepEqual(filterPhysicalSearchResults('노트북', null), []);
const handler = fs.readFileSync(path.join(__dirname, '../api/search.js'), 'utf8');
assert.match(handler, /filterPhysicalSearchResults\(rawKeyword, items\)/);
console.log('Physical-device search digital-listing regression: PASS');
