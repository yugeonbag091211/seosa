'use strict';

/*
 * A precise laptop screen size is a hard fact, not a preference. If the
 * catalog title does not prove the requested diagonal, do not offer the item
 * as a match. Other requests and vague 'under X inches' size ranges retain
 * the existing ranking behavior. This is intentionally fail-closed on exact
 * screen-size requests, without hallucinating missing specifications.
 */
const AIID = require('./_aiidentity');
const BRANDS = [
  { user: /\bLG\b|엘지|그램|\bgram\b/i, title: /\bLG\b|엘지|그램|\bgram\b/i },
  { user: /삼성|samsung|갤럭시북/i, title: /삼성|samsung|갤럭시북|galaxy\s*book/i },
  { user: /레노버|lenovo/i, title: /레노버|lenovo/i },
  { user: /\bASUS\b|에이수스|비보북|\bROG\b/i, title: /\bASUS\b|에이수스|비보북|\bROG\b/i },
  { user: /\bHP\b|휴렛/i, title: /\bHP\b|휴렛/i },
  { user: /맥북|macbook|\bapple\b|애플/i, title: /맥북|macbook|\bapple\b|애플/i },
  { user: /\bDELL\b|델/i, title: /\bDELL\b|델/i }
];
const LAPTOP = /노트북|랩탑|laptop|notebook|\bgram\b|그램|갤럭시북|맥북|macbook/i;
function requestedExactScreenSize(text) {
  const positive = AIID.splitNegations(text).positive;
  if (!LAPTOP.test(positive)) return null;
  const m = /(?:^|[^0-9])(1[0-9])(?:\.\d+)?\s*(인치|형)(?:\s*(이하|이내|이상|미만|초과|보다|부터))?/i.exec(positive);
  if (!m || m[3]) return null;
  const matches = BRANDS.filter(b => b.user.test(positive));
  return { inches: Number(m[1]), brand: matches.length === 1 ? matches[0] : null };
}
function provenScreenInches(title) {
  const t = String(title || '').normalize('NFKC');
  const explicit = /(?:^|[^0-9])(1[0-9])(?:\.\d+)?\s*(?:인치|형|inch(?:es)?\b)/i.exec(t);
  if (explicit) return Number(explicit[1]);
  // Named laptop series with a documented diagonal in the model family title:
  // LG gram 15 / 그램15, MacBook Pro 14 / 맥북 에어 13.
  const family = /(?:\bgram\b|그램|macbook(?:\s+(?:pro|air))?|맥북(?:\s+(?:프로|에어))?)\s*(1[3-7])(?=$|[^0-9])/i.exec(t);
  return family ? Number(family[1]) : null;
}
function filterVerifiedLaptopSpecs(items, request) {
  const input = Array.isArray(items) ? items : [];
  const constraint = requestedExactScreenSize(String(request || ''));
  if (!constraint) return input;
  return input.filter(it => {
    const title = String(it && it.title || '');
    if (constraint.brand && !constraint.brand.title.test(title)) return false;
    return provenScreenInches(title) === constraint.inches;
  });
}
module.exports = { filterVerifiedLaptopSpecs, requestedExactScreenSize, provenScreenInches };
