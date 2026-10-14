#!/usr/bin/env node
'use strict';
/*
 * Matcher evidence v2 (api/_offeridentity.js, 2026-10-14) — 외부 호출 0회, DB 0회.
 *
 *   node scripts/test-offer-matcher-evidence.js
 *
 * 이 파일이 지키는 것: **더 많이 MATCH 하되, 다른 상품은 끝까지 다르다.**
 *
 *   A. HyperX 오멘 MAX 16-AH1075TX — 롯데·Hmall·SSG·오늘의집 실제 표기. 왜 MATCH/REVIEW 인지 근거까지 고정
 *   B. CPU · GPU — 표기 정규화와 SKU 보존 (270HX ≠ 270HXPlus · 5070 ≠ 5070 Ti · «울트라7» 은 계열만)
 *   C. RAM · 저장 용량 — 32G = 32GB · 1T = 1TB = 1024GB, 정확한 용량 충돌은 그대로
 *   D. 색 정책 — 모델번호 계열에 색이 둘 이상 관측되면 «양쪽 색 미표기» 는 REVIEW
 *   E. 설명 낱말 — 강한 모델번호 + 옵션 일치일 때만, 검토된 광고 문구와 한쪽 꼬리표만 무시
 *   F. 판매처 번호 꼬리 · 브랜드 표
 *   G. 정규 식별 · 스냅숏 — CPU·GPU 를 담고, 컴퓨터가 아닌 상품의 스냅숏은 그대로
 *
 * ★ 기대값은 «실제로 같은 상품인가» 로 정했다. HyperX 를 억지로 합치지 않는다.
 */

const assert = require('assert');
// 뮤테이션 검사(scripts/test-offer-matcher-evidence-mutations.js)가 약하게 만든 사본을 끼운다.
const O = require(process.env.OFFER_IDENTITY_MODULE || '../api/_offeridentity');
const P = require(process.env.OFFER_PROMOTION_MODULE || '../api/_identitypromotion');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let seq = 0;
const offer = (title, mall) => O.parseOffer({ key: `k${++seq}`, title, mall: mall || 'ADPICK/SSG', productId: `p${seq}` });
const judge = (list, a, b) => O.matchOffers(a, b, O.contextFactory(list)(a, b));
const pair = (ta, tb) => { const a = offer(ta, 'ADPICK/SSG'), b = offer(tb, 'ADPICK/Hmall'); return judge([a, b], a, b); };
const brief = r => `${r.decision} c=[${r.conflicts.join(';')}] u=[${r.unknown.join(';')}] e=[${r.evidence.join(';')}]`;

/* ==================================================================
 *  A. HyperX 오멘 MAX 16-AH1075TX
 * ================================================================== */
