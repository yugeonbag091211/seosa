#!/usr/bin/env node
'use strict';

/*
 * 상품 카테고리 GPT 분류를 손님 검색과 분리해서 미리 해 둔다.
 * scripts/classify-product-kinds-batch.js 와 완전히 같은 구조·이유다.
 *
 *   node scripts/classify-product-categories-batch.js              # 최대 ROW_LIMIT개 분류
 *   node scripts/classify-product-categories-batch.js --dry-run    # GPT 호출·저장 없이 "몇 개 할지"만 확인
 *   node scripts/classify-product-categories-batch.js --rows 500   # 이번 실행에서 다룰 최대 상품 수
 *
 * 손님이 검색할 때는 api/_category-store.js의 lookupCategories가 이미
 * 저장된 값만 읽는다 — GPT를 부르지 않으므로 수십 ms밖에 안 걸린다.
 */

require('./_env');
const supabase = require('../api/_supabase');
const { syncCategories } = require('../api/_category-store');

const DEFAULT_ROW_LIMIT = 500;
const DEFAULT_ROUND_SIZE = 20; // classifyBatch의 DEFAULT_MAX_BATCH와 맞춘다.
const DEFAULT_ROUND_BUDGET_MS = 20000;

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? Number(process.argv[i + 1]) : NaN;
};
const ROW_LIMIT = Math.max(1, Math.min(5000,
  argValue('--rows') || Number(process.env.PRODUCT_CATEGORY_BATCH_ROWS) || DEFAULT_ROW_LIMIT));
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * category가 비어 있는 상품을 최대 limit개 가져온다.
 */
async function fetchUncategorized(client, limit) {
  const { data, error } = await client
    .from('products')
    .select('product_id, title')
    .is('category', null)
    .not('title', 'is', null)
    .limit(limit);
  if (error) throw new Error('category 조회 실패: ' + error.message);
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
 * @param {Function} [opts.sync]  주입 가능 — 기본은 _category-store.syncCategories.
 * @param {number}   [opts.rowLimit]
 * @param {number}   [opts.roundSize]
 * @param {number}   [opts.roundBudgetMs]
 * @param {boolean}  [opts.dryRun]
 * @param {Function} [opts.fetchUncategorized] 주입 가능 — 테스트용.
 * @returns {Promise<{candidates:number, classified:number, stillUnknown:number, rounds:number}>}
 */
async function runBatchClassification(opts = {}) {
  const client = opts.supabase || supabase;
  const sync = opts.sync || syncCategories;
  const rowLimit = Math.max(1, Number(opts.rowLimit) || DEFAULT_ROW_LIMIT);
  const roundSize = Math.max(1, Number(opts.roundSize) || DEFAULT_ROUND_SIZE);
  const roundBudgetMs = Math.max(1000, Number(opts.roundBudgetMs) || DEFAULT_ROUND_BUDGET_MS);
  const fetchFn = opts.fetchUncategorized || ((limit) => fetchUncategorized(client, limit));

  const items = await fetchFn(rowLimit);
  const result = { candidates: items.length, classified: 0, stillUnknown: 0, rounds: 0 };
  if (!items.length || opts.dryRun) return result;

  for (const round of chunk(items, roundSize)) {
    result.rounds += 1;
    let cats;
    try {
      cats = await sync(round, { supabase: client, timeBudgetMs: roundBudgetMs });
    } catch (e) {
      console.warn(`[category-batch] 라운드 실패(다음 실행에서 재시도됨): ${e.message}`);
      continue;
    }
    for (const it of round) {
      if (cats.has(it.productId)) result.classified += 1;
      else result.stillUnknown += 1;
    }
  }
  return result;
}

async function main() {
  const items = DRY_RUN ? await fetchUncategorized(supabase, ROW_LIMIT) : null;
  if (DRY_RUN) {
    console.log(`[category-batch] (dry-run) 분류 대상 ${items.length}개`
      + ` (최대 ${ROW_LIMIT}개까지 조회) — GPT 호출·저장 없음.`);
    return;
  }

  const t0 = Date.now();
  const result = await runBatchClassification({ rowLimit: ROW_LIMIT });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[category-batch] 대상 ${result.candidates}개, 분류 완료 ${result.classified}개, `
    + `재시도 대상(타임아웃 등) ${result.stillUnknown}개, 라운드 ${result.rounds}회, 소요 ${sec}s`);

  await writeContinueMarkerIfNeeded({ supabase });
}

/**
 * 이어 붙이기 표식 — scripts/classify-product-kinds-batch.js 와 같은 패턴.
 */
async function writeContinueMarkerIfNeeded(opts = {}) {
  const client = opts.supabase || supabase;
  const fetchFn = opts.fetchUncategorized || ((limit) => fetchUncategorized(client, limit));
  const markerPath = opts.markerPath || process.env.PRODUCT_CATEGORY_CONTINUE_MARKER || '/tmp/product-category-continue.json';
  const writeFile = opts.writeFile || ((p, c) => require('fs').writeFileSync(p, c));

  try {
    const remaining = await fetchFn(1);
    if (remaining.length) {
      writeFile(markerPath, JSON.stringify({ remaining: true }));
      console.log(`[category-batch] 아직 미분류 상품이 남아있음 — 이어 붙이기 표식 작성(${markerPath})`);
      return true;
    }
    console.log('[category-batch] 미분류 상품 0개 — 다 끝남');
    return false;
  } catch (e) {
    console.warn(`[category-batch] 잔여 확인 실패(이어 붙이기 판단 생략): ${e.message}`);
    return false;
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error(`[category-batch] 실행 실패: ${e && e.stack || e}`);
    process.exit(1);
  });
}

module.exports = { runBatchClassification, fetchUncategorized, chunk, writeContinueMarkerIfNeeded };
