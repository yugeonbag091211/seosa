'use strict';
const { hasConfirmedRecordLow } = require('./_priceevidence');
/*
 * SEOSA Concierge — LLM 없이 만드는 답변과 후속 질문.
 *
 * ── 무엇을 하는 모듈인가 ────────────────────────────────────────
 *
 * 판단은 원래부터 코드가 한다.
 *   _shopintent  조건 해석 · 랭킹
 *   _pricestat   가격 통계 · 구매 시점
 *   _deal        7단계 구매 시점 판정
 *   _decision    1위 · 격차 · 확신도 · 후회 위험 · 대안 · 뒤집는 조건
 *
 * LLM 이 하는 일은 그 결론을 사람 말로 옮기는 것뿐이다. 그래서 LLM 이 없어도
 * 답의 알맹이는 그대로 남아 있다 — 여기서 그것을 문장으로 조립한다.
 *
 * 이 모듈이 있어서 SEOSA 는 두 가지를 얻는다.
 *
 *   1) 모델이 죽어도 답이 나간다. 무료 모델 사슬(_llm.js)까지 전부 실패해도
 *      사용자는 "무엇을 왜 권하는지" 를 받는다.
 *   2) 답변이 끝이 아니라 다음 행동으로 이어진다(followups). 이 계산에는
 *      LLM 호출이 한 번도 들어가지 않는다.
 *
 * ── 지키는 선 ──────────────────────────────────────────────────
 *
 *   · 여기서 새 사실을 만들지 않는다. 금액·판정·근거는 전부 인자로 받은
 *     계산 결과에서 그대로 옮긴다. 없으면 그 줄을 아예 쓰지 않는다.
 *   · 근거가 없으면 단정하지 않는다. 확신도가 낮으면 문장도 낮춘다
 *     (hedgeFor 참고). "판단할 근거가 없다" 를 "괜찮다" 로 바꾸지 않는다.
 *   · 팔려고 밀지 않는다. 기록 대비 비싼 값이면 서두르지 말라고 말한다.
 *     후속 질문에도 재촉·가짜 긴급성을 넣지 않는다.
 */

