/*
 * 상품 스펙 추출 — 제목에서, 근거와 함께.
 *
 * ── 왜 제목인가 ─────────────────────────────────────────────────
 *
 * SEOSA 가 상품에 대해 실제로 가진 것은 제목·가격·가격 기록뿐이다.
 * 쿠팡/ADPICK 응답에는 정규화된 스펙 필드가 없다. 그래서 지금까지 AI 는
 * 스펙 질문에 "확인되지 않습니다" 만 할 수 있었고, 그것이 비교 답변의
 * 천장이었다.
 *
 * 그런데 한국 쇼핑몰 제목은 스펙 그 자체다. 운영 DB 실측:
 *
 *   "아이리스 저소음 에어 서큘레이터 PCF-HD15, PCF-HD15(블랙)"
 *   "…랜덤노트북 13 / 14 / 15.6인치 … ssd 램4 …"
 *   "Sidagar 대용량 세라믹 빨대텀블러 … 1개, 1100ml, 핑크"
 *   "Machenike L8 Pro/Max RGB 무선 게이밍 마우스 … 8K 반응률 PAW3395 센서"
 *
 * 모델명·용량·크기·색상·연결 방식이 전부 들어 있다. 이건 추측이 아니라
 * 판매자가 적어 놓은 사실이다. 그것을 구조화하는 것은 환각이 아니다.
 *
 * ── 지켜야 할 선 ────────────────────────────────────────────────
 *
 * ★ 제목에 없는 값은 절대 만들지 않는다.
 *   "무선 이어폰"에서 배터리 시간을 유추하지 않는다. 블루투스 이어폰이니
 *   보통 5시간쯤이라는 "상식"으로 채우는 순간, 그건 스펙이 아니라 환각이다.
 *
 * ★ 모든 추출값은 근거(evidence)를 함께 남긴다.
 *   evidence 는 제목에서 잘라낸 실제 문자열이다. 이것이 있으면 나중에
 *   AI 가 말한 스펙이 진짜인지 코드로 되짚을 수 있다(_ai.js firewall).
 *
 * ★ 애매하면 뽑지 않는다.
 *   틀린 스펙은 없는 스펙보다 훨씬 나쁘다. 사용자가 그걸 보고 산다.
 */

/** 값 하나와 그 근거. */
function pick(value, evidence) {
  return { value, evidence: String(evidence || '').trim() };
}

