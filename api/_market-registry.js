'use strict';
/*
 * MARKET REGISTRY — 「무엇이 무엇의 가격을 움직이는가」를 데이터로 적어 둔 곳.
 *
 * ── 이 파일이 따로 있는 이유 ────────────────────────────────────────
 *
 * News Intelligence 를 GPU/CPU/RAM/SSD 전용 엔진으로 만들면, 커피나 에어컨을
 * 붙이려는 순간 엔진을 다시 짜야 한다. 그래서 엔진(_news-intelligence.js)에는
 * «계산 방법» 만 두고, «세상이 어떻게 연결돼 있는가» 는 전부 이 파일의
 * 데이터로 뺐다.
 *
 *   엔진   = 범용 (general)
 *   레지스트리 = 지금 아는 만큼만 (limited)
 *
 * 새 카테고리를 지원하려면 여기에 노드 하나와 간선 몇 개를 «추가만» 하면
 * 된다. 엔진 코드는 건드리지 않는다. 그것이 이 분리의 유일한 목적이다.
 *
 * ── 절대 규칙 ───────────────────────────────────────────────────────
 *
 * 1. 모르는 카테고리는 UNSUPPORTED 다. 억지로 판단을 만들지 않는다.
 * 2. 인과는 «가까울수록만» 세게 본다. 3단계 건너간 연결로 BUY 를 만들지 않는다.
 * 3. 여기 적힌 relevance 는 추정치다. 확률이 아니다. 사용자에게 % 로 보여
 *    주지 않는다.
 */

/* ══════════════════════════════════════════════════════════════════
 *  1. 노드 — 상품 카테고리와 «가격을 움직이는 것» 을 같은 그래프에 둔다
 *
 *  kind:
 *    category  SEOSA 가 파는 물건의 묶음 (사용자가 사는 것)
 *    driver    그 가격을 움직이는 상류 요인 (사용자가 사지 않는 것)
 *
 *  두 종류를 굳이 한 그래프에 둔 이유는, 노트북이 CPU 에 의존하듯 «상품이
 *  상품에 의존» 하는 경우가 흔하기 때문이다. 종류를 갈라 두 그래프로 만들면
 *  그 간선을 어디에 적을지가 매번 애매해진다.
 *
 *  upstream: [노드id, relevance]
 *    relevance 는 «그 요인이 움직였을 때 이 카테고리 가격이 따라 움직이는
 *    정도» 의 추정치다(0~1). 경로가 여러 단계면 곱해진다 — 아래 relevanceTo 참고.
 * ══════════════════════════════════════════════════════════════════ */