/** 12345 → "12,345" */
function won(v) {
  const n = Math.round(Number(v) || 0);
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 상품명은 판매자가 쓴 긴 문자열이다. 문장에 넣을 만큼만 자른다. */
function shortTitle(t, n) {
  const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function priceOf(it) {
  if (!it) return 0;
  const p = Number(it.price != null ? it.price : it.lprice);
  return Number.isFinite(p) && p > 0 ? Math.round(p) : 0;
}

/* ==================================================================
 *  1) 결론 한 줄
 *
 *  두 축을 함께 읽는다.
 *    stance  — 지금 사도 되는가 (_deal 판정)
 *    hedge   — 얼마나 단정해도 되는가 (_decision 확신도)
 *
 *  둘을 섞지 않는다. "싼 값이다" 와 "그 판단이 얼마나 믿을 만한가" 는
 *  다른 질문이고, 하나로 뭉치면 둘 다 흐려진다.
 * ================================================================== */

/** 구매 시점 판정 → 사용자에게 할 말. */
const STANCE = {
  BUY:      '지금 사도 좋은 값이에요.',
  GOOD_BUY: '지금 값은 싼 편이에요.',
  NORMAL:   '가격은 평범해요. 필요하시면 지금 사도 손해는 아니에요.',
  WATCH:    '지금 정하기보다 며칠 지켜보시는 편을 권해요.',
  /*
   * ★ 이 두 줄이 SEOSA 가 판매를 밀지 않는다는 약속의 실체다.
   *   기록상 비싼 값이면 비싸다고 말한다. 팔 기회를 놓치더라도 그렇게 한다.
   */
  WAIT:     '지금은 서두르지 않는 편을 권해요. 기록상 비싼 구간이에요.',
  DONT_BUY: '지금 사는 건 권하지 않아요. 기록 대비 확연히 비쌉니다.',
  UNKNOWN:  ''
};

/**
 * 확신도에 따라 문장의 세기를 정한다.
 *
 * 확신이 낮은데 단정하면 그건 데이터가 아니라 말투로 사용자를 속이는 것이다.
 */
function hedgeFor(confidence) {
  /*
   * 절 전체를 돌려준다. 낱말(동사)만 갈아 끼우면 "이 상품을 가장 가까워
   * 보여요" 같은 비문이 나온다 — 조사가 함께 바뀌어야 한다.
   */
  if (confidence === 'high')   return { clause: '이 상품을 권해요.',      note: '' };
  if (confidence === 'medium') return { clause: '이 상품을 권할 만해요.', note: '' };
  return {
    clause: '이 상품이 가장 가까워 보여요.',
    note: '다만 지금 데이터로는 확신이 낮아요 — 아래 근거를 함께 봐 주세요.'
  };
}

/**
 * 결론 문단.
 *
 * @returns {string[]} 줄 목록 (비어 있을 수 있다)
 */
function conclusion(top, deal, decision, options = {}) {
  const L = [];
  if (!top) return L;

  const conf = (decision && decision.confidence && decision.confidence.confidence) || 'low';
  const hedge = hedgeFor(conf);
  const name = nameOf(top, 46);
  const p = priceOf(top);

  L.push(`추천: ${name}${p > 0 ? ` — ${won(p)}원` : ''}`);

  /*
   * 추천 강도가 weak 이면(예산 초과·후회 위험 높음) 권하는 말로 시작하지 않는다.
   * _decision.recommendLevel 이 이미 그렇게 판정한 것을 문장이 뒤집으면 안 된다.
   */
  const level = decision && decision.recommendation;
  if (level === 'weak') {
    L.push('지금 후보 중에서는 이것이 가장 가깝지만, 자신 있게 권하기는 어려워요.');
  } else {
    L.push(`지금 조건에서는 ${hedge.clause}`);
  }

  const stance = STANCE[(deal && deal.verdict) || 'UNKNOWN'];
  if (stance && !options.suppressTiming) L.push(stance);
  if (hedge.note && level !== 'weak') L.push(hedge.note);

  return L;
}

/* ==================================================================
 *  2) 이유 · 구매 시점 · 주의
 * ================================================================== */

/*
 * "이유" 자리에 들어가면 안 되는 말.
 *
 * decide().decisive 는 랭킹에 쓰인 사실을 모아 둔 것이라 부정형도 섞인다
 * ("검색어와 상품명이 일치하지 않음"). 프롬프트에서는 맥락이 있어 괜찮지만,
 * 사용자 화면의 "이유:" 아래에 그대로 놓이면 **추천하는 근거가 부정형**이
 * 되어 읽는 사람이 어리둥절해진다 (2026-08-30 실측에서 실제로 그렇게 나갔다).
 *
 * 지우는 것이 아니라 자리를 옮기는 것이다 — 아쉬운 점은 cautions() 가 맡는다.
 */
// "제외 요청하신 … 제품" · "요청 상품과 다름: …" 은 권하는 근거가 아니라 주의할 사실이다.
const NEGATIVE_REASON = /(않음|않습니다|없음|없습니다|어려움|어렵|불가|미확인|확인 안 됨|초과|제외 요청|요청 상품과 다름)/;

/** 왜 이것인가. rankItems / decide 가 이미 만들어 둔 문장을 옮긴다. */
function reasons(top, decision) {
  const out = [];
  const add = r => {
    const s = String(r == null ? '' : r).trim();
    if (!s || NEGATIVE_REASON.test(s) || out.indexOf(s) > -1) return;
    if (out.length < 3) out.push(s);
  };

  if (decision && Array.isArray(decision.decisive)) decision.decisive.forEach(add);
  if (!out.length && top) {
    add(top.fit);
    (Array.isArray(top.notes) ? top.notes : []).forEach(add);
  }
  return out;
}

/** 구매 시점 판정 블록. _deal.js 가 만든 문장 그대로. */
function timing(deal) {
  const L = [];
  if (!deal) {
    L.push('구매 시점: 가격 기록이 없어 판단하지 않았습니다.');
    return L;
  }
  if (deal.verdict === 'UNKNOWN') {
    L.push('구매 시점: 판단할 근거가 부족합니다.');
    if (deal.reasons && deal.reasons[0]) L.push(`- ${deal.reasons[0]}`);
  } else {
    L.push(`구매 시점: ${deal.label}`);
    (deal.reasons || []).slice(0, 2).forEach(r => L.push(`- ${r}`));
  }
  if (deal.freshness && deal.freshness.label) {
    L.push(`- 가격 데이터: ${deal.freshness.label}`);
  }
  return L;
}

/**
 * 주의할 점.
 *
 * 좋은 소식만 말하면 사용자가 손해를 본다. 판정이 좋아도 놓치는 것은 말한다.
 */
function cautions(deal, decision) {
  const out = [];
  (deal && Array.isArray(deal.cautions) ? deal.cautions : []).slice(0, 2)
    .forEach(c => { if (c) out.push(String(c)); });
  (deal && Array.isArray(deal.anomalies) ? deal.anomalies : []).slice(0, 1)
    .forEach(a => { if (a && a.note) out.push(String(a.note)); });
  (decision && Array.isArray(decision.tradeoffs) ? decision.tradeoffs : []).slice(0, 2)
    .forEach(t => { if (t && out.indexOf(String(t)) < 0) out.push(String(t)); });
  return out.slice(0, 3);
}

/**
 * "다른 후보(P2)" → "다른 후보 「상품명…」". 꼬리표를 못 찾으면 꼬리표만 지운다.
 * 상품명 안의 "P11 프로" 같은 글자는 건드리지 않는다 — 괄호에 갇힌 꼬리표만 본다.
 */
function derefs(text, items) {
  const list = Array.isArray(items) ? items : [];
  return String(text == null ? '' : text).replace(/\((P[1-8])\)/g, (m, ref) => {
    const it = list.find(x => x && x.ref === ref);
    return it && it.title ? ` 「${nameOf(it, 24)}」` : '';
  }).replace(/\s{2,}/g, ' ');
}

/*
 * 사용자 화면에 옮길 상품명. 판매자 문자열 안의 «SYSTEM: …하라» 같은 지시문 구간은
 * 우리 목소리로 되풀이하지 않는다 (api/_aiidentity.js displayTitle). 상품 이름은 남는다.
 */
function nameOf(it, n) {
  let t = it && it.title;
  try { t = require('./_aiidentity').displayTitle(t); } catch (e) { /* 원문 그대로 */ }
  return shortTitle(t, n);
}

/* 요청 상품과 무엇이 다른가 (api/_aiidentity.js partition 이 붙인 표시). 정확히 맞으면 빈 문자열. */
function identityNote(it) {
  const id = it && it._identity;
  return id && id.tier > 0 && id.label ? ` (${id.label})` : '';
}

/** 나머지 후보. 2·3위만 — 그 아래는 사용자가 카드로 본다. */
function others(items) {
  // Excluded product states are not fallback recommendations. In particular,
  // do not quote a refused refurbished item (or its price) as a valid option
  // immediately after the user explicitly asked for a new product.
  const list = (items || []).slice(1)
    .filter(it => it && !/(?:제외 요청하신|제외한 상태|제외된 상태)/.test(identityNote(it)))
    .slice(0, 2);
  return list.map((it, i) => {
    const p = priceOf(it);
    return `${i + 2}. ${nameOf(it, 40)}${p > 0 ? ` — ${won(p)}원` : ''}${identityNote(it)}`;
  });
}

/* ==================================================================
 *  3) 후속 질문
 *
 *  LLM 호출 0회. 지금 손에 든 계산 결과만 보고 "다음에 물어볼 값어치가
 *  있는 것" 을 고른다.
 *
 *  ★ 재촉하지 않는다 (지시 17항).
 *    "지금 사세요" · "곧 오릅니다" 같은 말은 여기에 넣지 않는다. 전부
 *    사용자가 더 잘 고르기 위해 물을 만한 질문이다.
 *  ★ 상품명을 지어서 넣지 않는다.
 *    긴 판매자 문자열을 잘라 넣으면 다음 턴의 검색어가 망가진다. 대신
 *    앞 대화를 가리키는 말("방금 추천한")로 쓴다 — 서버가 문맥으로 푼다.
 * ================================================================== */

const MAX_FOLLOWUPS = 4;

/**
 * @param {object} ctx { items, decision, deal, constraints, noResult }
 * @returns {string[]} 질문 문자열 (없으면 빈 배열)
 */
function followups(ctx) {
  const c = ctx || {};
  const items = Array.isArray(c.items) ? c.items : [];
  const out = [];
  const add = q => { if (q && out.indexOf(q) < 0 && out.length < MAX_FOLLOWUPS) out.push(q); };

  // 근거를 다시 묻는 것 — 이미 계산해 둔 결정 근거로 바로 답할 수 있다.
  if (c.decision) add('이거 왜 추천했어?');

  // 비교 — 후보가 둘 이상일 때만 뜻이 있다.
  if (items.length >= 2) add('방금 추천한 두 개 비교해줘');

  /*
   * 더 싼 것 — 1위보다 싼 후보가 실제로 있을 때만 묻는다.
   * 없는데 물으면 다음 턴이 "없습니다" 로 끝나 사용자 시간만 쓴다.
   */
  const topPrice = priceOf(items[0]);
  const cheaper = topPrice > 0 && items.slice(1).some(it => {
    const p = priceOf(it);
    return p > 0 && p < topPrice;
  });
  if (cheaper) add('더 싼 건 없어?');

  // 구매 시점 — 판정이 실제로 나와 있을 때만.
  if (c.deal && c.deal.verdict && c.deal.verdict !== 'UNKNOWN') add('지금 사는 게 좋을까?');

  // 조건을 못 맞췄으면 무엇을 풀면 되는지 (_noresult 가 이미 계산해 뒀다).
  if (c.noResult) add('조건을 조금 풀면 뭐가 나와?');

  // 예산을 말했으면 그 안에서 다시 좁힐 여지가 있다.
  if (c.constraints && c.constraints.budgetMax > 0) add('예산 안에서 가장 무난한 건?');

  return out;
}

/* ==================================================================
 *  4) 답변 조립
 * ================================================================== */

/**
 * 서버가 보증하지 못한 화면 상품에 대한 결정론 문장 (api/ai.js contextNoteBlock 과 짝).
 *
 * ★ 가격은 옵션 기록으로 확인된 과거 값만 말한다. "현재가"라고 부르지 않는다.
 * ★ 화면 표시명은 쓰지 않는다 — 브라우저가 보낸 문자열이다.
 */
function contextLines(ctx) {
  const c = ctx || {};
  const history = Array.isArray(c.historyOnly) ? c.historyOnly : [];
  const unverified = Array.isArray(c.unverified) ? c.unverified : [];
  const L = [];
  if (c.refMissing) {
    L.push('직전에 추천한 상품을 서버 기록으로 확인할 수 없어요.'
      + ' 어떤 상품인지 이름을 알려 주시면 그 상품으로 다시 확인해 드릴게요.');
  }
  history.forEach(it => {
    const h = it && it.hist;
    if (!h) return;
    L.push('보고 계신 상품의 이 옵션은 현재 판매가를 SEOSA 서버에서 확인하지 못했어요.');
    const facts = [];
    if (h.lastPrice > 0) facts.push(`최근 기록가 ${won(h.lastPrice)}원${h.lastDate ? `(${h.lastDate})` : ''}`);
    if (hasConfirmedRecordLow(h)) facts.push(`SEOSA 보유 관측 기록 중 확인된 최저가 ${won(h.low)}원${h.lowDate ? `(${h.lowDate})` : ''}`);
    if (h.count > 0) facts.push(`기록 ${h.count}일치`);
    if (facts.length) L.push(`SEOSA에 남은 이 옵션의 가격 기록: ${facts.join(' · ')}.`);
    L.push('지금 가격은 상품 페이지에서 확인해 주세요.');
  });
  if (unverified.length && !history.length) {
    L.push(c.fromRecommendation
      ? '직전에 추천한 상품을 SEOSA 서버 기록에서 다시 확인하지 못해, 지금 가격·구매 시점은 말씀드리기 어려워요.'
        + ' 상품 카드를 눌러 판매처에서 확인하시거나, 상품 이름으로 다시 물어봐 주세요.'
      : '지금 보고 계신 상품은 SEOSA 서버 기록에서 같은 상품·옵션을 확인하지 못해,'
        + ' 가격·할인·구매 시점은 말씀드리기 어려워요.');
  }
  return L;
}

const DEGRADED_HEAD = '지금은 AI 설명을 만들지 못했어요. 대신 서버가 계산한 결과를 그대로 알려 드릴게요.';
const DEGRADED_FOOT = '설명이 짧은 것은 AI 응답이 실패했기 때문이고, 위 숫자와 판정은 평소와 같은 계산입니다.';
const SAFETY_HEAD = '확인된 상품·가격 데이터만 기준으로 정리했어요.';

/**
 * SEOSA 데이터만으로 답변 본문을 만든다.
 *
 * @param {object} ctx
 *   items       랭킹된 상품 (0번이 1위)
 *   cards       화면에 함께 나갈 카드 (없으면 items 만으로 판단)
 *   decision    api/_decision.js decide() 결과
 *   deal        api/_deal.js dealOf() 결과
 *   constraints 사용자 조건
 *   noResult    api/_noresult.js analyze() 결과
 *   degraded    LLM 실패 뒤인가 (true 면 왜 짧은지 밝힌다)
 * @returns {{text:string, followups:string[]}}
 */
function compose(ctx) {
  const c = ctx || {};
  const identity = c.identity || {};
  /*
   * 다른 모델·형제 모델(SIBLING tier)은 조립본 답변 어디에도 나오지 않게 한다 (CO-04, 2026-10-23).
   *
   * api/ai.js 는 EXACT 상태에서 SIBLING 을 카드에서 빼지만, items[] 자체에는 랭킹·결정·pareto·프롬프트
   * 맥락을 위해 남겨 둔다. 이 조립본의 others() 는 items[1..3] 를 "다른 후보" 로 올리므로 그 자리에
   * G304 X 같은 다른 모델이 섞여 나왔다 ("G304 X SUPERLIGHT (요청하신 모델 계열(X)과 다름)").
   * 사용자가 보는 답변·카드·추천 1위가 하나같이 요청한 상품에만 머물도록, 조립본은 들어오자마자 좁힌다.
   *
   * ★ EXACT 상태에서만. NEAR 상태(정확한 후보가 없음)에서는 모든 근접 후보가 다른 모델이므로 그대로 둔다 —
   *   어차피 _concierge 가 "정확히 맞는 상품은 찾지 못했어요" 로 답한다.
   */
  const AIID = require('./_aiidentity');
  const rawItems = Array.isArray(c.items) ? c.items.filter(Boolean) : [];
  const items = identity.state === 'EXACT'
    ? rawItems.filter(it => !it._identity || it._identity.tier !== AIID.TIER.SIBLING)
    : rawItems;
  const cards = Array.isArray(c.cards) ? c.cards.filter(Boolean) : [];
  const top = items[0] || null;
  const L = [];
  const request = String(identity.label || '').trim();

  if (c.safety) { L.push(SAFETY_HEAD); L.push(''); }
  else if (c.degraded) { L.push(DEGRADED_HEAD); L.push(''); }

  /*
   * 상품이 바뀌어 앞 상품 전용 예산을 거뒀다 (api/_convstate.js budgetDropped, 2026-10-23 감사 CO-03).
   *
   * 모델 프롬프트에는 그 사실이 실리지만(api/ai.js P.budgetScopeChanged), 이 조립본이 답할 때는
   * 그 길로 닿지 않는다 — 실측(2026-10-23 실호출): "30만원 이하 노트북" 뒤 "청소기 추천" 에서
   * 예산은 올바르게 거뒀는데 조립본 답에는 그 말이 없었다. 조용히 넓히지 않는다는 것이 정책이므로
   * 머리에서 한 줄로 알린다. 새 예산을 우리가 정하지 않고, 같은 금액으로 맞출지만 묻는다.
   */
  if (c.budgetDropped && c.budgetDropped.budget > 0) {
    const from = String(c.budgetDropped.from || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    L.push(`앞서 말씀하신 예산 ${won(c.budgetDropped.budget)}원은${from ? ` 「${from}」` : ' 앞 상품'}의 예산으로 보아`
      + ' 이번 상품에는 적용하지 않았어요. 같은 금액으로 맞춰 드릴까요?');
    L.push('');
  }

  /*
   * 요청한 상품과 맞는 후보가 없을 때 (api/_aiidentity.js partition).
   *
   * ★ 다른 종류·다른 모델을 «추천» 으로 내보내지 않는다. 2026-10-12 live 레드팀에서
   *   "노트북 → 삼성으로" 에 갤럭시 버즈3, "무선 이어폰" 에 마우스, "아이패드 에어" 에
   *   아이폰 17 에어가 «추천: …» 으로 나갔다. 없으면 없다고 말하고, 근접 후보는
   *   무엇이 다른지와 함께만 보여 준다.
   */
  if (identity.state === 'NONE' || (identity.state === 'NEAR' && !top)) {
    L.push(request
      ? `「${request}」 조건에 맞는 상품을 이번 검색 결과에서 찾지 못했어요.`
      : '지금 조건에 맞는 상품을 찾지 못했어요.');
    L.push('다른 종류의 상품을 대신 권하지는 않을게요. 모델명이나 조건을 조금 바꿔서 다시 물어봐 주세요.');
    if (c.degraded && !c.safety) { L.push(''); L.push(DEGRADED_FOOT); }
    return { text: L.join('\n'), followups: [] };
  }
  if (identity.state === 'NEAR') {
    L.push(request
      ? `「${request}」 조건에 정확히 맞는 상품은 찾지 못했어요.`
      : '요청하신 조건에 정확히 맞는 상품은 찾지 못했어요.');
    L.push('가장 가까운 후보를 무엇이 다른지와 함께 보여 드릴게요.');
    L.push('');
    items.slice(0, 3).forEach((it, i) => {
      const p = priceOf(it);
      L.push(`${i + 1}. ${nameOf(it, 40)}${p > 0 ? ` — ${won(p)}원` : ''}${identityNote(it)}`);
    });
    if (c.degraded && !c.safety) { L.push(''); L.push(DEGRADED_FOOT); }
    return { text: L.join('\n'), followups: followups(Object.assign({}, c, { decision: null, deal: null })) };
  }

  if (!top) {
    /*
     * 화면 상품을 서버가 확인하지 못한 경우 (api/ai.js resolveContext).
     *
     * "조건에 맞는 상품을 찾지 못했어요" 는 틀린 말이다 — 사용자는 상품을 보고
     * 있고, 우리가 그 상품·옵션의 가격을 보증하지 못했을 뿐이다. 그 사실을 말한다.
     * 화면 표시명은 브라우저가 보낸 문자열이라 우리 목소리로 되풀이하지 않는다.
     */
    const notes = contextLines(c.context);
    if (notes.length) {
      notes.forEach(x => L.push(x));
      return { text: L.join('\n'), followups: followups(c) };
    }
    /*
     * 검색 자체를 못 했다 — «없다» 가 아니다 (2026-10-22 PR #179 Preview 실호출에서 발견).
     *
     * 쇼핑몰 조회가 실패하면 모델 프롬프트에는 "없다고 단정하지 마라"(P.searchFailed)가 실리는데, 후보가
     * 0개라 근거 검증이 모델 답을 버리고 아래 "조건에 맞는 상품을 찾지 못했어요" 로 바꿨다. 확인하지 못한 것을
     * 없다고 말한 셈이다. 검색 상태를 받아 실패와 «검색했는데 0건» 을 다르게 말한다.
     */
    if (!cards.length && c.search === 'failed') {
      L.push('지금은 쇼핑몰 상품 정보를 불러오지 못했어요. 조건에 맞는 상품이 없다는 뜻이 아니라, 이번에는 확인하지 못한 거예요.');
      L.push('확인되지 않은 상품이나 가격은 안내하지 않을게요. 잠시 후 다시 물어봐 주세요.');
      return { text: L.join('\n'), followups: [] };
    }
    if (!cards.length && c.search === 'empty') {
      L.push(request
        ? `방금 「${request}」 상품을 검색했지만 결과가 없었어요.`
        : '방금 검색했지만 결과가 없었어요.');
      L.push('다르게 부르는 이름이나 모델명이 있으면 알려 주세요. 다른 종류의 상품을 대신 권하지는 않을게요.');
      return { text: L.join('\n'), followups: [] };
    }
    /*
     * 상품이 없다. 있는 척하지 않는다.
     * 카드라도 있으면 그것만 가리킨다 (검색은 됐는데 랭킹에서 비었을 때).
     */
    L.push(cards.length
      ? '찾아온 상품만 아래에 보여 드립니다.'
      : '지금 조건에 맞는 상품을 찾지 못했어요.');
    if (c.degraded && !c.safety) { L.push(''); L.push(DEGRADED_FOOT); }
    return { text: L.join('\n'), followups: followups(c) };
  }

  const priceOnly = c.safety && !c.timingRequested;
  conclusion(top, c.deal, c.decision, { suppressTiming: priceOnly }).forEach(x => L.push(x));

  const why = reasons(top, c.decision);
  if (why.length) {
    L.push('');
    L.push('이유:');
    why.forEach(r => L.push(`- ${r}`));
  }

  // GPT 설명이 근거 검사에서 교체된 경우에도 노트북 추천을 가격 한 줄로 끝내지 않는다.
  // 검증하지 못한 CPU 성능·배터리를 좋다고 꾸미지 않고 실제 선택의 한계를 설명한다.
  if (c.safety && !c.timingRequested && LAPTOP_RE.test(String(top.title || ''))) {
    const family = laptopFamily(top.title);
    L.push('');
    L.push(`이건 지금 찾은 ${family} 후보 가운데 가격과 검색 조건을 기준으로 고른 상품이에요. 가격이 안정적이라는 사실만으로 성능까지 가장 좋은 노트북이라고 볼 수는 없어요.`);
    L.push('실제로 구매하기 전에는 CPU와 메모리가 작업에 충분한지, 중고·리퍼 등 제품 상태와 배터리·보증 조건이 어떤지 확인해야 해요.');
    const cons = c.constraints || {};
    if (!cons.budgetMax && !cons.useCase) {
      L.push(`아직 예산과 사용 목적을 듣지 못했어요. 학교 과제·문서 작업이 주목적인지, 영상 편집 같은 무거운 작업도 할지 알려주시면 다른 ${family} 모델과 함께 비교해드릴게요.`);
    }
  }

  L.push('');
  if (priceOnly) {
    // 상품 가격만 물은 사람에게 별도의 구매 권유를 하지 않는다.
    // 이 경우에도 마지막 가격 확인 시점은 반드시 드러낸다.
    const freshness = c.deal && c.deal.freshness && c.deal.freshness.label;
    if (freshness) L.push(`가격 확인 시점: ${freshness}`);
    L.push('위 금액은 검색 결과에 표시된 판매가이며 실제 결제 금액으로 확정된 값은 아니에요. 쿠폰·카드·회원 혜택과 배송비에 따라 달라질 수 있으니 결제 전에 판매처에서 확인해 주세요.');
    if (c.inventoryRequested) L.push('재고 보유 여부는 이 검색으로 확인하지 않았으니 판매처에서 함께 확인해 주세요.');
  } else {
    timing(c.deal).forEach(x => L.push(x));
  }

  const rest = others(items);
  if (rest.length) {
    L.push('');
    L.push('다른 후보:');
    rest.forEach(x => L.push(x));
  }

  /*
   * 내부 꼬리표(P2·P3)를 상품명으로 바꾼다.
   *
   * _decision 의 tradeoffs 는 프롬프트용이라 "다른 후보(P2)가 나은 점" 처럼
   * 꼬리표로 후보를 가리킨다. 모델은 그것을 상품명으로 옮기지만, 이 조립본은
   * 사용자에게 그대로 나간다 — 게스트 응답 실측(2026-09-02)에서 "(P2)" 가
   * 화면에 찍혔다. 사용자 화면에 P2 는 없다. 여기서 이름으로 되돌린다.
   */
  const warn = cautions(c.deal, c.decision).map(x => derefs(x, items));
  if (warn.length) {
    L.push('');
    L.push('주의:');
    warn.forEach(x => L.push(`- ${x}`));
  }

  /*
   * 사용자가 말한 조건을 우리가 지켰다고 밝힌다.
   * 조용히 반영하면 사용자는 자기 말이 먹혔는지 알 수 없어 같은 말을 다시 한다.
   *
   * ★ 사용자가 말한 금액(budgetSaid)을 적는다 (2026-10-22 Codex live 레드팀 BUG-01·03).
   *   예전에는 여유분이 섞인 내부 값(budgetMax)을 적어 "1만원" 이라고 한 사람에게 "말씀하신 예산
   *   11,000원" 이, 예산을 말한 적 없는 사람에게 "1,150,000원" 이 나갔다. 그리고 1위가 예산을
   *   넘는데도 "그대로 반영했습니다" 라고 했다. 반영했다는 말은 1위가 실제로 예산 안일 때만 한다.
   */
  if (c.constraints && c.constraints.budgetMax > 0) {
    const cons = c.constraints;
    const said = cons.budgetSaid || cons.budgetMax;
    const p = priceOf(top);
    // 같은 숫자를 «현재가» 로도 주장한 경우에는 금액을 되풀이하지 않는다 (_shopintent budgetQuoted 주석).
    const amount = cons.budgetQuoted ? '' : ` ${won(said)}원`;
    L.push('');
    if (p > 0 && p <= cons.budgetMax && (!cons.budgetMin || p >= cons.budgetMin)) {
      L.push(`말씀하신 예산${amount}은 그대로 반영했습니다.`);
    } else if (p > said && !cons.budgetQuoted) {
      L.push(`이 상품은 말씀하신 예산 ${won(said)}원보다 ${won(p - said)}원 비싸요.`);
    }
  }

  if (c.degraded && !c.safety) { L.push(''); L.push(DEGRADED_FOOT); }

  return { text: L.join('\n'), followups: followups(c) };
}

/* ==================================================================
 *  5) 품질 게이트 — 모델이 내부 블록을 그대로 베꼈는가
 *
 *  ── 왜 필요한가 (2026-08-30 무료 모델 실측) ────────────────────
 *
 *  프롬프트에는 코드가 계산한 결론이 블록으로 실린다. 힘 있는 모델은 그것을
 *  읽고 사람 말로 옮기는데, 작은 모델은 **그대로 베껴 낸다.** 실측 원문:
 *
 *    P1을 권합니다.
 *    결정적 이유: 검색어와 상품명이 일치하지 않음 / 30일 평균보다 3.5% 저렴
 *    포기하는 것: 다른 후보가 나은 점: 10,000원 더 저렴
 *    다른 기준이라면: 가격만 본다면 P3(현재가 279,000원…)
 *
 *  사실은 맞다. 그런데 이건 답변이 아니라 내부 계산 덤프다. "검색어와
 *  상품명이 일치하지 않음" 같은 우리 쪽 메모까지 사용자에게 나간다.
 *
 *  그럴 바에는 우리가 조립한 답이 낫다. compose() 는 같은 데이터에서
 *  같은 결론을 내되 사람이 읽는 글로 쓴다. 모델이 우리보다 잘 쓰지 못하면
 *  우리 글을 쓴다 — 그것이 무료 모델에서도 품질이 유지되는 방식이다.
 *
 *  ★ 보수적으로 판정한다. 라벨 하나가 우연히 스치는 것으로는 바꾸지 않는다.
 * ================================================================== */

/*
 * 프롬프트 블록에만 쓰이는 라벨. 답변에 그대로 나오면 베낀 것이다.
 *
 * ★ 고를 때 지킨 두 가지
 *   1) 서로 부분 문자열이 아니어야 한다. '판정:' 을 넣었더니 '가격 수준
 *      판정:' 한 줄이 둘로 세어져 라벨 하나짜리 답변이 덤프로 잡혔다.
 *   2) 이 파일의 compose() 가 쓰는 말이면 안 된다. 우리 조립본이 덤프로
 *      판정되면 대체가 무한히 돌거나 무의미해진다. ('조건 대조:' 는
 *      rankItems 가 붙이는 문구라 우리 "이유" 에도 그대로 나온다 — 뺐다)
 */
const BLOCK_LABELS = [
  '결정적 이유:', '1·2위 격차:', '추천 확신도:', '후회 위험:', '가격 기회:',
  '포기하는 것:', '다른 기준이라면:', '추천을 바꿀 수 있는 조건:',
  '가격 수준 판정:', '기록 내 위치:', '가격 최신성:', '이상 징후:'
];

/** 이 개수 이상 나오면 답변이 아니라 덤프로 본다. */
const BLOCK_DUMP_MIN = 2;

/**
 * @param {string} text 모델이 만든 답변 (ref·URL 정리가 끝난 것)
 * @returns {number} 발견한 내부 라벨 수 (BLOCK_DUMP_MIN 이상이면 덤프)
 */
function blockLabelCount(text) {
  const t = String(text == null ? '' : text);
  let n = 0;
  BLOCK_LABELS.forEach(l => { if (t.indexOf(l) > -1) n++; });
  return n;
}

function looksLikeBlockDump(text) {
  return blockLabelCount(text) >= BLOCK_DUMP_MIN;
}

/* ==================================================================
 *  6) "이거 왜 추천했어?" — 직전 추천 1위의 근거 (2026-10-09)
 *
 *  api/ai.js 가 직전 추천의 서명 참조(prevTopRef)로 그 상품·옵션만 다시 확인하고,
 *  같은 조건(대화 속 사용자 발화)으로 랭킹·결정·구매 시점 엔진을 다시 돌린 결과를
 *  넘긴다. 여기서는 그 결과에 실제로 있는 근거만 문장으로 옮긴다.
 *
 *  ★ 근거가 셋이면 셋만 말한다. 없는 근거를 채우지 않는다.
 *  ★ 대화 참조가 없는 것(refMissing)과 가격 확인이 안 된 것(top 없음)은 다른
 *    문제다. 앞의 것을 "같은 상품·옵션을 확인하지 못했다"고 말하지 않는다.
 * ================================================================== */

const REASON_REF_MISSING = '직전 추천 정보를 확인할 수 없어서 어떤 상품을 말씀하시는지 특정하기 어려워요.'
  + ' 상품명을 눌러주시거나 다시 말씀해 주세요.';
const REASON_PRICE_UNVERIFIED = '직전에 추천한 상품은 확인했지만, 지금 SEOSA 서버에서 그 상품·옵션의 현재 가격을'
  + ' 확인하지 못해 추천 근거를 다시 계산할 수 없어요. 가격은 상품 페이지에서 확인해 주세요.';

/** 마지막 글자의 받침으로 을/를. 한글이 아니면 둘 다 적는다. */
function eulReul(word) {
  const s = String(word || '').replace(/[…\s)\]」]+$/, '');
  const ch = s.charCodeAt(s.length - 1);
  if (!(ch >= 0xAC00 && ch <= 0xD7A3)) return '을(를)';
  return (ch - 0xAC00) % 28 ? '을' : '를';
}

/** 100000 → "10만원", 125000 → "125,000원" */
function budgetLabel(n) {
  const v = Math.round(Number(n) || 0);
  return v >= 10000 && v % 10000 === 0 ? `${v / 10000}만원` : `${won(v)}원`;
}

/** _deal 의 평서문("…낮다", "…가격이다")을 답변 말투로. 숫자는 건드리지 않는다. */
function politeFact(s) {
  const t = String(s == null ? '' : s).trim().replace(/[.。]$/, '');
  if (!t) return '';
  if (/이다$/.test(t)) return t.replace(/이다$/, '입니다.');
  if (/않는다$/.test(t)) return t.replace(/않는다$/, '않습니다.');
  if (/했다$/.test(t)) return t.replace(/했다$/, '했습니다.');
  if (/렸다$/.test(t)) return t.replace(/렸다$/, '렸습니다.');
  if (/랐다$/.test(t)) return t.replace(/랐다$/, '랐습니다.');
  if (/하다$/.test(t)) return t.replace(/하다$/, '합니다.');
  if (/다$/.test(t)) return t.replace(/다$/, '습니다.');
  return `${t}.`;
}

/*
 * 노트북 계열 — 조립본이 «그램 후보 가운데» 처럼 말할 때 실제 상품 계열을 쓴다.
 * 예전에는 맥북·씽크패드에도 "그램" 이라고 적었다 (2026-10-24 PR #186 후속 점검).
 */
const LAPTOP_RE = /노트북|그램|맥북|laptop|thinkpad|vivobook|macbook|씽크패드|갤럭시\s?북/i;
function laptopFamily(title) {
  const t = String(title || '');
  if (/그램|\bgram\b/i.test(t)) return '그램';
  if (/맥북|macbook/i.test(t)) return '맥북';
  if (/갤럭시\s?북/i.test(t)) return '갤럭시북';
  if (/씽크패드|thinkpad/i.test(t)) return '씽크패드';
  return '노트북';
}

/**
 * 구매 시점을 물었을 때 답 맨 앞에 두는 서버 결론 (api/ai.js — GPT 설명을 살린 답에만 붙는다).
 *
 * 모델의 «지금 사도 괜찮아요» 는 근거 검사에서 빠진다(같은 결론처럼 보여도 강도·부정어가 달라질 수 있다).
 * 결론은 _deal 판정 그대로, 근거 한 줄은 _deal 의 첫 문장 그대로다. 판정이 없으면 판단하지 않는다고 말한다.
 *
 * @param {{top:object, deal:object|null, named?:boolean}} ctx  named — 답 본문에 상품 이름이 없어 여기서 밝힌다
 * @returns {string}
 */
function timingLead(ctx) {
  const c = ctx || {};
  const top = c.top || null;
  if (!top) return '';
  const p = priceOf(top);
  const deal = c.deal || null;
  const who = c.named ? `${nameOf(top, 40)}의 ` : '';
  const head = p > 0 ? `서사가 확인한 ${who}판매가 ${won(p)}원 기준으로 보면, ` : '';
  if (!deal || !deal.verdict || deal.verdict === 'UNKNOWN') {
    return `${head}가격 기록이 아직 충분하지 않아서 지금이 특별히 좋은 때인지는 판단하기 어려워요.`;
  }
  const stance = deal.verdict === 'NORMAL'
    ? '지금 가격은 평범한 수준이에요. 꼭 서두를 이유도, 기다리면 반드시 싸진다고 볼 근거도 없어요.'
    : STANCE[deal.verdict];
  if (!stance) return '';
  const fact = Array.isArray(deal.reasons) && deal.reasons[0] ? politeFact(deal.reasons[0]) : '';
  const stale = deal.freshness && deal.freshness.level === 'stale' && deal.freshness.label
    ? ` 다만 ${deal.freshness.label} 기준이라 결제 전에 판매처 금액을 꼭 다시 확인해 주세요.` : '';
  return `${head}${stance}${fact ? ` ${fact}` : ''}${stale}`;
}

/** GPT 설명에서 추천 상품의 이름이 빠졌을 때 앞에 두는 한 줄 (api/ai.js). 금액은 서버가 확인한 판매가. */
function pickLine(top) {
  if (!top || !top.title) return '';
  const p = priceOf(top);
  return `서사가 고른 상품은 ${nameOf(top, 46)}${p > 0 ? `(${won(p)}원)` : ''}이에요.`;
}

/** 직전 추천 한 상품을 두고 이어 묻는 턴에서 같은 경우 — 무엇에 대한 답인지 먼저 밝힌다. */
function subjectLine(top) {
  if (!top || !top.title) return '';
  return `앞에서 추천한 ${nameOf(top, 46)} 기준으로 말씀드릴게요.`;
}

/** 근거 없는 금액 문장을 덜어냈을 때 붙이는 확인된 판매가 한 줄 (api/ai.js). 가격을 모르면 빈 문자열. */
function verifiedPriceLine(top) {
  const p = priceOf(top);
  if (!top || p <= 0) return '';
  const mall = String(top.mallLabel || top.mall || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return `서사가 확인한 ${nameOf(top, 40)}의 판매가는 ${won(p)}원${mall ? `(${mall})` : ''}이에요.`;
}

/*
 * 방금 물은 것을 다음 질문 칩으로 다시 권하지 않는다 (2026-10-24).
 * "이거 왜 추천했어?" 에 답하고 나서 또 "이거 왜 추천했어?" 칩을 띄우면 대화가 제자리를 돈다.
 */
function withoutAsked(list, asked) {
  const a = asked || {};
  return (Array.isArray(list) ? list : []).filter(q => !(a.reason && /왜\s*추천/.test(q))
    && !(a.timing && /지금\s*사는\s*게/.test(q)));
}

/**
 * 서명된 직전 추천으로 확인한 상품의 구매시점 대화 답변.
 * LLM이 다른 판매처/옵션 가격을 섞어 말하면 이 검증된 계산 결과를 자연스럽게 전달한다.
 */
function conversationalTiming(ctx) {
  const c = ctx || {};
  const top = c.top || null;
  if (!top) return { text: REASON_PRICE_UNVERIFIED };
  const name = shortTitle(top.title || '상품', 42);
  const p = priceOf(top);
  const deal = c.deal || null;
  const L = [`앞에서 추천했던 ${name} 말씀하시는 거죠?`];
  if (p > 0) L.push(`서사가 확인한 해당 상품·옵션의 판매가는 ${won(p)}원이에요.`);
  else L.push('지금은 이 상품·옵션의 판매가를 새로 확인하지 못해서 가격 수준을 단정하기 어려워요.');
  if (p > 0 && deal && deal.verdict && deal.verdict !== 'UNKNOWN') {
    const stance = deal.verdict === 'NORMAL'
      ? '가격 기록만으로 보면 지금 꼭 서둘러 살 만큼 특별히 싼 구간은 아니에요. 그렇다고 기다리면 반드시 더 싸진다고 볼 근거도 없어요.'
      : STANCE[deal.verdict];
    if (stance) L.push(stance);
    if (Array.isArray(deal.reasons)) deal.reasons.slice(0, 2).forEach(r => {
      const fact = politeFact(r);
      if (fact) L.push(fact);
    });
  } else {
    L.push('가격 기록이 충분하지 않거나 마지막 확인 시점이 오래돼서, 지금 구매가 유리한지 확실하게 판단하기 어려워요.');
  }
  if (deal && deal.freshness && deal.freshness.label) {
    L.push(`가격 확인 기준은 ${deal.freshness.label}입니다. 판매처에서 결제 전 금액을 다시 확인해 주세요.`);
  }
  if (LAPTOP_RE.test(String(top.title || ''))) {
    L.push('다만 노트북은 가격만으로 판단하기 어려워요. 사용 목적에 비해 CPU와 메모리가 충분한지, 배터리와 제품 상태가 어떤지도 확인해야 해요.');
    const cons = c.constraints || {};
    if (!cons.useCase && !cons.budgetMax) L.push('학교 과제나 문서 작업용인지, 영상 편집처럼 무거운 작업도 할 건지 알려주시면 지금 사는 편이 나을지 더 정확하게 비교해드릴게요.');
  }
  return { text: L.join('\n') };
}

/**
 * @param {object} ctx
 *   refMissing   서명된 직전 추천 참조가 없음·변조·만료
 *   top          서버가 그 참조로 다시 확인한 상품 (가격 확인 실패면 null)
 *   decision     api/_decision.js decide() — top 기준
 *   deal         api/_deal.js dealOf() — top 기준
 *   constraints  대화에서 모은 사용자 조건
 * @returns {{text:string, reasonCount:number}}
 */
function recommendationReason(ctx) {
  const c = ctx || {};
  if (c.refMissing) return { text: REASON_REF_MISSING, reasonCount: 0 };
  const top = c.top || null;
  if (!top) return { text: REASON_PRICE_UNVERIFIED, reasonCount: 0 };

  const name = shortTitle(top.title, 40);
  const price = priceOf(top);
  const cons = c.constraints || {};
  const fit = [];      // 조건 적합 — 사용자가 말한 조건과 상품의 대조
  const priceFacts = [];
  const notes = [];    // 권하기 어려운 사정 (있으면 숨기지 않는다)

  if (cons.budgetMax > 0 && price > 0) {
    if (price <= cons.budgetMax) fit.push(`예산 ${budgetLabel(cons.budgetMax)} 이하에 들어옵니다.`);
    else notes.push(`예산 ${budgetLabel(cons.budgetMax)}보다 ${won(price - cons.budgetMax)}원 비쌉니다.`);
  }
  if (cons.budgetMin > 0 && price >= cons.budgetMin) fit.push(`예산 하한 ${budgetLabel(cons.budgetMin)} 이상입니다.`);
  const hit = Array.isArray(top.featureHit) ? top.featureHit.filter(Boolean) : [];
  if (hit.length) fit.push(`요청하신 ${hit.join('·')} 조건에 맞습니다(상품명 기준).`);
  if (cons.brand && String(top.title || '').toLowerCase().includes(String(cons.brand).toLowerCase())) {
    fit.push(`말씀하신 ${cons.brand} 제품입니다.`);
  }

  const deal = c.deal || null;
  const dealReasons = deal && deal.verdict !== 'UNKNOWN' && Array.isArray(deal.reasons) ? deal.reasons : [];
  /*
   * 30일 평균 대비 — 랭킹(_shopintent scoreItem)이 «가격 가치»로 점수를 준 그 축이다.
   * _deal 문장에 같은 비교가 이미 있으면 두 번 말하지 않는다. 판정이 UNKNOWN(기록 멈춤)
   * 이면 평균도 지금 시점의 근거가 아니므로 쓰지 않는다.
   */
  const h = top.hist || null;
  if (dealReasons.length && h && h.avg30 > 0 && price > 0 && !dealReasons.some(r => /30일 평균/.test(r))) {
    const pct = Math.round((1 - price / h.avg30) * 1000) / 10;
    if (pct >= 3) priceFacts.push(`30일 평균 ${won(h.avg30)}원보다 ${pct}% 저렴합니다.`);
  }
  dealReasons.slice(0, 3).forEach(r => {
    const s = politeFact(r);
    if (s && priceFacts.indexOf(s) < 0) priceFacts.push(s);
  });
  if (priceFacts.length && price > 0) priceFacts[0] = `현재 ${won(price)}원으로 ${priceFacts[0]}`;
  const priceGood = !!(deal && (deal.verdict === 'BUY' || deal.verdict === 'GOOD_BUY'));

  const level = c.decision && c.decision.recommendation;
  let why;
  if (fit.length && priceFacts.length && priceGood) why = '조건과 가격 기록이 둘 다 좋았기 때문이에요';
  else if (fit.length && !priceFacts.length) why = '말씀하신 조건에 맞았기 때문이에요';
  else if (!fit.length && priceGood) why = '가격 기록상 지금 값이 좋았기 때문이에요';
  else if (fit.length || priceFacts.length) why = '아래 근거를 함께 따졌기 때문이에요';
  else why = '';

  const L = [];
  if (why) L.push(`${name}${eulReul(name)} 추천한 이유는 ${why}.`);
  else L.push(`${name}${eulReul(name)} 1순위로 고른 근거를 다시 확인했지만, 조건이나 가격 기록에서 내세울 만한 근거는 확인되지 않았어요.`);
  fit.concat(priceFacts).concat(notes).forEach(r => L.push(`- ${r}`));
  if (!priceFacts.length) L.push('- 가격 기록이 충분하지 않아 가격 시점은 근거로 쓰지 않았습니다.');

  if (level === 'weak') L.push('다만 후보 중 가장 가까웠을 뿐, 자신 있게 권하기는 어려운 상태였어요.');
  else if (fit.length && priceGood) L.push('그래서 후보 중 조건 적합도와 가격 시점을 함께 따져 1순위로 추천했습니다.');
  else if (fit.length || priceFacts.length) L.push('그래서 후보 중 이 상품을 1순위로 추천했습니다.');

  // 가격이 안정적이라는 사실만으로 성능까지 좋은 노트북이라고 단정하면 안 된다.
  // 사용자가 처음 물은 '왜?'에 가격 근거와 성능·용도 평가의 한계를 함께 풀어 설명한다.
  if (LAPTOP_RE.test(String(top.title || ''))) {
    L.push('');
    L.push('여기서 중요한 점은 가격이 안정적이라는 것과 좋은 노트북이라는 것은 다르다는 거예요. 성능, 메모리, 실제 제품 상태, 배터리, 보증 조건까지 확인해야 최종 구매를 권할 수 있어요.');
    if (!cons.budgetMax && !cons.useCase && !cons.priority) {
      L.push(`아직 예산과 사용 목적을 듣지 못했기 때문에 이 모델이 여러 ${laptopFamily(top.title)} 중 가장 잘 맞는 선택이라고 확정할 수는 없어요.`);
      L.push('문서 작업이나 학교 공부용인지, 영상 편집 같은 무거운 작업도 할지 알려주시면 그 조건으로 다른 모델과 비교해드릴게요.');
    }
  } else if (!fit.length && priceFacts.length) {
    L.push('');
    L.push('이 추천은 주로 확인된 가격 기록을 근거로 한 것이고, 사용 목적에 맞는 성능까지 검증한 결과는 아니에요. 사용 목적과 예산을 알려주시면 후보를 다시 비교해드릴게요.');
  }

  return { text: L.join('\n'), reasonCount: fit.length + priceFacts.length };
}

/* ==================================================================
 *  7) 예산 안의 후보가 없을 때 · 조건이 서로 맞지 않을 때 (2026-10-22 Codex live 레드팀)
 *
 *  BUG-01 — 후보가 전부 예산을 넘으면 1위가 곧 초과 상품이었다(1만원 예산 → 19,999,000원 노트북).
 *  BUG-03 — "100만원짜리 제품인데 가격이 500원인 것만" 에 말한 적 없는 예산 1,150,000원을 만들고
 *           무관한 책을 권했다.
 *
 *  ★ 둘 다 모델을 부르지 않고 서버가 아는 사실만 말한다. 다른 상품·다른 예산으로 몰래 바꾸지 않고,
 *    무엇을 바꾸면 되는지는 사용자가 정하게 한다.
 * ================================================================== */

/** 예산 범위를 사용자가 말한 금액으로. "3만원 이하" · "10만원 안팎" · "20만~30만원" · "5만원 이상" */
function budgetRangeLabel(cons) {
  const c = cons || {};
  const said = c.budgetSaid || c.budgetMax || c.budgetMin;
  if (c.budgetMin && c.budgetMax && c.budgetMin !== c.budgetMax) {
    return `${budgetLabel(c.budgetMin)}~${budgetLabel(c.budgetMax)}`;
  }
  if (c.budgetMax) return `${budgetLabel(said)}${c.budgetSoft ? ' 안팎' : ' 이하'}`;
  if (c.budgetMin) return `${budgetLabel(c.budgetMin)} 이상`;
  return '';
}

/**
 * @param {object} ctx
 *   constraints  사용자 조건 (예산이 있어야 한다)
 *   label        찾은 상품 구절 (api/_aiidentity requestLabel) — 없으면 생략
 *   outside      예산을 벗어나 걸러진 후보 (가장 싼 가격만 사실로 말한다)
 * @returns {{text:string, followups:string[]}}
 */
function budgetNoMatch(ctx) {
  const c = ctx || {};
  const cons = c.constraints || {};
  const range = budgetRangeLabel(cons);
  const label = String(c.label || '').trim();
  const L = [];
  L.push(label
    ? `「${label}」 중에서 ${range}인 상품은 이번 검색 결과에 없었어요.`
    : `${range}인 상품은 이번 검색 결과에 없었어요.`);
  const prices = (Array.isArray(c.outside) ? c.outside : []).map(priceOf).filter(p => p > 0);
  if (prices.length && cons.budgetMax) {
    const cheapest = Math.min.apply(null, prices);
    if (cheapest > cons.budgetMax) {
      const said = cons.budgetSaid || cons.budgetMax;
      L.push(`이번에 확인한 후보 중 가장 싼 것도 ${won(cheapest)}원이라, 말씀하신 ${budgetLabel(said)}보다 ${won(cheapest - said)}원 비싸요.`);
    }
  }
  /*
   * 무엇을 바꾸면 몇 개가 생기는지 (api/_noresult relaxations — 이번 검색 결과로 코드가 직접 센 값).
   * 조건을 우리가 바꾸지는 않는다. 선택지를 알리고 고르는 것은 사용자다.
   */
  const opts = (Array.isArray(c.options) ? c.options : []).filter(o => o && o.label && o.total > 0).slice(0, 2);
  if (opts.length) {
    L.push('조건을 바꾸면 이렇게 돼요 (이번 검색 결과에서 직접 센 개수예요):');
    opts.forEach(o => L.push(`- ${o.label} ${o.total}개`));
  }
  L.push('예산을 넘는 상품이나 다른 종류의 상품을 대신 권하지는 않을게요.');
  L.push('예산을 바꾸셔도 괜찮다면 금액을 알려 주세요. 그 금액으로 다시 찾아 드릴게요.');
  return { text: L.join('\n'), followups: [] };
}

/**
 * 금액끼리 모순인 요청 (api/_shopintent findConflict) — 검색 없이 무엇이 맞는지 되묻는다.
 * @param {object} conflict {kind, value?, price?, budget?, target?}
 * @param {string} [label] 상품 구절
 * @returns {{text:string, followups:string[]}}
 */
function constraintConflict(conflict, label) {
  const k = conflict || {};
  const what = String(label || '').trim();
  // 조사는 받침으로 고른다 ("상품을" · "노트북을") — "상품을(를)" 처럼 둘 다 적지 않는다.
  const noun = what || '상품';
  const er = eulReul(noun);
  const obj = `${noun}${er}`;
  const topic = `${noun}${er === '을' ? '은' : er === '를' ? '는' : '은(는)'}`;
  const L = [];
  if (k.kind === 'price-below-value') {
    L.push(`말씀하신 조건이 서로 맞지 않아요. ${budgetLabel(k.value)}짜리 ${obj} ${won(k.price)}원에 찾으시는 것으로 읽혔어요.`);
    L.push(`그 가격에 팔리는 것으로 확인된 상품이 아니면 지어내지 않을게요. 예산도 따로 정하지 않았어요.`);
    L.push('어느 쪽이 맞는지 알려 주세요.');
    L.push(`- 쓰실 수 있는 예산이 ${won(k.price)}원인가요, ${budgetLabel(k.value)}인가요?`);
    L.push('- 찾으시는 상품 이름이나 종류가 있으면 함께 알려 주세요.');
  } else if (k.kind === 'implausible-price') {
    L.push(`${won(k.price)}원에 파는 ${topic} 실제 판매가로 확인할 수 없어, 그런 가격을 지어내지 않을게요.`);
    L.push('그 조건 그대로라면 결과는 «없음» 이에요. 실제로 쓰실 수 있는 예산을 알려 주시면 그 안에서 확인된 가격으로만 찾아 드릴게요.');
  } else if (k.kind === 'budget-too-low') {
    L.push(`${won(k.budget)}원 예산으로 살 수 있는 ${topic} 찾을 수 없어요.`);
    L.push('다른 상품이나 더 비싼 상품을 대신 권하지는 않을게요. 쓰실 수 있는 예산을 알려 주시면 그 안에서 찾아 드릴게요.');
  } else if (k.kind === 'budget-below-target') {
    L.push(`예산 ${budgetLabel(k.budget)}으로 ${budgetLabel(k.target)}짜리 ${obj} 찾으시는 건 조건이 서로 맞지 않아요.`);
    L.push(`예산(${budgetLabel(k.budget)})과 찾으시는 가격대(${budgetLabel(k.target)}) 중 어느 쪽을 기준으로 할까요?`);
    L.push('상품 이름도 함께 알려 주시면 확인된 가격으로만 보여 드릴게요.');
  } else {
    L.push('말씀하신 조건이 서로 맞지 않아 어느 쪽을 기준으로 찾을지 정하지 못했어요. 예산과 찾으시는 상품을 다시 알려 주세요.');
  }
  return { text: L.join('\n'), followups: [] };
}

module.exports = {
  budgetNoMatch, constraintConflict, budgetRangeLabel,
  recommendationReason, conversationalTiming, REASON_REF_MISSING, REASON_PRICE_UNVERIFIED, politeFact, budgetLabel,
  timingLead, verifiedPriceLine, withoutAsked, laptopFamily, pickLine, subjectLine,
  compose, followups, looksLikeBlockDump, blockLabelCount,
  BLOCK_LABELS, BLOCK_DUMP_MIN,
  // 테스트·다른 모듈이 같은 문구를 쓰도록 노출한다 (문구가 두 벌이 되면 어긋난다)
  conclusion, reasons, timing, cautions, others, hedgeFor, shortTitle, won, derefs, contextLines,
  STANCE, MAX_FOLLOWUPS, DEGRADED_HEAD, DEGRADED_FOOT, SAFETY_HEAD
};
