'use strict';
// AI v3.4 — retrieval text normalization (product documents and queries).
//
// This module only EXPANDS what retrieval can find. It never decides that a
// listing satisfies a request: the existing identity/brand/model/budget
// validators (_ai-v3-catalog matchRequested, _ai-v3-core validateCandidates)
// still judge every candidate, whatever channel found it.
//
// The lexicon is versioned. The version is part of every embedding content
// hash, so changing a synonym re-embeds exactly the affected products.
const crypto = require('node:crypto');
const { explicitType } = require('./_ai-v31-taxonomy');
const { BRANDS, aliasRegex } = require('./_ai-v32-brands');
const { extractTitleEvidence } = require('./_ai-v3-identity');
const { canonModel } = require('./_ai-v31-retrieval');

const LEXICON_VERSION = 'v34-lex-2026-11-12.1';
// canonical retrieval token  ←  aliases sellers/users actually write.
// Only unambiguous aliases: '패드' (마우스패드) or '워치' alone are left out.
const SYNONYMS = [
  ['노트북', ['노트북', '랩탑', '랩톱', 'laptop', '노트pc', '노트북pc', 'notebook']],
  ['이어폰', ['이어폰', '이어버드', 'earbuds', 'earbud', 'tws', '커널형', '오픈형이어폰']],
  ['헤드폰', ['헤드폰', '헤드셋', 'headphone', 'headphones', 'headset']],
  ['스마트폰', ['스마트폰', '휴대폰', '핸드폰', '휴대전화', 'smartphone', '자급제', '공기계']],
  ['태블릿', ['태블릿', '태블릿pc', 'tablet', '아이패드', 'ipad', '갤럭시탭', 'galaxytab', '갤탭']],
  ['공기청정기', ['공기청정기', '청정기', 'airpurifier']],
  ['청소기', ['청소기', 'vacuum', '로봇청소기', '무선청소기', '스틱청소기', '물걸레청소기']],
  ['외장저장장치', ['외장하드', '외장hdd', '외장ssd', '포터블ssd', 'portablessd', 'externalssd', '외장디스크']],
  ['스마트워치', ['스마트워치', 'smartwatch', '애플워치', '갤럭시워치', 'applewatch', 'galaxywatch']],
  ['모니터', ['모니터', 'monitor']],
  ['스피커', ['스피커', 'speaker', '사운드바', 'soundbar']],
  ['키보드', ['키보드', 'keyboard', '기계식키보드']],
  ['마우스', ['마우스', 'mouse']],
  ['노이즈캔슬링', ['노이즈캔슬링', '노캔', 'anc', 'noisecancelling', 'noisecanceling']],
  ['무선', ['무선', 'wireless', '블루투스', 'bluetooth']],
  ['게이밍', ['게이밍', '게임용', 'gaming']],
  ['로봇', ['로봇', 'robot']]
];
const flat = s => String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣+]/g, '');
function basic(text) {
  return String(text == null ? '' : text).normalize('NFKC').toLowerCase()
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[^0-9a-z가-힣+.\s-]/g, ' ')
    .replace(/(?<![0-9])\.|\.(?![0-9])/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
// Short Latin aliases ("anc", "tws") must stand alone: "balance" is not ANC.
const SHORT_LATIN = /^[a-z0-9+]{1,5}$/;
function aliasPresent(alias, f, words) {
  const a = flat(alias);
  if (!a) return false;
  if (SHORT_LATIN.test(a)) return new RegExp('(?<![a-z0-9])' + a.replace(/\+/g, '\\+') + '(?![a-z0-9])').test(words);
  return f.includes(a);
}
function synonymTokens(text) {
  const f = flat(text), words = basic(text);
  const out = [];
  for (const [canonical, aliases] of SYNONYMS) {
    if (aliases.some(a => aliasPresent(a, f, words))) out.push('syn_' + canonical);
  }
  return out;
}
function brandOf(text) {
  const s = String(text || '').normalize('NFKC');
  for (const [canonical, company] of BRANDS) {
    if (company.some(alias => aliasRegex(alias).test(s))) return canonical;
  }
  return '';
}
// Latin+digit model codes as sellers write them ("WF-C700N", "G304", "S25").
function modelCodes(text) {
  const s = String(text || '').normalize('NFKC').toLowerCase();
  // letter-first codes (G304, WF-C700N, SM-S937N) and digit-first ones (15Z90S, 27GR75Q)
  const codes = s.match(/(?<![a-z0-9])(?:[a-z]{1,6}-?[a-z]?\d{1,4}[a-z]{0,4}|\d{1,3}[a-z]{1,3}\d{2,4}[a-z]{0,3})(?![a-z0-9])/g) || [];
  return [...new Set(codes.map(c => c.replace(/-/g, ''))
    .filter(c => !/^\d+(?:gb|tb|mm|cm|hz|w|g|k|mah)$/.test(c) && c.length >= 2))].slice(0, 8);
}
function identityTokens(evidence) {
  return Object.entries(evidence || {}).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => 'id_' + k + '_' + flat(v));
}
// A product document: category, brand, model codes, title identity and the
// normalized seller title. Retrieval-only; nothing here is shown to users.
function productDocument(row) {
  const title = String((row && row.title) || '');
  const category = explicitType(title) || explicitType(String((row && row.keyword) || '')) || '';
  const brand = brandOf(title);
  const evidence = extractTitleEvidence(title);
  const codes = modelCodes(title);
  const parts = [
    category ? 'cat_' + category : '',
    brand ? 'brand_' + flat(brand) : '',
    ...codes.map(c => 'model_' + canonModel(c)),
    ...identityTokens(evidence),
    ...synonymTokens(title + ' ' + ((row && row.keyword) || '')),
    basic(title)
  ].filter(Boolean);
  return { text: parts.join(' ').slice(0, 1200), category, brand, codes, evidence };
}
// A query document from what the USER said plus the planner keyword. The
// planner keyword may only add retrieval terms; it never becomes a filter.
function queryDocument({ query = '', userText = '', category = '', identity = {} } = {}) {
  const said = [userText, query].filter(Boolean).join(' ');
  const cat = category || explicitType(said) || '';
  const brand = brandOf(said);
  const codes = modelCodes(said);
  const parts = [
    cat ? 'cat_' + cat : '',
    brand ? 'brand_' + flat(brand) : '',
    ...codes.map(c => 'model_' + canonModel(c)),
    ...identityTokens(identity && typeof identity === 'object' ? identity : {}),
    ...synonymTokens(said),
    basic(said)
  ].filter(Boolean);
  return { text: parts.join(' ').slice(0, 600), category: cat, brand, codes };
}
function contentHash(docText, { embedderId = '', dims = 0 } = {}) {
  return crypto.createHash('sha256')
    .update(LEXICON_VERSION + '\u0001' + embedderId + '\u0001' + dims + '\u0001' + String(docText))
    .digest('hex');
}
module.exports = { LEXICON_VERSION, SYNONYMS, productDocument, queryDocument, contentHash, synonymTokens,
  brandOf, modelCodes, basic, flat };