const NODES = {
  /* ── 상류 요인 (driver) ── */
  wafer:            { kind: 'driver', label: '웨이퍼/파운드리', upstream: [] },
  packaging:        { kind: 'driver', label: '첨단 패키징',     upstream: [['wafer', 0.6]] },
  dram:             { kind: 'driver', label: 'DRAM',            upstream: [['wafer', 0.7]] },
  hbm:              { kind: 'driver', label: 'HBM',             upstream: [['dram', 0.8], ['packaging', 0.7]] },
  nand:             { kind: 'driver', label: 'NAND',            upstream: [['wafer', 0.7]] },
  ssd_controller:   { kind: 'driver', label: 'SSD 컨트롤러',    upstream: [['wafer', 0.5]] },
  display_panel:    { kind: 'driver', label: '디스플레이 패널', upstream: [] },
  battery_cell:     { kind: 'driver', label: '배터리 셀',       upstream: [] },
  compressor:       { kind: 'driver', label: '컴프레서',        upstream: [] },
  datacenter_capex: { kind: 'driver', label: 'AI 데이터센터 투자', upstream: [] },
  coffee_bean:      { kind: 'driver', label: '커피 생두',       upstream: [] },
  /*
   * 거시 요인. 거의 모든 수입 공산품에 얕게 걸린다 — 그래서 relevance 를
   * 낮게 준다. 환율이 움직였다고 특정 상품에 BUY 를 내면 안 된다.
   */
  fx_krw:           { kind: 'driver', label: '원/달러 환율',     upstream: [] },
  shipping:         { kind: 'driver', label: '해상/항공 물류',   upstream: [] },
  trade_policy:     { kind: 'driver', label: '관세·수출입 정책', upstream: [] },

  /* ── 상품 카테고리 (category) ──
   *
   * path 는 product → category → subcategory → industry 를 사람이 읽을 수
   * 있게 적어 둔 것이다. 계산에는 쓰지 않고 설명과 감사에만 쓴다.
   */
  gpu: {
    kind: 'category', label: '그래픽카드',
    path: ['PC 부품', 'GPU', '반도체'],
    upstream: [['wafer', 0.8], ['hbm', 0.7], ['packaging', 0.7],
               ['datacenter_capex', 0.7], ['dram', 0.5],
               ['fx_krw', 0.35], ['trade_policy', 0.5], ['shipping', 0.2]]
  },
  cpu: {
    kind: 'category', label: 'CPU',
    path: ['PC 부품', 'CPU', '반도체'],
    upstream: [['wafer', 0.85], ['packaging', 0.6],
               ['fx_krw', 0.35], ['trade_policy', 0.45], ['shipping', 0.2]]
  },
  ram: {
    kind: 'category', label: '메모리(RAM)',
    path: ['PC 부품', 'DRAM', '반도체'],
    upstream: [['dram', 0.95], ['hbm', 0.5], ['wafer', 0.5],
               ['fx_krw', 0.4], ['trade_policy', 0.4], ['shipping', 0.2]]
  },
  ssd: {
    kind: 'category', label: 'SSD',
    path: ['저장장치', 'NAND', '반도체'],
    upstream: [['nand', 0.95], ['ssd_controller', 0.5], ['wafer', 0.45],
               ['fx_krw', 0.4], ['trade_policy', 0.4], ['shipping', 0.2]]
  },

  /*
   * ── 아래는 «엔진이 범용임» 을 증명하기 위한 확장 예시다 ──
   *
   * 노드와 간선만 적혀 있고 엔진 코드는 한 줄도 늘지 않았다. 다만 V1 에서는
   * COVERAGE 로 아직 열지 않는다(아래 참고) — 구조는 준비하되 검증 안 된
   * 카테고리에 판단을 내보내지 않는다는 뜻이다.
   */
  laptop: {
    kind: 'category', label: '노트북',
    path: ['전자기기', 'PC', '완제품'],
    upstream: [['cpu', 0.6], ['ram', 0.5], ['ssd', 0.45], ['display_panel', 0.45],
               ['battery_cell', 0.3], ['fx_krw', 0.5], ['shipping', 0.25]]
  },
  smartphone: {
    kind: 'category', label: '스마트폰',
    path: ['전자기기', '모바일', '완제품'],
    upstream: [['wafer', 0.5], ['dram', 0.4], ['nand', 0.4], ['display_panel', 0.5],
               ['battery_cell', 0.35], ['fx_krw', 0.5]]
  },
  monitor: {
    kind: 'category', label: '모니터',
    path: ['전자기기', '디스플레이', '완제품'],
    upstream: [['display_panel', 0.85], ['fx_krw', 0.45], ['shipping', 0.3]]
  },
  aircon: {
    kind: 'category', label: '에어컨',
    path: ['생활가전', 'HVAC', '완제품'],
    upstream: [['compressor', 0.7], ['fx_krw', 0.3], ['shipping', 0.25]]
  },
  coffee: {
    kind: 'category', label: '커피',
    path: ['식품', '커피', '원자재'],
    upstream: [['coffee_bean', 0.9], ['fx_krw', 0.5], ['shipping', 0.4]]
  }
};

/* ══════════════════════════════════════════════════════════════════
 *  2. 커버리지 — 「이 카테고리에 판단을 낼 자격이 있는가」
 *
 *  ENGINE = GENERAL / INITIAL COVERAGE = LIMITED.
 *
 *  SUPPORTED            신호 출처와 가격 데이터가 모두 검증됐다. 판단을 낸다.
 *  PARTIALLY_SUPPORTED  신호는 있으나 검증이 덜 됐다. WATCH 위로는 올리지 않는다.
 *  UNSUPPORTED          판단하지 않는다. "시장 신호 데이터가 충분하지 않습니다".
 *
 *  ★ 여기 없는 것은 전부 UNSUPPORTED 다 (coverageOf 참고). 새 카테고리를
 *    노드에 적었다고 자동으로 켜지지 않는다 — 켜는 것은 사람의 판단이다.
 * ══════════════════════════════════════════════════════════════════ */

