#!/usr/bin/env node
'use strict';

/*
 * "본품 vs 부속" GPT 분류를 손님 검색과 분리해서 미리 해 둔다.
 *
 *   node scripts/classify-product-kinds-batch.js              # 최대 ROW_LIMIT개 분류
 *   node scripts/classify-product-kinds-batch.js --dry-run    # GPT 호출·저장 없이 "몇 개 할지"만 확인
 *   node scripts/classify-product-kinds-batch.js --rows 500   # 이번 실행에서 다룰 최대 상품 수
 *
 * ── 왜 이 스크립트가 따로 생겼나 (2026-11-25) ───────────────────────
 * 원래는 손님이 검색할 때, 처음 보는 상품이면 그 자리에서 GPT에게 "본품이냐
 * 부속이냐" 물어보고 바로 DB에 저장했다(api/_product-kind-store.js의
 * syncProductKinds, api/search.js에서 inline 호출). 그런데 운영 환경에서
 * Codex로 직접 돌려보니 — 처음 묻는 그 검색 한 번에 1.8~2.9초가 그대로
 * 더 걸렸다. 손님은 그 시간만큼 더 기다린 것이다.
 *
 * 그래서 "GPT에게 묻고 저장"하는 일을 손님 요청과 완전히 분리해서, 이 스크립트가
 * 한가할 때(GitHub Actions 스케줄) 미리 다 해 둔다. 손님이 검색할 때는
 * api/_product-kind-store.js의 lookupProductKinds가 이미 저장된 값만 읽는다
 * — GPT를 부르지 않으므로 수십 ms밖에 안 걸린다.
 *
 * 비유: 손님이 계산대에서 기다리는 동안 점원이 바코드를 찾는 게 아니라, 한가할
 * 때 미리 상품마다 바코드를 붙여 놓고(이 스크립트), 손님이 오면 스캔만
 * 하는 것(lookupProductKinds)이다.
 *
 * ── 안전장치 ─────────────────────────────────────────────────────
 * - 분류·저장 로직은 api/_product-kind-store.js의 syncProductKinds를 그대로
 *   재사용한다 — PR #272에서 고친 "null(재시도 대상) vs unknown(저장 가능)"
 *   구분을 그대로 물려받는다. 이 스크립트가 따로 null/unknown을 가리지 않는다.
 * - 한 회차(라운드)에 classifyBatch가 한 번에 다루는 상품 수는 분류기 자체의
 *   DEFAULT_MAX_BATCH(20)를 따른다 — 이 스크립트는 몇 라운드를 돌릴지만 정한다.
 * - --dry-run은 "product_kind가 비어 있는 상품이 몇 개인지"만 세고 끝낸다 —
 *   GPT 호출도 DB 쓰기도 없다.
 * - 이 스크립트가 실패하거나 중간에 멈춰도 손님 검색에는 아무 영향이 없다 —
 *   다음 실행 때 아직 비어 있는 상품부터 이어서 분류한다.
 */

require('./_env');
const supabase = require('../api/_supabase');
const { syncProductKinds } = require('../api/_product-kind-store');

const DEFAULT_ROW_LIMIT = 500;
const DEFAULT_ROUND_SIZE = 20; // classifyBatch의 DEFAULT_MAX_BATCH와 맞춘다.
const DEFAULT_ROUND_BUDGET_MS = 20000; // 라운드 하나(최대 20개 분류)당 넉넉한 시간.

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? Number(process.argv[i + 1]) : NaN;
};
const ROW_LIMIT = Math.max(1, Math.min(5000,
  argValue('--rows') || Number(process.env.PRODUCT_KIND_BATCH_ROWS) || DEFAULT_ROW_LIMIT));
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * product_kind가 비어 있는 상품을 최대 limit개 가져온다. 같은 product_id가
 * 여러 mall 행으로 중복될 수 있어 다시 한 번 중복을 걷어낸다.
 */
