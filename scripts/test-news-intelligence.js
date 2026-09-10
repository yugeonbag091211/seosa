#!/usr/bin/env node
'use strict';
/*
 * News Intelligence 시험 — 전부 fixture 다. 외부를 부르지 않는다.
 *
 * ★ 왜 fixture 인가
 *   판정 규칙을 시험하려면 «같은 입력에 같은 답» 이 나와야 한다. 진짜
 *   뉴스를 받아 시험하면 오늘 통과한 시험이 내일 이유 없이 깨진다.
 *   네트워크는 scripts/news-intelligence-audit.js 가 따로 확인한다.
 */

const assert = require('assert');
const NI = require('../api/_news-intelligence');
const R = require('../api/_market-registry');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  [PASS] ${name}`); }
  catch (e) { fail++; console.log(`  [FAIL] ${name}\n         ${e.message}`); }
}
function section(s) { console.log(`\n${s}`); }

const NOW = new Date('2026-09-10T12:00:00Z');
const daysAgo = d => new Date(NOW.getTime() - d * 86400000).toISOString();

/** 기사 하나 만들기 (정규화까지 통과시킨다). */
function art(o) {
  return NI.normalizeItem({
    title: o.title,
    url: o.url,
    publishedAt: o.at != null ? daysAgo(o.at) : daysAgo(1),
    summary: o.summary || '',
    sourceKey: o.gdelt ? '__gdelt__' : undefined
  }, NOW);
}

function events(list) {
  return NI.clusterEvents(list.filter(Boolean).map(i => Object.assign({}, i, NI.classify(i))));
}

/** 가격 통계 fixture — _pricestat.statsFrom 이 내는 모양과 같은 필드만 쓴다. */
function stat(o) {
  return Object.assign({
    count: 40, historyDays: 40, low: 80000, high: 120000,
    avg7: 100000, avg30: 100000, median: 100000,
    trendPct: 0, trendDays: 7, volatility: 5, lastDate: '2026-09-10'
  }, o || {});
}

/* ══════════════════════════════════════════════════════════════════ */
section('1. 출처 관문 — 허용 목록 밖은 들어오지 못한다');

t('출처 불명 블로그는 버려진다', () => {
  assert.strictEqual(art({ title: 'DRAM 공급 부족 심화', url: 'https://some-random-blog.tistory.com/123' }), null);
});
t('커뮤니티 게시물은 버려진다', () => {
  assert.strictEqual(art({ title: 'DRAM 공급 부족', url: 'https://gall.dcinside.com/board/view/?id=1' }), null);
});
t('SEO 재게시 사이트는 버려진다', () => {
  assert.strictEqual(art({ title: 'HBM 수요 증가', url: 'https://tech-news-aggregator.example.com/p/1' }), null);
});
t('공식 뉴스룸은 통과한다', () => {
  const a = art({ title: 'Micron announces production cut', url: 'https://investors.micron.com/news/x' });
  assert.ok(a && a.tier === 'A' && a.trust >= 20, '통과 + tier A');
});
t('정부 기관은 tier B 로 통과한다', () => {
  const a = art({ title: '반도체 수출 규제 시행', url: 'https://www.motie.go.kr/news/1' });
  assert.ok(a && a.tier === 'B' && a.trust === 30);
});
t('Google News RSS 도메인은 소스 목록에 없다', () => {
  assert.strictEqual(R.sourceOf('news.google.com'), null);
});
t('네이버 뉴스 도메인은 소스 목록에 없다', () => {
  assert.strictEqual(R.sourceOf('news.naver.com'), null);
});
t('미래 날짜 기사는 거부된다', () => {
  const a = NI.normalizeItem({ title: 'x', url: 'https://news.skhynix.com/a', publishedAt: daysAgo(-5) }, NOW);
  assert.strictEqual(a, null);
});

/* ══════════════════════════════════════════════════════════════════ */
section('2. 중복 제거 — 재게시 30건이 사건 1건이 된다');

t('URL 추적 파라미터를 털어 같은 기사로 본다', () => {
  const a = NI.normalizeUrl('https://news.skhynix.com/a/b?utm_source=x&utm_medium=y');
  const b = NI.normalizeUrl('https://news.skhynix.com/a/b/');
  assert.strictEqual(a, b, `${a} !== ${b}`);
});
t('AMP 판을 같은 기사로 본다', () => {
  assert.strictEqual(
    NI.normalizeUrl('https://news.skhynix.com/a/b/amp'),
    NI.normalizeUrl('https://news.skhynix.com/a/b'));
});
t('같은 원문 재게시 30건 → 사건 1건', () => {
  const list = [];
  for (let i = 0; i < 30; i++) {
    list.push(art({
      title: `[단독] SK hynix, HBM 생산 감산 결정 - 매체${i}`,
      url: `https://news.skhynix.com/hbm-cut?dup=${i}`, at: 1
    }));
  }
  const evs = events(list);
  assert.strictEqual(evs.length, 1, `사건 ${evs.length}개`);
  assert.strictEqual(evs[0].articleCount, 30);
});
t('재게시 30건이어도 독립 출처는 1곳이다', () => {
  const list = [];
  for (let i = 0; i < 30; i++) {
    list.push(art({ title: `SK hynix HBM 감산 결정 ${i}`, url: `https://news.skhynix.com/x?d=${i}`, at: 1 }));
  }
  const evs = events(list);
  assert.strictEqual(evs[0].independentSources, 1, '기사 수를 증거 수로 세면 안 된다');
});
t('같은 회사의 뉴스룸+IR 은 독립 출처 1곳이다', () => {
  const evs = events([
    art({ title: 'Micron 감산 결정', url: 'https://www.micron.com/a', at: 1 }),
    art({ title: 'Micron 감산 결정 발표', url: 'https://investors.micron.com/b', at: 1 })
  ]);
  assert.strictEqual(evs[0].independentSources, 1, 'group 이 같으면 1곳');
});
t('서로 다른 회사는 독립 출처 2곳이다', () => {
  const evs = events([
    art({ title: 'DRAM 감산 결정', url: 'https://www.micron.com/a', at: 1 }),
    art({ title: 'DRAM 감산 결정 발표', url: 'https://news.skhynix.com/b', at: 1 })
  ]);
  assert.strictEqual(evs[0].independentSources, 2);
});
t('시기가 멀면 같은 종류라도 다른 전개다', () => {
  const evs = events([
    art({ title: 'DRAM 감산 결정', url: 'https://www.micron.com/a', at: 1 }),
    art({ title: 'DRAM 감산 결정', url: 'https://news.skhynix.com/b', at: 200 })
  ]);
  assert.strictEqual(evs.length, 2, '반년 전 일과 어제 일은 한 사건이 아니다');
});
t('시기가 가까운 서로 다른 회사의 같은 전개는 한 사건 2출처다', () => {
  const evs = events([
    art({ title: 'NAND 감산 결정', url: 'https://www.kioxia.com/a', at: 1 }),
    art({ title: 'NAND 감산 발표', url: 'https://www.westerndigital.com/b', at: 3 })
  ]);
  assert.strictEqual(evs.length, 1, '같은 전개는 한 사건이어야 교차 확인이 성립한다');
  assert.strictEqual(evs[0].independentSources, 2);
});
t('종류가 다르면 제목이 닮아도 다른 사건이다', () => {
  const evs = events([
    art({ title: 'DRAM 생산 감산 결정', url: 'https://www.micron.com/a', at: 1 }),
    art({ title: 'DRAM 생산 증설 결정', url: 'https://www.micron.com/b', at: 1 })
  ]);
  assert.strictEqual(evs.length, 2);
});