console.log('=== A. HyperX ===');
{
  const lotte = offer('HyperX 오멘 MAX 16-AH1075TX U7-270HXPlus RTX5070Ti 32G/1TB 2.5K 240Hz 고사양 게이밍 노트북', 'ADPICK/롯데홈쇼핑');
  const hmall = offer('HyperX 오멘 MAX 16-AH1075TX U7-270HXPlus RTX5070Ti 32G/1TB 2.5K 240Hz 고사양 게이밍 노트북', 'ADPICK/Hmall');
  const ssg = offer('[HP] HyperX 오멘 MAX 16-AH1075TX U7-270HXPlus RTX5070Ti 32G/1TB 2.5K 240Hz 고사양 게이밍 노트북[이마트몰] [16-AH1075TX]', 'ADPICK/SSG');
  const house = offer('HP HyperX 오멘 MAX 16-AH1075TX 울트라7 RTX5070Ti 32G 1TB', 'ADPICK/오늘의집');
  const all = [lotte, hmall, ssg, house];

  ok(same(hmall.modelNumbers, ['16ah1075tx']), 'CPU·GPU 는 제품 모델번호가 아니다 — 모델번호는 16ah1075tx 하나', hmall.modelNumbers.join('/'));
  ok(same(hmall.cpu, ['ultra7-270hxplus']) && same(hmall.gpu, ['rtx5070ti']), 'U7-270HXPlus → ultra7-270hxplus · RTX5070Ti → rtx5070ti', `${hmall.cpu} ${hmall.gpu}`);
  ok(same(hmall.memory, ['32gb']) && same(hmall.storage, ['1024gb']), '노트북의 32G/1TB → RAM 32GB · 저장 1TB', `${hmall.memory} ${hmall.storage}`);
  ok(same(house.cpu, ['ultra7']), '«울트라7» 은 계열만 안다 (ultra7)', house.cpu.join('/'));
  ok(!house.anchors.length && !house.variants.length, '«울트라7» 이 모델 번호 7 + 등급 ultra 로 읽히지 않는다 (MAX 오염 없음)', `${house.anchors} ${house.variants}`);
  ok(ssg.brand === 'hp' && house.brand === 'hp' && !ssg.words.includes('hp'), '[HP] · HP 는 브랜드다 — 낱말로 남지 않는다');

  const lh = judge(all, lotte, hmall);
  ok(lh.decision === 'MATCH' && lh.tier === 'A', '롯데홈쇼핑 ↔ Hmall: 같은 SKU 모델번호 · 같은 옵션 → MATCH', brief(lh));
  const hs = judge(all, hmall, ssg);
  ok(hs.decision === 'MATCH' && hs.evidence.includes('brand_omitted_one_side'), 'Hmall ↔ SSG: [HP] 는 한쪽만 적은 브랜드 → MATCH', brief(hs));
  const hh = judge(all, hmall, house);
  ok(hh.decision === 'REVIEW' && hh.conflicts.length === 0, 'Hmall ↔ 오늘의집: 충돌은 없지만 확정할 근거가 모자라다 → REVIEW', brief(hh));
  ok(hh.unknown.includes('cpu_detail'), '오늘의집 REVIEW 근거 1: CPU 는 계열(울트라7)만 — 270HXPlus 인지 제목만으로 모른다', brief(hh));
  ok(hh.unknown.includes('size_hz') && hh.unknown.includes('size_k'), '오늘의집 REVIEW 근거 2: 2.5K · 240Hz 가 한쪽에만 적혀 있다', brief(hh));
  ok(hh.evidence.some(e => e.startsWith('descriptor_words_only:')), '«고사양 · 게이밍» 은 설명 문구로 본다 (REVIEW 의 이유가 아니다)', brief(hh));

  const res = O.clusterOffers(all);
  const home = k => res.groups.find(g => g.members.includes(k)).id;
  ok(home(lotte.key) === home(hmall.key) && home(hmall.key) === home(ssg.key), '군집: 롯데 · Hmall · SSG 가 한 군집');
  ok(home(house.key) !== home(hmall.key), '군집: 오늘의집은 따로 (REVIEW 는 군집 조건이 아니다)');
}

/* ==================================================================
 *  B. CPU · GPU
 * ================================================================== */