async function fetchUnclassified(client, limit) {
  const { data, error } = await client
    .from('products')
    .select('product_id, title')
    .is('product_kind', null)
    .not('title', 'is', null)
    .limit(limit);
  if (error) throw new Error('product_kind 조회 실패: ' + error.message);
  const seen = new Set();
  const out = [];
  for (const row of (data || [])) {
    const pid = String(row && row.product_id || '');
    if (!pid || !row.title || seen.has(pid)) continue;
    seen.add(pid);
    out.push({ productId: pid, title: row.title });
  }
  return out;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * @param {object} opts
 * @param {object}   [opts.supabase]
 * @param {Function} [opts.sync]        주입 가능 — 기본은 _product-kind-store.syncProductKinds.
 * @param {number}   [opts.rowLimit]
 * @param {number}   [opts.roundSize]
 * @param {number}   [opts.roundBudgetMs]
 * @param {boolean}  [opts.dryRun]
 * @param {Function} [opts.fetchUnclassified] 주입 가능 — 테스트에서 가짜 목록으로 교체한다.
 * @returns {Promise<{candidates:number, classified:number, unknown:number, stillUnknown:number, rounds:number}>}
 */
async function runBatchClassification(opts = {}) {
  const client = opts.supabase || supabase;
  const sync = opts.sync || syncProductKinds;
  const rowLimit = Math.max(1, Number(opts.rowLimit) || DEFAULT_ROW_LIMIT);
  const roundSize = Math.max(1, Number(opts.roundSize) || DEFAULT_ROUND_SIZE);
  const roundBudgetMs = Math.max(1000, Number(opts.roundBudgetMs) || DEFAULT_ROUND_BUDGET_MS);
  const fetchFn = opts.fetchUnclassified || ((limit) => fetchUnclassified(client, limit));

  const items = await fetchFn(rowLimit);
  const result = { candidates: items.length, classified: 0, stillUnknown: 0, rounds: 0 };
  if (!items.length || opts.dryRun) return result;

  for (const round of chunk(items, roundSize)) {
    result.rounds += 1;
    let kinds;
    try {
      kinds = await sync(round, { supabase: client, timeBudgetMs: roundBudgetMs });
    } catch (e) {
      console.warn(`[product-kind-batch] 라운드 실패(다음 실행에서 재시도됨): ${e.message}`);
      continue;
    }
    for (const it of round) {
      if (kinds.has(it.productId)) result.classified += 1;
      else result.stillUnknown += 1; // null — 타임아웃 등으로 못 물어봄, 다음 실행에서 재시도.
    }
  }
  return result;
}

async function main() {
  const items = DRY_RUN ? await fetchUnclassified(supabase, ROW_LIMIT) : null;
  if (DRY_RUN) {
    console.log(`[product-kind-batch] (dry-run) 분류 대상 ${items.length}개`
      + ` (최대 ${ROW_LIMIT}개까지 조회) — GPT 호출·저장 없음.`);
    return;
  }

  const t0 = Date.now();
  const result = await runBatchClassification({ rowLimit: ROW_LIMIT });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[product-kind-batch] 대상 ${result.candidates}개, 분류 완료 ${result.classified}개, `
    + `재시도 대상(타임아웃 등) ${result.stillUnknown}개, 라운드 ${result.rounds}회, 소요 ${sec}s`);

  await writeContinueMarkerIfNeeded({ supabase });
}

/**
 * ── 이어 붙이기 표식 (2026-11-26) ───────────────────────────────────────
 * 오늘처럼 밀린 게 몇만 건일 땐 한 번 실행(최대 rows개)으로 끝나지 않는다.
 * 이번 실행이 처리한 뒤에도 아직 product_kind가 빈 상품이 남아있으면, 그
 * 사실만 파일로 남긴다 — daily-prices.yml의 "이어 붙이기" 표식과 같은 패턴.
 * 실제로 다음 실행을 만드는 건 워크플로의 별도 단계가 한다(이 스크립트는
 * GitHub API를 모른다 — 그냥 "더 남았다"는 사실만 보고한다).
 *
 * @param {object} [opts]
 * @param {object}   [opts.supabase]
 * @param {Function} [opts.fetchUnclassified] 주입 가능 — 테스트용.
 * @param {string}   [opts.markerPath]
 * @param {Function} [opts.writeFile] 주입 가능 — 테스트에서 실제 파일 안 쓰고 검증.
 * @returns {Promise<boolean>} 표식을 남겼으면 true.
 */
async function writeContinueMarkerIfNeeded(opts = {}) {
  const client = opts.supabase || supabase;
  const fetchFn = opts.fetchUnclassified || ((limit) => fetchUnclassified(client, limit));
  const markerPath = opts.markerPath || process.env.PRODUCT_KIND_CONTINUE_MARKER || '/tmp/product-kind-continue.json';
  const writeFile = opts.writeFile || ((p, c) => require('fs').writeFileSync(p, c));

  try {
    const remaining = await fetchFn(1);
    if (remaining.length) {
      writeFile(markerPath, JSON.stringify({ remaining: true }));
      console.log(`[product-kind-batch] 아직 미분류 상품이 남아있음 — 이어 붙이기 표식 작성(${markerPath})`);
      return true;
    }
    console.log('[product-kind-batch] 미분류 상품 0개 — 다 끝남');
    return false;
  } catch (e) {
    console.warn(`[product-kind-batch] 잔여 확인 실패(이어 붙이기 판단 생략): ${e.message}`);
    return false;
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error(`[product-kind-batch] 실행 실패: ${e && e.stack || e}`);
    process.exit(1);
  });
}

module.exports = { runBatchClassification, fetchUnclassified, chunk, writeContinueMarkerIfNeeded };