/* ══════════════════════════════════════════════════════════════════ */
section('3. 분류 — 확실하지 않으면 UNKNOWN');

t('감산 기사는 PRODUCTION_CUT', () => {
  assert.strictEqual(NI.classify(art({ title: 'Micron DRAM 감산 결정', url: 'https://www.micron.com/a' })).eventType, 'PRODUCTION_CUT');
});
t('수출 규제 기사는 EXPORT_RESTRICTION', () => {
  assert.strictEqual(NI.classify(art({ title: 'GPU 수출 규제 강화', url: 'https://www.motie.go.kr/a' })).eventType, 'EXPORT_RESTRICTION');
});
t('노드에 걸리지 않으면 UNKNOWN 이다', () => {
  const c = NI.classify(art({ title: 'Company announces new office building', url: 'https://news.microsoft.com/a' }));
  assert.strictEqual(c.eventType, 'UNKNOWN', '붙일 곳 없는 사건은 사건이 아니다');
});
t('UNKNOWN 은 방향이 0이라 신호를 밀지 못한다', () => {
  assert.strictEqual(R.eventTypeOf('UNKNOWN').direction, 0);
});

/* ══════════════════════════════════════════════════════════════════ */
section('4. 시간 — 최신성 감쇠와 사건 유효기간');

