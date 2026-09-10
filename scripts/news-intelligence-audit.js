#!/usr/bin/env node
'use strict';
/*
 * News Intelligence 감사 — 수동 dry-run.
 *
 * ★ cron 이 아니다. production 스케줄에 붙이기 «전에» 사람이 눈으로 확인하는
 *   자리다. 여기서 나온 수치가 납득될 때에만 자동화를 논한다.
 *
 * 사용법
 *   node scripts/news-intelligence-audit.js              공식 RSS 만
 *   node scripts/news-intelligence-audit.js --gdelt      GDELT 보조 탐색까지
 *   node scripts/news-intelligence-audit.js --offline    네트워크 없이 fixture 로
 *   node scripts/news-intelligence-audit.js --json       기계가 읽을 형태로
 *
 * 외부 호출은 --gdelt 를 주지 않으면 공식 피드뿐이고, 피드 하나가 죽어도
 * 나머지는 계속 돈다(fail-open).
 */

const R = require('../api/_market-registry');
const NI = require('../api/_news-intelligence');
const F = require('../api/_news-fetch');
const STORE = require('../api/_news-audit-store');
const SHADOW = require('../api/_news-shadow-store');

const ARGS = process.argv.slice(2);
const USE_GDELT = ARGS.includes('--gdelt');
const OFFLINE = ARGS.includes('--offline');
const AS_JSON = ARGS.includes('--json');
/* 이번 실행의 «집계 수치» 를 누적 파일에 한 줄 남긴다 (기본 켜짐). */
const NO_SAVE = ARGS.includes('--no-save');
/* 쌓인 며칠치를 요약해서 보고 끝낸다 — 네트워크를 부르지 않는다. */
const SUMMARY_ONLY = ARGS.includes('--summary');

/* PHASE 10 에서 지정한 키워드. GDELT 보조 탐색에만 쓴다. */
/* 오늘 호출량을 보수적으로 유지한다. --gdelt 도 한 실행에 한 질의뿐이다. */
const QUERIES = ['semiconductor supply'];

/* dry-run 대상 — V1 검증용 대표 카테고리 */
const TARGETS = ['gpu', 'cpu', 'ram', 'ssd'];

/*
 * 네트워크 없이 돌릴 때 쓰는 fixture.
 *
 * ★ 진짜 기사가 아니다. 파이프라인이 도는지 보는 용도이며, 그래서 URL 도
 *   실제 기사 주소가 아니라 각 뉴스룸의 «도메인만» 맞춘 경로다. 이 값으로
 *   판단 품질을 주장하지 않는다.
 */
function fixture(now) {
  const d = n => new Date(now.getTime() - n * 86400000).toISOString();
  return [
    { title: 'Micron to reduce DRAM output amid inventory correction 감산', url: 'https://www.micron.com/about/newsroom/fixture-1', publishedAt: d(2) },
    { title: 'SK hynix DRAM 감산 결정, 공급 축소 전망', url: 'https://news.skhynix.com/fixture-2', publishedAt: d(3) },
    { title: 'SEMI: DRAM 감산 영향 분석', url: 'https://www.semi.org/fixture-3', publishedAt: d(4) },
    { title: 'AI 데이터 센터 설비 투자 확대 발표', url: 'https://news.microsoft.com/fixture-4', publishedAt: d(1) },
    { title: 'AI 서버 수요 증가 지속', url: 'https://blog.google/fixture-5', publishedAt: d(2) },
    { title: 'NAND 공급 부족 심화', url: 'https://www.kioxia.com/fixture-6', publishedAt: d(5) },
    { title: 'NAND 공급 부족 지속 전망', url: 'https://www.westerndigital.com/fixture-7', publishedAt: d(6) },
    { title: 'GPU 수출 규제 강화 시행', url: 'https://www.motie.go.kr/fixture-8', publishedAt: d(10) },
    { title: '신규 팹 증설 계획 발표 wafer', url: 'https://pr.tsmc.com/fixture-9', publishedAt: d(30) },
    { title: 'Company opens new employee wellness center', url: 'https://news.samsung.com/fixture-10', publishedAt: d(1) },
    /* 허용 목록 밖 — 반드시 버려져야 한다 */
    { title: 'DRAM 대폭락 임박!! 지금 사면 손해', url: 'https://random-blog.tistory.com/999', publishedAt: d(1) },
    { title: '[속보] HBM 공급 대란', url: 'https://cafe.naver.com/x/1', publishedAt: d(1) }
  ];
}

