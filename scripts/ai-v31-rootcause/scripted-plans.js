'use strict';
// Scripted planner (GPT stand-in) for the OFFLINE replay of the online-200
// corpus. Built from the recorded live GPT plans (docs/...-results.jsonl
// state.lastQuery) plus the corpus designer's category/budget, and it keeps
// the GPT behaviours that were actually observed to go wrong, so the server
// must be robust to them:
//   * N070: GPT emitted mode=compare with no second subject.
//   * N174/N182: GPT copied displayed product IDs into exclusions.
//   * N193/N194: GPT (adversarially) asks to shop for an explanation question.
const fs = require('node:fs');
const path = require('node:path');
const recorded = Object.fromEntries(fs.readFileSync(
  path.resolve(__dirname, '../../docs/ai-v31-online-200-2026-11-06-results.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(JSON.parse).map(r => [r.id, r]));
const GPT_CATEGORY = { 시계: '스마트워치' };
const MODEL_CODE = /\b(?:[A-Z]{1,4}-?[A-Z]?\d{2,4}[A-Z]{0,3}(?:\s*(?:Shield|Pro|Plus))?|T\d{1,2}(?:\s*Shield)?|V\d{1,2}|MX\s*(?:Master|Keys)\s*\d?[A-Z]?|Flip\s*\d|One\s*Touch|G\s*Pro\s*X\s*Superlight\s*\d?)\b/;
const OVERRIDES = {
  N048: { mode: 'compare', query: '갤럭시 S25 엣지', compareQuery: '갤럭시 S25 기본형', category: '스마트폰' },
  N070: { mode: 'compare', query: '삼성 T9 1TB 외장 SSD', compareQuery: '', category: '외장 SSD', exactModel: 'T9' },
  N131: { mode: 'compare', query: '로보락 로봇청소기', compareQuery: '삼성 제트 무선청소기', category: '청소기' },
  N154: { mode: 'recommend', query: '갤럭시 워치4', category: '스마트워치', maxPrice: 39999 },
  N162: { mode: 'recommend', query: '클래식 기타', category: '기타', maxPrice: 150000 },
  N167: { mode: 'recommend', query: '기타 본체', category: '기타', maxPrice: 140000 },
  N193: { mode: 'recommend', query: 'aptX 블루투스 코덱', category: '이어폰' },
  N194: { mode: 'recommend', query: 'OLED 모니터', category: '모니터' }
};
function scriptedPlan(test, state = {}) {
  const rec = recorded[test.id] || {};
  const rs = rec.state || {};
  const base = {
    mode: test.expectNoSearch ? 'none' : 'recommend',
    query: rs.lastQuery || '',
    compareQuery: '',
    category: GPT_CATEGORY[test.cat] || test.cat || '',
    maxPrice: test.max != null ? test.max : (rs.maxPrice != null ? rs.maxPrice : null),
    exclusions: [],
    mallOnly: '',
    exactModel: ''
  };
  const code = String(test.p).match(MODEL_CODE);
  if (code) base.exactModel = code[0];
  if (test.from) {
    // Follow-up: a planner keeps the subject and only restates constraints.
    base.query = state.lastQuery || base.query;
    base.category = state.category || base.category;
    base.maxPrice = null;
    if (['N174', 'N182'].includes(test.id)) base.exclusions = (state.presentedProductIds || []).slice();
  }
  return { ...base, ...(OVERRIDES[test.id] || {}) };
}
module.exports = { scriptedPlan };
