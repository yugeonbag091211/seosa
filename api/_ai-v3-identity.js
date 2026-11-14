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
  ['macbook', /(?:맥북|macbook)/i],
  // v3.2: watch and Galaxy Book lines carry model numbers, sizes and
  // variants (Classic/Ultra/Pro 360) that are different products.
  ['galaxywatch', /(?:갤럭시\s*워치|galaxy\s*watch)/i],
  ['applewatch', /(?:애플\s*워치|apple\s*watch)/i],
  ['galaxybook', /(?:갤럭시\s*북|galaxy\s*book)/i]
];
const FAMILY_PREFIX = {
  ipad: /(?:아이패드|ipad)/ig,
  galaxytab: /(?:갤럭시\s*탭|galaxy\s*tab)/ig,
  iphone: /(?:아이폰|iphone)/ig,
  galaxys: /(?:갤럭시\s*s|galaxy\s*s)/ig,
  airpods: /(?:에어팟|airpods)/ig,
  galaxybuds: /(?:갤럭시\s*버즈|galaxy\s*buds)/ig,
  macbook: /(?:맥북|macbook)/ig,
  galaxywatch: /(?:갤럭시\s*워치|galaxy\s*watch)/ig,
  applewatch: /(?:애플\s*워치|apple\s*watch)/ig,
  galaxybook: /(?:갤럭시\s*북|galaxy\s*book)/ig
};
const WATCH_FAMILIES = new Set(['galaxywatch', 'applewatch']);
const VARIANT_MAP = [
  ['edge', /(?<![a-z가-힣])(?:엣지|edge)(?![a-z가-힣])/i],
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
  // v3.2: "2테라" / "1테라바이트" are terabytes too.
  const regex = /(?<![0-9a-z])(\d{1,4})\s*(tb|gb|기가|테라|g)(?![a-z0-9])/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    let val = Number(match[1]);
    if (match[2].toLowerCase() === 'tb' || match[2] === '테라') val *= 1024;
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
  if (values.length) return distinct(values);
  // LG Gram shorthand: '그램 16' or '그램16 16Z90' identifies a
  // 16-inch laptop, even when the seller omits the word '인치'.
  // Do not infer a display size from arbitrary bare numbers or model codes.
  const gram = String(text).match(/(?:그램|gram)\s*(1[4-9])(?=\s|$|[,./])/i);
  if (gram) return Number(gram[1]);
  // v3.2: Korean listings often give the diagonal only in cm ("86.7cm",
  // "68.4cm"). Convert when no inch value is stated (one decimal).
  const cm = [...text.matchAll(/(?<![\d.])(\d{2,3}(?:\.\d{1,2})?)\s*cm(?![a-z])/gi)]
    .map(x => Math.round(Number(x[1]) / 2.54 * 10) / 10).filter(x => x >= 9 && x <= 70);
  return distinct(cm);
}
// Display sizes are marketed by class, not exact diagonal: a "32인치" monitor
// is 31.5", a "24인치" is 23.8", but a 15.6" laptop is NOT a "16인치" one.
function screenMatches(requested, actual, category) {
  const r = Number(requested), a = Number(actual);
  if (!Number.isFinite(r) || !Number.isFinite(a)) return false;
  if (Math.abs(r - a) < 0.05) return true;
  if (category === '모니터') return a >= r - 0.55 && a <= r + 0.35;
  if (category === '노트북') return Number.isInteger(r) && a >= r && a < r + 0.75;
  if (category === '태블릿' || category === '스마트폰') return Math.abs(r - a) <= 0.15;
  return false;
}
// Smartwatch case size (mm) — only meaningful for watch families.
function namedCaseMm(text, family) {
  if (!WATCH_FAMILIES.has(family) && !/(?:워치|watch)/i.test(text)) return null;
  const values = [...text.matchAll(/(?<!\d)(3[8-9]|4[0-9]|5[0-2])\s*mm(?![a-z])/gi)].map(x => Number(x[1]));
  return distinct(values);
}
// A title that enumerates many models ("S25 S24 S23 ...", "4/5/6세대",
// "V7/V8/V10") is a compatibility or accessory listing, not one device.
function listsManyModels(title) {
  const t = normalize(title);
  const sNumbers = new Set([...t.matchAll(/(?<![a-z0-9])s\s?(\d{1,2})(?![0-9])/g)].map(m => m[1]));
  if (sNumbers.size >= 3) return true;
  const generations = new Set([...t.matchAll(/(?<!\d)(\d{1,2})\s*세대/g)].map(m => m[1]));
  if (generations.size >= 3) return true;
  // A model RANGE after a family word: "아이폰 6-17", "갤럭시 S20~S25".
  if (/(?:아이폰|iphone|갤럭시|galaxy|워치|watch|버즈|buds)\s*s?\d{1,2}\s*[-~]\s*s?\d{1,2}(?![\d.])/.test(t)) return true;
  // Three or more distinct manufacturer model codes ("15Z90P 15Z95P 15Z980")
  // — capacities and CPU names are not model codes.
  const codes = new Set((t.match(/(?<![a-z0-9])(?=[a-z0-9-]*\d)(?=[a-z0-9-]*[a-z])[a-z0-9-]{5,12}(?![a-z0-9])/g) || [])
    .filter(c => !/^\d+(?:gb|tb|mb|mah|hz|mm|cm|w|g)$/.test(c) && !/^(?:i[3579]-\d+[a-z]*|usb\d.*|type-c|wi-fi\d*|ddr\d+|lpddr\d+x?|win\d+|rtx\d+|gtx\d+)$/.test(c)));
  if (codes.size >= 3) return true;
  return /(?<![\d.])[a-z]?\d{1,2}\s*\/\s*[a-z]?\d{1,2}\s*\/\s*[a-z]?\d{1,2}(?![\d.])/.test(t);
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
  if (family === 'applewatch' && /^se(?![a-z가-힣])/.test(afterSeries)) return 'se';
  // Galaxy Book "Pro 360" / "360" are 2-in-1 models distinct from "Pro".
  if (family === 'galaxybook' && /^(?:프로|pro)\s*360/.test(afterSeries)) return 'pro360';
  if (family === 'galaxybook' && /^360(?!\d)/.test(afterSeries)) return '360';
  if (WATCH_FAMILIES.has(family) && /^(?:클래식|classic)(?![a-z가-힣])/.test(afterSeries)) return 'classic';
  // The model suffix is the one adjacent to the series number. A later word
  // ("갤럭시북5 프로 ... 인텔 울트라5" CPU name) must not win by list order.
  let best = null;
  for (const [variant, pattern] of VARIANT_MAP) {
    const m = pattern.exec(afterSeries);
    if (m && (best === null || m.index < best.index)) best = { variant, index: m.index };
  }
  return best ? best.variant : null;
}
function namedSeries(text, family) {
  if (!['iphone','galaxytab','galaxys','airpods','galaxybuds','galaxywatch','applewatch','galaxybook'].includes(family)) return null;
  const prefix = FAMILY_PREFIX[family];
  const match = new RegExp(prefix.source, 'i').exec(text);
  if (!match) return null;
  const after = text.slice(match.index + match[0].length);
  if (family === 'applewatch') {
    const s = after.match(/^\s*(?:시리즈|series)\s*(\d{1,2})(?!\d)/i) ||
      after.match(/^\s*s?(\d{1,2})(?!\d)(?!\s*mm)/i);
    return s ? s[1] : null;
  }
  // "워치 44mm" / "북 16인치": a size is not a model number.
  const series = family === 'airpods'
    ? after.match(/^\s*(?:프로|pro|맥스|max)?\s*(\d{1,2})(?!\d)/i)
    : after.match(/^\s*(s?\d{1,3})(?!\d)(?!\s*(?:mm|인치|inch|형))/i);
  return series ? series[1].toLowerCase().replace(/^s(?=\d)/,'') : null;
}
function namedNetwork(text, family) {
  const cellular = /(?:셀룰러|cellular|\blte\b|\b5g\b|e-?sim)/i.test(text);
  if (WATCH_FAMILIES.has(family)) {
    // Watch connectivity: "블루투스(용)" Galaxy Watch, "GPS" Apple Watch.
    if (cellular) return 'cellular';
    if (/(?:블루투스|bluetooth)/i.test(text)) return 'bluetooth';
    if (/\bgps\b/i.test(text)) return 'gps';
    return null;
  }
  const wifi = /(?:와이파이|wi[\s-]?fi)/i.test(text);
  return cellular ? 'cellular' : wifi ? 'wifi' : null;
}