const COVERAGE = {
  gpu: 'SUPPORTED',
  cpu: 'SUPPORTED',
  ram: 'SUPPORTED',
  ssd: 'SUPPORTED',
  /* 확장 예시 — 구조는 있으나 아직 검증 전이다. */
  laptop:     'PARTIALLY_SUPPORTED',
  monitor:    'PARTIALLY_SUPPORTED',
  smartphone: 'PARTIALLY_SUPPORTED'
  /* aircon / coffee 는 일부러 비워 둔다 = UNSUPPORTED */
};

/* ══════════════════════════════════════════════════════════════════
 *  3. 이벤트 분류 체계 — 범용 taxonomy
 *
 *  direction   +1  가격에 «올리는» 압력   (사면 유리할 수 있는 쪽)
 *              -1  가격에 «내리는» 압력   (기다리면 유리할 수 있는 쪽)
 *               0  방향을 말할 수 없음 → 신호로 쓰지 않는다
 *
 *  halfLife    이 종류의 사건이 얼마나 오래 힘을 갖는가 (일). 감쇠에 쓴다.
 *              사건 종류마다 수명이 다르다는 것이 이 설계의 핵심이다 —
 *              배송 지연은 사흘이면 옛날 이야기지만 관세는 반년을 간다.
 *
 *  horizonDays 사건이 «아직 진행 중일 수 있는» 기간. 상태 판정(ACTIVE 등)에 쓴다.
 *
 *  ★ direction 0 인 종류는 BUY/WAIT 신호를 만들지 못한다. 근거로 보여줄
 *    수는 있어도 판단을 밀지는 않는다.
 * ══════════════════════════════════════════════════════════════════ */

const TRANSIENT = 3, MEDIUM = 18, STRUCTURAL = 120;

const EVENT_TYPES = {
  SUPPLY_DECREASE:         { direction:  1, halfLife: MEDIUM,     horizonDays: 90,  label: '공급 축소' },
  SUPPLY_INCREASE:         { direction: -1, halfLife: MEDIUM,     horizonDays: 90,  label: '공급 확대' },
  DEMAND_INCREASE:         { direction:  1, halfLife: MEDIUM,     horizonDays: 120, label: '수요 증가' },
  DEMAND_DECREASE:         { direction: -1, halfLife: MEDIUM,     horizonDays: 120, label: '수요 감소' },
  PRODUCTION_CUT:          { direction:  1, halfLife: MEDIUM,     horizonDays: 180, label: '감산' },
  PRODUCTION_EXPANSION:    { direction: -1, halfLife: STRUCTURAL, horizonDays: 540, label: '증설' },
  LOGISTICS_DISRUPTION:    { direction:  1, halfLife: TRANSIENT,  horizonDays: 30,  label: '물류 차질' },
  RAW_MATERIAL_PRICE_UP:   { direction:  1, halfLife: MEDIUM,     horizonDays: 120, label: '원자재 가격 상승' },
  RAW_MATERIAL_PRICE_DOWN: { direction: -1, halfLife: MEDIUM,     horizonDays: 120, label: '원자재 가격 하락' },
  TARIFF_INCREASE:         { direction:  1, halfLife: STRUCTURAL, horizonDays: 540, label: '관세 인상' },
  TARIFF_DECREASE:         { direction: -1, halfLife: STRUCTURAL, horizonDays: 540, label: '관세 인하' },
  EXPORT_RESTRICTION:      { direction:  1, halfLife: STRUCTURAL, horizonDays: 365, label: '수출 규제' },
  IMPORT_RESTRICTION:      { direction:  1, halfLife: STRUCTURAL, horizonDays: 365, label: '수입 규제' },
  PRODUCT_LAUNCH:          { direction: -1, halfLife: MEDIUM,     horizonDays: 120, label: '신제품 출시' },
  PRODUCT_DISCONTINUATION: { direction:  1, halfLife: MEDIUM,     horizonDays: 180, label: '단종' },
  SEASONAL_DEMAND:         { direction:  1, halfLife: MEDIUM,     horizonDays: 90,  label: '계절 수요' },
  PROMOTION_EVENT:         { direction: -1, halfLife: TRANSIENT,  horizonDays: 21,  label: '프로모션' },
  FAB_DISRUPTION:          { direction:  1, halfLife: MEDIUM,     horizonDays: 120, label: '생산시설 사고' },
  WEATHER_EVENT:           { direction:  1, halfLife: TRANSIENT,  horizonDays: 45,  label: '기상 이변' },
  /*
   * 방향을 말할 수 없는 것들. 근거로는 보여 주되 판단을 밀지 않는다.
   * 예: 환율 «변동» 은 오른 건지 내린 건지 제목만으로는 알 수 없다.
   */
  EXCHANGE_RATE_MOVE:      { direction: 0, halfLife: MEDIUM,     horizonDays: 60,  label: '환율 변동' },
  REGULATORY_CHANGE:       { direction: 0, halfLife: STRUCTURAL, horizonDays: 365, label: '규제 변화' },
  MACROECONOMIC_CHANGE:    { direction: 0, halfLife: STRUCTURAL, horizonDays: 180, label: '거시 변화' },
  COMPANY_GUIDANCE:        { direction: 0, halfLife: MEDIUM,     horizonDays: 90,  label: '실적 전망' },
  RECALL:                  { direction: 0, halfLife: MEDIUM,     horizonDays: 120, label: '리콜' },
  UNKNOWN:                 { direction: 0, halfLife: TRANSIENT,  horizonDays: 0,   label: '분류 불가' }
};