function pct(a, b) { return b ? Math.round(a / b * 1000) / 10 : 0; }

(async () => {
  const now = new Date();

  /* ── 누적 요약만 보고 끝 ── 네트워크를 부르지 않는다 ── */
  if (SUMMARY_ONLY) { printSummary(); return; }

  let events, items, stats;

  if (OFFLINE) {
    const raws = fixture(now);
    const norm = raws.map(r => NI.normalizeItem(r, now)).filter(Boolean);
    const classified = norm.map(it => Object.assign({}, it, NI.classify(it)));
    events = NI.clusterEvents(classified);
    items = classified;
    stats = {
      feeds: { attempted: 0, ok: 0, failed: 0, rawItems: raws.length, accepted: norm.length, rejected: raws.length - norm.length, errors: [] },
      gdelt: null, totalItems: norm.length, uniqueItems: norm.length,
      events: events.length,
      dedupeRate: pct(norm.length - events.length, norm.length),
      officialRatio: pct(norm.filter(i => i.tier === 'A' || i.tier === 'B').length, norm.length)
    };
  } else {
    const r = await F.collect({
      useFeeds: true, useGdelt: USE_GDELT, queries: QUERIES,
      maxQueries: 1, maxRecords: 20, now
    });
    events = r.events; items = r.items; stats = r.stats;
  }

  /* ── 1. 수집 ───────────────────────────────────────────────── */
  const feedStats = stats.feeds || { attempted: 0, ok: 0, failed: 0, rawItems: 0, accepted: 0, rejected: 0, errors: [] };
  const gdeltStats = stats.gdelt;
  const totalRaw = feedStats.rawItems + (gdeltStats ? gdeltStats.rawItems : 0);
  const totalAccepted = feedStats.accepted + (gdeltStats ? gdeltStats.accepted : 0);
  const totalRejected = feedStats.rejected + (gdeltStats ? gdeltStats.rejected : 0);

  /* ── 2. 분류 분포 ──────────────────────────────────────────── */
  const byEvent = {};
  events.forEach(e => { byEvent[e.eventType] = (byEvent[e.eventType] || 0) + 1; });
  const unknownEvents = byEvent.UNKNOWN || 0;

  const byNode = {};
  events.forEach(e => e.nodes.forEach(n => { byNode[n] = (byNode[n] || 0) + 1; }));

  /* ── 3. 카테고리별 판단 ────────────────────────────────────── */
  const adviceRows = TARGETS.map(cat => {
    /*
     * 가격은 이 감사에서 «넣지 않는다».
     *
     * ★ dry-run 의 목적은 뉴스 쪽 파이프라인 확인이다. 여기에 임의의 가격을
     *   넣으면 그 임의값이 만든 BUY/WAIT 를 마치 실제 판단인 양 보고하게
     *   된다. 가격 없이 돌리면 엔진은 «가격 기록 부족» 으로 BUY 를 막는데,
     *   그것이 지금 사실이다.
     */
    const adv = NI.advise({ categoryId: cat, events, stat: null, price: 0, dealVerdict: null });
    return { adv,
      category: cat, coverage: adv.coverage, advice: adv.advice,
      confidence: adv.confidence, level: adv.confidenceLevel,
      newsScore: adv.news ? adv.news.score : null,
      contradicted: adv.news ? adv.news.contradicted : null,
      usedEvents: adv.news ? adv.news.used.length : 0,
      usedEventIds: adv.news ? adv.news.used.map(u => u.eventId) : [],
      excludedEvents: adv.news ? adv.news.excluded.length : 0,
      evidence: adv.evidence.length,
      blockedBy: adv.blockedBy
    };
  });
  const decisions = adviceRows.map(({ adv, ...row }) => row);

  /* Shadow prediction은 계산하되 offline fixture는 저장하지 않는다. */
  const shadowPredictions = adviceRows.map(row => SHADOW.createPrediction({
    createdAt: now.toISOString(), category: row.category, product: '', advice: row.adv,
    currentPrice: null, priceStatsSnapshot: row.adv.priceConfirmation && row.adv.priceConfirmation.snapshot
  }));
  const shadowSaveResults = [];
  if (!OFFLINE && !NO_SAVE) {
    shadowPredictions.forEach(p => shadowSaveResults.push(SHADOW.appendPrediction(p)));
  }

  const storedEvaluations = SHADOW.loadEvaluations();
  const calibration = SHADOW.calibration(storedEvaluations);
  const lifecycleCounts = { ACTIVE: 0, WEAKENING: 0, RESOLVED: 0, EXPIRED: 0, UNCERTAIN: 0 };
  events.forEach(e => { const s = e.status || NI.eventStatus(e, events); lifecycleCounts[s] = (lifecycleCounts[s] || 0) + 1; });
  const contradictionIds = new Set();
  adviceRows.forEach(row => ((row.adv.news && row.adv.news.contradictionPairs) || []).forEach(p =>
    contradictionIds.add(p.eventIds.slice().sort().join('|'))));
  const sourceHealth = F.sourceHealthSnapshot();
  const sourceHealthDistribution = sourceHealth.reduce((out, s) => {
    out[s.status] = (out[s.status] || 0) + 1; return out;
  }, {});
  const categoryDiagnostics = adviceRows.map(row => {
    const related = events.filter(e => (e.categories || []).indexOf(row.category) > -1);
    return {
      category: row.category, coverage: row.coverage,
      unknownRatio: pct(related.filter(e => e.eventType === 'UNKNOWN').length, related.length),
      eventCount: related.length, actionable: row.usedEvents
    };
  });
  const evaluatedCounts = { '1d': 0, '3d': 0, '7d': 0 };
  storedEvaluations.forEach(e => Object.keys(evaluatedCounts).forEach(k => { if (e.horizons && e.horizons[k]) evaluatedCounts[k]++; }));

  /* ── 4. 잘못된 판단 후보 ──────────────────────────────────────
   *
   * 사람이 봐야 할 것만 골라 낸다. 「전부 괜찮아 보인다」는 감사가 아니다.
   */
  const suspicious = [];
  events.forEach(e => {
    if (e.eventType === 'UNKNOWN' && e.articleCount > 0) {
      suspicious.push({ kind: '분류 실패', eventType: e.eventType, title: e.items[0].title.slice(0, 70), nodes: e.nodes });
    }
    if (e.articleCount >= 3 && e.independentSources === 1) {
      suspicious.push({ kind: '한 출처가 여러 번', eventType: e.eventType, articles: e.articleCount, source: e.items[0].source });
    }
    /* 노드가 너무 많이 붙은 사건 — 정규식이 넓게 잡혔을 수 있다 */
    if (e.nodes.length >= 5) {
      suspicious.push({ kind: '노드 과다 매핑', eventType: e.eventType, nodes: e.nodes, title: e.items[0].title.slice(0, 70) });
    }
  });

  const report = {
    mode: OFFLINE ? 'offline-fixture' : (USE_GDELT ? 'rss+gdelt' : 'rss-only'),
    ranAt: now.toISOString(),
    ingestion: {
      feedsAttempted: feedStats.attempted, feedsOk: feedStats.ok, feedsFailed: feedStats.failed,
      gdeltQueries: gdeltStats ? gdeltStats.attempted : 0,
      totalArticles: totalRaw,
      accepted: totalAccepted,
      rejectedBySourcePolicy: totalRejected,
      acceptRate: pct(totalAccepted, totalRaw),
      uniqueAfterUrlDedupe: stats.uniqueItems || 0,
      events: events.length,
      dedupeRate: stats.dedupeRate,
      officialRatio: stats.officialRatio,
      feedErrors: feedStats.errors.slice(0, 20),
      feedSources: feedStats.sources || []
    },
    classification: {
      eventTypeDistribution: byEvent,
      unknownEvents,
      unknownRate: pct(unknownEvents, events.length),
      nodeDistribution: byNode
    },
    v2: {
      sourceHealth, sourceHealthDistribution,
      lifecycleCounts,
      graphMappedEvents: events.filter(e => e.categories && e.categories.length).length,
      contradictionCount: contradictionIds.size,
      shadowPredictions: shadowPredictions.length,
      shadowSaved: shadowSaveResults.filter(x => x.saved).length,
      evaluablePredictions: storedEvaluations.filter(x => x.evaluable).length,
      evaluated1d: evaluatedCounts['1d'], evaluated3d: evaluatedCounts['3d'], evaluated7d: evaluatedCounts['7d'],
      calibration: calibration,
      categoryDiagnostics
    },
    decisions,
    suspicious: suspicious.slice(0, 15)
  };

  /* ── 누적 지표 ──────────────────────────────────────────────────
   *
   * 며칠치를 견주려면 «실행마다 같은 방식으로 센 숫자» 가 필요하다.
   * 여기서 한 번만 계산해 파일에 남기고, --summary 가 그것들을 모은다.
   *
   * ★ 기사 제목·URL·본문은 남기지 않는다. 숫자만이다.
   */
  const tierCounts = { A: 0, B: 0, C: 0 };
  let mappedNodeArticles = 0, classifiedArticles = 0;
  items.forEach(i => {
    if (tierCounts[i.tier] != null) tierCounts[i.tier]++;
    if (i.nodes && i.nodes.length) mappedNodeArticles++;
    if (i.eventType && i.eventType !== 'UNKNOWN') classifiedArticles++;
  });

  /*
   * «쓸 수 있는 신호» — 판단에 실제로 들어간 사건 수(카테고리 중복 제거).
   * BUY/WAIT/WATCH 를 만들 재료가 하루에 몇 건이나 생기는지가 이 검증의 핵심 질문이다.
   */
  const usable = new Set();
  decisions.forEach(d => (d.usedEventIds || []).forEach(id => usable.add(id)));

  const tierTotal = tierCounts.A + tierCounts.B + tierCounts.C;
  const sourceTierDistribution = {
    A: pct(tierCounts.A, tierTotal),
    B: pct(tierCounts.B, tierTotal),
    C: pct(tierCounts.C, tierTotal)
  };
  const decisionCounts = { BUY: 0, WAIT: 0, WATCH: 0, NO_DECISION: 0 };
  decisions.forEach(d => {
    if (decisionCounts[d.advice] != null) decisionCounts[d.advice]++;
  });
  const classifiedEventCount = Math.max(0, events.length - unknownEvents);

  const metrics = {
    totalArticles: totalRaw,
    validArticles: totalAccepted,
    eventCount: events.length,
    unknownEventCount: unknownEvents,
    unknownRatio: pct(unknownEvents, events.length),
    mappedNodeArticleCount: mappedNodeArticles,
    mappedNodeRatio: pct(mappedNodeArticles, totalAccepted),
    classifiedEventCount,
    classifiedEventRatio: pct(classifiedEventCount, events.length),
    classifiedArticleCount: classifiedArticles,
    duplicateRatio: stats.dedupeRate,
    duplicateCount: Math.max(0, totalAccepted - events.length),
    sourceTierCounts: tierCounts,
    sourceTierDistribution,
    actionableSignalCount: usable.size,
    decisions: decisionCounts,
    feedsOk: feedStats.ok, feedsFailed: feedStats.failed,
    sourceHealth,
    lifecycleCounts,
    activeEvents: lifecycleCounts.ACTIVE, weakeningEvents: lifecycleCounts.WEAKENING,
    resolvedEvents: lifecycleCounts.RESOLVED, expiredEvents: lifecycleCounts.EXPIRED,
    uncertainEvents: lifecycleCounts.UNCERTAIN,
    contradictionCount: contradictionIds.size,
    shadowPredictions: shadowPredictions.length,
    evaluablePredictions: storedEvaluations.filter(x => x.evaluable).length,
    evaluated1d: evaluatedCounts['1d'], evaluated3d: evaluatedCounts['3d'], evaluated7d: evaluatedCounts['7d'],
    calibrationStatus: calibration.status,
    categoryDiagnostics
  };
  report.metrics = metrics;

  if (!NO_SAVE) {
    const saved = STORE.append(Object.assign({ timestamp: report.ranAt, mode: report.mode }, metrics));
    report.saved = saved;
  }

  if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); return; }

  /* ── 사람이 읽는 보고 ─────────────────────────────────────── */
  const L = console.log;
  L(`\n══ News Intelligence dry-run (${report.mode}) ══\n`);

  L('── 1. 수집 ──');
  L(`  working source ${report.ingestion.feedsOk} · failed source ${report.ingestion.feedsFailed} · 시도 ${report.ingestion.feedsAttempted}`);
  if (gdeltStats) L(`  GDELT 질의 ${gdeltStats.attempted} · 성공 ${gdeltStats.ok} · 실패 ${gdeltStats.failed}`);
  L(`  총 기사 ${report.ingestion.totalArticles}건`);
  L(`  유효 기사 ${report.ingestion.accepted}건 (${report.ingestion.acceptRate}%)`);
  L(`  출처 정책으로 버림 ${report.ingestion.rejectedBySourcePolicy}건`);
  L(`  URL 중복 제거 후 ${report.ingestion.uniqueAfterUrlDedupe}건`);
  L(`  → 사건 ${report.ingestion.events}건 (중복 제거율 ${report.ingestion.dedupeRate}%)`);
  L(`  공식 출처 비율 ${report.ingestion.officialRatio}%`);
  if (report.ingestion.feedErrors.length) {
    L('  피드 오류:');
    report.ingestion.feedErrors.forEach(e => L(`    ${e.host} — ${e.status || ''} ${e.error || ''}`));
  }
  if (report.ingestion.feedSources.length) {
    L('  source 실행 상태:');
    report.ingestion.feedSources.forEach(s => L(`    ${s.host} — ${s.status}${s.httpStatus ? ` (${s.httpStatus})` : ''}`));
  }

  L('\n── 2. 분류 ──');
  const dist = Object.entries(byEvent).sort((a, b) => b[1] - a[1]);
  if (!dist.length) L('  (사건 없음)');
  dist.forEach(([k, v]) => L(`  ${String(k).padEnd(24)} ${v}`));
  L(`  분류 실패(UNKNOWN) 비율 ${report.classification.unknownRate}%`);
  L('  노드 매핑:');
  Object.entries(byNode).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => L(`    ${String(k).padEnd(18)} ${v}`));

  L('\n── 3. 카테고리별 판단 ──');
  decisions.forEach(d => {
    L(`  [${d.category}] ${d.advice}  (coverage ${d.coverage} · 신뢰도 ${d.confidence}/${d.level})`);
    L(`      뉴스압력 ${d.newsScore} · 사용 ${d.usedEvents} · 제외 ${d.excludedEvents} · 근거 ${d.evidence}건${d.contradicted ? ' · ★상충' : ''}`);
    if (d.blockedBy.length) L(`      BUY 차단: ${d.blockedBy.join(' / ')}`);
  });

  L('\n── 4. 사람이 확인해야 할 것 ──');
  if (!suspicious.length) L('  (없음)');
  suspicious.slice(0, 15).forEach(s => L(`  · ${s.kind}: ${JSON.stringify(s)}`));

  L('\n── 5. 안전 점검 ──');
  const allEvidence = decisions.reduce((n, d) => n + d.evidence, 0);
  const noOrigin = items.filter(i => !i.id || !/^https:\/\//.test(i.url)).length;
  L(`  ingestion 기록 없는 항목: ${noOrigin}건 (0이어야 한다)`);
  L(`  원문 저장 여부: shortSummary 최대 ${NI.SUMMARY_MAX}자 · body/content 필드 없음`);
  L(`  유료 뉴스 API 사용: ${F.paidNewsEnabled() ? 'YES' : 'NO'}`);
  L(`  화면에 오를 근거 총 ${allEvidence}건 — 전부 실제 수집 기록 기반`);
  if (F.UNREACHABLE_FEEDS && F.UNREACHABLE_FEEDS.length) {
    L('  수집 포기한 공식 출처:');
    F.UNREACHABLE_FEEDS.forEach(u => L(`    ${u.host} — ${u.reason}`));
  }

  L('\n── 6. 이번 실행 지표 ──');
  L(`  총 기사 ${metrics.totalArticles} · 유효 ${metrics.validArticles} · 사건 ${metrics.eventCount}`);
  L(`  UNKNOWN 비율 ${metrics.unknownRatio}% · 노드 매핑 ${metrics.mappedNodeRatio}% · 사건 분류 ${metrics.classifiedEventRatio}%`);
  L(`  중복 제거율 ${metrics.duplicateRatio}% · tier A/B/C = ${metrics.sourceTierDistribution.A}%/${metrics.sourceTierDistribution.B}%/${metrics.sourceTierDistribution.C}%`);
  L(`  ★ actionable signal ${metrics.actionableSignalCount}건`);
  L(`  판단 BUY/WAIT/WATCH/NO_DECISION = ${metrics.decisions.BUY}/${metrics.decisions.WAIT}/${metrics.decisions.WATCH}/${metrics.decisions.NO_DECISION}`);
  if (report.saved) {
    L(report.saved.ok
      ? (report.saved.duplicate ? `  누적 기록: 같은 run 중복 방지 (${report.saved.file})` : `  누적 기록: ${report.saved.file}`)
      : `  누적 기록 실패: ${report.saved.reason}`);
  }

  L('\n── V2 Shadow Intelligence ──');
  L(`  source health ${Object.entries(sourceHealthDistribution).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  L(`  lifecycle ACTIVE/WEAKENING/RESOLVED/EXPIRED/UNCERTAIN = ${lifecycleCounts.ACTIVE}/${lifecycleCounts.WEAKENING}/${lifecycleCounts.RESOLVED}/${lifecycleCounts.EXPIRED}/${lifecycleCounts.UNCERTAIN}`);
  L(`  graph path 매핑 event ${report.v2.graphMappedEvents}/${events.length} · contradiction ${report.v2.contradictionCount}`);
  L(`  shadow prediction ${report.v2.shadowPredictions} · 저장 ${report.v2.shadowSaved} · evaluable ${report.v2.evaluablePredictions}`);
  L(`  평가 +1d/+3d/+7d = ${report.v2.evaluated1d}/${report.v2.evaluated3d}/${report.v2.evaluated7d}`);
  L(`  calibration ${calibration.status}`);
  L('  category coverage:');
  categoryDiagnostics.forEach(c => L(`    ${c.category} ${c.coverage} · event ${c.eventCount} · UNKNOWN ${c.unknownRatio}% · actionable ${c.actionable}`));

  L('\n── Tier B source 진단 ──');
  F.PUBLIC_SOURCE_DIAGNOSTICS.forEach(s =>
    L(`  ${String(s.name).padEnd(14)} ${String(s.status).padEnd(11)} ${s.feedUrl || s.reason || ''}`));

  printSummary();
})().catch(e => {
  /* 감사 스크립트도 조용히 죽지 않는다. 무엇이 실패했는지는 말한다. */
  console.error('감사 실패:', e && e.message ? e.message : e);
  process.exit(1);
});

/*
 * 며칠치 누적 요약.
 *
 * ★ 하루치로 결론 내리지 않기 위한 장치다. 실행이 2회 미만이면 추세라고
 *   부르지 않고 그렇게 말한다 — 표본 1개를 추세로 읽는 것이 이 검증에서
 *   가장 하기 쉬운 실수다.
 */
function printSummary() {
  const L = console.log;
  const runs = STORE.load();
  const s = STORE.summarize(runs);

  L('\n── 누적 (며칠치) ──');
  if (!s.runs) { L('  기록 없음 — dry-run 을 한 번 이상 돌리면 쌓인다.'); return; }

  L(`  실행 ${s.runs}회 · 서로 다른 날짜 ${s.distinctDays}일 (${String(s.firstRun).slice(0, 16)} ~ ${String(s.lastRun).slice(0, 16)})`);
  L(`  총 기사 ${s.totals.totalArticles} · 유효 ${s.totals.validArticles} (${s.ratios.validRatio}%) · 사건 ${s.totals.events}`);
  L(`  UNKNOWN 비율 ${s.ratios.unknownRatio}%`);
  L(`  노드 매핑 비율 ${s.ratios.mappedNodeRatio}% · 사건 분류 비율 ${s.ratios.classifiedEventRatio}%`);
  L(`  중복 비율 ${s.ratios.duplicateRatio}%`);
  L(`  출처 tier 분포  A ${s.ratios.tierAShare}% · B ${s.ratios.tierBShare}% · C ${s.ratios.tierCShare}%`);
  L(`  ★ actionable signal 누적 ${s.totals.actionableSignals}건`);
  L(`  판단 BUY/WAIT/WATCH/NO_DECISION = ${s.totals.decisions.BUY}/${s.totals.decisions.WAIT}/${s.totals.decisions.WATCH}/${s.totals.decisions.NO_DECISION}`);

  L('  실행별:');
  s.perRun.slice(-10).forEach(r =>
    L(`    ${String(r.timestamp).slice(0, 16)}  ${String(r.mode).padEnd(12)} 기사 ${String(r.total).padStart(4)} · UNKNOWN ${String(r.unknownRatio).padStart(5)}% · 신호 ${r.actionableSignalCount}`));

  /*
   * 판정은 «며칠치가 쌓인 뒤에만» 말한다.
   * 기준: UNKNOWN 90% 이상이고 쓸 수 있는 신호가 거의 없으면 무료 소스로는 부족하다.
   */
  L('\n── 판정 ──');
  if (s.distinctDays < 2) {
    L('  NEED_MORE_DAYS — 아직 하루치다. 이틀 이상 쌓은 뒤에 본다.');
  } else if (s.ratios.unknownRatio >= 90 && s.totals.actionableSignals <= s.distinctDays) {
    L(`  ${s.distinctDays}일 누적 UNKNOWN ${s.ratios.unknownRatio}% · 신호 ${s.totals.actionableSignals}건.`);
    L('  PAID_OR_API_SOURCE_LIKELY_NEEDED');
  } else {
    L(`  ${s.distinctDays}일 누적 UNKNOWN ${s.ratios.unknownRatio}% · 신호 ${s.totals.actionableSignals}건.`);
    L('  FREE_SOURCES_SUFFICIENT');
  }
  L('');
}
