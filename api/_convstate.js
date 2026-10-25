'use strict';
/*
 * 긴 대화의 조건 — 서명 상태(convState)를 펼치고 다시 접는 곳.
 *
 * ── 왜 생겼나 (2026-10-22 Codex live 레드팀 LONG 세션) ─────────────────
 *
 * 웹(public/index.html CONST.LIMIT.CHAT_HISTORY)과 앱(apps/mobile/lib/ai.ts MAX_HISTORY)은 대화를
 * 10개(사용자 5턴)만 보낸다. 서버는 그 안의 사용자 발화로 조건을 다시 모으고(api/ai.js constraints),
 * 찾던 상품도 그 안에서 찾는다(api/_intent.js conversationProduct). 그래서
 *
 *   [1]  "30만원 이하 노트북 추천해줘. 중고는 제외해."
 *   …    (12턴)
 *   [13] "그중에 제일 싼 거"
 *
 * 의 [13] 에는 예산도, 중고 제외도, 노트북도 남아 있지 않았다. 30턴 뒤 "30만원 예산" 을 잊은
 * 운영 재현이 이것이다.
 *
 * ── 어떻게 ────────────────────────────────────────────────────────
 *
 * 서버가 응답마다 «지금까지의 조건» 을 접어 서명해 내려보내고(api/_aicontext.js
 * createConversationState), 프론트는 받은 그대로 다음 요청에 돌려준다. 다음 요청에서 서명이 맞으면
 * 그 상태가 대화 기록보다 앞선 기본값이고, 그 뒤의 발화가 덮어쓴다.
 *
 *   product              찾던 상품 구절 (conversationProduct 와 같은 규칙으로 누적한 것)
 *   constraints          예산·받는 사람·우선순위 (_shopintent parseConstraints → mergeConstraints)
 *   excludedConditions   빼 달라고 한 상태 — 중고·리퍼·렌탈… (_aiidentity buildContract 와 같은 판정)
 *   absorbed             이미 접어 넣은 사용자 발화의 지문
 *
 * ★ absorbed 가 있는 이유 — 상태는 «지난 응답까지의 전부» 다. 대화 기록 10개 안에는 이미 접힌
 *   발화가 그대로 남아 있어서, 그것을 상태 위에 한 번 더 겹치면 같은 말을 두 번 들은 것이 된다.
 *   "조금 넘어도 괜찮아" 는 겹칠 때마다 상한이 1.3배씩 커진다. 그래서 접힌 발화의 지문을 함께
 *   서명해 두고, 다음 요청에서는 «마지막으로 접힌 발화 뒤의, 아직 안 접힌 발화» 만 겹친다
 *   (응답을 못 받은 질문이 여기에 해당한다 — 웹은 질문을 먼저 기록에 넣는다).
 * ★ 조건은 정규식으로만 뽑는다. LLM 이 뽑은 용도·브랜드(cls.extra)는 그 턴에만 쓰고 싣지 않는다 —
 *   서명은 «서버가 사용자 말에서 결정적으로 뽑은 값» 만 보증한다.
 * ★ 상태가 없거나 서명이 틀리면 예전과 똑같이 동작한다(옛 프론트·변조·만료). api/ai.js 는
 *   carried 일 때만 상태를 쓴다.
 * ★ 상태는 조건을 «잊지 않게» 할 뿐 넓히지 않는다. 새 상품의 가격만 묻는 말에 옛 예산을 거는지는
 *   여전히 api/ai.js 의 판단이다 — 상태의 예산은 이번 발화의 예산이 아니다.
 */

const crypto = require('crypto');
const { parseConstraints, mergeConstraints, constraintLine } = require('./_shopintent');