/* V2 이름을 명시적으로 노출한다. V1의 halfLife는 하위 호환을 위해 유지한다. */
Object.keys(EVENT_TYPES).forEach(type => {
  EVENT_TYPES[type].halfLifeDays = EVENT_TYPES[type].halfLife;
});

/**
 * 어떤 사건이 어떤 사건을 «끝내는가».
 * PRODUCT_LAUNCH 는 출시가 끝나면 더는 대기 이유가 아니다 — 같은 노드에서
 * 뒤에 온 반대 사건이 앞 사건을 RESOLVED 로 만든다.
 */
const RESOLVES = {
  SUPPLY_DECREASE: ['SUPPLY_INCREASE', 'SUPPLY_RECOVERY'],
  SUPPLY_INCREASE: ['SUPPLY_DECREASE'],
  PRODUCTION_CUT:  ['PRODUCTION_EXPANSION'],
  FAB_DISRUPTION:  ['SUPPLY_INCREASE'],
  LOGISTICS_DISRUPTION: ['SUPPLY_INCREASE'],
  PRODUCT_LAUNCH:  ['PRODUCT_LAUNCH_DONE']
};

/* 서로 독립적으로 관측됐을 때 방향 신뢰도를 낮추는 사건 쌍. */
const CONTRADICTIONS = Object.freeze({
  SUPPLY_DECREASE: ['SUPPLY_INCREASE', 'PRODUCTION_EXPANSION'],
  SUPPLY_INCREASE: ['SUPPLY_DECREASE', 'PRODUCTION_CUT', 'FAB_DISRUPTION'],
  DEMAND_INCREASE: ['DEMAND_DECREASE'],
  DEMAND_DECREASE: ['DEMAND_INCREASE', 'PRODUCT_LAUNCH'],
  PRODUCTION_CUT: ['PRODUCTION_EXPANSION', 'SUPPLY_INCREASE'],
  PRODUCTION_EXPANSION: ['PRODUCTION_CUT', 'SUPPLY_DECREASE'],
  RAW_MATERIAL_PRICE_UP: ['RAW_MATERIAL_PRICE_DOWN'],
  RAW_MATERIAL_PRICE_DOWN: ['RAW_MATERIAL_PRICE_UP'],
  TARIFF_INCREASE: ['TARIFF_DECREASE'],
  TARIFF_DECREASE: ['TARIFF_INCREASE'],
  PRODUCT_LAUNCH: ['PRODUCT_DISCONTINUATION', 'DEMAND_DECREASE'],
  PRODUCT_DISCONTINUATION: ['PRODUCT_LAUNCH']
});

/* ══════════════════════════════════════════════════════════════════
 *  4. 출처 신뢰도
 *
 *  tier   A  공식 기업 뉴스룸 / IR (1차 출처)
 *         B  정부·공공·산업기관 (1차 출처, 이해관계 없음)
 *         C  GDELT 보조 탐색 (단독으로는 근거가 되지 못한다)
 *
 *  trust  0~30. confidence 의 sourceTrust 축에 그대로 들어간다.
 *
 *  ★ 이 목록에 «없는 도메인은 버린다». 블로그·커뮤니티·SEO 재게시를
 *    이름으로 걸러내려 하면 끝이 없다. 허용 목록만 통과시키는 쪽이
 *    유일하게 지켜지는 방어다.
 *
 *  ★ group 은 «독립 출처» 를 세는 단위다. 같은 회사의 뉴스룸과 IR 페이지는
 *    독립 출처 2개가 아니다.
 * ══════════════════════════════════════════════════════════════════ */

