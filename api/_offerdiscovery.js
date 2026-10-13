'use strict';
/*
 * Product Identity — Candidate Discovery v2 (후보 재탐색).
 *
 *     products ─▶ parseOffer ─▶ [blockKeys (Phase 1)] ─▶ clusterOffers ─▶ groups
 *                                  └─ [discoveryKeys (v2)] ─▶ rediscover ─▶ groups ⊇ baseline
 *
 * ── 이 파일이 하는 일은 «matcher 에게 보여 주는 쌍» 을 늘리는 것뿐이다 ──
 *
 *   판정은 하지 않는다. 새로 만난 쌍도 전부 api/_offeridentity.js 의 matchOffers 가
 *   clusterOffers 와 «같은» 문맥(contextFactory)으로 판정한다. 군집에 넣는 조건도
 *   그대로 all-pairs 다 — 새 구성원은 군집의 모든 구성원과 MATCH 여야 한다.
 *
 *     후보 생성 ≠ MATCH.  키를 공유했다는 사실은 증거가 아니다.
 *
 * ── 왜 Phase 1 blockKeys 를 고치지 않고 따로 두는가 ─────────────────
 *
 *   2026-10-14 운영 스냅숏(71,277행) 실측:
 *     · MATCH 판정이 날 쌍 중 blockKeys 가 놓친 쌍은 6 개뿐이다(판매처 교차는 5 개) — Tier A
 *       (모델번호·GTIN)는 키가 구조적으로 빠짐없이 잡고, Tier B 는 «계열 낱말이 같을 것» 이 키에
 *       들어 있다. 빠진 것은 붙여쓰기만 다른 계열 낱말(«플로우 스테이트» ↔ «플로우스테이트»)이다.
 *     · 반대로 REVIEW 감인 쌍은 대부분 후보로 만나지도 못한다(제목이 거의 같은 판매처 교차
 *       REVIEW 쌍의 71%).
 *   그래서 v2 는 Phase 1 의 키를 그대로 두고 «덧붙이는» 키만 만든다. 기존 군집은
 *   한 명도 빠지지 않는다(rediscover 는 붙이거나 합치기만 한다).
 *
 * ── 덧붙이는 키 (전부 후보 단계에서만 쓴다) ─────────────────────────
 *
 *   mpn         모델번호를 공백·하이픈·슬래시 차이와 무관하게 — 16-AH1075TX = 16AH1075TX
 *               = 16 AH1075TX = 16 AH 1075 TX. 원문의 영숫자 조각을 이어 붙여 만든다.
 *   short_code  숫자가 적어 parseOffer 가 모델번호로 안 읽는 하이픈 코드 (BZ-AX1 · LZHD-H05)
 *   family      브랜드(없으면 제목 앞 두 낱말) + 첫 앵커 + 등급. 계열 낱말 차이를 넘어 만나게 한다.
 *               단 낱말이 조금은 겹쳐야 한다(FAMILY_MIN_JACCARD) — 브랜드·숫자만 같은 무관한 상품은 거른다.
 *   words       앵커도 모델번호도 없는 상품의 계열 낱말 서명 (REVIEW 로만 이어진다 — Tier 증거가 없다)
 *
 *   한/영 표기(오멘 ↔ omen)는 «키» 에만 맞춘다(KEY_ALIASES). matcher 의 낱말은 그대로다 —
 *   표기를 맞췄다고 같은 상품이 되지 않는다.
 *
 * ── 크기 상한 (O(N²) 금지) ─────────────────────────────────────────
 *
 *   버킷이 maxBucket 을 넘으면 «옵션 서명» (용량·메모리·색·규격·수량) 으로 나눈다.
 *   MATCH 는 이 값들이 같거나 양쪽 모두 없을 때만 나므로 나눠도 MATCH 쌍을 잃지 않는다
 *   (모르는 값은 와일드카드가 아니다 — '∅' 는 자기 칸이다). 그래도 크면 건너뛰고 센다.
 *
 * ── 판매처 ─────────────────────────────────────────────────────────
 *
 *   판매처는 표시 판매처다. 'ADPICK/SSG' 와 'ADPICK/롯데홈쇼핑' 은 백엔드가 같아도 다른
 *   판매처다. 반대로 라벨 없는 'ADPICK' 은 «판매처를 모른다» — 같은 판매처일 수도 있다.
 *   v2 는 «알려진 같은 판매처» 끼리의 쌍은 만들지 않는다(같은 몰 중복 찾기가 목적이 아니다).
 *
 * ── 하지 않는 것 ───────────────────────────────────────────────────
 *
 *   DB 를 읽거나 쓰지 않는다. parseOffer · matchOffers 를 바꾸지 않는다. 기존 군집에서
 *   구성원을 빼지 않는다. 운영 경로(검색·상세·shadow 워커)는 이 파일을 부르지 않는다 —
 *   오프라인 평가(scripts/eval-offer-discovery.js)만 부른다.
 */

