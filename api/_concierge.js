'use strict';
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
function conclusion(top, deal, decision) {
  const L = [];
  if (!top) return L;

  const conf = (decision && decision.confidence && decision.confidence.confidence) || 'low';
  const hedge = hedgeFor(conf);
  const name = shortTitle(top.title, 46);
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
  if (stance) L.push(stance);
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
const NEGATIVE_REASON = /(않음|않습니다|없음|없습니다|어려움|어렵|불가|미확인|확인 안 됨|초과)/;

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

/** 나머지 후보. 2·3위만 — 그 아래는 사용자가 카드로 본다. */
function others(items) {
  const list = (items || []).slice(1, 3).filter(Boolean);
  return list.map((it, i) => {
    const p = priceOf(it);
    return `${i + 2}. ${shortTitle(it.title, 40)}${p > 0 ? ` — ${won(p)}원` : ''}`;
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

const DEGRADED_HEAD = '지금은 AI 설명을 만들지 못했어요. 대신 서버가 계산한 결과를 그대로 알려 드릴게요.';
const DEGRADED_FOOT = '설명이 짧은 것은 AI 응답이 실패했기 때문이고, 위 숫자와 판정은 평소와 같은 계산입니다.';

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
  const items = Array.isArray(c.items) ? c.items.filter(Boolean) : [];
  const cards = Array.isArray(c.cards) ? c.cards.filter(Boolean) : [];
  const top = items[0] || null;
  const L = [];

  if (c.degraded) { L.push(DEGRADED_HEAD); L.push(''); }

  if (!top) {
    /*
     * 상품이 없다. 있는 척하지 않는다.
     * 카드라도 있으면 그것만 가리킨다 (검색은 됐는데 랭킹에서 비었을 때).
     */
    L.push(cards.length
      ? '찾아온 상품만 아래에 보여 드립니다.'
      : '지금 조건에 맞는 상품을 찾지 못했어요.');
    if (c.degraded) { L.push(''); L.push(DEGRADED_FOOT); }
    return { text: L.join('\n'), followups: followups(c) };
  }

  conclusion(top, c.deal, c.decision).forEach(x => L.push(x));

  const why = reasons(top, c.decision);
  if (why.length) {
    L.push('');
    L.push('이유:');
    why.forEach(r => L.push(`- ${r}`));
  }

  L.push('');
  timing(c.deal).forEach(x => L.push(x));

  const rest = others(items);
  if (rest.length) {
    L.push('');
    L.push('다른 후보:');
    rest.forEach(x => L.push(x));
  }

  const warn = cautions(c.deal, c.decision);
  if (warn.length) {
    L.push('');
    L.push('주의:');
    warn.forEach(x => L.push(`- ${x}`));
  }

  /*
   * 사용자가 말한 조건을 우리가 지켰다고 밝힌다.
   * 조용히 반영하면 사용자는 자기 말이 먹혔는지 알 수 없어 같은 말을 다시 한다.
   */
  if (c.constraints && c.constraints.budgetMax > 0) {
    L.push('');
    L.push(`말씀하신 예산 ${won(c.constraints.budgetMax)}원은 그대로 반영했습니다.`);
  }

  if (c.degraded) { L.push(''); L.push(DEGRADED_FOOT); }

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

module.exports = {
  compose, followups, looksLikeBlockDump, blockLabelCount,
  BLOCK_LABELS, BLOCK_DUMP_MIN,
  // 테스트·다른 모듈이 같은 문구를 쓰도록 노출한다 (문구가 두 벌이 되면 어긋난다)
  conclusion, reasons, timing, cautions, others, hedgeFor, shortTitle, won,
  STANCE, MAX_FOLLOWUPS, DEGRADED_HEAD, DEGRADED_FOOT
};
