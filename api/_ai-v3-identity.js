'use strict';

// Listing-title evidence ONLY, never manufacturer-confirmed specifications.
// Parse explicit identifiers and reject ambiguous or conflicting listings.
// This module has no model, network, DB or hard-coded QA question dependencies.
const normalize = value => String(value || '').normalize('NFKC').toLowerCase();
const compact = value => normalize(value).replace(/[^0-9a-z가-힣+]/g, '');
const trimFields = evidence => Object.fromEntries(Object.entries(evidence).filter(([,v]) => v != null));

const FAMILIES = [
  ['ipad', /(?:아이패드|ipad)/i],
  ['galaxytab', /(?:갤럭시\s*탭|galaxy\s*tab)/i],
  ['iphone', /(?:아이폰|iphone)/i],
  ['galaxys', /(?:갤럭시\s*s|galaxy\s*s)(?=\s*\d)/i],
  ['airpods', /(?:에어팟|airpods)/i],
  ['galaxybuds', /(?:갤럭시\s*버즈|galaxy\s*buds)/i],
  ['macbook', /(?:맥북|macbook)/i]
];
const FAMILY_PREFIX = {
  ipad: /(?:아이패드|ipad)/ig,
  galaxytab: /(?:갤럭시\s*탭|galaxy\s*tab)/ig,
  iphone: /(?:아이폰|iphone)/ig,
  galaxys: /(?:갤럭시\s*s|galaxy\s*s)/ig,
  airpods: /(?:에어팟|airpods)/ig,
  galaxybuds: /(?:갤럭시\s*버즈|galaxy\s*buds)/ig,
  macbook: /(?:맥북|macbook)/ig
};
const VARIANT_MAP = [
  ['pro-max', /(?<![a-z가-힣])(?:프로\s*맥스|pro\s*max)(?![a-z가-힣])/i],
  ['ultra', /(?<![a-z가-힣])(?:울트라|ultra)(?![a-z가-힣])/i],
  ['pro', /(?<![a-z가-힣])(?:프로|pro)(?![a-z가-힣])/i],
  ['air', /(?<![a-z가-힣])(?:에어|air)(?![a-z가-힣])/i],
  ['mini', /(?<![a-z가-힣])(?:미니|mini)(?![a-z가-힣])/i],
  ['plus', /(?<![a-z가-힣])(?:플러스|plus|\+)(?![a-z가-힣])/i],
  ['max', /(?<![a-z가-힣])(?:맥스|max)(?![a-z가-힣])/i],
  ['fe', /\bfe\b/i]
];