const OI = require('./_offeridentity');
const Core = require('./_identitycore');

const SOURCE = Object.freeze({ MPN: 'mpn', SHORT_CODE: 'short_code', FAMILY: 'family', WORDS: 'words' });
const SOURCE_BIT = { mpn: 1, short_code: 2, family: 4, words: 8 };
const SOURCES = Object.keys(SOURCE_BIT);

const DEFAULTS = Object.freeze({
  /* v2 버킷 상한. 옵션 서명으로 나눈 뒤에도 넘으면 건너뛴다(stats.oversizedBuckets). */
  maxBucket: 200,
  /* clusterOffers 의 MAX_GROUP 과 같다 — 합친 군집도 이보다 커지지 않는다. */
  maxGroup: 50,
  /* Phase 1 블록 안 쌍을 다시 볼 때의 상한 (clusterOffers 의 MAX_BLOCK 과 같다). */
  baseMaxBlock: 2000,
  sources: SOURCES
});

/* ==================================================================
 *  판매처
 * ================================================================== */

/* 여러 판매처를 한 백엔드로 들여오는 출처. 라벨 없이 이 이름만 있으면 판매처를 모른다. */
const AGGREGATOR_SOURCES = new Set(['ADPICK']);

function merchantOf(x) { return String((x && x.mall) || '').trim(); }
function merchantKnown(m) { return !!m && !AGGREGATOR_SOURCES.has(m); }

/** 'cross' 서로 다른 알려진 판매처 · 'same' 같은 알려진 판매처 · 'unknown' 한쪽이라도 모름 */
function merchantRelation(a, b) {
  const ma = merchantOf(a), mb = merchantOf(b);
  if (!merchantKnown(ma) || !merchantKnown(mb)) return 'unknown';
  return ma === mb ? 'same' : 'cross';
}

/* ==================================================================
 *  키
 * ================================================================== */

/*
 * 한/영 표기 — 키 전용. matcher 는 이 표를 모른다(같은 상품이라는 근거가 아니다).
 * _offeridentity 의 BRANDS · ALIASES 에 이미 있는 것은 parseOffer 가 맞춰 준다. 여기에는
 * 운영 제목에서 두 표기가 함께 관측된 브랜드·계열만 둔다. 뜻이 둘인 말(레이저=razer/laser,
 * 브라운=braun/갈색)은 넣지 않는다.
 */
const KEY_ALIASES = new Map([
  ['오멘', 'omen'], ['하이퍼엑스', 'hyperx'], ['젠하이저', 'sennheiser'], ['브리츠', 'britz'],
  ['키친에이드', 'kitchenaid'], ['로보락', 'roborock'], ['샥즈', 'shokz'], ['나이키', 'nike'],
  ['아디다스', 'adidas'], ['뉴발란스', 'newbalance'], ['아식스', 'asics'], ['에이치피', 'hp'],
  ['에이서', 'acer'], ['엠에스아이', 'msi'], ['스틸시리즈', 'steelseries'], ['테팔', 'tefal'],
  ['파나소닉', 'panasonic'], ['쿠쿠', 'cuckoo'], ['쿠첸', 'cuchen'], ['코웨이', 'coway'],
  ['스탠리', 'stanley'], ['드롱기', 'delonghi'], ['네스프레소', 'nespresso'], ['위닉스', 'winix'],
  ['티피링크', 'tplink'], ['아이리버', 'iriver'], ['후지필름', 'fujifilm'], ['보스', 'bose'],
  ['오쿠마', 'okuma'], ['에코백스', 'ecovacs'], ['드리미', 'dreame'], ['카시오', 'casio']
]);
const aliasKey = w => KEY_ALIASES.get(w) || w;