const SOURCES = {
  /* ── A. 공식 기업 뉴스룸 / IR ── */
  'nvidianews.nvidia.com':   { name: 'NVIDIA Newsroom',      tier: 'A', trust: 28, group: 'nvidia' },
  'blogs.nvidia.com':        { name: 'NVIDIA Blog',          tier: 'A', trust: 24, group: 'nvidia' },
  'investor.nvidia.com':     { name: 'NVIDIA IR',            tier: 'A', trust: 28, group: 'nvidia' },
  'ir.amd.com':              { name: 'AMD IR',               tier: 'A', trust: 28, group: 'amd' },
  'amd.com':             { name: 'AMD',                  tier: 'A', trust: 24, group: 'amd' },
  'newsroom.intel.com':      { name: 'Intel Newsroom',       tier: 'A', trust: 28, group: 'intel' },
  'intc.com':            { name: 'Intel IR',             tier: 'A', trust: 28, group: 'intel' },
  'investors.micron.com':    { name: 'Micron IR',            tier: 'A', trust: 28, group: 'micron' },
  'micron.com':          { name: 'Micron',               tier: 'A', trust: 26, group: 'micron' },
  'news.samsung.com':        { name: 'Samsung Newsroom',     tier: 'A', trust: 27, group: 'samsung' },
  'semiconductor.samsung.com': { name: 'Samsung Semiconductor', tier: 'A', trust: 26, group: 'samsung' },
  'news.skhynix.com':        { name: 'SK hynix Newsroom',    tier: 'A', trust: 27, group: 'skhynix' },
  'skhynix.com':         { name: 'SK hynix',             tier: 'A', trust: 26, group: 'skhynix' },
  'pr.tsmc.com':             { name: 'TSMC',                 tier: 'A', trust: 28, group: 'tsmc' },
  'tsmc.com':            { name: 'TSMC',                 tier: 'A', trust: 26, group: 'tsmc' },
  'asml.com':            { name: 'ASML',                 tier: 'A', trust: 27, group: 'asml' },
  'kioxia.com':          { name: 'Kioxia',               tier: 'A', trust: 26, group: 'kioxia' },
  'westerndigital.com':  { name: 'Western Digital',      tier: 'A', trust: 26, group: 'wd' },
  'sandisk.com':         { name: 'SanDisk',              tier: 'A', trust: 24, group: 'wd' },
  'solidigm.com':        { name: 'Solidigm',             tier: 'A', trust: 24, group: 'solidigm' },
  'press.aboutamazon.com':   { name: 'AWS/Amazon',           tier: 'A', trust: 24, group: 'amazon' },
  /* 아마존 뉴스룸이 옮겨 간 곳. 옛 도메인도 남겨 둔다 — 옛 링크가 여전히 돈다. */
  'aboutamazon.com':         { name: 'AWS/Amazon',           tier: 'A', trust: 24, group: 'amazon' },
  'news.microsoft.com':      { name: 'Microsoft',            tier: 'A', trust: 24, group: 'microsoft' },
  'blog.google':             { name: 'Google',               tier: 'A', trust: 24, group: 'google' },
  'cloud.google.com':        { name: 'Google Cloud',         tier: 'A', trust: 22, group: 'google' },

  /* ── B. 정부 / 공공 / 산업기관 ── */
  'motie.go.kr':         { name: '산업통상자원부',        tier: 'B', trust: 30, group: 'motie' },
  'msit.go.kr':          { name: '과학기술정보통신부',    tier: 'B', trust: 30, group: 'msit' },
  'customs.go.kr':       { name: '관세청',                tier: 'B', trust: 30, group: 'customs' },
  'kotra.or.kr':         { name: 'KOTRA',                 tier: 'B', trust: 28, group: 'kotra' },
  'kita.net':            { name: '한국무역협회',          tier: 'B', trust: 28, group: 'kita' },
  'bok.or.kr':           { name: '한국은행',              tier: 'B', trust: 30, group: 'bok' },
  'semi.org':            { name: 'SEMI',                  tier: 'B', trust: 28, group: 'semi' },
  'wsts.org':            { name: 'WSTS',                  tier: 'B', trust: 28, group: 'wsts' },

  /* ── C. GDELT (보조 탐색 전용) ──
   * 실제 기사 도메인은 제각각이라 도메인으로 등록할 수 없다. 수집기가
   * GDELT 로 들어온 항목에 이 키를 직접 붙인다(_news-fetch.js 참고).
   */
  '__gdelt__':               { name: 'GDELT', tier: 'C', trust: 8, group: 'gdelt' }
};

