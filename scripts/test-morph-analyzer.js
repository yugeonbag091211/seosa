#!/usr/bin/env node
/*
 * 형태소 분석기(키위) 통합 테스트 — 외부 호출 0회.
 *
 *   node scripts/test-morph-analyzer.js
 *
 * api/_morph-analyzer.js 로 실제 키위 모델을 띄우고, api/_search.js 에
 * setMorphProvider 로 꽂은 뒤 글자 매칭이 "진짜 형태소 경계"를 보고
 * 판단하는지 확인한다. 기존 scripts/test-search.js 는 분석기를 안 꽂은
 * 상태(기존 동작)를 지키는 회귀 테스트고, 이 파일은 분석기를 꽂았을 때
 * "새로 해결된 문제"와 "기존에 잘 되던 것이 안 깨졌는지"를 같이 본다.
 */
'use strict';

const path = require('path');
const S = require('../api/_search');
const M = require('../api/_morph-analyzer');

let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`); }
}
function section(name) { console.log(`\n${name}`); }

function score(keyword, title, titles) {
  const a = S.analyzeQuery(keyword, { titles: titles || [title] });
  return S.scoreTitle(a, title).score;
}

async function main() {
  console.log('키위 형태소 분석기 로딩 중...');
  const t0 = Date.now();
  await M.ensureReady();
  console.log(`로딩 완료 (${Date.now() - t0}ms), ready=${M.isReady()}`);

  if (!M.isReady()) {
    console.log('키위 로딩 실패 — 테스트를 건너뜁니다 (모델 파일 누락 가능성).');
    process.exit(1);
  }

  S.setMorphProvider(M.analyzeFlatSync);

  section('① 형태소 경계 밖 우연한 글자 겹침은 더 이상 높은 점수를 받지 않는다');
  /*
   * 2026-11-28: 처음엔 "경계 위반 = 0점(완전 거부)"이었는데, Codex가 운영
   * 제목 6,284건을 분석해보니 Kiwi가 진짜 복합어("롤방충망"·"볶음귀리")도
   * 사전에 없다는 이유로 한 덩어리로 묶어서 "방충망"·"귀리" 검색이 똑같이
   * 거부당하는 경우가 많았다(3,000건 재생 중 32건 실손실). 품사 태그만으로는
   * "스테어케이스"(진짜 하나의 외래어)와 "롤방충망"(사전에 없어서 못 쪼갠
   * 진짜 복합어)을 구별할 수 없어서, 거부 대신 감점(MORPH_BOUNDARY_DEMOTE)
   * 으로 재설계했다 — 완전히 숨기지는 않되 진짜 일치보다 한참 낮게 깐다.
   */
  check(
    score('케이스', '그랜드 스테어케이스 에스칼란테 자율 주행 오디오 투어') < 0.5,
    '"케이스" 검색 — "스테어케이스"(계단, 하나의 외래어 명사) 는 더 이상 높은 점수를 받지 않는다(감점만, 완전 거부는 아님)',
    score('케이스', '그랜드 스테어케이스 에스칼란테 자율 주행 오디오 투어')
  );

  check(
    score('케이스', '아이폰15 프로 맥스 실리콘 케이스 투명') >= 0.9,
    '"케이스" 검색 — 진짜 케이스 상품은 그대로 만점',
    score('케이스', '아이폰15 프로 맥스 실리콘 케이스 투명')
  );

  section('② 진짜 합성어는 형태소 경계가 일치해서 그대로 매칭된다 (회귀 방지)');

  check(
    score('햇빛', '솔라보 티타늄 코팅 자동차 앞유리 햇빛가리개 원터치') > 0,
    '"햇빛" 검색 — "햇빛가리개"는 "햇빛"+"가리개" 진짜 합성어라 그대로 매칭',
    score('햇빛', '솔라보 티타늄 코팅 자동차 앞유리 햇빛가리개 원터치')
  );

  check(
    score('가리개', '솔라보 티타늄 코팅 자동차 앞유리 햇빛가리개 원터치') > 0,
    '"가리개" 검색도 동일하게 매칭',
    score('가리개', '솔라보 티타늄 코팅 자동차 앞유리 햇빛가리개 원터치')
  );

  check(
    score('그래픽카드', 'RTX 4070 그래픽카드 12GB') >= 0.9,
    '진짜 그래픽카드(GPU)는 여전히 만점',
    score('그래픽카드', 'RTX 4070 그래픽카드 12GB')
  );

  section('③ api/search.js 가 실제로 쓰는 경로(rankItems, minScore:0)로도 재확인');
  /*
   * 2026-11-27: ①은 scoreTitle 을 직접 불렀는데, 실제 운영 배포에서 "케이스"
   * 검색에 "스테어케이스"가 그대로 남아 있었다 — scoreTitle 은 0점을 정확히
   * 냈지만, api/search.js 가 부르는 rankItems(keyword, items, {minScore:0})
   * 안의 digitOnlyLink 세이프넷이 "그래도 글자는 겹치니(canonicalKey 부분
   * 문자열) 봐주자"고 도로 살려줬기 때문 — ①의 score() 헬퍼는 이 경로를
   * 아예 거치지 않아서 로컬 테스트로는 못 잡았다. #279에서 digitOnlyLink를
   * 형태소 경계를 보게 고쳐서 한 번 막았었다.
   *
   * 2026-11-28 재설계 이후: "스테어케이스"는 이제 0점이 아니라 감점된 낮은
   * 점수(0.18)를 받으므로 digitOnlyLink(0점 전용 세이프넷)의 대상에서
   * 애초에 벗어난다 — 그래서 minScore:0 호출에서 "포함은 되지만 진짜
   * 케이스 상품보다 한참 아래"가 맞는 동작이다. 완전히 안 보이게 숨기던
   * 이전 동작으로 되돌아가면 안 된다(그건 "롤방충망"도 다시 숨긴다는 뜻).
   */
  (() => {
    const items = [
      { title: '아이폰15 프로 맥스 실리콘 케이스 투명', productId: 'real-case' },
      { title: '그랜드 스테어케이스 에스칼란테 자율 주행 오디오 투어', productId: 'stair-case' },
    ];
    const { items: kept } = S.rankItems('케이스', items, { minScore: 0 });
    const ids = kept.map(it => it.productId);
    check(
      ids.includes('real-case'),
      'rankItems(minScore:0) — 진짜 케이스 상품은 그대로 남음',
      ids
    );
    check(
      ids.includes('stair-case'),
      'rankItems(minScore:0) — "스테어케이스"는 이제 완전히 사라지지 않고 낮은 점수로 남는다(재설계 의도)',
      ids
    );
    const realScore = score('케이스', '아이폰15 프로 맥스 실리콘 케이스 투명');
    const stairScore = score('케이스', '그랜드 스테어케이스 에스칼란테 자율 주행 오디오 투어');
    check(
      stairScore < realScore * 0.3,
      '"스테어케이스" 점수가 진짜 케이스 상품보다 한참 낮다(최상단에 뜨지 않음)',
      { realScore, stairScore }
    );
  })();

  section('③-2 Codex 운영 재생에서 발견된 진짜 복합어 손실 복구 확인 (2026-11-28)');
  check(
    score('방충망', '루나텍스 미세방충망 롤방충망 창문용') > 0,
    '"방충망" 검색 — "롤방충망"(진짜 복합어, Kiwi가 한 덩어리로 오분석) 이제 다시 매칭됨',
    score('방충망', '루나텍스 미세방충망 롤방충망 창문용')
  );
  check(
    score('귀리', '건강한하루 볶음귀리 500g') > 0,
    '"귀리" 검색 — "볶음귀리"(진짜 복합어) 이제 다시 매칭됨',
    score('귀리', '건강한하루 볶음귀리 500g')
  );

  section('④ 기존 254개 회귀 테스트가 분석기를 꽂은 상태에서도 그대로 통과하는지');
  // 전체를 여기서 다시 돌리진 않되(별도 스크립트가 책임), 대표적으로
  // 분석기 도입 전 reverted 했던 두 핵심 케이스만 재확인한다.
  check(
    score('서큘레이터', '홈플래닛 에어 써큘레이터') > 0,
    'spelling-variant "써큘레이터"/"서큘레이터" 매칭 유지',
    score('서큘레이터', '홈플래닛 에어 써큘레이터')
  );

  S.setMorphProvider(null);

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('테스트 실행 중 오류:', err);
  process.exit(1);
});