console.log('=== B. CPU · GPU ===');
{
  [['Intel Core Ultra 7 270HX 노트북', ['ultra7-270hx']], ['Core Ultra7 270HX 노트북', ['ultra7-270hx']], ['Ultra 7 270HX 노트북', ['ultra7-270hx']],
    ['U7-270HX 노트북', ['ultra7-270hx']], ['U7-270HXPlus 노트북', ['ultra7-270hxplus']], ['인텔 코어 울트라7 155H 노트북', ['ultra7-155h']],
    ['울트라7 노트북', ['ultra7']], ['i7-14700HX 노트북', ['i7-14700hx']], ['코어 i5 1335U 노트북', ['i5-1335u']],
    ['라이젠5 7500F 조립PC', ['ryzen5-7500f']], ['R7-8845HS 노트북', ['ryzen7-8845hs']], ['인텔 i5 2024년형 노트북', ['i5']]
  ].forEach(([t, want]) => { const x = offer(t); ok(same(x.cpu, want), `CPU «${t}» → ${want}`, x.cpu.join('/')); });
  [['RTX5070Ti 노트북', ['rtx5070ti']], ['RTX 5070 Ti 노트북', ['rtx5070ti']], ['GeForce RTX 5070 Ti 노트북', ['rtx5070ti']],
    ['지포스 RTX 5070 Ti 노트북', ['rtx5070ti']], ['RTX 5070 노트북', ['rtx5070']], ['RX 7600 XT 데스크탑', ['rx7600xt']]
  ].forEach(([t, want]) => { const x = offer(t); ok(same(x.gpu, want), `GPU «${t}» → ${want}`, x.gpu.join('/')); });

  const card = offer('MSI 지포스 RTX5070Ti 게이밍 트리오 OC 16GB');
  ok(!card.gpu.length && card.modelNumbers.includes('rtx5070ti') && same(card.storage, ['16gb']) && !card.memory.length,
    '그래픽카드(컴퓨터 아님)는 칩이 곧 상품 — 예전대로 모델번호, 16GB 는 그대로', `${card.gpu} ${card.modelNumbers} ${card.storage}`);
  const spaced = offer('MSI 지포스 RTX 5070 Ti 게이밍 트리오 OC 16GB');
  ok(!spaced.gpu.length && same(spaced.storage, ['16gb']), '띄어 쓴 그래픽카드 제목도 부품 분리를 하지 않는다 (예전과 같다)', `${spaced.gpu} ${spaced.storage}`);
  const phone = offer('삼성전자 갤럭시 S25 울트라 5G 256GB 티타늄 블랙 자급제 SM-S938N');
  ok(!phone.cpu.length && phone.variants.includes('ultra') && phone.modelNumbers.includes('sms938n'),
    '휴대폰 «S25 울트라 5G» 의 «울트라 5» 는 CPU 가 아니다 — 등급 ultra 가 남는다', `${phone.cpu} ${phone.variants} ${phone.modelNumbers}`);
  const tablet = offer('삼성 갤럭시탭 S10 울트라 5G 512GB SM-X926N');
  ok(!tablet.cpu.length && tablet.variants.includes('ultra'), '태블릿 «울트라 5G» 도 마찬가지', `${tablet.cpu} ${tablet.variants}`);
  const watch = offer('Apple 애플워치 울트라 3 49mm 티타늄 블랙 MX4P3KH/A');
  ok(!watch.cpu.length && watch.variants.includes('ultra') && same(watch.anchors, ['3']),
    '«애플워치 울트라 3» 의 맨 «울트라 3» 은 CPU 가 아니다 (코어·인텔 머리가 없다)', `${watch.cpu} ${watch.variants} ${watch.anchors}`);
  // «노트북» 낱말이 없는 쿠팡식 제목 — «코어Ultra5» 처럼 코어·인텔 머리가 붙은 계열 표기는 CPU 이고 컴퓨터의 근거다.
  const yoga5 = offer('레노버 2024 요가 슬림 7 14IMH9 코어Ultra5 인텔 14세대, Luna Grey, 512GB, 16GB, WIN11 Home');
  ok(same(yoga5.cpu, ['ultra5']) && yoga5.computer && same(yoga5.memory, ['16gb']) && same(yoga5.storage, ['512gb']),
    '«코어Ultra5 … 512GB, 16GB» → CPU 계열 ultra5 · RAM 16GB · 저장 512GB', `${yoga5.cpu} ${yoga5.memory} ${yoga5.storage}`);
  const yoga = pair('레노버 2024 요가 슬림 7 14IMH9 코어Ultra5 인텔 14세대', '레노버 2024 요가 슬림 7 14IMH9 코어Ultra7 인텔 14세대');
  ok(yoga.decision === 'NO_MATCH' && yoga.conflicts.some(c => c.startsWith('cpu_mismatch')), '코어Ultra5 ≠ 코어Ultra7 (계열이 다르면 충돌)', brief(yoga));
  const partCard = offer('기가바이트 지포스 RTX 4090 Gaming OC D6X 24GB GV-N4090GAMING OC-24GD');
  ok(same(partCard.gpu, ['rtx4090']) && !partCard.modelNumbers.some(c => c.startsWith('rtx')), '강한 부품번호가 있으면 그쪽이 상품 — 칩은 부품', `${partCard.gpu} ${partCard.modelNumbers}`);

  const conflictOf = (ta, tb, tag) => { const r = pair(ta, tb); ok(r.decision === 'NO_MATCH' && r.conflicts.some(c => c.startsWith(tag)), `${tag}: «${ta}» ↔ «${tb}»`, brief(r)); };
  conflictOf('HP 오멘 MAX 16-AH1075TX 울트라7 270HX RTX5070Ti 32GB 1TB 노트북', 'HP 오멘 MAX 16-AH1075TX U7-270HXPlus RTX5070Ti 32GB 1TB 노트북', 'cpu_mismatch');
  conflictOf('삼성 갤럭시북5 프로 NT960XHA 울트라7 155H 16GB 512GB 노트북', '삼성 갤럭시북5 프로 NT960XHA 울트라7 258V 16GB 512GB 노트북', 'cpu_mismatch');
  conflictOf('MSI 크로스헤어 16 A14VGK i7-14700HX RTX4070 16GB 1TB 노트북', 'MSI 크로스헤어 16 A14VGK 울트라7 270HX RTX4070 16GB 1TB 노트북', 'cpu_mismatch');
  conflictOf('ASUS ROG Strix G16 G614JV RTX4060 16GB 1TB 노트북', 'ASUS ROG Strix G16 G614JV RTX5070Ti 16GB 1TB 노트북', 'gpu_mismatch');
  conflictOf('ASUS ROG Strix G16 G614JV RTX5070 16GB 1TB 노트북', 'ASUS ROG Strix G16 G614JV RTX 5070 Ti 16GB 1TB 노트북', 'gpu_mismatch');
  conflictOf('레노버 리전 5 16IRX9 i7-14650HX RTX4060 16GB 1TB 노트북', '레노버 리전 5 16IRX9 i7-14650HX RTX4060Ti 16GB 1TB 노트북', 'gpu_mismatch');
  conflictOf('ASUS 젠북 14 UX3405MA 울트라5 16GB 512GB 노트북', 'ASUS 젠북 14 UX3405MA 울트라7 16GB 512GB 노트북', 'cpu_mismatch');

  const detail = pair('HP 오멘 MAX 16-AH1075TX U7-270HXPlus RTX5070Ti 32GB 1TB 노트북', 'HP 오멘 MAX 16-AH1075TX 울트라7 RTX5070Ti 32GB 1TB 노트북');
  ok(detail.decision === 'REVIEW' && same(detail.unknown, ['cpu_detail']), '다른 값이 다 같아도 CPU 가 계열만이면 REVIEW (cpu_detail 하나)', brief(detail));
  const sameGpu = pair('ASUS ROG Strix G16 G614JV RTX 5070 Ti 16GB 1TB 노트북', 'ASUS ROG Strix G16 G614JV GeForce RTX5070Ti 16GB 1TB 노트북');
  ok(sameGpu.decision === 'MATCH', 'GPU 표기만 다르면(RTX 5070 Ti = GeForce RTX5070Ti) 같다', brief(sameGpu));
  const oneGpu = pair('ASUS ROG Strix G16 G614JV RTX4060 16GB 1TB 노트북', 'ASUS ROG Strix G16 G614JV 16GB 1TB 노트북');
  ok(oneGpu.decision === 'REVIEW' && oneGpu.unknown.includes('gpu') && !oneGpu.conflicts.length, 'GPU 한쪽만 → REVIEW (모르는 값은 와일드카드가 아니다)', brief(oneGpu));
}