/* ══════════════════════════════════════════════════════════════════
 *  5. 조회 함수
 * ══════════════════════════════════════════════════════════════════ */

/** 이 카테고리에 판단을 낼 자격이 있는가. 모르는 것은 전부 UNSUPPORTED. */
function coverageOf(nodeId) {
  return COVERAGE[nodeId] || 'UNSUPPORTED';
}

function nodeOf(nodeId) {
  return NODES[nodeId] || null;
}

function eventTypeOf(type) {
  return EVENT_TYPES[type] || EVENT_TYPES.UNKNOWN;
}

function sourceOf(host) {
  return SOURCES[String(host || '').toLowerCase()] || null;
}

/** 지금 판단을 내보내도 되는 카테고리 목록 (감사·진단용). */
function supportedNodes() {
  return Object.keys(COVERAGE).filter(k => COVERAGE[k] !== 'UNSUPPORTED');
}

/*
 * 인과 거리 — driver 가 움직였을 때 category 가 얼마나 따라 움직이는가.
 *
 * 최단 경로가 아니라 «가장 센 경로» 를 찾는다. 간선 가중치가 곱해지므로
 * 단계가 늘수록 저절로 약해진다 — 직접 0.9, 한 단계 건너 0.9*0.7=0.63,
 * 두 단계면 0.44. 「1단계 0.7 / 2단계 0.4」 라는 기준이 깊이 상수를
 * 따로 두지 않아도 자연히 나온다.
 *
 * ★ MAX_DEPTH 가 이 함수의 안전장치다. 그래프에 순환이 생겨도 멈추고,
 *   "환율 → 웨이퍼 → HBM → GPU → 노트북" 같은 먼 연결을 근거로
 *   쓰지 못하게 한다.
 */
const MAX_DEPTH = 3;

/*
 * V2 propagation policy. hops=0은 같은 노드, hops=1은 직접 상류 간선이다.
 * 실제 간선 경로가 없으면 hop 숫자만으로 영향을 만들어 내지 않는다.
 */
const IMPACT_PROPAGATION = Object.freeze({
  maxHops: MAX_DEPTH,
  hopWeights: Object.freeze([1, 0.7, 0.4, 0.2])
});

/* registry가 표현하는 범용 계층. 개별 node의 실제 연결은 NODES.upstream이 소유한다. */
const GRAPH_LAYERS = Object.freeze([
  'PRODUCT', 'PRODUCT_CATEGORY', 'INDUSTRY', 'COMPONENT', 'RAW_MATERIAL',
  'MACRO_POLICY', 'REGION', 'LOGISTICS', 'SEASONAL', 'PROMOTION'
]);

const NODE_LAYERS = Object.freeze({
  wafer: 'COMPONENT', packaging: 'COMPONENT', dram: 'COMPONENT', hbm: 'COMPONENT',
  nand: 'COMPONENT', ssd_controller: 'COMPONENT', display_panel: 'COMPONENT',
  battery_cell: 'COMPONENT', compressor: 'COMPONENT', coffee_bean: 'RAW_MATERIAL',
  datacenter_capex: 'MACRO_POLICY', fx_krw: 'MACRO_POLICY', trade_policy: 'MACRO_POLICY',
  shipping: 'LOGISTICS'
});

function layerOf(nodeId) {
  const node = NODES[nodeId];
  if (!node) return null;
  return NODE_LAYERS[nodeId] || (node.kind === 'category' ? 'PRODUCT_CATEGORY' : 'INDUSTRY');
}