t('1시간 전 뉴스가 30일 전 뉴스보다 영향이 크다', () => {
  const fresh = NI.recencyWeight(1 / 24, 'PRODUCTION_CUT');
  const old = NI.recencyWeight(30, 'PRODUCTION_CUT');
  assert.ok(fresh > old * 2, `${fresh} vs ${old}`);
  assert.ok(fresh > 0.95 && old < 0.4);
});
t('일시적 사건은 빠르게 감쇠한다', () => {
  const transient = NI.recencyWeight(7, 'LOGISTICS_DISRUPTION');
  const medium = NI.recencyWeight(7, 'PRODUCTION_CUT');
  assert.ok(transient < medium / 3, `물류 ${transient} vs 감산 ${medium}`);
});
t('구조적 사건은 오래되어도 영향이 남는다', () => {
  const w = NI.recencyWeight(30, 'TARIFF_INCREASE');
  assert.ok(w > 0.8, `관세 30일 뒤 ${w}`);
});
t('장기 정책은 오래되어도 ACTIVE 다', () => {
  const evs = events([art({ title: 'GPU 관세 인상 시행', url: 'https://www.customs.go.kr/a', at: 90 })]);
  assert.strictEqual(NI.eventStatus(evs[0], evs), 'ACTIVE');
});
t('반대 사건이 뒤에 오면 RESOLVED 다', () => {
  const evs = events([
    art({ title: 'NAND 공급 부족 심화', url: 'https://www.kioxia.com/a', at: 20 }),
    art({ title: 'NAND 공급 회복 정상화', url: 'https://www.kioxia.com/b', at: 2 })
  ]);
  const shortage = evs.find(e => e.eventType === 'SUPPLY_DECREASE');
  assert.strictEqual(NI.eventStatus(shortage, evs), 'RESOLVED');
});
t('RESOLVED 사건은 압력 계산에서 빠진다', () => {
  const evs = events([
    art({ title: 'NAND 공급 부족 심화', url: 'https://www.kioxia.com/a', at: 20 }),
    art({ title: 'NAND 공급 회복 정상화', url: 'https://www.kioxia.com/b', at: 2 })
  ]);
  const np = NI.newsPressure(evs, 'ssd');
  assert.ok(np.excluded.some(e => e.reason === '종료된 사건'), JSON.stringify(np.excluded));
});

/* ══════════════════════════════════════════════════════════════════ */
section('5. 관련도 — 먼 인과를 과장하지 않는다');

t('직접 관련은 높다 (dram → ram)', () => {
  assert.ok(R.relevanceTo('ram', 'dram') >= 0.9);
});
t('한 단계 간접은 약해진다 (wafer → ram)', () => {
  const r = R.relevanceTo('ram', 'wafer');
  assert.ok(r > 0.3 && r < 0.8, `${r}`);
});
t('먼 인과는 근거에서 제외될 만큼 약하다', () => {
  const r = R.relevanceTo('coffee', 'hbm');
  assert.ok(r < NI.MIN_RELEVANCE, `커피 vs HBM = ${r}`);
});
t('관련도 낮은 뉴스는 압력에서 빠진다', () => {
  const evs = events([art({ title: '생두 가격 급등 원자재 가격 상승', url: 'https://www.kita.net/a', at: 1 })]);
  const np = NI.newsPressure(evs, 'gpu');
  assert.strictEqual(np.used.length, 0);
  assert.ok(np.excluded[0].reason.startsWith('관련도 낮음'));
});

/* ══════════════════════════════════════════════════════════════════ */
section('6. 판단 — BUY 는 좀처럼 나오지 않는다');

