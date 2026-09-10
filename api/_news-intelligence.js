'use strict';
/*
 * NEWS INTELLIGENCE — 외부 신호를 가격 판단의 «보조» 근거로 옮긴다.
 *
 * ── 이 파일의 자리 ──────────────────────────────────────────────────
 *
 *   _pricestat.js   관측된 가격이 무엇을 말하는가
 *   _deal.js        그래서 지금 사도 되는가          ← 판정의 주인
 *   여기            바깥에서 무슨 일이 일어나고 있는가 ← 보조 신호
 *
 * ★ 이 파일은 _deal.js 의 판정을 덮어쓰지 않는다.
 *   advise() 는 dealVerdict 를 «입력으로 받아» 그보다 위로 올라가지 못한다.
 *   뉴스가 아무리 강해도 가격 기록이 BUY 를 말하지 않으면 BUY 가 나오지 않는다.
 *   그것이 "뉴스 하나로 BUY 하지 마라" 를 주석이 아니라 코드로 지키는 방법이다.
 *
 * ── 네트워크가 없다 ─────────────────────────────────────────────────
 *
 * 이 파일에는 fetch 가 없다. 수집은 _news-fetch.js 가 하고 여기는 «받은 것을
 * 계산» 만 한다. 그래서 전부 fixture 로 시험할 수 있고, 외부가 죽어도 이
 * 파일의 동작은 변하지 않는다.
 *
 * ── 절대 하지 않는 것 ───────────────────────────────────────────────
 *
 * 1. 미래 가격을 예측하지 않는다. "오를 것이다" 라고 쓰지 않는다.
 * 2. confidence 를 «상승 확률» 로 말하지 않는다. 근거의 강도일 뿐이다.
 * 3. ingestion 기록이 없는 근거를 화면에 올리지 않는다 (id 없으면 버린다).
 * 4. 기사 원문을 저장하지 않는다. 요약은 피드가 준 것을 잘라 쓴다.
 */

const R = require('./_market-registry');

/* 저장·표시를 허용하는 요약 길이. 원문 보관이 아니라 «식별용 한 줄» 이다. */
const SUMMARY_MAX = 200;
/* 이보다 오래된 기사는 직접 신호에서 뺀다(사건이 ACTIVE 면 예외 — 아래 참고). */
const HARD_AGE_DAYS = 60;
/* 이보다 관련도가 낮은 뉴스는 근거로 보여 주지 않는다. */
const MIN_RELEVANCE = 0.25;
/* BUY 를 허용하는 최소 독립 출처 수. */
const MIN_INDEPENDENT_FOR_BUY = 2;

/* ══════════════════════════════════════════════════════════════════
 *  1. 정규화 — 같은 것을 같다고 부르기 위한 준비
 * ══════════════════════════════════════════════════════════════════ */

/*
 * 추적 파라미터. 같은 기사가 utm_* 만 다르게 20번 재게시되는 것을 막는다.
 */
const TRACKING_RE = /^(utm_|fbclid|gclid|igshid|mc_[ce]id|ref|ref_src|source|cmpid|ncid|spm|s_kwcid)/i;

/**
 * URL 정규화. 같은 기사를 하나의 키로 모은다.
 * 실패하면 빈 문자열 — 파싱되지 않는 URL 은 근거가 될 수 없다.
 */
function normalizeUrl(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  let u;
  try { u = new URL(raw); } catch (e) { return ''; }

  u.hash = '';
  u.protocol = 'https:';
  /*
   * ★ 호스트에서 www. 를 «떼지 않는다».
   *
   *   이 URL 은 사용자가 실제로 눌러서 나가는 주소다. 정규화한답시고
   *   www 를 떼면 그 주소를 서비스하지 않는 사이트에서 링크가 깨진다.
   *   「원문으로 정상 연결」이 이 기능의 최소 조건이므로 주소는 건드리지 않는다.
   *
   *   같은 기사를 www 유무로 두 번 세지 않는 일은 dedupeKey() 가 따로 맡고,
   *   출처 조회는 hostOf() 가 www 를 떼고 본다. 「보여줄 주소」와
   *   「비교할 열쇠」를 가른다.
   */
  u.host = u.host.toLowerCase();
  // AMP 판은 같은 기사다.
  u.pathname = u.pathname.replace(/\/amp\/?$/i, '/').replace(/\.amp$/i, '');
  // 끝의 슬래시는 의미가 없다.
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');

  const keep = [];
  u.searchParams.forEach((v, k) => { if (!TRACKING_RE.test(k)) keep.push([k, v]); });
  keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  u.search = '';
  keep.forEach(([k, v]) => u.searchParams.append(k, v));

  return u.toString();
}

/**
 * 출처 조회 키. www. 를 뗀 호스트다.
 * SOURCES 의 키도 같은 규칙으로 적어 둔다 — 한쪽만 떼면 영원히 못 만난다.
 */
function hostOf(url) {
  try { return new URL(url).host.toLowerCase().replace(/^www\./, ''); }
  catch (e) { return ''; }
}

/**
 * 중복 비교용 열쇠. 보여줄 주소(normalizeUrl)와 달리 www 를 떼고 본다.
 * `www.x.com/a` 와 `x.com/a` 는 같은 기사다.
 */
function dedupeKey(url) {
  const n = normalizeUrl(url);
  if (!n) return '';
  return n.replace(/^https:\/\/www\./, 'https://');
}

/*
 * 제목 지문.
 *
 * 재게시본은 제목 앞뒤에 매체명·말머리를 붙인다("[단독] …", "… - 매체명").
 * 그래서 기호·조사·매체 꼬리를 털어 내고 «의미 있는 낱말의 집합» 만 남긴다.
 */
const STOPWORDS = new Set([
  '단독', '속보', '종합', '기자', '보도', '뉴스', '오늘', '내일', '올해',
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with',
  'says', 'said', 'report', 'reports', 'update', 'exclusive'
]);