/* 원문에서 영숫자 조각이 «구분자로만» 이어진 구간. 한글·괄호를 건너 잇지 않는다. */
const RUN_RE = /[a-z0-9]+(?:[\s\-_./]+[a-z0-9]+)*/g;
const FRAG_SPLIT_RE = /[\s\-_./]+/;
const MAX_WINDOW = 4;
/*
 * 단위·규격 조각 (32g · 1tb · 240hz · 1200x900) — 모델번호의 일부가 아니다. 이런 조각을 품은 이음은 만들지 않는다.
 * 맨숫자 조각("16")은 예외다 — «16-AH1075TX» 처럼 모델번호 앞머리일 수 있다.
 */
const UNIT_FRAG_RE = /^\d+(?:gb|tb|mb|g|kg|mg|mcg|ml|l|mm|cm|m|w|mah|hz|mp|p|k|t|v|a|ea|pcs|pc|cc|in|inch|oz|nm|mbps|gbps|x)$|^\d+x\d+(?:x\d+)?[a-z]*$/;
/*
 * 규격·표준 낱말 (USB 3.0 · Wi-Fi 6 · Win11 Home · M.2 NVMe · MP3 CD) — 상품이 아니라 규격이다.
 * 운영 스냅숏에서 이런 이음이 수십 개 상품을 한 버킷에 모았다. 이 조각이 낀 이음은 키로 쓰지 않는다.
 */
const SPEC_FRAG_RE = /^(?:usb\d*|wi|fi\d*e?|wifi\d*e?|win\d*|windows\d*|home|mp3|cd\d*|nvme|m2|gen\d*|ddr\d*x?|lpddr\d*x?|pcie\d*|hdmi\d*|dp\d*|bt\d*|ipx?\d*|kf\d*|type|ver\d*|ssdt\d*)$/;

/**
 * 원문에서 모델번호 후보 문자열을 뽑는다 (공백·하이픈·슬래시 차이와 무관).
 *   "16-AH1075TX" · "16AH1075TX" · "16 AH1075TX" · "16 AH 1075 TX" → 16ah1075tx (+ 꼬리 영문을 뗀 16ah1075)
 * @returns {Map<string,string>} 문자열 → source(mpn|short_code)
 */
function codeRunKeys(title) {
  const s = Core.cleanIdentityTitle(title).normalize('NFKC').toLowerCase();
  const out = new Map();
  const add = (k, src) => {
    const cur = out.get(k);
    if (!cur || (cur === SOURCE.SHORT_CODE && src === SOURCE.MPN)) out.set(k, src);
  };
  RUN_RE.lastIndex = 0;
  let m;
  while ((m = RUN_RE.exec(s)) !== null) {
    const frags = m[0].split(FRAG_SPLIT_RE).filter(Boolean);
    for (let i = 0; i < frags.length; i++) {
      let joined = '';
      for (let k = i; k < Math.min(frags.length, i + MAX_WINDOW); k++) {
        if (UNIT_FRAG_RE.test(frags[k]) || SPEC_FRAG_RE.test(frags[k])) break;
        joined += frags[k];
        const src = codeShape(joined, k - i + 1, frags[i]);
        if (!src) continue;
        add(joined, src);
        // 색·지역 접미(SM-R630NZWAKOO) 와 붙여 쓴 옵션(16AH1075TX) 을 함께 만나게 — 꼬리 영문을 뗀 줄기.
        const stem = joined.replace(/[a-z]+$/, '');
        if (stem !== joined && /[a-z]/.test(stem) && (stem.match(/\d/g) || []).length >= 3) add(stem, SOURCE.MPN);
      }
    }
  }
  return out;
}

