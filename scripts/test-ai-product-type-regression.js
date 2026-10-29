'use strict';

// Offline: exercise the same identity partition used to build recommendation cards.
const assert = require('assert');
const AIID = require('../api/_aiidentity');

const cases = [
  ['노트북 추천해줘', '노트북으로 돈버는 방법 온라인 교육', false],
  ['노트북 추천해줘', '실무 노트북 사용법 온라인 교육', false],
  ['노트북 추천해줘', '노트북 입문자를 위한 코딩 클래스', false],
  ['노트북 추천해줘', 'LG 울트라PC 15U50R 인텔 i5 8GB 256GB 노트북', true],
  ['아이패드 추천해줘', '아이패드 호환 애플펜슬 2세대', false],
  ['아이패드 추천해줘', '아이패드 에어 액정 디스플레이 교체 부품', false],
  ['갤럭시탭 추천해줘', '갤럭시탭 S9 호환 액정 패널 교체', false],
  ['아이패드 추천해줘', '애플 아이패드 프로 매직키보드', false],
  ['갤럭시탭 추천해줘', '갤럭시탭 호환 S펜 정품 스타일러스', false],
  ['갤럭시탭 추천해줘', '갤럭시탭 S9 S펜 정품', false],
  ['갤럭시탭 추천해줘', '갤럭시탭 S9 호환 스타일러스 펜촉 포함', false],
  ['아이패드 추천해줘', '아이패드 프로 호환 애플펜슬 여분 펜촉 증정', false],
  ['갤럭시탭 추천해줘', '갤럭시탭 S9 호환 매직키보드 키스킨 포함', false],
  ['아이패드 추천해줘', 'Apple 아이패드 에어 M2 11인치 128GB 본체 스마트펜 포함', true],
  ['갤럭시탭 추천해줘', '삼성 갤럭시탭 S9 태블릿 본체 S펜 포함', true],
  ['갤럭시탭 추천해줘', '삼성 갤럭시탭 S9 128GB S펜 포함', true],
  ['아이패드 추천해줘', 'Apple 아이패드 에어 M2 본체 매직키보드 포함', true],
  ['헤드셋 추천해줘', '무선 TWS 블루투스 이어버드 헤드셋', false],
  ['헤드폰 추천해줘', '무선 TWS 블루투스 이어버드 헤드폰', false],
  ['헤드셋 추천해줘', '소니 WH-CH520 블루투스 무선 헤드셋', true],
  ['이어폰 추천해줘', '애플 에어팟 맥스 헤드폰', false],
  ['이어폰 추천해줘', '삼성 갤럭시 버즈3 무선 이어폰', true]
];

let failures = 0;
for (const [question, title, expected] of cases) {
  const contract = AIID.buildContract({ query: question, userText: question, titles: [title] });
  const actual = AIID.partition([{ title }], contract).items.length > 0;
  try {
    assert.strictEqual(actual, expected);
    console.log('PASS', JSON.stringify(question), JSON.stringify(title));
  } catch (error) {
    failures++;
    console.error('FAIL', JSON.stringify(question), JSON.stringify(title), `expected=${expected} actual=${actual}`);
  }
}
console.log(`${cases.length - failures}/${cases.length} passed`);
if (failures) process.exitCode = 1;