function titleTokens(title) {
  return String(title == null ? '' : title)
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')        // 말머리 / 괄호 홍보
    .replace(/[-—–|·:,."'“”‘’!?%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

/** 정렬된 토큰 문자열. 어순이 바뀐 재게시도 같은 키가 된다. */
function titleKey(title) {
  return titleTokens(title).slice().sort().join(' ');
}

/** 두 제목의 토큰 자카드 유사도 (0~1). */
function titleSimilarity(a, b) {
  const A = new Set(titleTokens(a));
  const B = new Set(titleTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach(w => { if (B.has(w)) inter++; });
  return inter / (A.size + B.size - inter);
}

/* 짧고 안정적인 해시. 사건 id 와 기사 id 에 쓴다 (암호 용도가 아니다). */
function hash(s) {
  let h = 2166136261;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/* ══════════════════════════════════════════════════════════════════
 *  2. 수집 항목 정규화 — «저장해도 되는 것» 만 남긴다
 *
 *  PHASE 2 에서 허용한 필드 밖은 여기서 떨어진다. 구조적으로 원문을
 *  들고 다닐 수 없게 만드는 것이 목적이다 — 나중에 누가 실수로 body 를
 *  넣어도 이 함수를 지나면 사라진다.
 * ══════════════════════════════════════════════════════════════════ */

function normalizeItem(raw, now) {
  if (!raw) return null;
  const url = normalizeUrl(raw.url);
  if (!url) return null;

  /*
   * 출처 관문. 허용 목록에 없으면 «여기서» 버린다.
   * GDELT 로 들어온 것은 수집기가 sourceKey:'__gdelt__' 를 달아 준다 —
   * 그때는 도메인이 무엇이든 tier C 로 취급한다.
   */
  const key = raw.sourceKey === '__gdelt__' ? '__gdelt__' : hostOf(url);
  const src = R.sourceOf(key);
  if (!src) return null;

  const title = String(raw.title || '').trim().slice(0, 300);
  if (!title) return null;

  const publishedAt = toDate(raw.publishedAt);
  if (!publishedAt) return null;
  const ageDays = Math.max(0, (now.getTime() - publishedAt.getTime()) / 86400000);
  // 미래 날짜 기사는 받지 않는다 — 피드 오류이거나 조작이다.
  if (publishedAt.getTime() > now.getTime() + 86400000) return null;

  return {
    id: hash(url),
    url,
    title,
    source: src.name,
    sourceKey: key,
    sourceGroup: src.group,
    tier: src.tier,
    trust: src.trust,
    publishedAt: publishedAt.toISOString(),
    ageDays: Math.round(ageDays * 100) / 100,
    /* 원문이 아니라 피드가 준 한 줄이다. 길이를 구조로 잘라 둔다. */
    shortSummary: String(raw.summary || '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX)
  };
}

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/* ══════════════════════════════════════════════════════════════════
 *  3. 분류 — 규칙 기반 (zero-cost)
 *
 *  LLM 을 쓰지 않는다. 이유는 비용이 아니라 «재현성» 이다. 같은 기사에
 *  같은 분류가 나와야 어제의 판단과 오늘의 판단을 비교할 수 있고,
 *  잘못된 분류를 규칙 한 줄로 고칠 수 있다.
 *
 *  ★ 확실하지 않으면 UNKNOWN 이다. UNKNOWN 은 방향이 0 이라 신호를 밀지 못한다.
 * ══════════════════════════════════════════════════════════════════ */

/*
 * 순서가 곧 우선순위다. 위에서 걸리면 아래는 보지 않는다.
 * 구체적인 것을 위에, 넓은 것을 아래에 둔다.
 */
const EVENT_RE = [
  ['TARIFF_INCREASE',         /관세\s*(?:를\s*)?(?:인상|부과|상향)|\btariffs? (?:hike|increase|impose)|new tariffs?\b/i],
  ['TARIFF_DECREASE',         /관세\s*(?:를\s*)?(?:인하|철폐|면제)|\btariffs? (?:cut|reduce|lift|exempt)/i],
  ['EXPORT_RESTRICTION',      /수출\s*(?:규제|통제|제한|금지)|\bexport (?:control|restriction|ban|curb)/i],
  ['IMPORT_RESTRICTION',      /수입\s*(?:규제|제한|금지)|\bimport (?:restriction|ban|curb)/i],
  ['FAB_DISRUPTION',          /(?:공장|팹|생산라인)\s*(?:화재|사고|정전|중단|가동\s*중단)|\bfab (?:fire|outage|halt|shutdown)|\bpower outage\b/i],
  ['PRODUCTION_CUT',          /감산|생산\s*(?:축소|감축|중단)|\bproduction cut|output reduction|scale back production/i],
  ['PRODUCTION_EXPANSION',    /증설|생산\s*(?:확대|증대)|신규\s*(?:팹|공장)|\bnew fab\b|capacity expansion|expand production/i],
  ['SUPPLY_DECREASE',         /공급\s*(?:부족|차질|축소|타이트)|품귀|재고\s*(?:부족|소진)|\bsupply (?:shortage|crunch|tightness|constraint)|sold out\b/i],
  ['SUPPLY_INCREASE',         /공급\s*(?:확대|회복|정상화)|재고\s*(?:증가|확보)|\bsupply (?:recovery|improve|increase)|inventory build/i],
  ['RAW_MATERIAL_PRICE_UP',   /(?:계약|고정거래)\s*가격\s*(?:상승|인상)|원자재\s*가격\s*상승|\bcontract price(?:s)? (?:rise|up|increase)|price hike\b/i],
  ['RAW_MATERIAL_PRICE_DOWN', /(?:계약|고정거래)\s*가격\s*(?:하락|인하)|원자재\s*가격\s*하락|\bcontract price(?:s)? (?:fall|down|decline)/i],
  ['LOGISTICS_DISRUPTION',    /물류\s*(?:대란|차질)|해상\s*운임\s*(?:급등|상승)|항만\s*(?:적체|파업)|\b(?:port congestion|shipping delay|freight surge)/i],
  ['DEMAND_INCREASE',         /수요\s*(?:증가|급증|확대)|주문\s*(?:증가|폭주)|\bdemand (?:surge|growth|increase|jump)|strong demand\b/i],
  ['DEMAND_DECREASE',         /수요\s*(?:감소|둔화|위축)|\bdemand (?:decline|slowdown|weak|drop)/i],
  ['PRODUCT_DISCONTINUATION', /단종|생산\s*종료|\bdiscontinu(?:e|ed|ation)|end of life\b/i],
  ['PRODUCT_LAUNCH',          /(?:출시|공개|발표)\s*(?:예정|임박)?|신제품|\blaunch(?:es|ed|ing)?\b|\bunveil|\bannounce[sd]? (?:the )?new\b/i],
  ['RECALL',                  /리콜|회수\s*조치|\brecall\b/i],
  ['WEATHER_EVENT',           /(?:지진|태풍|홍수|가뭄|한파)|\b(?:earthquake|typhoon|flood|drought)\b/i],
  ['SEASONAL_DEMAND',         /(?:성수기|신학기|블랙프라이데이|연말\s*특수)|\b(?:back[- ]to[- ]school|holiday season|peak season)\b/i],
  ['PROMOTION_EVENT',         /(?:할인|프로모션|특가)\s*(?:행사|이벤트)|\b(?:discount event|promotion|price cut for)\b/i],
  ['EXCHANGE_RATE_MOVE',      /환율\s*(?:급등|급락|변동|상승|하락)|\bexchange rate\b|\bwon (?:weaken|strengthen)/i],
  ['REGULATORY_CHANGE',       /규제\s*(?:도입|강화|완화)|법안|\bregulat(?:ion|ory) (?:change|reform)/i],
  ['MACROECONOMIC_CHANGE',    /(?:기준금리|인플레이션|경기\s*(?:침체|둔화))|\b(?:interest rate|inflation|recession)\b/i],
  ['COMPANY_GUIDANCE',        /(?:실적|가이던스|전망)\s*(?:발표|상향|하향)|\b(?:guidance|earnings|outlook) (?:raise|cut|report)/i],
  /*
   * 설비 투자. 「13 billion investment」 같은 표현을 놓치고 있었다(실측).
   *
   * ★ 금액+투자만으로는 열지 않는다. 이 규칙이 걸려도 노드 검출이
   *   datacenter_capex 를 함께 집어야 사건이 성립한다(classify 아래 참고) —
   *   그래야 「어느 제약회사의 10억 달러 투자」가 GPU 수요로 둔갑하지 않는다.
   */
  ['DATACENTER_CAPEX',        /설비\s*투자\s*(?:확대|증가)|\bcapex (?:increase|expansion|boost)|AI (?:investment|buildout)|\b\d[\d.,]*\s*billion\b[^.]{0,40}\binvestment\b/i]
];

/*
 * DATACENTER_CAPEX 는 taxonomy 에 별도 종류를 두지 않고 DEMAND_INCREASE 로
 * 옮긴다. 사용자에게 중요한 것은 «수요가 늘었다» 이지 그 수요가 어디서
 * 왔는지가 아니다. 노드(datacenter_capex)가 출처를 이미 기록한다.
 */
const EVENT_ALIAS = { DATACENTER_CAPEX: 'DEMAND_INCREASE' };

/**
 * 기사 하나를 분류한다.
 * @returns {{eventType, nodes, supplySignal, demandSignal}}
 */
function classify(item) {
  const text = `${item.title} ${item.shortSummary || ''}`;

  let eventType = 'UNKNOWN';
  for (const [type, re] of EVENT_RE) {
    if (re.test(text)) { eventType = EVENT_ALIAS[type] || type; break; }
  }

  const nodes = R.detectNodes(text);
  /*
   * 어느 노드에도 걸리지 않으면 우리가 아는 시장의 이야기가 아니다.
   * 분류가 됐더라도 UNKNOWN 으로 되돌린다 — 붙일 곳이 없는 사건은 사건이 아니다.
   */
  if (!nodes.length) eventType = 'UNKNOWN';

  const def = R.eventTypeOf(eventType);
  return {
    eventType,
    nodes,
    /* 사람이 읽는 축. 방향과 별개로 «무엇에 관한 이야기인가» 를 남긴다. */
    supplySignal: /SUPPLY|PRODUCTION|FAB|LOGISTICS|EXPORT|IMPORT|WEATHER/.test(eventType)
      ? (def.direction > 0 ? 'tightening' : def.direction < 0 ? 'easing' : 'unclear') : 'none',
    demandSignal: /DEMAND|SEASONAL|LAUNCH/.test(eventType)
      ? (def.direction > 0 ? 'rising' : def.direction < 0 ? 'falling' : 'unclear') : 'none'
  };
}

/* ══════════════════════════════════════════════════════════════════
 *  4. 사건 묶기 — 기사 20건이 아니라 사건 1건이다
 *
 *  ★ 이것이 이 파일에서 가장 중요한 방어다. 같은 보도자료를 받아쓴 기사
 *    20개를 «독립 증거 20개» 로 세면 confidence 는 언제나 만점이 된다.
 *    그러면 이 엔진은 홍보를 증폭하는 기계가 된다.
 *
 *  묶는 기준은 두 가지다.
 *    1) 정규화된 URL 이 같다      → 같은 기사
 *    2) 제목 유사도가 임계 이상   → 같은 사건의 재게시
 *  그리고 같은 사건 안에서 «독립 출처» 는 sourceGroup 으로 센다.
 * ══════════════════════════════════════════════════════════════════ */

const SIMILARITY_THRESHOLD = 0.55;
/*
 * 같은 «시장 전개» 로 묶는 시간창 (일).
 *
 * ★ 이 창이 필요한 이유 (시험이 잡아낸 설계 오류)
 *
 *   처음에는 제목 유사도만으로 묶었다. 그러자 "NAND 감산 결정"(Kioxia)과
 *   "NAND 감산 발표"(WD)가 유사도 0.5 로 임계값에 미달해 각각 «독립 출처
 *   1곳짜리 별개 사건» 이 됐다. 그러면 서로 다른 회사가 같은 방향을 말하는
 *   진짜 교차 확인이 영영 2곳으로 세지지 않고, BUY 는 원리상 나올 수 없다.
 *
 *   묶어야 하는 단위는 «같은 기사» 가 아니라 «같은 시장 전개» 다.
 *   같은 종류의 사건이 같은 대상에 비슷한 시기에 일어났다면, 그것은 여러
 *   출처가 확인해 주고 있는 하나의 전개다. 제목이 얼마나 닮았는지는
 *   그다음 문제다.
 *
 *   시간창이 없으면 반년 전 감산과 어제 감산이 한 사건이 된다. 그래서
 *   종류·대상·«시기» 세 가지가 모두 맞을 때만 묶는다.
 */
const CLUSTER_WINDOW_DAYS = 14;
const CONFIRMATION_SIMILARITY = 0.8;

function clusterEvents(items) {
  const events = [];

  for (const it of items) {
    if (!it) continue;
    const cls = it.eventType ? it : Object.assign({}, it, classify(it));
    const at = new Date(cls.publishedAt).getTime();

    /*
     * 같은 사건인가.
     *   1) 종류가 같다        — "감산" 과 "증설" 은 제목이 닮아도 다른 사건이다
     *   2) 대상 노드가 겹친다 — NAND 이야기와 커피 이야기를 섞지 않는다
     *   3) 시기가 가깝다      — 반년 전 일과 어제 일은 다른 전개다
     * 셋이 맞으면 같은 전개로 본다. URL 이 같거나 제목이 닮은 것은
     * 그 안에서 «같은 기사» 를 두 번 세지 않기 위한 별개의 검사다.
     */
    let target = null;
    for (const ev of events) {
      if (ev.eventType !== cls.eventType) continue;
      if (!ev.nodes.some(n => cls.nodes.indexOf(n) > -1)) continue;
      const near = ev.items.some(x =>
        Math.abs(new Date(x.publishedAt).getTime() - at) <= CLUSTER_WINDOW_DAYS * 86400000);
      const horizonMs = (R.eventTypeOf(cls.eventType).horizonDays || 0) * 86400000;
      const confirmedContinuation = horizonMs > 0 && ev.items.some(x =>
        Math.abs(new Date(x.publishedAt).getTime() - at) <= horizonMs &&
        titleSimilarity(x.title, cls.title) >= CONFIRMATION_SIMILARITY);
      if (near || confirmedContinuation) { target = ev; break; }
    }

    if (!target) {
      target = {
        eventType: cls.eventType,
        nodes: cls.nodes.slice(),
        items: [],
        supplySignal: cls.supplySignal,
        demandSignal: cls.demandSignal
      };
      events.push(target);
    } else {
      cls.nodes.forEach(n => { if (target.nodes.indexOf(n) === -1) target.nodes.push(n); });
    }

    // 같은 URL 을 두 번 담지 않는다.
    if (!target.items.some(x => dedupeKey(x.url) === dedupeKey(cls.url))) target.items.push(cls);
  }

  const finalized = events.map(finalizeEvent);
  return finalized.map(ev => lifecycleEvent(ev, finalized));
}

function finalizeEvent(ev) {
  const items = ev.items.slice().sort((a, b) =>
    new Date(a.publishedAt) - new Date(b.publishedAt));

  const groups = new Set(items.map(i => i.sourceGroup));
  const officialGroups = new Set(items.filter(i => i.tier === 'A' || i.tier === 'B').map(i => i.sourceGroup));
  const govGroups = new Set(items.filter(i => i.tier === 'B').map(i => i.sourceGroup));

  const first = items[0];
  const last = items[items.length - 1];

  const sourceIds = [...groups].filter(Boolean).sort();
  const categories = Object.keys(R.NODES).filter(id =>
    R.NODES[id].kind === 'category' && ev.nodes.some(n => R.relevanceTo(id, n) > 0));
  const def = R.eventTypeOf(ev.eventType);
  const rawStrength = Math.round(clamp(0.5 + Math.min(3, Math.max(0, groups.size - 1)) * 0.15, 0, 1) * 1000) / 1000;

  return Object.assign({}, ev, {
    /* 사건 id — 종류 + 노드 + 대표 제목지문. 같은 사건은 실행마다 같은 id 다. */
    eventId: hash(`${ev.eventType}|${ev.nodes.slice().sort().join(',')}|${titleKey(first.title)}`),
    items,
    articleCount: items.length,
    /* ★ 독립 출처 = 같은 회사/기관을 하나로 센 수 */
    independentSources: groups.size,
    independentSourceCount: groups.size,
    sourceIds,
    officialSources: officialGroups.size,
    govSources: govGroups.size,
    /* 전부 GDELT 뿐인가 — 이 경우 단독 근거가 되지 못한다 */
    gdeltOnly: items.every(i => i.tier === 'C'),
    /* 한 회사의 자기 발표뿐인가 — 기업 PR 단독은 BUY 근거가 아니다 */
    singleCompanyPR: officialGroups.size <= 1 && govGroups.size === 0 &&
                     items.every(i => i.tier === 'A'),
    categories,
    direction: def.direction,
    eventStart: first.publishedAt,
    eventStartAt: first.publishedAt,
    firstSeenAt: first.publishedAt,
    lastSeenAt: last.publishedAt,
    lastConfirmedAt: last.publishedAt,
    ageDays: last.ageDays,
    oldestAgeDays: first.ageDays,
    maxTrust: items.reduce((m, i) => Math.max(m, i.trust), 0),
    rawStrength
  });
}

/** V2 event lifecycle 필드를 붙인다. 새 확인은 lastConfirmedAt을 갱신해 감쇠를 되돌린다. */
function lifecycleEvent(ev, allEvents) {
  const def = R.eventTypeOf(ev.eventType);
  const startMs = Date.parse(ev.eventStartAt || ev.eventStart || ev.firstSeenAt || '');
  const expectedEndAt = Number.isFinite(startMs)
    ? new Date(startMs + (def.horizonDays || 0) * 86400000).toISOString()
    : null;
  const status = eventStatus(ev, allEvents);
  const effectiveStrength = Math.round((Number(ev.rawStrength) || 0) * recencyWeight(ev.ageDays, ev.eventType) * 1000) / 1000;
  return Object.assign({}, ev, { expectedEndAt, status, effectiveStrength });
}

/* ══════════════════════════════════════════════════════════════════
 *  5. 시간 — 「기사 날짜」와 「사건 유효기간」은 다르다
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 최신성 가중치. 사건 종류마다 반감기가 다르다.
 *
 *   w = 0.5 ^ (age / halfLife)
 *
 * 반감기 18일(중기 기본)에서 실측: 1일 0.96 · 3일 0.89 · 7일 0.76 ·
 * 14일 0.58 · 30일 0.32 · 60일 0.10. 「하루 1.00 / 사흘 0.90 / 일주일 0.75 /
 * 30일 0.35」 라는 기준선을 계단표가 아니라 연속 함수로 만족한다 —
 * 계단표는 경계에서 하루 차이로 값이 튄다.
 */
function recencyWeight(ageDays, eventType) {
  const half = R.eventTypeOf(eventType).halfLifeDays || R.eventTypeOf(eventType).halfLife || R.MEDIUM;
  const age = Math.max(0, Number(ageDays) || 0);
  return Math.round(Math.pow(0.5, age / half) * 1000) / 1000;
}

/**
 * 사건 상태.
 *
 *   ACTIVE     아직 진행 중일 수 있다 (유효기간 안이거나 최근 재확인됨)
 *   RESOLVED   끝났다 — 같은 노드에 반대 사건이 «뒤에» 들어왔다
 *   EXPIRED    유효기간이 지났고 재확인도 없다
 *   UNCERTAIN  같은 묶음 안에서 방향이 엇갈린다
 *
 * ★ 20일 전 공장 화재라도 복구 소식이 없으면 ACTIVE 다. 기사 날짜만으로
 *   버리면 «아직 벌어지고 있는 일» 을 놓친다.
 */
function eventStatus(ev, allEvents) {
  const def = R.eventTypeOf(ev.eventType);
  if (ev.eventType === 'UNKNOWN') return 'UNCERTAIN';

  const resolvers = R.RESOLVES[ev.eventType] || [];
  const opposite = (all) => (all || []).some(o =>
    o !== ev &&
    o.nodes.some(n => ev.nodes.indexOf(n) > -1) &&
    (resolvers.indexOf(o.eventType) > -1 ||
     R.eventTypeOf(o.eventType).direction === -def.direction && def.direction !== 0) &&
    new Date(o.lastConfirmedAt) > new Date(ev.lastConfirmedAt));

  if (opposite(allEvents)) return 'RESOLVED';

  const horizon = def.horizonDays || 0;
  const age = Math.max(0, Number(ev.ageDays) || 0);
  const halfLifeDays = def.halfLifeDays || def.halfLife || R.MEDIUM;
  // 새 확인은 오래된 사건도 ACTIVE로 되돌린다.
  if (age <= Math.min(14, halfLifeDays)) return 'ACTIVE';
  if (age <= halfLifeDays) return 'ACTIVE';
  if (age <= horizon) return 'WEAKENING';
  return 'EXPIRED';
}

/* ══════════════════════════════════════════════════════════════════
 *  6. confidence — 「근거가 얼마나 튼튼한가」. 상승 확률이 아니다.
 *
 *  ★ 이 숫자를 % 로 읽히게 두지 않는다. 화면에는 CONFIDENCE_NOTE 를
 *    반드시 함께 내보낸다 (marketBlock 참고).
 * ══════════════════════════════════════════════════════════════════ */

const CONFIDENCE_NOTE = '신뢰도는 예측 확률이 아니라 근거의 강도를 의미합니다.';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * @param ev        clusterEvents 가 만든 사건
 * @param relevance 이 사건이 판단 대상 카테고리에 닿는 정도 (0~1)
 * @param opts      { priceAgrees: true|false|null, contradicted: bool, status }
 */
function confidenceOf(ev, relevance, opts) {
  const o = opts || {};
  const rec = recencyWeight(ev.ageDays, ev.eventType);

  /* 각 축은 상한이 정해져 있다. 합이 100 을 넘으면 잘라 낸다. */
  const sourceTrust = clamp(ev.maxTrust, 0, 30);

  const n = ev.independentSources;
  const independentEvidence = n >= 4 ? 20 : n === 3 ? 16 : n === 2 ? 12 : 5;

  const officialConfirmation = ev.govSources > 0 ? 15
    : ev.officialSources >= 2 ? 12
    : ev.officialSources === 1 ? 8 : 0;

  const eventRelevance = clamp(relevance, 0, 1) * 15;

  const recencyContribution = rec * 10;

  /*
   * 교차 동의 — 같은 사건을 «서로 다른» 출처가 같은 방향으로 말하는가.
   * 기사 수가 아니라 독립 출처 수로 센다.
   */
  const crossSourceAgreement = n >= 3 ? 10 : n === 2 ? 6 : 0;

  /*
   * 가격 확인 — 뉴스가 말하는 방향으로 실제 가격이 움직였는가.
   * null(모름)은 0 이다. 없는 확인을 있는 것처럼 세지 않는다.
   */
  const priceConfirmation = o.priceConfirmation === 'CONFIRMED' || o.priceAgrees === true ? 10 : 0;
  const priceContradictionPenalty = o.priceConfirmation === 'CONTRADICTED' || o.priceAgrees === false ? 12 : 0;

  const contradictionPenalty = Number.isFinite(o.contradictionPenalty)
    ? clamp(o.contradictionPenalty, 0, 40)
    : (o.contradicted ? 25 : 0);
  const stalenessPenalty = (1 - rec) * 20;
  /* EXPIRED / RESOLVED 는 더 깎는다 — 끝난 일은 지금의 근거가 아니다. */
  const statusPenalty = o.status === 'EXPIRED' ? 20 : o.status === 'RESOLVED' ? 35 : 0;

  const axes = {
    sourceTrust, independentEvidence, officialConfirmation, eventRelevance,
    recencyContribution, crossSourceAgreement, priceConfirmation,
    contradictionPenalty: -contradictionPenalty,
    priceContradictionPenalty: -priceContradictionPenalty,
    stalenessPenalty: -Math.round(stalenessPenalty * 10) / 10,
    statusPenalty: -statusPenalty
  };

  const total = sourceTrust + independentEvidence + officialConfirmation + eventRelevance
    + recencyContribution + crossSourceAgreement + priceConfirmation
    - contradictionPenalty - priceContradictionPenalty - stalenessPenalty - statusPenalty;

  return { score: Math.round(clamp(total, 0, 100)), axes, recencyWeight: rec };
}

/** 사람이 읽는 등급. 숫자를 확률로 오해하지 않도록 말로도 준다. */
function confidenceLevel(score) {
  return score >= 75 ? 'HIGH' : score >= 50 ? 'MEDIUM' : 'LOW';
}

function eventDirection(ev) {
  return Number.isFinite(Number(ev && ev.direction))
    ? Number(ev.direction)
    : R.eventTypeOf(ev && ev.eventType).direction;
}

function contradictionPairs(events, categoryId) {
  const candidates = (events || []).map(ev => {
    const impacts = (ev.nodes || []).map(n => R.impactTo(categoryId, n)).filter(Boolean);
    const impact = impacts.sort((a, b) => b.impact - a.impact)[0] || null;
    return { ev, impact, status: ev.status || eventStatus(ev, events) };
  }).filter(x => x.impact && x.impact.impact >= MIN_RELEVANCE &&
    x.status !== 'RESOLVED' && x.status !== 'EXPIRED' && eventDirection(x.ev) !== 0);

  const pairs = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if (a.ev.eventId === b.ev.eventId) continue;
      const configured = (R.CONTRADICTIONS[a.ev.eventType] || []).indexOf(b.ev.eventType) > -1 ||
        (R.CONTRADICTIONS[b.ev.eventType] || []).indexOf(a.ev.eventType) > -1;
      if (!configured) continue;
      const independent = Math.min(
        Number(a.ev.independentSourceCount || a.ev.independentSources || 0),
        Number(b.ev.independentSourceCount || b.ev.independentSources || 0));
      if (independent < 1) continue;
      pairs.push({
        eventIds: [a.ev.eventId, b.ev.eventId],
        eventTypes: [a.ev.eventType, b.ev.eventType],
        severity: independent >= 2 ? 'HIGH' : 'MEDIUM',
        penalty: independent >= 2 ? 35 : 20
      });
    }
  }
  return pairs;
}

/* ══════════════════════════════════════════════════════════════════
 *  7. 뉴스 압력 — 사건들을 카테고리 하나의 «압력» 으로 합친다
 * ══════════════════════════════════════════════════════════════════ */

/**
 * @returns {{score, up, down, used, excluded, contradicted}}
 *   score  -100(내리는 압력) ~ +100(올리는 압력)
 */
function newsPressure(events, categoryId, opts) {
  const o = opts || {};
  const all = events || [];
  let up = 0, down = 0;
  const used = [], excluded = [];

  for (const ev of all) {
    const status = ev.status || eventStatus(ev, all);
    const def = R.eventTypeOf(ev.eventType);

    // 이 사건이 이 카테고리에 얼마나 닿는가 (가장 센 경로).
    let relevance = 0, impactPath = null;
    for (const n of ev.nodes) {
      const impact = R.impactTo(categoryId, n);
      if (impact && impact.impact > relevance) { relevance = impact.impact; impactPath = impact.path; }
    }

    const rec = recencyWeight(ev.ageDays, ev.eventType);
    const reasonSkip =
      ev.eventType === 'UNKNOWN' ? '분류 불가'
      : def.direction === 0 ? '방향 없음'
      : relevance < MIN_RELEVANCE ? `관련도 낮음(${relevance})`
      : status === 'RESOLVED' ? '종료된 사건'
      : status === 'EXPIRED' ? `만료됨(${Math.round(ev.ageDays)}일)`
      : null;

    if (reasonSkip) {
      excluded.push({ eventId: ev.eventId, eventType: ev.eventType, status, relevance, reason: reasonSkip });
      continue;
    }

    /*
     * 한 사건의 무게 = 방향 × 관련도 × 최신성 × 독립성.
     * 독립성을 곱하는 이유는, 한 곳만 말하는 이야기는 여러 곳이 말하는
     * 이야기보다 약해야 하기 때문이다. 기사 수가 아니라 출처 수로 센다.
     */
    const independence = ev.independentSources >= 3 ? 1 : ev.independentSources === 2 ? 0.8 : 0.5;
    const strength = Number.isFinite(Number(ev.effectiveStrength))
      ? Number(ev.effectiveStrength)
      : (Number.isFinite(Number(ev.rawStrength)) ? Number(ev.rawStrength) * rec : rec);
    const weight = relevance * independence * strength;

    if (def.direction > 0) up += weight; else down += weight;
    used.push({ eventId: ev.eventId, eventType: ev.eventType, status, relevance, impactPath, recencyWeight: rec, weight: Math.round(weight * 100) / 100 });
  }

  /*
   * 상충 — 올리는 압력과 내리는 압력이 둘 다 의미 있게 존재한다.
   * 이때는 «둘을 빼서 작은 숫자» 로 만들지 않는다. 상충은 정보가 없는
   * 것이 아니라 «판단하면 안 된다» 는 정보다.
   */
  const pairs = contradictionPairs(all, categoryId);
  const contradicted = pairs.length > 0 || (up > 0.3 && down > 0.3 && Math.min(up, down) / Math.max(up, down) > 0.4);
  const contradictionPenalty = pairs.reduce((m, p) => Math.max(m, p.penalty), contradicted ? 20 : 0);

  const net = up - down;
  const score = Math.round(clamp(net, -3, 3) / 3 * 100);
  return {
    score, up: Math.round(up * 100) / 100, down: Math.round(down * 100) / 100,
    used, excluded, contradicted, contradictionCount: pairs.length,
    contradictionPenalty, contradictionPairs: pairs
  };
}

/* ══════════════════════════════════════════════════════════════════
 *  8. 가격 기회 — 기존 가격 통계를 그대로 읽는다
 *
 *  ★ 새 가격 계산을 만들지 않는다. _pricestat.statsFrom 이 준 stat 을
 *    읽기만 한다. 가격의 주인은 그쪽이다.
 * ══════════════════════════════════════════════════════════════════ */

/**
 * @param stat  _pricestat.statsFrom 결과
 * @param price 현재가
 * @param dealPercentile _deal.dealOf 가 낸 percentile (0~1) — 있으면 그대로 쓴다
 * @returns {{score, percentile, vsAvg30Pct, trendPct, high90, low90, enough}}
 *   score 0(비싸다) ~ 100(싸다)
 */
function priceOpportunity(stat, price, dealPercentile) {
  const out = {
    score: null, percentile: null, vsAvg30Pct: null, trendPct: null,
    volatility: null, low: null, high: null, enough: false
  };
  const p = Math.round(Number(price) || 0);
  if (!stat || p <= 0 || !(Number(stat.count) > 0)) return out;

  out.low = stat.low || null;
  out.high = stat.high || null;
  out.trendPct = (stat.trendPct == null) ? null : stat.trendPct;
  out.volatility = (stat.volatility == null) ? null : stat.volatility;

  if (stat.avg30 > 0) out.vsAvg30Pct = Math.round((p / stat.avg30 - 1) * 1000) / 10;

  /*
   * percentile — 기록 안에서 지금 가격이 어느 높이인가 (0 = 최저, 1 = 최고).
   * _deal 이 이미 계산했으면 그 값을 쓴다. 같은 데이터로 두 개의 숫자를
   * 만들지 않는다.
   */
  if (dealPercentile != null) out.percentile = dealPercentile;
  else if (stat.high > stat.low && stat.low > 0) {
    out.percentile = Math.round(clamp((p - stat.low) / (stat.high - stat.low), 0, 1) * 100) / 100;
  }

  /* 판단할 만큼 기록이 있는가. 없으면 점수를 만들지 않는다. */
  out.enough = Number(stat.count) >= 7 && out.percentile != null;
  if (!out.enough) return out;

  out.score = Math.round((1 - out.percentile) * 100);
  return out;
}

/** 기존 price_history 집계값을 V2의 읽기 전용 snapshot으로 정규화한다. */
function priceStatsSnapshot(stat, currentPrice) {
  const s = stat || {};
  const n = v => Number.isFinite(Number(v)) ? Number(v) : null;
  return {
    currentPrice: n(currentPrice),
    '7dChange': n(s.change7d != null ? s.change7d : s['7dChange']),
    '30dChange': n(s.change30d != null ? s.change30d : (s['30dChange'] != null ? s['30dChange'] : s.trendPct)),
    '30dAverage': n(s.avg30 != null ? s.avg30 : s['30dAverage']),
    '90dPercentile': n(s.percentile90 != null ? s.percentile90 : s['90dPercentile']),
    volatility: n(s.volatility),
    observationCount: n(s.count != null ? s.count : s.observationCount) || 0
  };
}

/** 뉴스 방향이 가격에 나타났는지 확인한다. 모름과 반대를 구분한다. */
function confirmWithPrice(direction, stat, currentPrice) {
  const snap = priceStatsSnapshot(stat, currentPrice);
  if (!(snap.currentPrice > 0) || snap.observationCount < 7) {
    return { status: 'INSUFFICIENT_PRICE_DATA', snapshot: snap };
  }
  const move = snap['7dChange'] != null ? snap['7dChange'] : snap['30dChange'];
  if (!direction || move == null || Math.abs(move) <= 1) {
    return { status: 'NOT_YET_CONFIRMED', snapshot: snap };
  }
  return { status: Math.sign(move) === Math.sign(direction) ? 'CONFIRMED' : 'CONTRADICTED', snapshot: snap };
}

/* ══════════════════════════════════════════════════════════════════
 *  9. 판단 — 규칙 기반, 보수적, 그리고 «가격 엔진 아래» 에 선다
 * ══════════════════════════════════════════════════════════════════ */

const ADVICE_LABEL = {
  BUY:         '구매 고려',
  WAIT:        '기다리는 편이 낫다',
  WATCH:       '지켜볼 만하다',
  NO_DECISION: '판단하지 않는다'
};

/* 뉴스 판단이 넘어설 수 없는 천장. _deal.DEAL_ORDER 와 짝을 이룬다. */
const DEAL_ORDER = { DONT_BUY: 0, WAIT: 1, WATCH: 2, NORMAL: 3, GOOD_BUY: 4, BUY: 5, UNKNOWN: -1 };

/* 가격이 이 높이 위면 뉴스가 무엇을 말하든 BUY 를 내지 않는다. */
const PCTL_TOO_HIGH = 0.7;
/* BUY 를 허용하는 최소 confidence / WAIT 를 허용하는 최소 confidence. */
const BUY_MIN_CONF = 75, WAIT_MIN_CONF = 60;

/**
 * 최종 보조 판단.
 *
 * @param input {
 *   categoryId,  판단 대상 카테고리 (레지스트리 노드 id)
 *   events,      clusterEvents 결과
 *   stat, price, dealPercentile,
 *   dealVerdict  _deal.dealOf().verdict — ★ 이 값이 천장이다
 * }
 */
function advise(input) {
  const o = input || {};
  const categoryId = o.categoryId || '';
  const coverage = R.coverageOf(categoryId);

  const out = {
    advice: 'NO_DECISION',
    label: ADVICE_LABEL.NO_DECISION,
    coverage,
    categoryId,
    confidence: 0,
    confidenceLevel: 'LOW',
    news: null,
    price: null,
    reasons: [],
    blockedBy: [],
    evidence: [],
    priceConfirmation: { status: 'INSUFFICIENT_PRICE_DATA', snapshot: priceStatsSnapshot(null, o.price) }
  };

  /* ── 관문 1. 커버리지 ── 모르는 카테고리에 판단을 만들지 않는다 ── */
  if (coverage === 'UNSUPPORTED') {
    out.reasons.push('현재 시장 신호 데이터가 충분하지 않습니다');
    return out;
  }

  const events = o.events || [];
  const news = newsPressure(events, categoryId);
  const price = priceOpportunity(o.stat, o.price, o.dealPercentile);
  out.news = news;
  out.price = price;

  /* ── 관문 2. 쓸 수 있는 사건이 있는가 ── */
  if (!news.used.length) {
    out.reasons.push('이 카테고리에 연결되는 최근 시장 신호를 찾지 못했습니다');
    return out;
  }

  /* ── 사건별 confidence 를 계산하고 가장 센 것을 대표로 삼는다 ── */
  const priceDir = price.trendPct == null ? null : (price.trendPct > 1 ? 1 : price.trendPct < -1 ? -1 : 0);
  const scored = news.used.map(u => {
    const ev = events.find(e => e.eventId === u.eventId);
    const dir = R.eventTypeOf(ev.eventType).direction;
    /*
     * 가격 확인 — 뉴스 방향과 실제 가격 방향이 같은가.
     * 모르면 null 이다. 모르는 것을 «확인됨» 으로 올리지 않는다.
     */
    const priceAgrees = (priceDir == null || dir === 0) ? null : (priceDir === dir);
    const c = confidenceOf(ev, u.relevance, {
      priceAgrees, contradicted: news.contradicted, status: u.status
    });
    return { ev, u, dir, conf: c, priceAgrees };
  }).sort((a, b) => b.conf.score - a.conf.score);

  const top = scored[0];
  out.priceConfirmation = confirmWithPrice(top.dir, o.stat, o.price);
  if (out.priceConfirmation.snapshot['90dPercentile'] == null && o.dealPercentile != null) {
    out.priceConfirmation.snapshot['90dPercentile'] = Number(o.dealPercentile);
  }
  /* 가격 확인 상태까지 반영한 최종 confidence를 한 번만 다시 계산한다. */
  top.conf = confidenceOf(top.ev, top.u.relevance, {
    priceConfirmation: out.priceConfirmation.status,
    contradicted: news.contradicted,
    contradictionPenalty: news.contradictionPenalty,
    status: top.u.status
  });
  out.confidence = top.conf.score;
  out.confidenceLevel = confidenceLevel(top.conf.score);

  /* ── 증거 목록 ── ingestion 기록이 있는 것만, 관련도 순으로 ──
   *
   * ★ id 와 url 이 없는 항목은 여기서 떨어진다. 화면에 오르는 근거는
   *   반드시 실제로 수집된 기사여야 한다 (hallucination 방어).
   */
  out.evidence = buildEvidence(scored);

  /* ── 방향 ── */
  const upward = news.score > 0;
  const downward = news.score < 0;

  /* ── 관문 3. BUY 를 막는 조건들 ──
   *
   * 하나라도 걸리면 BUY 가 아니다. 이유를 blockedBy 에 남겨 둔다 —
   * 왜 BUY 가 아닌지 설명할 수 없으면 판단을 신뢰할 수 없다.
   */
  const blocked = [];
  if (news.contradicted) blocked.push('상충하는 신호가 함께 있음');
  if (top.ev.independentSources < MIN_INDEPENDENT_FOR_BUY) blocked.push('독립 출처가 2곳 미만');
  if (top.ev.gdeltOnly) blocked.push('GDELT 보조 탐색 단독');
  if (top.ev.singleCompanyPR) blocked.push('기업 자체 발표 단독');
  if (out.confidence < BUY_MIN_CONF) blocked.push(`신뢰도 ${out.confidence} < ${BUY_MIN_CONF}`);
  if (!price.enough) blocked.push('가격 기록이 부족함');
  else if (price.percentile != null && price.percentile >= PCTL_TOO_HIGH) {
    blocked.push(`현재 가격이 기록상 높은 구간(상위 ${Math.round((1 - price.percentile) * 100)}%)`);
  }
  if (!upward) blocked.push('상승 압력이 확인되지 않음');
  if (out.priceConfirmation.status === 'CONTRADICTED' ||
      (priceDir != null && top.dir !== 0 && priceDir === -top.dir)) {
    blocked.push('뉴스 방향과 실제 가격 방향이 반대');
  }
  out.blockedBy = blocked;

  /* ── 판단 ── */
  let advice;
  if (!blocked.length) {
    advice = 'BUY';
    out.reasons.push('여러 독립 출처에서 상승 압력 신호가 확인됨');
    if (price.vsAvg30Pct != null && price.vsAvg30Pct < 0) {
      out.reasons.push(`현재 가격이 30일 평균보다 ${Math.abs(price.vsAvg30Pct)}% 낮음`);
    }
  } else if (downward && out.confidence >= WAIT_MIN_CONF && !news.contradicted &&
             price.enough && price.percentile != null && price.percentile >= 0.5) {
    advice = 'WAIT';
    out.reasons.push('하락 압력 신호가 있고 현재 가격이 기록상 높은 편');
  } else {
    advice = 'WATCH';
    out.reasons.push(news.contradicted
      ? '신호가 서로 엇갈려 지금은 방향을 말할 수 없음'
      : '신호는 있으나 판단을 내리기에는 근거가 충분하지 않음');
  }

  /* ── 관문 4. 커버리지 천장 ──
   * 검증이 덜 된 카테고리는 WATCH 위로 올리지 않는다.
   */
  if (coverage === 'PARTIALLY_SUPPORTED' && advice !== 'WATCH') {
    if (advice === 'BUY') out.blockedBy.push('검증 전 카테고리(PARTIALLY_SUPPORTED)');
    advice = 'WATCH';
  }

  /* ── 관문 5. ★ 가격 엔진 천장 ──
   *
   * 이 엔진은 _deal.js 의 판정 위로 올라가지 못한다. 가격 기록이
   * "싼 편" 이라고 말하지 않는데 뉴스만으로 BUY 를 내면, 같은 데이터로
   * 두 개의 답을 말하는 것이고 그중 하나는 근거가 없다.
   */
  if (advice === 'BUY') {
    const dv = o.dealVerdict ? DEAL_ORDER[o.dealVerdict] : undefined;
    if (dv === undefined || dv < DEAL_ORDER.GOOD_BUY) {
      out.blockedBy.push(`가격 판정이 BUY 를 뒷받침하지 않음(${o.dealVerdict || 'UNKNOWN'})`);
      advice = 'WATCH';
    }
  }

  out.advice = advice;
  out.label = ADVICE_LABEL[advice];
  return out;
}

/**
 * 화면에 올릴 근거를 고른다.
 *
 * ★ 이 함수가 hallucination 의 마지막 관문이다.
 *   id 없음 / url 없음 / 관련도 미달 은 전부 여기서 떨어진다. 화면은
 *   이 함수가 돌려준 것만 그린다 — 모델이 만든 제목이 낄 자리가 없다.
 */
function buildEvidence(scored) {
  const seen = new Set();
  const out = [];

  for (const s of scored) {
    for (const it of s.ev.items) {
      if (!it || !it.id || !it.url) continue;          // 기록 없는 근거는 버린다
      if (seen.has(it.id)) continue;
      if (s.u.relevance < MIN_RELEVANCE) continue;
      seen.add(it.id);

      const rec = recencyWeight(it.ageDays, s.ev.eventType);
      out.push({
        id: it.id,
        title: it.title,
        source: it.source,
        tier: it.tier,
        publishedAt: it.publishedAt,
        ageDays: Math.round(it.ageDays * 10) / 10,
        url: it.url,
        eventId: s.ev.eventId,
        eventType: s.ev.eventType,
        eventLabel: R.eventTypeOf(s.ev.eventType).label,
        status: s.u.status,
        relevance: s.u.relevance,
        recencyWeight: rec,
        /* 오래된 근거는 그렇다고 말한다. 숨기면 사용자가 과대평가한다. */
        agingNote: it.ageDays >= 7
          ? `이 신호는 ${Math.round(it.ageDays)}일 전에 발생하여 현재 영향도가 낮게 반영되었습니다.`
          : ''
      });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════
 *  10. 사용자 출력 — 짧게, 그리고 정직하게
 * ══════════════════════════════════════════════════════════════════ */

const DISCLAIMER =
  '본 결과는 수집된 가격·뉴스 데이터에 기반한 참고 정보이며, ' +
  '실제 가격과 재고는 판매처와 시점에 따라 달라질 수 있습니다.';

/**
 * advise() 결과를 화면용 블록으로 옮긴다.
 *
 * ★ 여기서 새로운 사실을 만들지 않는다. advise 가 계산한 값을 문장으로
 *   옮기기만 한다. "다음 주에 오른다" 같은 예측 문장은 만들 수 없다 —
 *   그런 문장을 만들 재료 자체가 이 함수에 없다.
 */
function marketBlock(adv) {
  if (!adv) return null;

  const head = adv.advice === 'NO_DECISION'
    ? '현재 시장 신호 데이터가 충분하지 않습니다'
    : adv.news && adv.news.score > 0 ? '상승 압력'
    : adv.news && adv.news.score < 0 ? '하락 압력'
    : '엇갈린 신호';

  const lines = [];
  if (adv.advice !== 'NO_DECISION') {
    const n = adv.evidence.length;
    const groups = new Set(adv.evidence.map(e => e.source)).size;
    if (n) lines.push(`서로 다른 출처 ${groups}곳에서 관련 신호 ${n}건이 확인됐습니다.`);

    const newest = adv.evidence[0] ? adv.evidence.reduce((a, b) => a.ageDays < b.ageDays ? a : b) : null;
    const oldest = adv.evidence[0] ? adv.evidence.reduce((a, b) => a.ageDays > b.ageDays ? a : b) : null;
    if (newest) lines.push(`가장 최근 근거: ${ago(newest.ageDays)}`);
    if (oldest && oldest !== newest) lines.push(`가장 오래된 활성 근거: ${ago(oldest.ageDays)}`);

    if (adv.price && adv.price.vsAvg30Pct != null) {
      const v = adv.price.vsAvg30Pct;
      lines.push(`현재 가격: 30일 평균 대비 ${v > 0 ? '+' : ''}${v}%`);
    }
  }

  return {
    title: '시장 신호',
    headline: head,
    confidence: adv.confidence,
    confidenceLevel: adv.confidenceLevel,
    /* ★ 숫자 옆에 반드시 붙는다. 신뢰도를 확률로 읽지 못하게 한다. */
    confidenceNote: CONFIDENCE_NOTE,
    lines,
    verdict: adv.advice,
    verdictLabel: adv.label,
    reasons: adv.reasons,
    blockedBy: adv.blockedBy,
    evidence: adv.evidence.map(e => ({
      id: e.id, title: e.title, source: e.source,
      publishedAt: e.publishedAt, url: e.url,
      eventLabel: e.eventLabel, agingNote: e.agingNote
    })),
    disclaimer: DISCLAIMER
  };
}

function ago(days) {
  const d = Number(days) || 0;
  if (d < 1 / 24) return '1시간 이내';
  if (d < 1) return `${Math.round(d * 24)}시간 전`;
  return `${Math.round(d)}일 전`;
}

module.exports = {
  normalizeUrl, hostOf, dedupeKey, titleKey, titleSimilarity, hash,
  normalizeItem, classify, clusterEvents,
  recencyWeight, eventStatus, lifecycleEvent, contradictionPairs,
  confidenceOf, confidenceLevel, newsPressure, priceOpportunity,
  priceStatsSnapshot, confirmWithPrice,
  advise, marketBlock, buildEvidence,
  SUMMARY_MAX, HARD_AGE_DAYS, MIN_RELEVANCE, MIN_INDEPENDENT_FOR_BUY,
  SIMILARITY_THRESHOLD, CLUSTER_WINDOW_DAYS, CONFIRMATION_SIMILARITY, PCTL_TOO_HIGH, BUY_MIN_CONF, WAIT_MIN_CONF,
  ADVICE_LABEL, CONFIDENCE_NOTE, DISCLAIMER
};