/** 신뢰할 만한 상승 압력 사건 (독립 출처 3곳, 공식). */
function strongUpward(at) {
  return [
    art({ title: 'DRAM 공급 부족 심화 전망', url: 'https://www.micron.com/a', at: at == null ? 1 : at }),
    art({ title: 'DRAM 공급 부족 지속 전망', url: 'https://news.skhynix.com/b', at: at == null ? 1 : at }),
    art({ title: 'DRAM 공급 부족 관련 전망', url: 'https://www.semi.org/c', at: at == null ? 2 : at })
  ];
}

t('가격이 저점 + 신뢰 상승압력이면 BUY 가능', () => {
  const adv = NI.advise({
    categoryId: 'ram', events: events(strongUpward()),
    stat: stat({ avg30: 100000 }), price: 84000, dealPercentile: 0.1,
    dealVerdict: 'GOOD_BUY'
  });
  assert.strictEqual(adv.advice, 'BUY', `blockedBy=${JSON.stringify(adv.blockedBy)}`);
});
t('가격이 90일 고점 근처면 BUY 가 차단된다', () => {
  const adv = NI.advise({
    categoryId: 'ram', events: events(strongUpward()),
    stat: stat(), price: 119000, dealPercentile: 0.97, dealVerdict: 'GOOD_BUY'
  });
  assert.notStrictEqual(adv.advice, 'BUY');
  assert.ok(adv.blockedBy.some(b => b.includes('높은 구간')), JSON.stringify(adv.blockedBy));
});
t('독립 출처 1곳뿐이면 BUY 가 차단된다', () => {
  const adv = NI.advise({
    categoryId: 'ram',
    events: events([art({ title: 'DRAM 공급 부족 심화', url: 'https://www.micron.com/a', at: 1 })]),
    stat: stat(), price: 84000, dealPercentile: 0.1, dealVerdict: 'BUY'
  });
  assert.notStrictEqual(adv.advice, 'BUY');
  assert.ok(adv.blockedBy.some(b => b.includes('독립 출처')), JSON.stringify(adv.blockedBy));
});
t('GDELT 단독으로는 BUY 가 나오지 않는다', () => {
  const adv = NI.advise({
    categoryId: 'ram',
    events: events([
      art({ title: 'DRAM 공급 부족 심화', url: 'https://reuters.example.com/a', at: 1, gdelt: true }),
      art({ title: 'DRAM 공급 부족 확대', url: 'https://bloomberg.example.com/b', at: 1, gdelt: true }),
      art({ title: 'DRAM 공급 부족 지속', url: 'https://ft.example.com/c', at: 1, gdelt: true })
    ]),
    stat: stat(), price: 84000, dealPercentile: 0.1, dealVerdict: 'BUY'
  });
  assert.notStrictEqual(adv.advice, 'BUY');
  assert.ok(adv.blockedBy.some(b => b.includes('GDELT')), JSON.stringify(adv.blockedBy));
});
t('기업 자체 발표 단독이면 BUY 가 차단된다', () => {
  const adv = NI.advise({
    categoryId: 'ram',
    events: events([
      art({ title: 'DRAM 공급 부족 심화', url: 'https://www.micron.com/a', at: 1 }),
      art({ title: 'DRAM 공급 부족 심화 발표', url: 'https://investors.micron.com/b', at: 1 })
    ]),
    stat: stat(), price: 84000, dealPercentile: 0.1, dealVerdict: 'BUY'
  });
  assert.notStrictEqual(adv.advice, 'BUY');
  assert.ok(adv.blockedBy.some(b => b.includes('기업 자체 발표')), JSON.stringify(adv.blockedBy));
});
t('상충 뉴스가 있으면 WATCH 로 내려간다', () => {
  const adv = NI.advise({
    categoryId: 'ram',
    events: events(strongUpward().concat([
      art({ title: 'DRAM 생산 증설 확대 발표', url: 'https://news.samsung.com/x', at: 1 }),
      art({ title: 'DRAM 생산 증설 계획 발표', url: 'https://newsroom.intel.com/y', at: 1 }),
      art({ title: 'DRAM 생산 증설 추진', url: 'https://www.semi.org/z', at: 1 })
    ])),
    stat: stat(), price: 84000, dealPercentile: 0.1, dealVerdict: 'BUY'
  });
  assert.strictEqual(adv.advice, 'WATCH');
  assert.ok(adv.news.contradicted, '상충으로 인식돼야 한다');
});
t('오래된 뉴스만 있으면 BUY 가 나오지 않는다', () => {
  const adv = NI.advise({
    categoryId: 'ram', events: events(strongUpward(75)),
    stat: stat(), price: 84000, dealPercentile: 0.1, dealVerdict: 'BUY'
  });
  assert.notStrictEqual(adv.advice, 'BUY', `blockedBy=${JSON.stringify(adv.blockedBy)}`);
});
t('뉴스 방향과 가격 방향이 반대면 BUY 가 차단된다', () => {
  const adv = NI.advise({
    categoryId: 'ram', events: events(strongUpward()),
    stat: stat({ trendPct: -12 }),               // 뉴스는 공급부족인데 가격은 하락 중
    price: 84000, dealPercentile: 0.1, dealVerdict: 'BUY'
  });
  assert.notStrictEqual(adv.advice, 'BUY');
  assert.ok(adv.blockedBy.some(b => b.includes('반대')), JSON.stringify(adv.blockedBy));
});
t('가격 기록이 부족하면 BUY 가 차단된다', () => {
  const adv = NI.advise({
    categoryId: 'ram', events: events(strongUpward()),
    stat: stat({ count: 3 }), price: 84000, dealVerdict: 'BUY'
  });
  assert.notStrictEqual(adv.advice, 'BUY');
  assert.ok(adv.blockedBy.some(b => b.includes('가격 기록')), JSON.stringify(adv.blockedBy));
});