/** 상태가 기억하는 접힌 발화 수. 프론트가 보내는 사용자 발화(최대 10개 중)보다 넉넉하다. */
const MAX_ABSORBED = 8;
/** 상태 뒤에 겹칠 아직 안 접힌 발화의 상한 (프론트 기록 10개 안의 사용자 발화). */
const MAX_REPLAY = 8;
/** 지문 길이(바이트). 9바이트 → base64url 12자. 대화 안에서 우연히 겹칠 일이 없으면 충분하다. */
const DIGEST_BYTES = 9;
/** api/ai.js MAX_QUESTION_LEN 과 같다 — 질문과 기록의 같은 발화가 같은 지문이 되게 한다. */
const TEXT_LEN = 500;

/*
 * 예산을 «거둔다» 는 말 — "예산 상관없어" · "가격은 신경 쓰지 마".
 *
 * 상태가 생기기 전에는 예산이 3턴 뒤 기록 창 밖으로 밀려나며 저절로 사라졌다. 이제는 사용자가
 * 바꿔 말할 때까지 남는다. 그러니 거두는 말도 들어야 한다 — 그렇지 않으면 "예산 상관없어" 라고
 * 한 뒤에도 대화가 끝날 때까지 옛 상한이 걸린다.
 * ★ 좁게 잡는다. "예산 조건 빼지 마" · "예산은 꼭 지켜" 는 거두는 말이 아니다.
 */
const BUDGET_RELEASE_RE = /(?:예산|가격|금액)\s*(?:은|는|이|도|을|를)?\s*(?:(?:조건|제한)\s*(?:은|을)?\s*)?(?:상관\s*(?:없|않|안\s*해)|무관|신경\s*(?:안\s*써|쓰지\s*(?:마|않))|제한\s*(?:없|두지\s*(?:마|않))|(?:빼|지워|없애)(?:줘|주세요|도\s*돼|도\s*괜찮)|취소(?!\s*하지)|해제(?!\s*하지))/;

/*
 * 예산의 «범위» — 이 예산이 그 상품의 예산인가, 앞으로 찾는 모든 상품의 예산인가.
 *
 * ── 왜 생겼나 (2026-10-23 Codex 감사 CO-03) ───────────────────────
 *
 *   [1]  "30만원 이하 노트북 추천해줘."
 *   …    (상품 얘기가 없는 20턴)
 *   [21] "청소기 추천해줘."
 *
 * 상태가 생기기 전에는 [1] 의 예산이 기록 창 밖으로 밀려나며 사라졌다. 이제는 남는다 —
 * 그래서 [21] 의 청소기에 노트북 예산 30만원이 걸렸다. 사용자는 노트북 예산을 말했을 뿐
 * 청소기 예산을 말한 적이 없다.
 *
 * 그래서 예산을 접을 때 그 예산이 «어느 상품의 말이었는지»(budgetProduct)와 사용자가
 * «모든 상품» 이라고 말했는지(budgetScope)를 함께 서명해 둔다. 찾는 상품이 아주 다른
 * 것으로 바뀌고 이번 발화에 새 예산이 없으면 상품 전용 예산은 거둔다(dropped). 그때
 * api/ai.js 는 옛 상한 없이 찾고, 짧게 한 줄로 그 사실을 알린다 — 조용히 넓히지 않는다.
 *
 * ★ 전용/전역 구분만 한다. 사용자가 바꿔 말한 예산, 거두는 말("예산 상관없어")은 먼저 반영된다.
 * ★ 빼 달라고 한 상태(중고·리퍼)는 거두지 않는다 — 상품이 바뀌어도 "중고는 싫다" 는 그대로
 *   사실이고, 지우면 사용자가 싫다고 한 것을 다시 권하게 된다(넓히는 쪽의 실수).
 */
const GLOBAL_BUDGET_RE = /(모든\s*(?:상품|제품|물건|것|거)|어떤\s*(?:상품|제품|것|거)\s*(?:이?든)|뭐(?:든지|든)|무엇이?든|상품\s*(?:상관|관계)\s*없|앞으로\s*(?:는|도)?\s*(?:계속|쭉|전부|모두|다)|전부\s*(?:다\s*)?(?:같|동일))/;