/*
 * iPad mini 의 세대 (2026-11-14, 100문항 오프라인 Q034).
 * 사용자는 «아이패드 미니 7» 처럼 «세대» 없이 말하고, 판매처는 «미니 7» · «A17 Pro» 로 적는다.
 * 예전에는 둘 다 세대로 읽지 않아 «미니 7» 요청에 «mini(A20 Pro 모델)» 신형이 같은 모델로 통과했다.
 * 칩 → 세대는 Apple 이 정한 것만: A12 = 5세대, A15 = 6세대, A17 Pro = 7세대. 모르는 칩은 세대를
 * 지어내지 않는다(그러면 세대를 요구한 요청에서 «확인 불가» 로 빠진다 — checkListingIdentity).
 */
function miniGeneration(text, family, variant) {
  if (family !== 'ipad' || variant !== 'mini') return null;
  const spoken = /(?:미니|mini)\s*(\d)(?![\d.]|\s*(?:인치|inch|형|세대|gb|tb|기가|테라))/i.exec(text);
  if (spoken) return Number(spoken[1]);
  if (/(?<![a-z0-9])a17\s*pro(?![a-z0-9])/i.test(text)) return 7;
  if (/(?<![a-z0-9])a15(?![0-9])/i.test(text)) return 6;
  if (/(?<![a-z0-9])a12(?![0-9])/i.test(text)) return 5;
  return null;
}
function extractTitleEvidence(text) {
  const t=normalize(text);
  const family=namedFamily(t);
  const variant=namedVariant(t,family);
  const generation=namedGeneration(t);
  return trimFields({
    family, series:namedSeries(t,family), variant,
    generation:generation != null ? generation : miniGeneration(t,family,variant), storageGb:namedStorage(t), ramGb:namedRam(t),
    screenInches:namedScreen(t), chip:namedChip(t), network:namedNetwork(t,family),
    caseMm:namedCaseMm(t,family)
  });
}
function requestedIdentity(text) {
  // A user may change a model/option in the same utterance:
  // "128GB 말고 256GB", "아이패드 대신 갤럭시탭".
  // Only user-supplied language can override prior search constraints.
  let input=normalize(text);
  // A standalone Korean "버즈3 프로" names Samsung's Galaxy Buds family.
  // Do not apply this alias to other brands' "Redmi Buds" products.
  input=input.replace(/^\s*(?:(?:삼성|삼성전자)\s*)?버즈\s*(?=\d|fe\b|프로\b)/i,'갤럭시 버즈');
  const segments=input.split(/(?:말고|아니고|대신)/);
  if (segments.length < 2) return extractTitleEvidence(input);
  const before=extractTitleEvidence(segments.slice(0,-1).join(' '));
  const after=extractTitleEvidence(segments[segments.length-1]);
  if (after.family && before.family && after.family !== before.family) return after;
  return trimFields({...before,...after});
}
function mergeRequested(previous, current, isNewSubject) {
  let next = requestedIdentity(current);
  // A follow-up can omit the product family while changing a named model:
  // '갤럭시탭 S10 FE+' -> 'S10 FE로' means the *base* FE, not FE+.
  // Bind this shorthand only to the already established Galaxy Tab family.
  if (!isNewSubject && previous?.family === 'galaxytab' && !next.family &&
      /(?<![a-z0-9])s\s*\d{1,2}\s*fe(?:\s*\+|\s*plus|\s*플러스)?(?=\s|$|[가-힣,.])/i.test(String(current))) {
    next = extractTitleEvidence('갤럭시 탭 ' + String(current));
  }
  return trimFields({...(!isNewSubject && previous && typeof previous==='object' ? previous : {}), ...next});
}
const IDENTITY_KEYS = ['family','series','variant','generation','storageGb','ramGb','screenInches','chip','network','caseMm'];
function checkListingIdentity(listingTitle, requested, options = {}) {
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
    if (!IDENTITY_KEYS.includes(key)) continue;
    const value = requested[key];
    if (e[key] == null) {
      // A missing detail is not proof that a different listing meets the request.
      return { ok:false, reason:'identity_unverified', field:key, evidence:e };
    }
    if (key === 'screenInches' && options.category) {
      if (!screenMatches(value, e[key], options.category))
        return { ok:false, reason:'identity_mismatch', field:key, evidence:e };
      continue;
    }
    if (String(e[key]) !== String(value)) {
      return { ok:false, reason:'identity_mismatch', field:key, evidence:e };
    }
  }
  return { ok:true, evidence:e, checkedFields:requestedKeys.length };
}
module.exports={extractTitleEvidence,requestedIdentity,mergeRequested,checkListingIdentity,compact,
  screenMatches,listsManyModels,IDENTITY_KEYS};