/** 이어 붙인 문자열이 모델번호 꼴인가. 아니면 ''. */
function codeShape(c, fragCount, firstFrag) {
  /*
   * 숫자만 있는 스타일 코드(나이키 «880840-603») — 하이픈으로 이은 것만, 앞 조각 5자리 이상·합 8자리 이상.
   * 날짜(2026-10-14)·전화(010-1234-5678)·ISBN(979-11-…)은 앞 조각이 짧아 걸리지 않는다. 맨 긴 숫자 하나는 판매처 번호다.
   */
  if (/^\d+$/.test(c)) return fragCount >= 2 && firstFrag && /^\d{5,}$/.test(firstFrag) && c.length >= 8 && c.length <= 14 ? SOURCE.MPN : '';
  if (c.length < 4 || c.length > 24 || !/[a-z]/.test(c) || !/\d/.test(c)) return '';
  // «숫자 + 단위 글자» (500mg · 1080p · 3600mbps) 와 치수(1200x900) 는 규격이다 (_offeridentity.addCode 와 같은 생각).
  if (/^\d+[a-z]+$/.test(c) || /^\d+x\d+(?:x\d+)?[a-z]*$/.test(c)) return '';
  const digits = (c.match(/\d/g) || []).length;
  if (digits >= 3) return SOURCE.MPN;
  // 숫자가 한두 개인 코드는 하이픈 등으로 «이어 쓴» 것만 (BZ-AX1 · LZHD-H05). 낱말 하나(buds3)는 앵커 쪽이다.
  if (fragCount >= 2 && /[a-z]{2,}/.test(c) && c.length >= 5) return SOURCE.SHORT_CODE;
  return '';
}

/* 키에 쓰는 계열 낱말 — 등급 표기(v:)·맨숫자를 빼고 한/영 표기만 맞춘다. 순서는 제목 순서. */
function keyWords(id) {
  return id.wordSeq.filter(w => !w.startsWith('v:') && !/^\d+$/.test(w)).map(aliasKey);
}

/*
 * 계열 키의 머리로 쓰지 않는 낱말 — 한 글자 한글, 숫자 뒤에 붙는 단위·등급 말.
 * 운영 스냅숏에서 «26년» · «1등급» · «2채널» · «6년근» 의 숫자가 앵커로 읽혀 무관한 상품을 한 버킷에 모았다.
 */
const HEAD_STOP_RE = /^(?:[가-힣]|년형|년식|년근|등급|채널|개월|퍼센트)$/;
const SPEC_ANCHOR_TAIL = '(?:년|월|일|등급|채널|%|퍼센트|년근|세트)';
const LEADING_TAGS_RE = /^\s*(?:\[[^\]]*\]\s*)+/;

/**
 * 첫 앵커가 계열 키에 쓸 만한가. 판정이 아니라 «후보 버킷이 잡음으로 커지지 않게» 거르는 것이다.
 *   · 앵커가 단위 말 앞에 붙은 숫자면(«26년» · «1등급» · «100%») 모델 번호가 아니다.
 *   · 앵커가 맨 앞 대괄호 꼬리표 안에만 있으면(«[룽스_6820]» · «[예스24배송]») 판매자 표기다.
 */
function familyAnchorUsable(id) {
  const a = id.primaryAnchor;
  const raw = Core.cleanIdentityTitle(id.title).normalize('NFKC').toLowerCase();
  const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/^\d+$/.test(a) && new RegExp(`(?<![a-z0-9.])${esc}\\s*${SPEC_ANCHOR_TAIL}`).test(raw)) return false;
  return new RegExp(`(?<![a-z0-9])${esc}(?![0-9])`).test(raw.replace(LEADING_TAGS_RE, ' '));
}

/* 계열 키로 만난 쌍은 계열 낱말이 이만큼은 겹쳐야 후보다 (브랜드·첫 앵커만 같은 무관한 상품을 거른다). */
const FAMILY_MIN_JACCARD = 0.2;
function wordJaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  a.forEach(w => { if (b.has(w)) inter++; });
  return inter / (a.size + b.size - inter);
}