/** 상품 구절의 낱말 — 두 글자 이상이고 숫자만은 아닌 것. */
function productTokens(text) {
  return String(text || '').normalize('NFKC').toLowerCase()
    .replace(/[^0-9a-z가-힣]+/g, ' ').split(' ')
    .filter(t => t.length >= 2 && /[^0-9]/.test(t));
}

/**
 * 두 상품 구절이 «같은 상품을 이어 찾는 말» 인가.
 *
 * 낱말 하나라도 겹치면 같은 줄기로 본다 — "노트북" → "게이밍 노트북" 은 좁히는 말이고,
 * "맥북" → "맥북프로" 처럼 붙여 쓴 말도 한쪽이 다른 쪽을 품는다. 겹치는 낱말이 없을 때만
 * 다른 상품으로 본다(예산을 거두는 쪽이 더 조심스러운 판정이므로 좁게 잡는다).
 */
function sameProductLine(a, b) {
  const x = productTokens(a);
  const y = productTokens(b);
  if (!x.length || !y.length) return true;   // 한쪽을 모르면 바뀌었다고 하지 않는다
  return x.some(t => y.some(u => t === u || t.includes(u) || u.includes(t)));
}

/**
 * 구절 안의 «상품 종류» 낱말 (api/_aiidentity.js categoryNounOf — 노트북·청소기·이어폰…).
 *
 * ★ 종류명이 있는 쪽끼리만 비교한다 — 이것이 예산을 거두는 판정을 좁게 잡는 장치다.
 *   · "조금 넘어도 괜찮아" 는 api/_intent.js extractQuery 가 상품 구절처럼 내놓지만(그 턴에는
 *     앞 상품을 이어받으므로 그쪽에서는 문제가 없다) 종류명이 없다 → 상품이 바뀐 것이 아니다.
 *   · "맥북 프로" 도 종류명이 없다(브랜드·모델명이다) → 노트북 예산을 거두지 않는다. 맥북은
 *     실제로 노트북이고, 브랜드명에서 종류를 알아내는 표가 아직 없다.
 *   그래서 거두는 것은 "노트북" → "청소기" 처럼 종류가 분명히 다른 전환뿐이다. 브랜드·모델명만으로
 *   종류가 바뀌는 전환(아이폰 → 맥북)은 아직 못 본다 — 종류 표가 생기면 여기서 쓰면 된다.
 */
function categoryNounsOf(text) {
  let catOf;
  try { catOf = require('./_aiidentity').categoryNounOf; } catch (e) { catOf = null; }
  if (!catOf) return [];
  // "무선청소기" · "로봇청소기" 는 둘 다 청소기다 — 합성어는 종류명 부분까지 줄여서 본다.
  const explicit = productTokens(text).filter(t => catOf(t)).map(t => {
    for (let i = t.length - 2; i > 0; i--) {
      const tail = t.slice(i);
      if (catOf(tail) && tail.length >= 2) return tail;
    }
    return t;
  });
  // A bare model-family name can identify the *kind* of device even when
  // the user omits "이어폰"/"노트북". Otherwise a prior laptop budget can
  // silently leak into a new AirPods recommendation.
  const t = String(text || '').normalize('NFKC').toLowerCase();
  const aliases = [];
  if (/(?:에어팟|airpods|갤럭시\s*버즈|galaxy\s*buds|버즈[2-9]\s*프로)/i.test(t)
      && !/(?:케이스|파우치|보호필름|충전\s*케이블)/.test(t)) aliases.push('이어폰');
  if (/(?:맥북|macbook|lg\s*그램|그램\s*(?:15|16|17|프로)|갤럭시북)/i.test(t)
      && !/(?:충전기|파우치|키스킨|보호필름)/.test(t)) aliases.push('노트북');
  if (/(?:아이패드|ipad|갤럭시\s*탭|galaxy\s*tab)/i.test(t)
      && !/(?:케이스|파우치|보호필름)/.test(t)) aliases.push('태블릿');
  return [...new Set(explicit.concat(aliases))];
}