function distinct(values) {
  const filtered = values.filter(x => x != null && x !== '');
  return [...new Set(filtered)].length === 1 ? filtered[0] : null;
}
function namedStorage(text) {
  const values = [];
  const regex = /(?<![0-9a-z])(\d{1,4})\s*(tb|gb|기가|g)(?![a-z0-9])/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    let val = Number(match[1]);
    if (match[2].toLowerCase() === 'tb') val *= 1024;
    // 8/16/24 GB are usually RAM; do not confuse them with storage.
    const before = text.slice(Math.max(0,match.index-10), match.index);
    const after = text.slice(match.index+match[0].length, match.index+match[0].length+10);
    const beforeWide = text.slice(Math.max(0, match.index-32),match.index);
    const descriptorBefore = /(?:ram|램|메모리)\s*$/i.test(before)
      && !/\d{1,3}\s*(?:gb|g|기가)\s*(?:ram|램|메모리)\s*$/i.test(beforeWide);
    const ramDescriptor = descriptorBefore || /^\s*(?:ram|램|메모리)/i.test(after);
    if (val >= 32 && val <= 8192 && !ramDescriptor) values.push(val);
  }
  return distinct(values);
}
function namedRam(text) {
  const vals = [];
  const patterns = [
    /(?:ram|램|메모리)\s*(\d{1,3})\s*(?:gb|기가|g)(?![a-z0-9])/gi,
    /(?<![a-z0-9])(\d{1,3})\s*(?:gb|기가|g)\s*(?:ram|램|메모리)/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const v=Number(match[1]); if (v > 0 && v <= 256) vals.push(v);
    }
  }
  return distinct(vals);
}
function namedScreen(text) {
  const values = [...text.matchAll(/(?<!\d)(\d{1,2}(?:\.\d)?)\s*(?:인치|inch|형|["″])(?![a-z])/gi)]
    .map(x => Number(x[1])).filter(x => x >= 5 && x <= 70);
  // Apple seller shorthand "iPad Air 11 M4" uses 11 as screen size;
  // do not mistake an "iPad 11세대" generation number for inches.
  const ipadSize=String(text).match(/(?:아이패드|ipad)\s*(?:에어|air|프로|pro)?\s*(11|13)\s*(?=m[1-9]|wifi|wi-?fi)/i);
  if(ipadSize)values.push(Number(ipadSize[1]));
  return distinct(values);
}
function namedGeneration(text) {
  const values = [...text.matchAll(/(?<!\d)(\d{1,2})\s*(?:세대|generation|gen)(?![a-z])/gi)]
    .map(x => Number(x[1])).filter(x => x > 0);
  return distinct(values);
}
function namedChip(text) {
  const values = [...text.matchAll(/(?<![a-z0-9])m([1-9]\d?)(?:\s*(pro|max|ultra))?(?![a-z0-9])/gi)]
    .map(x => 'm' + x[1] + (x[2] ? '-' + x[2].toLowerCase() : ''));
  return distinct(values);
}
function namedFamily(text) {
  const families = FAMILIES.filter(([,p]) => p.test(text)).map(([f])=>f);
  return distinct(families);
}
function namedVariant(text, family) {
  if (!family) return null;
  const re = FAMILY_PREFIX[family];
  if (!re) return null;
  const m = new RegExp(re.source, 'i').exec(text);
  if (!m) return null;
  // Limit to the model phrase after the product family. A generic "pro" in
  // seller advertising elsewhere in the title must not change the model.
  const segment = text.slice(m.index + m[0].length, m.index + m[0].length + 26)
    .split(/[|,()[\]\\/]/)[0];
  const afterSeries = segment.replace(/^\s*(?:s?\d{1,3})(?!\d)\s*/i, '').trim();
  // A Pro/Max AirPods title is not the ordinary AirPods 4 ANC model.
  if (family === 'airpods' && /(?:^|\s)(?:프로|pro|맥스|max)(?:\s*\d|\s|$)/i.test(afterSeries))
    return /(?:맥스|max)/i.test(afterSeries) ? 'max' : 'pro';
  if (family === 'airpods' &&
    /(?:\banc\b|액티브\s*노이즈\s*캔슬링|active\s*noise\s*cancell?ation|노이즈\s*캔슬링)/i.test(afterSeries)) return 'anc';
  // Galaxy Tab FE+ (FE Plus) is a distinct model from the base FE.
  // Detect it before the generic FE suffix, including compact S9FE+ titles.
  if (family === 'galaxytab' && /^fe\s*(?:\+|플러스|plus)(?![a-z가-힣])/i.test(afterSeries)) return 'fe-plus';
  if (family === 'iphone' && /^e(?![a-z가-힣])/.test(afterSeries)) return 'e';
  if (family === 'iphone' && /^se(?![a-z가-힣])/.test(afterSeries)) return 'se';
  for (const [variant, pattern] of VARIANT_MAP) {
    if (pattern.test(afterSeries)) return variant;
  }
  return null;
}
function namedSeries(text, family) {
  if (!['iphone','galaxytab','galaxys','airpods','galaxybuds'].includes(family)) return null;
  const prefix = FAMILY_PREFIX[family];
  const match = new RegExp(prefix.source, 'i').exec(text);
  if (!match) return null;
  const after = text.slice(match.index + match[0].length);
  const series = family === 'airpods'
    ? after.match(/^\s*(?:프로|pro|맥스|max)?\s*(\d{1,2})(?!\d)/i)
    : after.match(/^\s*(s?\d{1,3})(?!\d)/i);
  return series ? series[1].toLowerCase().replace(/^s(?=\d)/,'') : null;
}
function namedNetwork(text) {
  const cellular = /(?:셀룰러|cellular|\blte\b|\b5g\b)/i.test(text);
  const wifi = /(?:와이파이|wi[\s-]?fi)/i.test(text);
  return cellular ? 'cellular' : wifi ? 'wifi' : null;
}

function extractTitleEvidence(text) {
  const t=normalize(text);
  const family=namedFamily(t);
  return trimFields({
    family, series:namedSeries(t,family), variant:namedVariant(t,family),
    generation:namedGeneration(t), storageGb:namedStorage(t), ramGb:namedRam(t),
    screenInches:namedScreen(t), chip:namedChip(t), network:namedNetwork(t)
  });
}
function requestedIdentity(text) {
  // A user may change a model/option in the same utterance:
  // "128GB 말고 256GB", "아이패드 대신 갤럭시탭".
  // Only user-supplied language can override prior search constraints.
  const input=normalize(text);
  const segments=input.split(/(?:말고|아니고|대신)/);
  if (segments.length < 2) return extractTitleEvidence(input);
  const before=extractTitleEvidence(segments.slice(0,-1).join(' '));
  const after=extractTitleEvidence(segments[segments.length-1]);
  if (after.family && before.family && after.family !== before.family) return after;
  return trimFields({...before,...after});
}
function mergeRequested(previous, current, isNewSubject) {
  return trimFields({...(!isNewSubject && previous && typeof previous==='object' ? previous : {}),
    ...requestedIdentity(current)});
}
function checkListingIdentity(listingTitle, requested) {
  const e=extractTitleEvidence(listingTitle);
  const requestedKeys = Object.keys(requested || {}).filter(k => requested[k] != null);
  // "Buds FE" is an exact unnumbered model; "Buds3 FE" is a different generation.
  if(requested?.family==='galaxybuds'&&requested.variant==='fe'&&
    requested.series==null&&e.series!=null)
    return {ok:false,reason:'identity_mismatch',field:'series',evidence:e};
  // A named numbered model without a suffix is the base model, not an FE/Pro/Ultra variant.
  if (requested && requested.series && !requested.variant && e.variant)
    return { ok:false, reason:'identity_mismatch', field:'variant', evidence:e };
  for (const key of requestedKeys) {
    if (!['family','series','variant','generation','storageGb','ramGb','screenInches','chip','network'].includes(key)) continue;
    const value = requested[key];
    if (e[key] == null) {
      // A missing detail is not proof that a different listing meets the request.
      return { ok:false, reason:'identity_unverified', field:key, evidence:e };
    }
    if (String(e[key]) !== String(value)) {
      return { ok:false, reason:'identity_mismatch', field:key, evidence:e };
    }
  }
  return { ok:true, evidence:e, checkedFields:requestedKeys.length };
}
module.exports={extractTitleEvidence,requestedIdentity,mergeRequested,checkListingIdentity,compact};