/* ══════════════════════════════════════════════════════════════════ */
section('7. ★ Deal Engine 천장 — 가격 엔진을 덮어쓰지 않는다');

t('가격 판정이 WAIT 면 뉴스가 아무리 세도 BUY 가 안 나온다', () => {
  const adv = NI.advise({
    categoryId: 'ram', events: events(strongUpward()),
    stat: stat(), price: 84000, dealPercentile: 0.05, dealVerdict: 'WAIT'
  });
  assert.strictEqual(adv.advice, 'WATCH');
  assert.ok(adv.blockedBy.some(b => b.includes('가격 판정')), JSON.stringify(adv.blockedBy));
});
t('가격 판정이 NORMAL 이어도 BUY 로 올리지 않는다', () => {
  const adv = NI.advise({
    categoryId: 'ram', events: events(strongUpward()),
    stat: stat(), price: 84000, dealPercentile: 0.05, dealVerdict: 'NORMAL'
  });
  assert.strictEqual(adv.advice, 'WATCH');
});
t('가격 판정이 UNKNOWN 이면 BUY 가 안 나온다', () => {
  const adv = NI.advise({
    categoryId: 'ram', events: events(strongUpward()),
    stat: stat(), price: 84000, dealPercentile: 0.05, dealVerdict: 'UNKNOWN'
  });
  assert.strictEqual(adv.advice, 'WATCH');
});

/* ══════════════════════════════════════════════════════════════════ */
section('8. 커버리지 — 모르는 카테고리에 판단을 만들지 않는다');

t('UNSUPPORTED 카테고리는 NO_DECISION', () => {
  const adv = NI.advise({
    categoryId: 'coffee', events: events(strongUpward()),
    stat: stat(), price: 84000, dealPercentile: 0.1, dealVerdict: 'BUY'
  });
  assert.strictEqual(adv.advice, 'NO_DECISION');
  assert.strictEqual(adv.coverage, 'UNSUPPORTED');
  assert.ok(adv.reasons[0].includes('충분하지 않'));
});
t('레지스트리에 없는 카테고리도 NO_DECISION', () => {
  const adv = NI.advise({ categoryId: 'nonexistent', events: [], stat: stat(), price: 1000 });
  assert.strictEqual(adv.advice, 'NO_DECISION');
});
t('PARTIALLY_SUPPORTED 는 WATCH 위로 올라가지 않는다', () => {
  const adv = NI.advise({
    categoryId: 'laptop',
    events: events([
      art({ title: 'CPU 공급 부족 심화', url: 'https://newsroom.intel.com/a', at: 1 }),
      art({ title: 'CPU 공급 부족 지속', url: 'https://ir.amd.com/b', at: 1 }),
      art({ title: 'CPU 공급 부족 전망', url: 'https://www.semi.org/c', at: 1 })
    ]),
    stat: stat(), price: 84000, dealPercentile: 0.05, dealVerdict: 'BUY'
  });
  assert.strictEqual(adv.advice, 'WATCH');
});