/* ==================================================================
 *  C. RAM · 저장 용량
 * ================================================================== */
console.log('=== C. RAM · 저장 용량 ===');
{
  const forms = ['LG 그램 16Z90S-GA5BK 울트라5 32G/1TB 노트북', 'LG 그램 16Z90S-GA5BK 울트라5 32GB RAM 1TB 노트북',
    'LG 그램 16Z90S-GA5BK 울트라5 32GB 1TB 노트북', 'LG 그램 16Z90S-GA5BK 울트라5 32GB 1024GB 노트북', 'LG 그램 16Z90S-GA5BK 울트라5 32GB SSD 1T 노트북'];
  forms.forEach(t => { const x = offer(t); ok(same(x.memory, ['32gb']) && same(x.storage, ['1024gb']), `«${t}» → RAM 32GB · 저장 1TB`, `${x.memory} ${x.storage}`); });
  const r = pair(forms[0], forms[3]);
  ok(r.decision === 'MATCH', '32G/1TB 와 32GB 1024GB 는 같은 옵션', brief(r));
  const noGpu = offer('ASUS ROG Strix G16 G614JV 16GB 1TB 노트북');
  ok(same(noGpu.memory, ['16gb']) && same(noGpu.storage, ['1024gb']), 'CPU·GPU 를 안 적은 노트북도 16GB 는 RAM', `${noGpu.memory} ${noGpu.storage}`);
  const ram = pair('LG 그램 16Z90S-GA5BK 울트라5 16GB 512GB 노트북', 'LG 그램 16Z90S-GA5BK 울트라5 32GB 512GB 노트북');
  ok(ram.decision === 'NO_MATCH' && ram.conflicts.some(c => c.startsWith('memory_mismatch')), 'RAM 16GB ≠ 32GB', brief(ram));
  const ssd = pair('LG 그램 16Z90S-GA5BK 울트라5 16GB 512GB 노트북', 'LG 그램 16Z90S-GA5BK 울트라5 16GB 1TB 노트북');
  ok(ssd.decision === 'NO_MATCH' && ssd.conflicts.some(c => c.startsWith('storage_mismatch')), 'SSD 512GB ≠ 1TB', brief(ssd));
  const phone = offer('Apple 아이폰 17 Pro 256GB 블랙 자급제');
  ok(same(phone.storage, ['256gb']) && !phone.memory.length, '휴대폰 용량은 그대로 저장 용량', `${phone.storage} ${phone.memory}`);
}