function toNum(s) {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/*
 * 기능 키워드.
 *
 * 표기가 여러 가지인 것들을 하나의 라벨로 모은다("노이즈캔슬링" / "ANC" /
 * "노캔" → 노이즈캔슬링). 라벨은 사용자에게 그대로 보여도 되는 한국어다.
 *
 * ★ 부정 표현을 조심한다. "배터리없음" 이 있는데 배터리 기능으로 잡으면
 *   정반대가 된다. NEGATE 에 걸리면 그 기능은 빼는 게 아니라 아예 안 뽑는다.
 */
const FEATURES = [
  ['무선',         /무선|와이어리스|wireless/i,                        /무선\s?충전/],
  ['유선',         /유선(?!\s?무선)|wired/i,                            null],
  ['블루투스',     /블루투스|bluetooth/i,                               null],
  ['노이즈캔슬링', /노이즈\s?캔슬|노캔|\bANC\b|액티브\s?노이즈/i,       null],
  ['방수',         /방수|생활방수|\bIPX?\d\b|waterproof/i,              null],
  ['급속충전',     /급속\s?충전|고속\s?충전|fast\s?charg/i,             null],
  ['무선충전',     /무선\s?충전|qi\s?충전/i,                            null],
  ['터치조작',     /터치\s?(조작|컨트롤)/i,                             null],
  ['마이크',       /마이크|mic\b|통화/i,                                null],
  ['경량',         /초경량|경량|가벼운/i,                               null],
  ['대용량',       /대용량/i,                                           null],
  ['저소음',       /저소음|무소음|정숙/i,                               null],
  ['휴대용',       /휴대용|포터블|portable/i,                           null],
  ['충전식',       /충전식|rechargeab/i,                                /배터리\s?없음/],
  ['LED',          /\bLED\b|엘이디/i,                                   null],
  ['RGB',          /\bRGB\b/i,                                          null],
  ['SSD',          /\bSSD\b/i,                                          null],
  ['기내용',       /기내용/i,                                           null],
  ['확장형',       /확장형/i,                                           null],
  ['보온보냉',     /보온보냉|보냉|보온/i,                               null]
];

/*
 * 색상.
 *
 * 제목 끝의 옵션 표기(", 블랙" · "(블랙)")에 주로 나온다. 상품명 한가운데의
 * 낱말을 색으로 잡으면 "블랙박스"·"화이트보드" 같은 것이 걸리므로,
 * 낱말 경계(구분자·괄호·끝)에 붙은 것만 본다.
 */
const COLORS = ['블랙', '화이트', '실버', '골드', '로즈골드', '그레이', '네이비', '베이지',
  '핑크', '레드', '블루', '그린', '퍼플', '옐로우', '아이보리', '카키', '브라운', '민트'];

/*
 * 여러 값이 나열된 항목은 뽑지 않는다.
 *
 * 실측: "랜덤노트북 13 / 14 / 15.6인치 …" — 셋 중 무엇이 올지 모른다는 뜻인데,
 * 마지막 값만 집어 "15.6인치"라고 말하면 사실이 아니다. 같은 단위가 두 번
 * 이상 나오면 애매한 것으로 보고 통째로 건너뛴다.
 * ("애매하면 뽑지 않는다" — 틀린 스펙은 없는 스펙보다 나쁘다)
 */
const AMBIGUOUS = [
  ['inch', /\d{1,2}(?:\.\d)?\s*인치/g],
  ['ml',   /\d{2,5}\s*ml\b/gi],
  /*
   * "13 / 14 / 15.6인치" — 앞의 두 숫자에는 단위가 안 붙어서 위 규칙에 한 번만
   * 걸린다. 빗금으로 이어진 숫자 나열 자체를 "여러 규격" 신호로 본다.
   */
  ['inch', /\d{1,2}(?:\.\d)?\s*\/\s*\d{1,2}(?:\.\d)?\s*(?:\/\s*\d{1,2}(?:\.\d)?\s*)?인치/g]
];

/* 단위 추출 규칙. [키, 정규식, 변환] — 정규식의 첫 캡처가 숫자다. */
const UNITS = [
  ['size_inch',    /(\d{1,2}(?:\.\d)?)\s*인치/,                    v => toNum(v)],
  ['size_inch',    /(\d{1,2}(?:\.\d)?)\s*"(?!\w)/,                 v => toNum(v)],
  ['capacity_ml',  /(\d{2,5})\s*ml\b/i,                            v => toNum(v)],
  ['capacity_ml',  /(\d(?:\.\d)?)\s*L(?![a-zA-Z])/,                v => Math.round(toNum(v) * 1000)],
  ['weight_g',     /(\d{1,4}(?:\.\d)?)\s*kg\b/i,                   v => Math.round(toNum(v) * 1000)],
  ['weight_g',     /(\d{2,4})\s*g(?![a-zA-Z가-힣])/,               v => toNum(v)],
  ['battery_mah',  /(\d{3,6})\s*mAh/i,                             v => toNum(v)],
  ['power_w',      /(\d{1,4})\s*W(?![a-zA-Z])/,                    v => toNum(v)],
  ['refresh_hz',   /(\d{2,4})\s*Hz/i,                              v => toNum(v)],
  ['length_cm',    /(\d{1,4}(?:\.\d)?)\s*cm\b/i,                   v => toNum(v)]
];

/*
 * 저장·메모리.
 *
 * GB 하나만으로는 램인지 저장장치인지 알 수 없다. 앞뒤 낱말로 가른다.
 * 가르지 못하면 뽑지 않는다 — 램 8GB 를 저장 8GB 로 말하면 틀린 스펙이다.
 */
const RAM_RE = [
  /램\s*(\d{1,3})\s*(?:gb|기가)?/i,
  /ram\s*(\d{1,3})\s*(?:gb|기가)?/i,
  /(\d{1,3})\s*(?:gb|기가)\s*램/i
];
/*
 * 순서가 중요하다. "램 16GB SSD 256GB" 에서 앞의 16GB 를 저장으로 읽으면
 * 램과 저장이 통째로 뒤바뀐다(실측으로 실제 그랬다). "SSD 뒤의 숫자"를
 * 먼저 보고, "숫자 + GB + SSD" 꼴은 앞에 램 표기가 붙어 있으면 버린다.
 */
const STORAGE_RE = [
  /ssd\s*(\d{2,4})\s*gb/i,
  /(\d{1,2})\s*tb/i,
  /(\d{2,4})\s*gb\s*(?:저장|용량)/i,
  /(\d{2,4})\s*gb\s*ssd/i          // ← 램 표기가 앞에 있으면 아래에서 버린다
];
/** 저장 후보 바로 앞이 램 표기인가 ("램 16GB SSD" 의 16GB) */
const RAM_PREFIX = /(램|ram|메모리)\s*$/i;

/** 수량 — "4개입", "20켤레", "3박스" */
const COUNT_RE = /(\d{1,3})\s*(개입|켤레|매입|매|팩|박스|입|개)(?![가-힣])/;

/*
 * 모델명/품번.
 *
 * "PCF-HD15", "BZ-ER7L", "HA-1005", "FV-X9" 처럼 영문+숫자에 하이픈이 섞인
 * 토큰이다. 브랜드명(영문 단어)이나 순수 숫자와 구분하려고 다음을 요구한다.
 *   · 영문과 숫자가 모두 들어 있다
 *   · 길이 4~20
 *   · 하이픈이 있거나, 영문 뒤에 숫자가 붙는 형태
 * "8K", "USB", "Type-C" 같은 일반 규격어는 제외 목록으로 뺀다.
 */
const MODEL_STOP = new Set(['USB', 'TYPE-C', 'TYPE', 'HDMI', 'RGB', 'LED', 'ANC', 'SSD',
  'HDD', 'DDR4', 'DDR5', 'IPX4', 'IPX5', 'IPX7', 'IPX8', 'BT5', '4K', '8K', '2K', '1080P',
  'A/S', 'PD', 'QC3', 'M1', 'M2', 'M3', 'M4']);
const MODEL_RE = /\b([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+|[A-Z]{2,}[0-9]{2,}[A-Z0-9]*)\b/g;

/**
 * 제목에서 스펙을 뽑는다.
 *
 * @param {string} title 상품명(판매자가 쓴 문자열)
 * @returns {{specs:object, features:string[], evidence:object}}
 *   specs    — 정규화된 수치 (없으면 키 자체가 없다)
 *   features — 기능 라벨 배열
 *   evidence — 각 값이 제목의 어느 문자열에서 나왔는지
 */
function extractSpecs(title) {
  const t = String(title == null ? '' : title);
  const specs = {};
  const features = [];
  const evidence = {};

  if (!t.trim()) return { specs, features, evidence };

  /* ── 기능 ── */
  FEATURES.forEach(([label, re, negate]) => {
    if (negate && negate.test(t)) return;      // "배터리없음" 같은 부정 표기
    const m = t.match(re);
    if (m) {
      features.push(label);
      evidence[label] = m[0].trim();
    }
  });

  /* ── 단위 값 ── */
  // 같은 단위가 두 번 이상 나오면("13/14/15.6인치") 어느 것인지 알 수 없다 — 건너뛴다.
  const ambiguous = new Set();
  AMBIGUOUS.forEach(([tag, re, minHits]) => {
    const hits = t.match(re);
    // 빗금 나열 규칙은 한 번만 걸려도 "여러 규격"이라는 뜻이다.
    if (hits && hits.length >= (String(re).includes('\\/') ? 1 : 2)) ambiguous.add(tag);
  });

  UNITS.forEach(([key, re, conv]) => {
    if (specs[key] !== undefined) return;      // 먼저 걸린 규칙을 우선한다
    if (key === 'size_inch' && ambiguous.has('inch')) return;
    if (key === 'capacity_ml' && ambiguous.has('ml')) return;
    const m = t.match(re);
    if (!m) return;
    const v = conv(m[1]);
    if (v != null && v > 0) { specs[key] = v; evidence[key] = m[0].trim(); }
  });

  /* ── 램 / 저장 ── */
  for (const re of RAM_RE) {
    const m = t.match(re);
    if (m) { specs.ram_gb = toNum(m[1]); evidence.ram_gb = m[0].trim(); break; }
  }
  for (const re of STORAGE_RE) {
    const m = t.match(re);
    if (!m) continue;
    // "램 16GB SSD 256GB" — 앞이 램 표기면 이건 저장 용량이 아니다.
    if (m.index != null && RAM_PREFIX.test(t.slice(Math.max(0, m.index - 8), m.index))) continue;
    const isTb = /tb/i.test(m[0]);
    const v = toNum(m[1]) * (isTb ? 1024 : 1);
    // 램으로 이미 잡은 값과 같으면 같은 숫자를 두 번 읽은 것이다.
    if (v > 0 && v !== specs.ram_gb) { specs.storage_gb = v; evidence.storage_gb = m[0].trim(); break; }
  }

  /* ── 수량 ── */
  {
    const m = t.match(COUNT_RE);
    if (m) {
      const n = toNum(m[1]);
      if (n && n > 0 && n <= 999) { specs.count = n; evidence.count = m[0].trim(); }
    }
  }

  /* ── 색상 (옵션 표기 자리에 있는 것만) ── */
  for (const c of COLORS) {
    const re = new RegExp(`[,(（/]\\s*${c}(?![가-힣])|${c}\\s*[)）]`);
    const m = t.match(re);
    if (m) { specs.color = c; evidence.color = m[0].replace(/[,(（)）/]/g, '').trim(); break; }
  }

  /* ── 모델명 ── */
  {
    MODEL_RE.lastIndex = 0;
    let m, best = '';
    while ((m = MODEL_RE.exec(t)) !== null) {
      const tok = m[1];
      if (MODEL_STOP.has(tok.toUpperCase())) continue;
      if (tok.length < 4 || tok.length > 20) continue;
      if (!/[0-9]/.test(tok) || !/[A-Za-z]/.test(tok)) continue;
      /*
       * 부품 품번은 제품 모델이 아니다.
       *
       * 실측: "…무선 게이밍 마우스 세트 8K 반응률 PAW3395 센서 도크 포함"
       * → PAW3395 를 모델로 뽑았다. 그건 마우스 모델이 아니라 안에 든 센서
       *   품번이다. AI 가 "모델 PAW3395" 라고 말하면 틀린 정보가 된다.
       * 바로 뒤에 부품을 가리키는 말이 오면 건너뛴다.
       */
      const after = t.slice(m.index + tok.length, m.index + tok.length + 8);
      if (/^\s*(센서|칩|칩셋|프로세서|드라이버|유닛|배터리|sensor|chip)/i.test(after)) continue;
      // 하이픈이 있는 쪽이 품번일 가능성이 높다. 없으면 가장 긴 것.
      if (!best || (tok.includes('-') && !best.includes('-')) || tok.length > best.length) best = tok;
    }
    if (best) { specs.model = best; evidence.model = best; }
  }

  return { specs, features, evidence };
}

/* ── 표시 ─────────────────────────────────────────────────────── */

const SPEC_LABEL = {
  size_inch: '크기', capacity_ml: '용량', weight_g: '무게', battery_mah: '배터리',
  power_w: '전력', refresh_hz: '주사율', length_cm: '길이',
  ram_gb: '램', storage_gb: '저장', count: '수량', color: '색상', model: '모델'
};

function formatSpec(key, v) {
  switch (key) {
    case 'size_inch':    return `${v}인치`;
    case 'capacity_ml':  return v >= 1000 ? `${Math.round(v / 100) / 10}L` : `${v}ml`;
    case 'weight_g':     return v >= 1000 ? `${Math.round(v / 100) / 10}kg` : `${v}g`;
    case 'battery_mah':  return `${v}mAh`;
    case 'power_w':      return `${v}W`;
    case 'refresh_hz':   return `${v}Hz`;
    case 'length_cm':    return `${v}cm`;
    case 'ram_gb':       return `${v}GB`;
    case 'storage_gb':   return v >= 1024 ? `${v / 1024}TB` : `${v}GB`;
    case 'count':        return `${v}개`;
    default:             return String(v);
  }
}

/**
 * 프롬프트에 실을 한 줄. 뽑힌 게 없으면 빈 문자열.
 *
 * ★ 이 줄에 적힌 것만 스펙으로 말해도 된다는 뜻이다. 그래서 "상품명에서
 *   확인된 것" 이라고 출처를 명시한다 — 제조사 공식 스펙표가 아니다.
 */
function specLine(sp) {
  if (!sp) return '';
  const parts = [];
  Object.keys(SPEC_LABEL).forEach(k => {
    if (sp.specs[k] !== undefined) parts.push(`${SPEC_LABEL[k]} ${formatSpec(k, sp.specs[k])}`);
  });
  if (sp.features.length) parts.push(sp.features.join('·'));
  return parts.join(' | ');
}

/**
 * 두 상품의 스펙 차이 — 비교 질문용.
 *
 * 양쪽 모두 값이 있는 항목만 비교한다. 한쪽만 있으면 "A만 확인됨"으로
 * 남긴다 — 없는 쪽을 "없다"로 단정하면 안 된다(제목에 안 썼을 뿐일 수 있다).
 *
 * @returns {{same:string[], diff:string[], onlyA:string[], onlyB:string[]}}
 */
function compareSpecs(a, b, nameA, nameB) {
  const out = { same: [], diff: [], onlyA: [], onlyB: [] };
  if (!a || !b) return out;

  const A = nameA || 'A', B = nameB || 'B';

  Object.keys(SPEC_LABEL).forEach(k => {
    const va = a.specs[k], vb = b.specs[k];
    if (va === undefined && vb === undefined) return;
    if (va !== undefined && vb === undefined) { out.onlyA.push(`${SPEC_LABEL[k]} ${formatSpec(k, va)}(${A}만 확인됨)`); return; }
    if (va === undefined && vb !== undefined) { out.onlyB.push(`${SPEC_LABEL[k]} ${formatSpec(k, vb)}(${B}만 확인됨)`); return; }
    if (va === vb) out.same.push(`${SPEC_LABEL[k]} ${formatSpec(k, va)}`);
    else out.diff.push(`${SPEC_LABEL[k]}: ${A} ${formatSpec(k, va)} / ${B} ${formatSpec(k, vb)}`);
  });

  const fa = new Set(a.features), fb = new Set(b.features);
  [...fa].forEach(f => { if (fb.has(f)) out.same.push(f); else out.onlyA.push(`${f}(${A}만 확인됨)`); });
  [...fb].forEach(f => { if (!fa.has(f)) out.onlyB.push(`${f}(${B}만 확인됨)`); });

  return out;
}

/**
 * 사용자가 요구한 기능을 이 상품이 만족하는가.
 *
 * @returns {{hit:string[], miss:string[]}}
 *   miss 는 "없다"가 아니라 "제목에서 확인되지 않았다"는 뜻이다.
 *   호출부는 이 구분을 지켜서 표현해야 한다.
 */
function matchFeatures(sp, wanted) {
  const hit = [], miss = [];
  const have = new Set((sp && sp.features) || []);
  (wanted || []).forEach(w => {
    if (!w) return;
    (have.has(w) ? hit : miss).push(w);
  });
  return { hit, miss };
}

/*
 * 사용자 말 → 기능 요구.
 *
 * "통화 품질도 중요해" → 마이크,  "노캔 되는 걸로" → 노이즈캔슬링
 * 조건 추출(_shopintent)이 잡는 예산·취향과 달리, 이건 상품 기능에 직접
 * 대응하는 요구라서 스펙 쪽에 둔다.
 */
const WANT_RE = [
  ['노이즈캔슬링', /노이즈\s?캔슬|노캔|\banc\b|소음\s?차단/i],
  ['마이크',       /통화|마이크|음성\s?통화/],
  ['방수',         /방수|땀|비\s?맞|물에/],
  ['무선',         /무선|블루투스/],
  ['유선',         /유선(?!\s?무선)/],
  ['경량',         /가벼(운|워|웠)|경량|무게/],
  ['대용량',       /대용량|용량\s?(큰|커)/],
  ['저소음',       /조용|저소음|무소음/],
  ['급속충전',     /급속\s?충전|고속\s?충전|빨리\s?충전/],
  // "다닐"은 다+닐이라 '다니'로 잡히지 않는다. 활용형을 함께 본다.
  ['휴대용',       /휴대|들고\s?다[니닐녀]|가지고\s?다[니닐녀]|밖에서\s?쓸/]
];

/** 사용자 발화에서 원하는 기능 라벨을 뽑는다. */
function wantedFeatures(text) {
  const s = String(text || '');
  const out = [];
  WANT_RE.forEach(([label, re]) => { if (re.test(s) && out.indexOf(label) < 0) out.push(label); });
  return out;
}

/* ==================================================================
 *  카테고리 인텔리전스
 *
 *  ── 왜 필요한가 ────────────────────────────────────────────────
 *
 *  지금까지 사양 비교는 카테고리를 몰랐다. 그래서 이런 일이 가능했다.
 *
 *    "이 노트북은 용량이 더 큽니다" ← 1100ml 텀블러 규칙이 노트북에 적용
 *    "이 이어폰은 화면이 더 큽니다" ← 캐리어의 인치 규칙이 이어폰에 적용
 *
 *  숫자 자체는 상품명에서 온 진짜 값이라 firewall 에도 걸리지 않는다.
 *  사실이지만 무의미한 비교 — 그게 더 나쁘다. 전문가처럼 들리면서 틀렸다.
 *
 *  카테고리마다 "이 물건을 고를 때 실제로 보는 것"이 다르다. 그것만 비교한다.
 *
 *  ★ 카테고리를 모르면 제한하지 않는다. 목록에 없는 물건까지 막으면
 *    비교 자체가 사라진다. 아는 카테고리에서만 좁힌다.
 * ================================================================== */

const CATEGORY_RE = [
  ['노트북',   /노트북|랩탑|laptop|맥북|macbook|그램|아이디어패드|씽크패드|갤럭시\s?북/i],
  ['태블릿',   /태블릿|tablet|아이패드|ipad|갤럭시\s?탭|탭\s?s\d/i],
  ['스마트폰', /스마트폰|휴대폰|아이폰|iphone|갤럭시\s?[szaf]\d|공기계/i],
  ['모니터',   /모니터|monitor|디스플레이(?!포트)/i],
  ['TV',       /\bTV\b|티비|텔레비전|스마트\s?티비/i],
  ['이어폰',   /이어폰|이어버드|에어팟|버즈|earbud/i],
  ['헤드폰',   /헤드폰|헤드셋|headphone|headset/i],
  ['키보드',   /키보드|keyboard|기계식\s?키/i],
  ['마우스',   /마우스(?!\s?패드)|mouse/i],
  ['스피커',   /스피커|사운드바|speaker/i],
  ['가전',     /냉장고|세탁기|건조기|에어컨|공기청정기|청소기|전자레인지|에어프라이어|서큘레이터|선풍기|가습기/],
  ['주방',     /텀블러|보온병|케틀|주전자|냄비|프라이팬|도시락|물병/],
  ['가방',     /캐리어|백팩|가방|파우치|크로스백|여행가방/]
];

/*
 * 카테고리별로 "고를 때 실제로 보는 것".
 *
 *   specs    — 수치 비교가 의미 있는 항목 (크면 좋은 것 위주)
 *   features — 있으면/없으면이 선택을 가르는 기능
 *
 * 여기 없는 항목은 그 카테고리에서 비교하지 않는다. 예를 들어 이어폰에
 * size_inch 는 넣지 않는다 — 이어폰 제목의 "인치"는 케이스 크기이거나
 * 다른 물건 이야기다.
 */
const CATEGORY_SPECS = {
  노트북:   { specs: ['ram_gb', 'storage_gb', 'size_inch', 'weight_g', 'battery_mah'], features: ['SSD', '경량', '휴대용'] },
  태블릿:   { specs: ['storage_gb', 'size_inch', 'weight_g', 'battery_mah'],           features: ['경량', '휴대용', 'LED'] },
  스마트폰: { specs: ['storage_gb', 'ram_gb', 'size_inch', 'battery_mah'],             features: ['방수', '무선충전', '급속충전'] },
  모니터:   { specs: ['size_inch', 'refresh_hz'],                                       features: ['LED'] },
  TV:       { specs: ['size_inch', 'refresh_hz'],                                       features: ['LED'] },
  이어폰:   { specs: ['battery_mah', 'weight_g'],                                       features: ['노이즈캔슬링', '마이크', '방수', '무선', '블루투스', '터치조작'] },
  헤드폰:   { specs: ['battery_mah', 'weight_g'],                                       features: ['노이즈캔슬링', '마이크', '무선', '블루투스'] },
  키보드:   { specs: ['weight_g'],                                                      features: ['무선', '유선', 'RGB', 'LED', '저소음'] },
  마우스:   { specs: ['weight_g'],                                                      features: ['무선', '유선', 'RGB', '경량'] },
  스피커:   { specs: ['power_w', 'battery_mah'],                                        features: ['무선', '블루투스', '방수', '휴대용'] },
  가전:     { specs: ['power_w', 'capacity_ml'],                                        features: ['저소음', 'LED', '휴대용'] },
  주방:     { specs: ['capacity_ml', 'weight_g'],                                       features: ['보온보냉', '대용량', '휴대용'] },
  가방:     { specs: ['size_inch', 'weight_g', 'capacity_ml'],                          features: ['확장형', '기내용', '경량', '방수'] }
};

/**
 * 상품명에서 카테고리를 알아본다.
 * @returns {string} 모르면 빈 문자열
 */
function detectCategory(title) {
  const t = String(title == null ? '' : title);
  for (const [name, re] of CATEGORY_RE) {
    if (re.test(t)) return name;
  }
  return '';
}

/**
 * 이 카테고리에서 비교해도 되는 사양인가.
 *
 * ★ 카테고리를 모르면 true — 아는 것만 좁힌다.
 */
function specMatters(category, key) {
  if (!category) return true;
  const def = CATEGORY_SPECS[category];
  if (!def) return true;
  return def.specs.indexOf(key) > -1;
}

/** 이 카테고리에서 선택을 가르는 기능 목록 (없으면 빈 배열) */
function categoryFeatures(category) {
  const def = category && CATEGORY_SPECS[category];
  return def ? def.features.slice() : [];
}

/*
 * 조사 붙이기.
 *
 * 기능 라벨을 문장에 끼워 넣을 때 "마이크이 확인되지 않음" 처럼 조사가
 * 어긋나면, 그 문장이 프롬프트를 거쳐 답변에 그대로 나온다. 프리미엄
 * 컨시어지라고 말하면서 조사를 틀리고 있으면 안 된다.
 *
 * 받침 판정은 한글 음절의 종성 인덱스로 한다((코드-0xAC00)%28 !== 0 이면 받침).
 * 한글이 아닌 글자(영문·숫자)로 끝나면 받침 없는 쪽을 쓴다 — LED·RGB 같은
 * 라벨에서 "LED가" 가 자연스럽다.
 */
function particle(word, withBatchim, withoutBatchim) {
  const s = String(word == null ? '' : word);
  const last = s.charCodeAt(s.length - 1);
  const isHangul = last >= 0xAC00 && last <= 0xD7A3;
  const hasBatchim = isHangul && (last - 0xAC00) % 28 !== 0;
  return s + (hasBatchim ? withBatchim : withoutBatchim);
}

/** "마이크가" / "노이즈캔슬링이" */
const iga  = w => particle(w, '이', '가');
/** "마이크는" / "노이즈캔슬링은" */
const eunn = w => particle(w, '은', '는');
/** "마이크를" / "노이즈캔슬링을" */
const eulr = w => particle(w, '을', '를');

module.exports = {
  extractSpecs, specLine, compareSpecs, matchFeatures, wantedFeatures,
  formatSpec, SPEC_LABEL, particle, iga, eunn, eulr,
  detectCategory, specMatters, categoryFeatures, CATEGORY_SPECS
};