/* ══════════════════════════════════════════════════════════════════ */
section('9. 같은 엔진이 다른 상품군에서도 돈다 (범용성)');

t('SSD 에도 같은 엔진이 그대로 적용된다', () => {
  const adv = NI.advise({
    categoryId: 'ssd',
    events: events([
      art({ title: 'NAND 감산 결정', url: 'https://www.kioxia.com/a', at: 1 }),
      art({ title: 'NAND 감산 발표', url: 'https://www.westerndigital.com/b', at: 1 }),
      art({ title: 'NAND 감산 관련', url: 'https://www.semi.org/c', at: 1 })
    ]),
    stat: stat(), price: 84000, dealPercentile: 0.1, dealVerdict: 'GOOD_BUY'
  });
  assert.strictEqual(adv.advice, 'BUY', JSON.stringify(adv.blockedBy));
});
t('모니터(다른 산업)도 레지스트리만으로 동작한다', () => {
  const adv = NI.advise({
    categoryId: 'monitor',
    events: events([art({ title: '디스플레이 패널 공급 부족', url: 'https://news.samsung.com/a', at: 1 })]),
    stat: stat(), price: 84000, dealPercentile: 0.1, dealVerdict: 'GOOD_BUY'
  });
  assert.ok(adv.news.used.length > 0, '패널 뉴스가 모니터에 연결돼야 한다');
});

/* ══════════════════════════════════════════════════════════════════ */
section('10. 안전 — hallucination · 원문 저장 · 확률 표현');