/* ==================================================================
 *  D. 색 정책
 * ================================================================== */
console.log('=== D. 색 정책 ===');
{
  const black = offer('로지텍 G304 LIGHTSPEED 무선 게이밍 마우스 블랙', 'ADPICK/SSG');
  const white = offer('로지텍 G304 LIGHTSPEED 무선 게이밍 마우스 화이트', 'ADPICK/GS SHOP');
  const x = offer('로지텍 G304 LIGHTSPEED 무선 게이밍 마우스', 'ADPICK/Hmall');
  const y = offer('로지텍코리아 G304 LIGHTSPEED 무선 게이밍 마우스', 'ADPICK/롯데홈쇼핑');
  const withColors = judge([black, white, x, y], x, y);
  ok(withColors.decision === 'REVIEW' && withColors.unknown.includes('color'),
    '같은 모델번호에 색이 둘 이상 관측되면 «양쪽 색 미표기» 는 REVIEW', brief(withColors));
  const alone = judge([x, y], x, y);
  ok(alone.decision === 'MATCH', '색 관측이 없으면 «양쪽 미표기» 를 과하게 떨어뜨리지 않는다', brief(alone));
  const black2 = offer('로지텍 G304 LIGHTSPEED 무선 게이밍 마우스 블랙', 'ADPICK/오늘의집');
  const bothBlack = judge([black, white, x, y, black2], black, black2);
  ok(bothBlack.decision === 'MATCH', '양쪽 모두 같은 색이면 문제 없다', brief(bothBlack));

  // 한 판매 글 안의 «그레이스 브라운» 은 색 이름 하나인데 두 색으로 읽힌다 — 그것만으로 «색이 여럿» 이라고 하지 않는다.
  const grace = offer('쿠쿠 냄새 연기 걱정없는 전기 양면 멀티 그릴 생선구이기 CFR-332GB (그레이스 브라운)', 'ADPICK/더블유컨셉코리아');
  const c1 = offer('쿠쿠 CFR-332GB 멀티양면그릴 생선구이기', 'ADPICK/Hmall');
  const c2 = offer('쿠쿠 CFR-332GB 멀티양면그릴 생선구이기', 'ADPICK/SSG');
  ok(judge([grace, c1, c2], c1, c2).decision === 'MATCH', '여러 색이 읽히는 판매 글 하나는 색 차원의 근거가 아니다', brief(judge([grace, c1, c2], c1, c2)));

  // 본품과 그 모델용 부속은 다른 계열 — 본품 색이 부속 쌍의 문맥으로 번지지 않는다.
  const mainA = offer('소니 WH-1000XM6 블랙'), mainB = offer('소니 WH-1000XM6 플래티넘 실버');
  const padA = offer('소니 WH-1000XM6 이어패드 교체용', 'ADPICK/Hmall'), padB = offer('WH-1000XM6 이어패드 교체용', 'ADPICK/SSG');
  const dims = O.contextFactory([mainA, mainB, padA, padB])(padA, padB).lineDimensions;
  ok(!dims.has('color'), '부속 쌍의 문맥에는 본품 계열의 색 차원이 없다', [...dims].join('/'));
}