/*
 * 옵션 서명 — MATCH 가 나려면 반드시 같아야 하는 값만 담는다 (matchOffers 의 충돌·한쪽값 규칙):
 *   용량 · 메모리 · 색(하나일 때) · 규격 · 수량(1 은 «표기 없음» 과 같다).
 * 그래서 큰 버킷을 이 서명으로 나눠도 MATCH 쌍은 같은 칸에 남는다.
 */
function optionSignature(id) {
  const specs = Object.keys(id.specs || {}).sort().map(u => `${u}=${id.specs[u].join('/')}`).join(',');
  const qty = id.quantity != null && id.quantity !== 1 ? String(id.quantity) : '';
  return [id.storage.join('/'), id.memory.join('/'), id.colors.join('/'), specs, qty].join('|');
}

/**
 * v2 후보 키. Phase 1 blockKeys 는 포함하지 않는다(그 쌍은 이미 비교된다).
 * @returns {Array<{key:string, source:string}>}
 */
function discoveryKeys(input, opts) {
  const id = OI.parseOffer(input);
  const on = new Set((opts && opts.sources) || SOURCES);
  const out = [];
  const seen = new Set();
  const push = (key, source) => { if (on.has(source) && !seen.has(key)) { seen.add(key); out.push({ key, source }); } };

  if (on.has(SOURCE.MPN) || on.has(SOURCE.SHORT_CODE)) {
    codeRunKeys(id.title).forEach((source, k) => push(`m:${k}`, source));
  }
  const words = keyWords(id);
  if (id.primaryAnchor) {
    if (familyAnchorUsable(id)) {
      // 브랜드를 모르면 제목 앞 두 낱말 — «[HP] HyperX 오멘» 과 «HyperX 오멘» 이 하나는 겹치게.
      const heads = id.brand ? [id.brand] : [...new Set(words.filter(w => !HEAD_STOP_RE.test(w)).slice(0, 2))];
      heads.forEach(h => push(`f:${h}|${id.primaryAnchor}|${id.variants.join(',')}`, SOURCE.FAMILY));
    }
  } else if (!id.modelNumbers.length && !id.gtins.length) {
    const sig = [...new Set(words)].sort();
    if (sig.length >= 2) push(`w:${sig.join(',')}`, SOURCE.WORDS);
  }
  return out;
}

/* ==================================================================
 *  후보 쌍
 * ================================================================== */

/**
 * v2 키로만 새로 만나는 쌍. Phase 1 블록 키를 공유하는 쌍(이미 비교되는 쌍)과
 * 알려진 같은 판매처 쌍은 뺀다.
 *
 * @param {Array} ids parseOffer 결과
 * @returns {{pairs:Array<[number,number,number]>, stats:object}}  [i, j, sourceBits] (i<j)
 */