/** 상품 id는 runtime이 소유하고, registry는 category 이후의 설명 가능한 계층을 준다. */
function marketHierarchyOf(categoryId) {
  const node = NODES[categoryId];
  if (!node || node.kind !== 'category') return [];
  const descriptive = (node.path || []).map((label, index, all) => ({
    layer: index === all.length - 1 ? 'INDUSTRY' : 'PRODUCT_CATEGORY', label
  }));
  return [{ layer: 'PRODUCT_CATEGORY', id: categoryId, label: node.label }].concat(descriptive);
}

function graphPath(categoryId, driverId) {
  if (!categoryId || !driverId || !NODES[categoryId] || !NODES[driverId]) return null;
  if (categoryId === driverId) return { path: [categoryId], hops: 0, edgeWeight: 1, hopWeight: 1, impact: 1 };

  let best = null;
  const queue = [{ id: categoryId, path: [categoryId], edgeWeight: 1, hops: 0 }];
  const seen = new Map([[categoryId, 1]]);
  while (queue.length) {
    const cur = queue.shift();
    if (cur.hops >= IMPACT_PROPAGATION.maxHops) continue;
    const node = NODES[cur.id];
    if (!node) continue;
    for (const [next, edge] of node.upstream || []) {
      if (cur.path.indexOf(next) > -1) continue;
      const hops = cur.hops + 1;
      const edgeWeight = cur.edgeWeight * edge;
      const path = cur.path.concat(next);
      const hopWeight = IMPACT_PROPAGATION.hopWeights[hops] || 0;
      const candidate = { path, hops, edgeWeight, hopWeight, impact: Math.round(Math.min(edgeWeight, hopWeight) * 100) / 100 };
      if (next === driverId && (!best || candidate.impact > best.impact)) best = candidate;
      if ((seen.get(next) || 0) >= edgeWeight) continue;
      seen.set(next, edgeWeight);
      queue.push({ id: next, path, edgeWeight, hops });
    }
  }
  return best;
}

function relevanceTo(categoryId, driverId) {
  if (!categoryId || !driverId) return 0;
  if (categoryId === driverId) return 1;
  if (!NODES[categoryId] || !NODES[driverId]) return 0;

  let best = 0;
  const seen = new Map();          // 노드 → 그 노드까지의 최고 가중치
  const queue = [[categoryId, 1, 0]];

  while (queue.length) {
    const [id, weight, depth] = queue.shift();
    if (depth >= MAX_DEPTH) continue;
    const node = NODES[id];
    if (!node) continue;

    for (const [next, edge] of node.upstream || []) {
      const w = weight * edge;
      if (next === driverId) { if (w > best) best = w; continue; }
      // 더 센 경로로 이미 지나간 노드는 다시 펼치지 않는다.
      if ((seen.get(next) || 0) >= w) continue;
      seen.set(next, w);
      queue.push([next, w, depth + 1]);
    }
  }
  return Math.round(best * 100) / 100;
}

/** V2 영향도: 실제 경로 + hop 감쇠를 함께 반환한다. */
function impactTo(categoryId, driverId) {
  return graphPath(categoryId, driverId);
}

/*
 * 텍스트에서 노드를 알아본다 (상품명 · 검색어 · 기사 제목 공통).
 *
 * ★ 여기서 «여러 개» 를 돌려준다. "SK하이닉스 HBM 감산" 은 hbm 이면서
 *   dram 이기도 하다. 하나로 좁히면 그 사건이 RAM 에 닿는 경로를 잃는다.
 *
 * ★ 정규식은 보수적으로 적는다. 넓게 잡아 아무 기사나 걸리는 것보다
 *   좁게 잡아 놓치는 편이 낫다 — 놓친 기사는 판단을 흐리지 않는다.
 */