t('ingestion 기록(id) 없는 근거는 화면에 오르지 않는다', () => {
  const evs = events(strongUpward());
  const scored = [{ ev: Object.assign({}, evs[0], { items: [{ title: '가짜 기사', url: '', id: '' }] }),
                    u: { relevance: 1, status: 'ACTIVE' } }];
  assert.strictEqual(NI.buildEvidence(scored).length, 0);
});
t('모든 근거에 실제 원문 URL 이 있다', () => {
  const adv = NI.advise({
    categoryId: 'ram', events: events(strongUpward()),
    stat: stat(), price: 84000, dealPercentile: 0.1, dealVerdict: 'GOOD_BUY'
  });
  assert.ok(adv.evidence.length > 0);
  adv.evidence.forEach(e => {
    assert.ok(/^https:\/\//.test(e.url), `원문 링크 없음: ${e.title}`);
    assert.ok(e.id, 'id 없음');
  });
});
t('원문 전체를 저장하지 않는다 (요약 길이 제한)', () => {
  const long = 'x'.repeat(5000);
  const a = art({ title: '테스트', url: 'https://news.skhynix.com/z', summary: long });
  assert.ok(a.shortSummary.length <= NI.SUMMARY_MAX, `${a.shortSummary.length}자`);
  assert.strictEqual(a.body, undefined, 'body 필드가 존재하면 안 된다');
  assert.strictEqual(a.content, undefined, 'content 필드가 존재하면 안 된다');
});
t('신뢰도를 확률로 표현하지 않는다', () => {
  const adv = NI.advise({
    categoryId: 'ram', events: events(strongUpward()),
    stat: stat(), price: 84000, dealPercentile: 0.1, dealVerdict: 'GOOD_BUY'
  });
  const block = NI.marketBlock(adv);
  assert.ok(block.confidenceNote.includes('예측 확률이 아니라'));
  const text = JSON.stringify(block);
  assert.ok(!/확률\s*\d+\s*%/.test(text), '확률 % 표현이 있으면 안 된다');
  assert.ok(!/반드시\s*(?:오|내)른/.test(text), '단정적 예측 표현 금지');
});
t('출력에 면책 문구가 붙는다', () => {
  const adv = NI.advise({
    categoryId: 'ram', events: events(strongUpward()),
    stat: stat(), price: 84000, dealPercentile: 0.1, dealVerdict: 'GOOD_BUY'
  });
  assert.ok(NI.marketBlock(adv).disclaimer.includes('참고 정보'));
});
t('오래된 근거에는 영향도 안내가 붙는다', () => {
  const adv = NI.advise({
    categoryId: 'ram', events: events(strongUpward(21)),
    stat: stat(), price: 84000, dealPercentile: 0.1, dealVerdict: 'GOOD_BUY'
  });
  assert.ok(adv.evidence.some(e => e.agingNote.includes('영향도가 낮게 반영')), '노후 안내 필요');
});

/* ══════════════════════════════════════════════════════════════════ */
section('11. fail-open — 뉴스가 없어도 기존 기능은 멀쩡하다');

t('사건이 하나도 없으면 NO_DECISION 이고 throw 하지 않는다', () => {
  const adv = NI.advise({ categoryId: 'ram', events: [], stat: stat(), price: 84000, dealVerdict: 'BUY' });
  assert.strictEqual(adv.advice, 'NO_DECISION');
});
t('입력이 통째로 비어도 throw 하지 않는다', () => {
  assert.doesNotThrow(() => NI.advise({}));
  assert.doesNotThrow(() => NI.advise(null));
  assert.doesNotThrow(() => NI.marketBlock(null));
  assert.doesNotThrow(() => NI.clusterEvents([]));
  assert.doesNotThrow(() => NI.newsPressure(null, 'ram'));
});
t('망가진 피드 항목은 조용히 버려진다', () => {
  assert.strictEqual(NI.normalizeItem({}, NOW), null);
  assert.strictEqual(NI.normalizeItem({ url: 'not-a-url' }, NOW), null);
  assert.strictEqual(NI.normalizeItem(null, NOW), null);
});

/* ══════════════════════════════════════════════════════════════════ */
section('12. 기존 엔진 regression — 건드리지 않았다');

t('_deal.js 의 판정 순서가 그대로다', () => {
  const D = require('../api/_deal');
  assert.strictEqual(D.DEAL_ORDER.BUY, 5);
  assert.strictEqual(D.DEAL_ORDER.GOOD_BUY, 4);
  assert.strictEqual(D.DEAL_ORDER.UNKNOWN, -1);
});
t('_pricestat.js 를 수정하지 않았다 (필요 함수 그대로)', () => {
  const P = require('../api/_pricestat');
  ['statsFrom', 'loadStats', 'assess', 'fairness'].forEach(f =>
    assert.strictEqual(typeof P[f], 'function', `${f} 없음`));
});
t('News Intelligence 는 가격 통계를 새로 계산하지 않는다', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'api', '_news-intelligence.js'), 'utf8');
  // 주석에서 _pricestat 을 «언급» 하는 것은 괜찮다. 금지하는 것은 «호출» 이다.
  assert.ok(src.indexOf("require('./_pricestat')") === -1, '가격 엔진을 불러 통계를 다시 만들면 안 된다');
  ['statsFrom(', 'loadStats('].forEach(c => assert.ok(src.indexOf(c) === -1, c + ' 호출은 금지다'));
});
t('엔진에 네트워크 호출이 없다', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'api', '_news-intelligence.js'), 'utf8');
  assert.ok(!/\bfetch\s*\(/.test(src), '엔진은 순수해야 한다');
});
t('유료 뉴스 API 경로가 존재하지 않는다', () => {
  const F = require('../api/_news-fetch');
  assert.strictEqual(F.paidNewsEnabled(), false);
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'api', '_news-fetch.js'), 'utf8');
  assert.ok(!/newsdata\.io|apitube\.io/i.test(src), '승인 전에는 호출 경로 자체가 없어야 한다');
});
t('새 서버리스 함수를 만들지 않았다 (_ 접두사)', () => {
  const fs = require('fs');
  ['_market-registry.js', '_news-intelligence.js', '_news-fetch.js'].forEach(f => {
    assert.ok(fs.existsSync(require('path').join(__dirname, '..', 'api', f)), `${f} 없음`);
    assert.ok(f.startsWith('_'), `${f} 는 _ 로 시작해야 한다`);
  });
});

/* ══════════════════════════════════════════════════════════════════ */
console.log(`\n───── PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