/* ==================================================================
 *  E. 설명 낱말 (강한 모델번호일 때만)
 * ================================================================== */
console.log('=== E. 설명 낱말 ===');
{
  const desc = pair('소니 WH-1000XM5 블랙', '[공식대리점] 소니 노이즈캔슬링 무선 헤드폰 WH-1000XM5 블랙');
  ok(desc.decision === 'MATCH' && desc.evidence.some(e => e.startsWith('descriptor_words_only:')), '강한 모델번호 + 광고 문구만 다름 → MATCH', brief(desc));
  const tag = pair('[빈폴레이디스] 해리스 트위드 세미오버핏 재킷 카키 (BF6911C32H)', '해리스 트위드 세미오버핏 재킷 카키 (BF6911C32H)');
  ok(tag.decision === 'MATCH' && tag.evidence.some(e => e.includes('tag:')), '한쪽에만 붙은 맨 앞 꼬리표는 판매처 표기로 본다', brief(tag));
  const twoTags = pair('[케이맘] 유리창 청소 자석 창문닦이 P700012', '[맥킨더] 유리창 청소 자석 창문닦이 P700012');
  ok(twoTags.decision === 'REVIEW', '양쪽 꼬리표가 서로 다르면(다른 판매처·브랜드일 수 있다) REVIEW', brief(twoTags));
  const other = pair('신일 핸드블랜더 SMX-HB505WK', '신일 핸드블랜더 풀세트 SMX-HB505WK');
  ok(other.decision === 'REVIEW' && other.unknown.some(u => u.startsWith('title_words')), '사전에 없는 낱말(풀세트)은 그대로 REVIEW', brief(other));
  const weak = pair('로지텍코리아 공식 G304 X SUPERLIGHT 게이밍 마우스 화이트', '로지텍 G304 X SUPERLIGHT (화이트) 무선 마우스');
  ok(weak.decision === 'REVIEW', '짧은 계열 코드(G304)에는 설명 낱말 예외를 쓰지 않는다', brief(weak));
  const install = pair('삼성전자 네오QLED KQ85QNH70AFXKR 스탠드형', '삼성전자 네오QLED KQ85QNH70AFXKR 벽걸이형');
  ok(install.decision === 'REVIEW', '강한 모델번호가 같아도 설치 형태(벽걸이형/스탠드형)는 설명 문구가 아니다', brief(install));
  const wired = pair('젠하이저 IE100 PRO Wired 모니터링 유선이어폰', '젠하이저 IE100 PRO Wireless 모니터링 무선이어폰');
  ok(wired.decision !== 'MATCH', '유선 ↔ 무선은 같은 상품이 아니다', brief(wired));
  const lex = O._internal.DESCRIPTOR_WORDS;
  ['lightspeed', 'superlight', '스탠드형', '벽걸이형', '여성', '남성', '유선', '유무선', '적축', '풀세트', '라일락', 'tpu', 'edge', 'v:mini'].forEach(w =>
    ok(!lex.has(w), `«${w}» 는 설명 낱말 사전에 없다 (SKU 를 가른다)`));
  ok(O._internal.strongProductCode('16ah1075tx') && O._internal.strongProductCode('bf6911c32h') && !O._internal.strongProductCode('g304')
    && !O._internal.strongProductCode('rtx5070ti') && !O._internal.strongProductCode('i714650hx'), '강한 모델번호: SKU 코드는 예, 짧은 계열 코드·칩 이름은 아니오');
}

/* ==================================================================
 *  F. 판매처 번호 꼬리 · 브랜드
 * ================================================================== */