const NODE_RE = [
  /*
   * ★ 복수형을 반드시 함께 잡는다 (2026-09-10 실측으로 고침).
   *   처음에는 \bGPU\b 로 적었는데, 그러면 "2 Million Additional GPUs" 가
   *   걸리지 않는다 — \b 뒤의 s 는 낱말 문자라 경계가 서지 않는다.
   *   실제 피드 78건을 돌려 보니 이것 하나 때문에 노드 매핑이 거의 전멸했다.
   */
  ['hbm',              /\bHBMs?\b|고대역폭\s?메모리|high[- ]bandwidth memory/i],
  ['dram',             /\bDRAMs?\b|디램|D램|\bDDR[45]\b|메모리\s?반도체/i],
  ['nand',             /\bNANDs?\b|낸드|\bV-?NAND\b|3D\s?낸드|NAND flash/i],
  ['wafer',            /\b(?:wafer|foundry)\b|웨이퍼|파운드리|\b\d+nm\b|미세공정/i],
  ['packaging',        /\b(?:CoWoS|advanced packaging)\b|첨단\s?패키징|후공정/i],
  ['ssd_controller',   /SSD\s?컨트롤러|(?:ssd|nand)\s+controller/i],
  ['datacenter_capex', /\b(?:data ?cent(?:er|re)|AI (?:server|infrastructure|capex))\b|데이터\s?센터|AI\s?서버|설비\s?투자/i],
  ['display_panel',    /\b(?:OLED|LCD|display panel)\b|디스플레이\s?패널|패널\s?가격/i],
  ['battery_cell',     /배터리\s?셀|리튬이온|\blithium[- ]ion\b/i],
  ['compressor',       /컴프레서|\bcompressor\b/i],
  ['coffee_bean',      /생두|원두|\b(?:arabica|robusta|coffee bean)\b/i],
  ['fx_krw',           /원\/?달러|환율|\b(?:won|KRW)[\/ ]?(?:dollar|USD)\b|\bexchange rate\b/i],
  ['shipping',         /해상\s?운임|물류\s?대란|항만|\b(?:freight|shipping rate|port congestion)\b/i],
  ['trade_policy',     /관세|수출\s?규제|수입\s?규제|\b(?:tariff|export control|export restriction)\b/i],

  ['gpu',              /\b(?:GPUs?|graphics cards?|RTX|GeForce|Radeon|Blackwell)\b|그래픽\s?카드|지포스|라데온/i],
  ['cpu',              /\b(?:CPUs?|Ryzen|Core Ultra|EPYC|Xeon|processors?)\b|프로세서|중앙처리장치/i],
  ['ram',              /\b(?:RAM|DIMM|SODIMM)\b|램\s?가격|메모리\s?모듈/i],
  ['ssd',              /\bSSDs?\b|\bNVMe\b|솔리드\s?스테이트/i],
  ['laptop',           /노트북|랩탑|\b(?:laptop|notebook PC)\b/i],
  ['smartphone',       /스마트폰|\b(?:smartphone|iPhone|Galaxy S\d)\b/i],
  ['monitor',          /모니터|\bmonitor\b/i],
  ['aircon',           /에어컨|\bair conditioner\b/i],
  ['coffee',           /커피|\bcoffee\b/i]
];

/**
 * @returns {string[]} 알아본 노드 id 들 (없으면 빈 배열)
 */
function detectNodes(text) {
  const t = String(text == null ? '' : text);
  if (!t) return [];
  const out = [];
  for (const [id, re] of NODE_RE) {
    if (re.test(t) && out.indexOf(id) === -1) out.push(id);
  }
  return out;
}

/**
 * 상품/검색어를 «판단 대상 카테고리» 하나로 좁힌다.
 *
 * detectNodes 와 달리 category 종류만 본다 — 사용자는 HBM 을 사지 않는다.
 * 여러 개가 걸리면 커버리지가 높은 쪽을 고르고, 그래도 같으면 먼저 걸린 쪽이다.
 */
const COVERAGE_RANK = { SUPPORTED: 2, PARTIALLY_SUPPORTED: 1, UNSUPPORTED: 0 };

function detectCategory(text) {
  const cats = detectNodes(text).filter(id => NODES[id] && NODES[id].kind === 'category');
  if (!cats.length) return '';
  let best = cats[0];
  for (const c of cats) {
    if (COVERAGE_RANK[coverageOf(c)] > COVERAGE_RANK[coverageOf(best)]) best = c;
  }
  return best;
}

module.exports = {
  NODES, COVERAGE, EVENT_TYPES, RESOLVES, CONTRADICTIONS, SOURCES,
  coverageOf, nodeOf, eventTypeOf, sourceOf, supportedNodes,
  relevanceTo, impactTo, graphPath, layerOf, marketHierarchyOf, detectNodes, detectCategory,
  MAX_DEPTH, IMPACT_PROPAGATION, GRAPH_LAYERS, NODE_LAYERS, TRANSIENT, MEDIUM, STRUCTURAL
};
