'use strict';
/*
 * Kiwi(형태소 분석) 도입 판단용 측정 — 지금 JS 파이프라인이 띄어쓰기 변형에 이미 견고한가.
 *
 *   node scripts/search-eval/oss-spacing-robustness.js --snapshot <catalog.jsonl>
 *
 * 질문마다 같은 후보(동결 카탈로그 검색 결과)를 두 검색어로 판정한다:
 *   원문(띄어 씀)  «무선 이어폰», «아이폰 16 프로», «갤럭시 탭 S10»
 *   붙여 씀        «무선이어폰», «아이폰16프로», «갤럭시탭S10»
 * 두 판정(남긴 상품 집합)이 같으면 띄어쓰기에 견고하다. 다르면 형태소 분석이 메울 수 있는 틈이다.
 * 외부 호출·DB 0회.
 */
const path = require('path');
const argv = process.argv.slice(2);
const SNAPSHOT = argv[argv.indexOf('--snapshot') + 1];
const S = require('../../api/_search');
const Gate = require('../../api/_product-gate');
const Spec = require('./spec');
const { CatalogRetriever } = require('./catalog-retriever');

const EXAMPLES = ['무선이어폰', '무선 이어폰', '아이폰16프로', '아이폰 16 프로', '갤럭시탭S10', '갤럭시 탭 S10',
  '80만원 이하 노트북', '조용한 무선 마우스', '게임용 노트북 중 가벼운 제품'];

function keptKeys(query, pool) {
  const spec = Gate.parseQuery(query, { titles: pool.map(x => x.title) });
  const ranked = S.rankItems(spec.rankText, pool.map(x => ({ ...x }))).items.filter(it => Number(it.relevance) >= S.MIN_SCORE);
  const g = Gate.gateItems(spec, ranked);
  return { keys: new Set(g.kept.map(x => `${x.productId}|${x.mall}`)), kept: g.kept };
}

(async () => {
  console.log('[예시] 현재 토큰화(_search.splitTokens) · 관문 해석(_product-gate.parseQuery)');
  for (const q of EXAMPLES) {
    const spec = Gate.parseQuery(q);
    console.log(`  ${q.padEnd(18)} tokens=${JSON.stringify(S.splitTokens(S.normalizeText(q)))} type=${spec.type || '-'} head=${spec.head || '-'} models=${spec.models.join('/') || '-'} fam=${spec.families.map(f => f.anchor + ':' + f.nums.join('/')).join(',') || '-'} var=${[...spec.variants].join('/') || '-'} budget=${spec.budget.max || '-'}`);
  }
  const retriever = new CatalogRetriever(SNAPSHOT);
  const qs = require('./questions-dev').filter(q => q.cat !== 'followup' && /\s/.test(q.q));
  let same = 0, differ = 0, p5Spaced = 0, p5Fused = 0, n = 0;
  const diffs = [];
  for (const q of qs) {
    const pool = retriever.search(q.q, 30);
    const fused = q.q.replace(/\s+/g, '');
    const a = keptKeys(q.q, pool), b = keptKeys(fused, pool);
    const eq = a.keys.size === b.keys.size && [...a.keys].every(k => b.keys.has(k));
    if (eq) same++; else { differ++; if (diffs.length < 12) diffs.push(`${q.q} → ${fused}: ${a.keys.size} vs ${b.keys.size}`); }
    const p = list => { const top = list.slice(0, 5); return top.length ? top.filter(it => Spec.judgeItem(q, it).ok).length / top.length : null; };
    const pa = p(a.kept), pb = p(b.kept);
    if (pa != null && pb != null) { p5Spaced += pa; p5Fused += pb; n++; }
  }
  console.log(`\n[띄어쓰기 견고성] 질문 ${qs.length}개(띄어 쓴 것만) — 남긴 상품 집합이 같음 ${same}, 다름 ${differ} (${Math.round(differ / qs.length * 1000) / 10}%)`);
  console.log(`  P@5 평균 (둘 다 결과가 있는 ${n}개): 띄어 씀 ${(p5Spaced / Math.max(1, n)).toFixed(3)} · 붙여 씀 ${(p5Fused / Math.max(1, n)).toFixed(3)}`);
  diffs.forEach(d => console.log('   ' + d));
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