/** 종류가 분명히 다른 상품으로 바뀌었는가 (양쪽에 종류명이 있고, 그 종류도 낱말도 겹치지 않는다). */
function productKindChanged(from, to) {
  const a = categoryNounsOf(from);
  const b = categoryNounsOf(to);
  if (!a.length || !b.length) return false;
  if (a.some(x => b.includes(x))) return false;
  return !sameProductLine(from, to);
}

/** 상태 이름 → 사람이 읽는 말 (api/_aiidentity.js KO_CONDITION 과 같다). */
const KO_CONDITION = { rental: '렌탈', refurbished: '리퍼', used: '중고', display: '전시', opened: '개봉', sealed: '미개봉', new: '새상품' };

function textOf(h) {
  return String(h && (h.text != null ? h.text : h.content) || '');
}

function norm(text) {
  return String(text == null ? '' : text).normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, TEXT_LEN);
}

/** 사용자 발화 하나의 지문. 원문은 상태에 싣지 않는다. */
function digest(text) {
  const s = norm(text);
  if (!s) return '';
  return crypto.createHash('sha256').update(s, 'utf8').digest().subarray(0, DIGEST_BYTES)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function releasesBudget(text, parsed) {
  const p = parsed || parseConstraints(text);
  return !p.budgetMax && !p.budgetMin && BUDGET_RELEASE_RE.test(String(text || ''));
}

/** 예산 필드만 비운다. 필드 이름을 박지 않는다 — _shopintent 가 예산 필드를 늘려도 함께 비워진다. */
function withoutBudget(c) {
  const out = Object.assign({}, c);
  Object.keys(out).forEach(k => {
    if (!/^budget/.test(k)) return;
    out[k] = typeof out[k] === 'number' ? 0 : typeof out[k] === 'string' ? '' : false;
  });
  return out;
}

/** 발화 하나를 조건에 겹친다 (api/ai.js 의 앞 대화 훑기와 같은 규칙 + 예산 거두기). */
function foldConstraints(c, text, limit) {
  const t = String(text || '').slice(0, limit || TEXT_LEN);
  if (!t) return c;
  const parsed = parseConstraints(t);
  return mergeConstraints(releasesBudget(t, parsed) ? withoutBudget(c) : c, parsed);
}

/** 발화 하나가 스스로 말한 상품 구절 (앞 대화를 보지 않는다). */
function productOf(text) {
  try {
    return require('./_intent').conversationProduct([{ role: 'user', text: String(text || '') }]) || '';
  } catch (e) {
    return '';
  }
}

/** 발화 하나의 예산 — 금액을 말했는가(모순인 금액은 세지 않는다, parseConstraints «모순» 주석). */
function budgetOf(parsed) {
  return !!(parsed && !parsed.conflict && (parsed.budgetMax || parsed.budgetMin));
}

/**
 * 발화 하나를 «조건 + 예산 범위» 에 겹친다.
 *
 * @param {{c:object, scope:string, product:string, dropped:object|null}} acc
 *   scope    'global' = 사용자가 모든 상품에 적용한다고 말한 예산, 'product' = 그 상품의 예산, '' = 예산 없음
 *   product  'product' 범위 예산이 어느 상품의 말이었는지
 *   dropped  상품이 바뀌어 거둔 예산 (api/ai.js 가 한 줄로 알린다)
 */
function foldTurn(acc, text, limit) {
  const t = String(text || '').slice(0, limit || TEXT_LEN);
  if (!t) return acc;
  const parsed = parseConstraints(t);
  const hasBudget = budgetOf(parsed);
  let { c, scope, product } = acc;
  c = foldConstraints(c, t, limit);
  if (hasBudget) {
    scope = GLOBAL_BUDGET_RE.test(t) ? 'global' : 'product';
    product = productOf(t) || product || '';
  } else if (releasesBudget(t, parsed)) {
    scope = '';
    product = '';
  }
  return { c, scope, product };
}

/*
 * 발화 하나가 빼 달라고 한 상태 / 원한다고 말한 상태.
 * 이번 턴의 식별 계약(api/_aiidentity.js buildContract)과 같은 판정을 쓴다 — 다른 규칙으로 읽으면
 * "중고 제외" 를 이번 턴과 다음 턴이 다르게 알아듣는다.
 */
function conditionsOf(text) {
  try {
    const c = require('./_aiidentity').buildContract({ query: '', userText: text }).condition;
    return { excluded: [...(c.excluded || [])], mentioned: [...(c.mentioned || [])] };
  } catch (e) {
    return { excluded: [], mentioned: [] };
  }
}

/** 뺀 상태는 다음에 그 상태를 원한다고 말할 때까지 남는다 ("중고 제외" → … → "중고도 괜찮아"). */
function foldConditions(list, text) {
  const set = new Set(list || []);
  const c = conditionsOf(text);
  c.excluded.forEach(x => set.add(x));
  c.mentioned.forEach(x => set.delete(x));
  return [...set];
}

function emptyConstraints() {
  return mergeConstraints(null, null);
}

/**
 * 이번 요청의 대화 상태.
 *
 * @param {object|null} state  api/_aicontext.js verifyConversationState 결과 (없거나 틀리면 null)
 * @param {Array} hist         normalizeHistory 결과 (꼬리의 중복 질문을 걷어낸 것)
 * @param {string} q           이번 질문
 * @param {{window?:number, textLimit?:number}} [opts]
 *   window     상태가 없을 때 조건을 훑는 기록 수 (api/ai.js MAX_HISTORY_MSGS)
 *   textLimit  기록 한 칸에서 조건을 읽는 길이 (api/ai.js MAX_HISTORY_LEN)
 * @returns {{
 *   carried: boolean,
 *   base: object|null,              상태가 있을 때 «이번 질문 직전까지» 의 조건. 없으면 null
 *   replay: Array,                  api/ai.js 가 base 위에 겹칠 기록 칸 (상태가 있으면 이미 base 에 들어 있다)
 *   intentHist: Array,              의도 판정(api/_intent.js classify)에 넘길 기록 — 상태의 상품 구절을 끼운 것
 *   excludedBefore: string[],       상태가 있을 때 이번 질문 직전까지 빼 달라고 한 상태
 *   next: object                    응답에 실을 다음 상태 (createConversationState 입력)
 * }}
 */
function resolve(state, hist, q, opts) {
  const o = opts || {};
  const window = o.window || 6;
  const textLimit = o.textLimit || TEXT_LEN;
  const list = Array.isArray(hist) ? hist : [];
  const isUser = h => h && h.role !== 'assistant';

  let base = null;
  let replay;
  let intentHist = list;
  let excluded = [];
  let absorbed = [];
  let folded;      // 이번에 상태로 접는 기록 칸
  // 예산의 범위 — 상태에서 이어받는다. 상태가 없으면 기록 창을 훑으며 처음부터 센다.
  const stateBudget = !!(state && state.constraints && (state.constraints.budgetMax || state.constraints.budgetMin));
  let acc = {
    c: null,
    // 범위를 모르는 옛 상태(이 기능 전에 서명된 토큰)의 예산은 그 상품의 예산으로 본다.
    scope: !state ? '' : state.budgetScope === 'global' ? 'global' : stateBudget ? 'product' : '',
    product: state ? String(state.budgetProduct || state.product || '') : '',
    dropped: null
  };
  let budgetDropped = null;
  /*
   * 예산을 말한 발화가 상품 이름을 함께 말하지 않는 일이 더 많다 ("노트북 추천해줘" → "30만원 이하로").
   * 그래서 그때 찾고 있던 상품(thread)을 예산의 상품으로 적는다.
   */
  let thread = state ? String(state.product || '') : '';
  let qParsed = null;
  const fold = (text) => {
    const own = productOf(text);
    acc = foldTurn(acc, text, textLimit);
    if (own) thread = own;
    if (acc.scope === 'product' && !acc.product) acc.product = thread;
    return acc.c;
  };

  if (state) {
    absorbed = (state.absorbed || []).slice();
    const known = new Set(absorbed);
    // 마지막으로 접힌 발화 — 그보다 앞의 기록은 이미 상태 안에 있다(또는 상태보다 오래됐다).
    let last = -1;
    list.forEach((h, i) => { if (isUser(h) && known.has(digest(textOf(h)))) last = i; });
    folded = list.slice(last + 1).filter(h => isUser(h) && !known.has(digest(textOf(h)))).slice(-MAX_REPLAY);

    acc.c = mergeConstraints(state.constraints, null);
    excluded = (state.excludedConditions || []).slice();
    folded.forEach(h => {
      fold(textOf(h));
      excluded = foldConditions(excluded, textOf(h));
    });
    /*
     * 이번 질문이 예산을 거두면 base 에서 미리 걷는다 — api/ai.js 는 그 위에 이번 질문을 그대로 겹친다.
     * 상품이 바뀌어 거두는 예산도 같다. 이번 질문의 조건은 아직 겹치지 않는다(ai.js 가 turnCons 로 겹친다).
     */
    qParsed = parseConstraints(q);
    replay = [];
    // 상태의 상품 구절은 «마지막으로 접힌 발화» 자리에 끼운다. 그 뒤의 정정만 위에 누적된다.
    if (state.product) {
      intentHist = list.slice(0, last + 1).concat([{ role: 'user', text: state.product }], list.slice(last + 1));
    }
  } else {
    // 상태가 없으면 예전 그대로 — 기록 창 안의 사용자 발화만 훑는다.
    replay = list.slice(-window);
    folded = replay.filter(isUser);
  }

  /*
   * 이번 대화가 찾고 있는 상품 — 상태의 상품 구절 위에 정정을 누적한 것(ai.js 의 검색어와 같은 규칙).
   * 예산의 범위를 판정하려면 «이 발화가 상품을 말했는가» 가 아니라 이 누적값이 필요하다.
   * "조금 넘어도 괜찮아" 는 그 자체로는 상품처럼 읽히지만(extractQuery), 누적값은 여전히 노트북이다.
   */
  let product = '';
  try {
    product = require('./_intent').conversationProduct(intentHist.concat([{ role: 'user', text: q }]));
  } catch (e) {
    product = state ? state.product : '';
  }

  /*
   * 상품이 아주 다른 것으로 바뀌었으면 상품 전용 예산을 거둔다 (GLOBAL_BUDGET_RE 주석, CO-03).
   * 이번 질문의 조건은 아직 겹치지 않았다 — api/ai.js 가 turnCons 로 겹친다. 그래서 여기서 거두면
   * 이번 발화의 새 예산·거두는 말이 그 위에 그대로 반영된다.
   */
  if (state && acc.scope === 'product' && acc.product && (acc.c.budgetMax || acc.c.budgetMin)
      && !budgetOf(qParsed) && !releasesBudget(q, qParsed)
      && productKindChanged(acc.product, product)) {
    budgetDropped = { budget: acc.c.budgetMax || acc.c.budgetMin, from: acc.product, to: product };
    acc.c = withoutBudget(acc.c);
    acc.scope = '';
    acc.product = '';
  }
  // 이번 질문이 예산을 거두면 base 에서 미리 걷는다 — api/ai.js 는 그 위에 이번 질문을 그대로 겹친다.
  if (state) base = releasesBudget(q, qParsed) ? withoutBudget(acc.c) : acc.c;

  // 다음 상태 — 이번 질문까지 접는다.
  if (!base) {
    acc.c = emptyConstraints();
    folded.forEach(h => { fold(textOf(h)); });
    folded.forEach(h => { excluded = foldConditions(excluded, textOf(h)); });
  }
  const nextConstraints = fold(q);
  const nextExcluded = foldConditions(excluded, q);
  folded.concat([{ role: 'user', text: q }]).forEach(h => {
    const d = digest(textOf(h));
    if (!d) return;
    const at = absorbed.indexOf(d);
    if (at > -1) absorbed.splice(at, 1);
    absorbed.push(d);
  });

  return {
    carried: !!state,
    base,
    replay,
    intentHist,
    excludedBefore: state ? excluded : [],
    // 상품이 바뀌어 거둔 상품 전용 예산 (api/ai.js 가 한 줄로 알린다). 없으면 null.
    budgetDropped,
    next: {
      product,
      // 모순(conflict)·완화 고지(budgetNotice)는 그 턴의 일이다. 다음 턴으로 넘기지 않는다.
      constraints: Object.assign({}, nextConstraints, { conflict: null, budgetNotice: '' }),
      excludedConditions: nextExcluded,
      absorbed: absorbed.slice(-MAX_ABSORBED),
      budgetScope: acc.scope === 'global' ? 'global' : '',
      budgetProduct: acc.scope === 'product' ? String(acc.product || '').slice(0, 120) : '',
      // Prior pair identity is already signed. The handler clears it on new topics.
      comparison: state && Array.isArray(state.comparison) ? state.comparison : [],
      startedAt: state ? state.startedAt : undefined
    }
  };
}

/**
 * 이번 턴 식별 계약에 앞 대화에서 빼 달라고 한 상태를 더한다.
 * 이번 발화가 그 상태를 원한다고 말했으면("중고도 괜찮아") 더하지 않는다.
 */
function applyConditions(contract, excludedBefore) {
  if (!contract || !contract.condition || !(excludedBefore || []).length) return contract;
  const mentioned = contract.condition.mentioned || new Set();
  excludedBefore.forEach(x => { if (!mentioned.has(x)) contract.condition.excluded.add(x); });
  if (contract.condition.excluded.size) contract.empty = false;
  return contract;
}

/**
 * 프롬프트에 실을 한 줄 — "찾던 상품: 노트북 · 예산 300,000원 이하 · 빼 달라고 한 상태: 중고".
 * 상태를 이어받은 턴에서만 쓴다(그때는 그 말을 한 발화가 기록 창 밖에 있을 수 있다).
 *
 * @param {object} next       resolve().next
 * @param {boolean} withBudget 예산을 이 줄에 적을지 (api/ai.js 가 조건 블록을 따로 싣는 턴이면 false)
 */
function summaryLine(next, withBudget) {
  if (!next) return '';
  const parts = [];
  /*
   * 상품 구절은 사용자가 쓴 낱말이고 이 줄은 시스템 프롬프트에 들어간다. api/ai.js safeText 와 같은 규칙으로
   * 한 줄로 누르고 꺾쇠를 없앤 뒤 따옴표로 묶는다 — 구절 안의 문장이 지시처럼 읽히지 않게.
   */
  const product = String(next.product || '').slice(0, 480).replace(/\p{C}/gu, ' ').replace(/[<>"]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 60);
  if (product) parts.push(`찾던 상품(사용자가 쓴 말): "${product}"`);
  if (withBudget) {
    const c = next.constraints ? mergeConstraints(next.constraints, null) : null;
    const line = c ? constraintLine(c) : '';
    if (line) parts.push(line);
  }
  const ex = (next.excludedConditions || []).map(x => KO_CONDITION[x] || x);
  if (ex.length) parts.push(`빼 달라고 한 상태: ${ex.join('·')}`);
  return parts.join(' · ');
}

module.exports = {
  resolve, applyConditions, summaryLine,
  digest, releasesBudget, conditionsOf,
  MAX_ABSORBED, MAX_REPLAY
};
