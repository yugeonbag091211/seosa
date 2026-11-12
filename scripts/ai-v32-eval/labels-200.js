'use strict';
// Expected-availability labels for the online-200 corpus
// (scripts/ai-v31-online-200-cases.js), from the read-only Neon evidence in
// docs/ai-v31-rootcause-2026-11-06/db-oracle.jsonl plus manual review of the
// candidate titles (2026-11-06 14:10-15:40 KST catalog state).
//
//   FIND               a suitable product exists in the catalog → no cards = search failure
//   NO_RESULT          nothing in the catalog satisfies the request → no cards is correct
//   NEEDS_VERIFICATION related listings exist but titles cannot prove the constraint
//   NON_SHOPPING       explanation / small talk → must not search
//   DYNAMIC            follow-up: expectation computed from the previous turn's cards
//
// Labels are about the CATALOG, never about what any model version returned.
const NO_RESULT = {
  N007: 'no JBL headphone in catalog (only a JBL-compatible case, a laptop gift mention)',
  N026: 'iPad Air M4 256GB Wi-Fi listings are all 13-inch',
  N028: 'no iPad 10th gen 64GB listing',
  N033: 'Lenovo tablets start at 329,000',
  N040: 'only a carrier-conditioned (통신사이동/완납개통) iPhone 16e',
  N041: 'only an S Pen for S24 Ultra',
  N043: 'base S25 256GB: only an implausible 180,420 listing; other S25 listings state no capacity',
  N045: 'only a Pixel 9a replacement screen',
  N046: 'iPhone 16 Pro 256GB only as used/refurbished',
  N047: 'S23 listing is 256GB, not 128GB',
  N049: 'Galaxy Book4 listings are 15.6"/14" (no 16-inch Book4)',
  N051: 'MacBook Air 13 M4 only as 24GB/512GB (and 15-inch)',
  N052: 'ASUS Vivobook laptops start at 689,000',
  N056: 'no MacBook Pro M4 Pro listing',
  N058: 'no 13-inch laptop <= 1,000,000 (only an LCD part)',
  N062: 'WD 1TB HDD <= 120,000 only as a multi-capacity overseas listing',
  N065: 'no single-capacity 500GB external SSD',
  N067: 'Seagate One Touch only as 16TB desktop',
  N069: '2TB external drive <= 150,000 only as an implausible 35,800 listing',
  N071: '256GB external SSD only as multi-capacity listings',
  N072: '512GB external drives only as multi-capacity listings',
  N118: 'only a Blueair filter',
  N122: 'Samsung stick vacuums <= 400,000: only parts, bags and phone cases',
  N134: 'no JBL Flip 6 (only Flip Essential)',
  N148: 'only Redmi Watch 5 Active (a different model)',
  N151: 'no Galaxy Watch6 Classic',
  N152: 'Apple Watch Series 10 only used / multi-size',
  N154: 'no Galaxy Watch4 at all (the request must still be searched)',
  N159: 'no Aria STG-004',
  N166: 'no used electric guitar; new ones start at 119,800'
};
const NEEDS_VERIFICATION = {
  N031: 'iPad Pro M4 256GB listing without screen size',
  N032: 'iPad mini 7 listing without capacity/network; others 512GB',
  N035: 'Galaxy Tab S9 FE listings state 128GB or no capacity',
  N037: 'iPhone 16 자급제 listing without capacity',
  N038: 'S25+ 자급제 listing without capacity; 256GB ones are graded used',
  N055: 'IdeaPad listings do not state 16GB RAM (some state 8GB)',
  N073: 'Samsung 27" model-code listing without size/FHD text',
  N164: 'acoustic guitars rarely state full size (one OM body)',
  N165: 'no listing states Strat/ST style'
};
// FIND evidence (catalog IDs) for the non-PASS questions that were misses.
const FIND_EVIDENCE = {
  N011: ['ADPICK:c0bad6e04a4af4d', '쿠팡:304287476'], N022: ['ADPICK:276840178edc9a4', 'ADPICK:d0bc5aec0661e23'],
  N039: ['쿠팡:8037230169', '쿠팡:8011369583'], N044: ['쿠팡:9150760301', '쿠팡:8161274337'],
  N048: ['쿠팡:8493748753', '쿠팡:8493748728'], N057: ['쿠팡:9024365733'], N060: ['쿠팡:9024365733'],
  N061: ['ADPICK:94f5a4d1450bd', 'ADPICK:1fb119fbd1dfb'], N063: ['ADPICK:0899d3b04900e', 'ADPICK:40de782ca653c'],
  N070: ['ADPICK:f2c01d8b3557d', 'ADPICK:d196974c77710', '쿠팡:7701711535'], N079: ['쿠팡:7975403014'],
  N092: ['쿠팡:8964372507'], N096: ['쿠팡:9205023094'], N116: ['쿠팡:9594095844'],
  N124: ['ADPICK:6aa8637d50770', '쿠팡:9731663816'], N136: ['쿠팡:8356322970', '쿠팡:9724815949'],
  N145: ['ADPICK:5e8cfd5d7e9a0'], N157: ['쿠팡:9666547493', '쿠팡:9313312366', '쿠팡:8730182617'],
  N158: ['쿠팡:8513421530', '쿠팡:9496241320'], N160: ['쿠팡:9666547493'], N161: ['쿠팡:9666547493'],
  N162: ['쿠팡:9636934514'], N163: ['쿠팡:9666547493'], N167: ['쿠팡:9666547493', '쿠팡:8513421530'],
  N168: ['ADPICK:eb6683781e6c']
};
const NON_SHOPPING = new Set(['N193', 'N194', 'N195', 'N196', 'N197', 'N198', 'N199', 'N200']);
function labelFor(test) {
  if (NON_SHOPPING.has(test.id) || test.expectNoSearch) return { expect: 'NON_SHOPPING' };
  if (test.from) return { expect: 'DYNAMIC' };
  if (NO_RESULT[test.id]) return { expect: 'NO_RESULT', note: NO_RESULT[test.id] };
  if (NEEDS_VERIFICATION[test.id]) return { expect: 'NEEDS_VERIFICATION', note: NEEDS_VERIFICATION[test.id] };
  return { expect: 'FIND', evidence: FIND_EVIDENCE[test.id] || [] };
}
module.exports = { labelFor, NO_RESULT, NEEDS_VERIFICATION, FIND_EVIDENCE };