function discoverCandidates(ids, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const n = ids.length;
  const baseKeys = ids.map(id => OI.blockKeys(id));
  const wordSets = ids.map(id => new Set(keyWords(id)));
  const buckets = new Map();
  ids.forEach((id, i) => discoveryKeys(id, o).forEach(({ key, source }) => {
    let b = buckets.get(key);
    if (!b) { b = { source, list: [] }; buckets.set(key, b); }
    b.list.push(i);
  }));

  const stats = {
    keys: buckets.size, buckets: 0, splitBuckets: 0, oversizedBuckets: 0, skippedPairs: 0,
    enumerated: 0, sameMerchantSkipped: 0, baseDuplicates: 0, familyLowOverlap: 0, pairs: 0,
    bySource: Object.fromEntries(SOURCES.map(s => [s, { keys: 0, pairs: 0 }]))
  };
  // i*n+j → pairs 의 자리 (≥0) · -1 제외 확정(같은 판매처·Phase 1 후보) · -2 계열 키만으로는 겹침 부족(다른 키로 다시 볼 수 있음)
  const seen = new Map();
  const pairs = [];
  const sharesBase = (i, j) => {
    const a = baseKeys[i], b = baseKeys[j];
    for (let x = 0; x < a.length; x++) for (let y = 0; y < b.length; y++) if (a[x] === b[y]) return true;
    return false;
  };
  const enumerate = (list, source) => {
    const bit = SOURCE_BIT[source];
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const i = Math.min(list[x], list[y]), j = Math.max(list[x], list[y]);
        stats.enumerated++;
        const p = i * n + j;
        const at = seen.get(p);
        if (at !== undefined && at >= 0) {
          if (!(pairs[at][2] & bit)) { pairs[at][2] |= bit; stats.bySource[source].pairs++; }
          continue;
        }
        if (at === -1) continue;
        if (merchantRelation(ids[i], ids[j]) === 'same') { stats.sameMerchantSkipped++; seen.set(p, -1); continue; }
        if (sharesBase(i, j)) { stats.baseDuplicates++; seen.set(p, -1); continue; }
        // 계열 키만으로는 낱말 겹침이 있어야 한다. 다른 키로 다시 만나면 그때 판단한다(-2 는 «아직 미정»).
        if (source === SOURCE.FAMILY && wordJaccard(wordSets[i], wordSets[j]) < FAMILY_MIN_JACCARD) {
          if (at === undefined) stats.familyLowOverlap++;
          seen.set(p, -2);
          continue;
        }
        seen.set(p, pairs.length);
        pairs.push([i, j, bit]);
        stats.bySource[source].pairs++;
      }
    }
  };

  // 결정론 — 키 순서와 무관하게 같은 쌍 집합 (출처 비트도 같다).
  [...buckets.keys()].sort().forEach(key => {
    const { source, list } = buckets.get(key);
    if (list.length < 2) return;
    stats.buckets++;
    stats.bySource[source].keys++;
    if (list.length <= o.maxBucket) { enumerate(list, source); return; }
    stats.splitBuckets++;
    const parts = new Map();
    list.forEach(i => {
      const sig = optionSignature(ids[i]);
      if (!parts.has(sig)) parts.set(sig, []);
      parts.get(sig).push(i);
    });
    [...parts.keys()].sort().forEach(sig => {
      const part = parts.get(sig);
      if (part.length < 2) return;
      if (part.length > o.maxBucket) {
        stats.oversizedBuckets++;
        stats.skippedPairs += (part.length * (part.length - 1)) / 2;
        return;
      }
      enumerate(part, source);
    });
  });
  stats.pairs = pairs.length;
  return { pairs, stats };
}

/* ==================================================================
 *  재탐색 — 기존 군집을 지키며 붙이거나 합친다
 * ================================================================== */