console.log('=== F. 판매처 번호 · 브랜드 ===');
{
  const s = offer('[셀러허브] 바투 로잉머신 RM1060 홈트레이닝 홈짐 헬스용품 (S50671126)[이마트몰] [50671126]');
  ok(!s.words.includes('s') && s.longNumbers.includes('50671126'), '«(S50671126)» 의 S 는 낱말이 아니라 판매처 번호의 일부', s.words.join(','));
  const p = offer('[컴핏비너스] 제로터치 드로즈 2컬러 YSETM010_P334379316');
  ok(!p.words.includes('p') && p.modelNumbers.includes('ysetm010'), '«_P334379316» 의 P 도 판매처 번호', p.words.join(','));
  const r = pair('바투 로잉머신 RM1060 홈트레이닝 홈짐 헬스용품', '[셀러허브] 바투 로잉머신 RM1060 홈트레이닝 홈짐 헬스용품 (S50671126)[이마트몰] [50671126]');
  ok(r.decision === 'MATCH', '판매처 번호 꼬리만 다른 같은 판매 글 → MATCH', brief(r));
  ok(offer('에이치피 오멘 16 노트북').brand === 'hp' && offer('소니코리아 WH-1000XM5').brand === 'sony', '에이치피 = hp · 소니코리아 = sony');
  const brands = pair('HP 빅터스 15-FB2063AX 노트북', '삼성 빅터스 15-FB2063AX 노트북');
  ok(brands.decision === 'NO_MATCH' && brands.conflicts.some(c => c.startsWith('brand_mismatch')), '브랜드 표에 넣은 브랜드는 둘 다 적혔으면 충돌을 만든다', brief(brands));
  const logi = offer('로지텍G 로지텍코리아 G304 LIGHTSPEED 무선 게이밍 마우스');
  ok(!logi.words.includes('g'), '«로지텍G» 의 G 는 하위 상표 — 계열 낱말이 아니다', logi.words.join(','));
}

/* ==================================================================
 *  G. 정규 식별 · 스냅숏
 * ================================================================== */
console.log('=== G. 정규 식별 · 스냅숏 ===');
{
  const laptop = offer('HyperX 오멘 MAX 16-AH1075TX U7-270HXPlus RTX5070Ti 32G/1TB 노트북');
  const snap = P.snapshotOf(laptop);
  ok(same(snap.cpu, ['ultra7-270hxplus']) && same(snap.gpu, ['rtx5070ti']), '노트북 스냅숏은 CPU·GPU 를 담는다 (바뀌면 stale 로 드러난다)');
  const mouse = offer('로지텍 MX Master 3S 그래파이트');
  const json = P.stableJson(P.snapshotOf(mouse));
  ok(!json.includes('"cpu"') && !json.includes('"gpu"'), '컴퓨터가 아닌 상품의 스냅숏에는 cpu·gpu 키가 없다 (예전 스냅숏과 같다)', json);
  const twin = offer('HyperX 오멘 MAX 16-AH1075TX U7-270HXPlus RTX5070Ti 32G/1TB 노트북', 'ADPICK/Hmall');
  const identity = P.canonicalIdentity([laptop, twin], P.commonStrongIdentifier([laptop, twin]), 'A');
  ok(same(identity.cpu, ['ultra7-270hxplus']) && same(identity.gpu, ['rtx5070ti']), '정규 식별(키의 재료)에 CPU·GPU 가 들어간다', JSON.stringify(identity));
  ok(P.reasonFromConflict('cpu_mismatch:a!=b') === 'REJECT_CPU_CONFLICT' && P.reasonFromConflict('gpu_mismatch:a!=b') === 'REJECT_GPU_CONFLICT'
    && P.reasonFromUnknown('cpu_detail') === 'HOLD_CPU_NOT_EXACT' && P.reasonFromUnknown('gpu') === 'HOLD_MISSING_GPU', '승격 정책이 CPU·GPU 사유를 안다');
}

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
if (fail) {
  console.log(failures.slice(0, 20).map(f => `  - ${f}`).join('\n'));
  process.exit(1);
}
assert.ok(true);