function pairKey(a, b) { return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`; }
const RELATION_RANK = { cross: 0, unknown: 1, same: 2 };

/**
 * @param {Array} offers  parseOffer 입력 또는 결과
 * @param {object} [opts] {baseline: clusterOffers 결과(없으면 계산), maxBucket, maxGroup, sources}
 * @returns {{groups:Array, reviews:Array, baseline:object, stats:object}}
 */
function rediscover(offers, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const started = Date.now();
  const ids = (offers || []).filter(Boolean).map(OI.parseOffer);
  const indexOf = new Map(ids.map((id, i) => [id.key, i]));
  const baseline = o.baseline || OI.clusterOffers(ids, { maxGroup: o.maxGroup });
  // ★ clusterOffers 와 같은 문맥. 이것 없이 matchOffers 를 부르면 계열 차원이 비어 다른 답이 나온다.
  const ctx = OI.contextFactory(ids);

  const judged = new Map();
  const stats = {
    offers: ids.length, comparisons: 0,
    v2: { pairs: 0, MATCH: 0, REVIEW: 0, NO_MATCH: 0, bySource: Object.fromEntries(SOURCES.map(s => [s, { pairs: 0, MATCH: 0, REVIEW: 0, NO_MATCH: 0 }])) },
    baseRecheck: { pairs: 0, matchNotGrouped: 0 },
    attached: 0, mergedGroups: 0, newGroups: 0, blockedMerges: 0, skippedFullGroups: 0,
    discovery: null, ms: 0
  };
  const judge = (i, j) => {
    const k = i < j ? i * ids.length + j : j * ids.length + i;
    let r = judged.get(k);
    if (!r) { stats.comparisons++; r = OI.matchOffers(ids[i], ids[j], ctx(ids[i], ids[j])); judged.set(k, r); }
    return r;
  };

  /* 기존 군집 — 구성원은 빼지 않는다. */
  const groupOf = new Int32Array(ids.length).fill(-1);
  const members = [];
  const origin = [];
  const baselineSize = new Map();
  baseline.groups.forEach(g => {
    const gi = members.length;
    const list = g.members.map(k => indexOf.get(k)).filter(i => i !== undefined);
    list.forEach(i => { groupOf[i] = gi; });
    members.push(list);
    origin.push({ baselineIds: [g.id] });
    baselineSize.set(g.id, list.length);
  });
  ids.forEach((id, i) => { if (groupOf[i] < 0) { groupOf[i] = members.length; members.push([i]); origin.push({ baselineIds: [] }); } });

  /* 1) v2 후보 쌍 판정 */
  const disc = discoverCandidates(ids, o);
  stats.discovery = disc.stats;
  const matches = [];
  const reviews = [];
  disc.pairs.forEach(([i, j, bits]) => {
    const r = judge(i, j);
    stats.v2.pairs++;
    stats.v2[r.decision]++;
    const srcs = SOURCES.filter(s => bits & SOURCE_BIT[s]);
    srcs.forEach(s => { stats.v2.bySource[s].pairs++; stats.v2.bySource[s][r.decision]++; });
    if (r.decision === OI.DECISION.MATCH) matches.push([i, j, r.confidence]);
    else if (r.decision === OI.DECISION.REVIEW) {
      reviews.push({ a: ids[i].key, b: ids[j].key, sources: srcs, relation: merchantRelation(ids[i], ids[j]), confidence: r.confidence, unknown: r.unknown });
    }
  });

  /* 2) Phase 1 블록 안에서 MATCH 인데 군집이 갈라 놓은 쌍 (greedy 순서 탓) */
  const blocks = new Map();
  ids.forEach((id, i) => OI.blockKeys(id).forEach(k => { if (!blocks.has(k)) blocks.set(k, []); blocks.get(k).push(i); }));
  const seenBase = new Set();
  [...blocks.keys()].sort().forEach(k => {
    const list = blocks.get(k);
    if (list.length < 2 || list.length > o.baseMaxBlock) return;
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const i = Math.min(list[x], list[y]), j = Math.max(list[x], list[y]);
      if (groupOf[i] === groupOf[j]) continue;
      const p = i * ids.length + j;
      if (seenBase.has(p)) continue;
      seenBase.add(p);
      stats.baseRecheck.pairs++;
      const r = judge(i, j);
      if (r.decision === OI.DECISION.MATCH) { stats.baseRecheck.matchNotGrouped++; matches.push([i, j, r.confidence]); }
    }
  });

  /*
   * 3) 합치기 — 판매처 교차 쌍부터(같은 판매처 중복보다 교차 발견이 먼저다), 그다음 확신 순.
   *    두 군집을 합치려면 «모든» 교차 쌍이 MATCH 여야 한다(all-pairs). 하나라도 아니면 합치지 않는다.
   */
  matches.sort((x, y) => RELATION_RANK[merchantRelation(ids[x[0]], ids[x[1]])] - RELATION_RANK[merchantRelation(ids[y[0]], ids[y[1]])]
    || y[2] - x[2] || (pairKey(ids[x[0]].key, ids[x[1]].key) < pairKey(ids[y[0]].key, ids[y[1]].key) ? -1 : 1));
  matches.forEach(([i, j]) => {
    const ga = groupOf[i], gb = groupOf[j];
    if (ga === gb) return;
    const A = members[ga], B = members[gb];
    if (A.length + B.length > o.maxGroup) { stats.skippedFullGroups++; return; }
    for (const x of A) for (const y of B) {
      if (judge(x, y).decision !== OI.DECISION.MATCH) { stats.blockedMerges++; return; }
    }
    // 기존 군집 쪽을 남긴다(작은 baseline id). 둘 다 1인 군집이면 새 군집이다.
    const [keep, drop] = keepOrder(ga, gb, origin);
    const singles = (members[keep].length === 1) + (members[drop].length === 1);
    members[drop].forEach(x => { groupOf[x] = keep; });
    members[keep] = members[keep].concat(members[drop]);
    members[drop] = [];
    origin[keep].baselineIds = origin[keep].baselineIds.concat(origin[drop].baselineIds);
    if (singles === 2) stats.newGroups++;        // 1인 + 1인 → 새 군집
    else if (singles === 1) stats.attached++;    // 군집에 한 명 붙임
    else stats.mergedGroups++;                   // 군집 + 군집 (all-pairs 를 다 통과했을 때만)
  });

  /* 4) 결과 — clusterOffers 와 같은 꼴 + 출처 */
  const out = [];
  members.forEach((list, gi) => {
    if (!list.length) return;
    const ms = list.map(i => ids[i]).sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    const priced = ms.filter(m => m.price > 0).sort((x, y) => x.price - y.price || (x.key < y.key ? -1 : 1));
    // baseline: 기존 다중 군집 그대로 · grown: 기존 다중 군집 ⊂ 이 군집 · new: 기존 다중 군집 없이 새로 묶임
    const baseIds = origin[gi].baselineIds.slice().sort((a, b) => a - b);
    const baseMulti = baseIds.filter(b => baselineSize.get(b) > 1);
    const kind = !baseMulti.length ? (ms.length > 1 ? 'new' : 'single')
      : baseMulti.length === 1 && baselineSize.get(baseMulti[0]) === ms.length ? 'baseline' : 'grown';
    out.push({
      id: out.length, size: ms.length, origin: kind, baselineIds: baseIds,
      identity: OI._internal.canonicalIdentity(ms),
      malls: [...new Set(ms.map(m => m.mall).filter(Boolean))].sort(),
      members: ms.map(m => m.key),
      lowest: priced[0] ? { key: priced[0].key, mall: priced[0].mall, price: priced[0].price } : null
    });
  });
  stats.ms = Date.now() - started;
  return { groups: out, reviews, baseline, stats };
}

function keepOrder(ga, gb, origin) {
  const rank = g => (origin[g].baselineIds.length ? Math.min(...origin[g].baselineIds) : Infinity);
  const ra = rank(ga), rb = rank(gb);
  if (ra !== rb) return ra < rb ? [ga, gb] : [gb, ga];
  return ga < gb ? [ga, gb] : [gb, ga];
}

/* ==================================================================
 *  집계 — 그룹 수를 두 가지 판매처 정의로 센다
 * ================================================================== */

/**
 * @param {Array} groups clusterOffers / rediscover 의 groups
 * @param {Map<string,object>} byKey offer key → identity
 */
function groupStats(groups, byKey) {
  const multi = groups.filter(g => g.size > 1);
  let cross = 0, crossRows = 0, known = 0, knownRows = 0, rows = 0;
  multi.forEach(g => {
    const malls = g.members.map(k => merchantOf(byKey.get(k)));
    const all = new Set(malls), knownSet = new Set(malls.filter(merchantKnown));
    rows += g.size;
    if (all.size > 1) { cross++; crossRows += g.size; }
    if (knownSet.size > 1) { known++; knownRows += g.size; }
  });
  return {
    multiOfferGroups: multi.length, groupedRows: rows,
    // Phase 2 shadow 와 같은 정의 — mall 문자열이 둘 이상 (라벨 없는 'ADPICK' 도 한 판매처로 센다)
    crossMerchantGroups: cross, crossMerchantRows: crossRows,
    // 엄격한 정의 — «알려진» 판매처가 둘 이상. 라벨 없는 ADPICK 은 같은 판매처의 재수집일 수 있다.
    knownCrossMerchantGroups: known, knownCrossMerchantRows: knownRows
  };
}

module.exports = {
  SOURCE, DEFAULTS, KEY_ALIASES,
  merchantOf, merchantKnown, merchantRelation,
  codeRunKeys, optionSignature, discoveryKeys, discoverCandidates, rediscover, groupStats
};
