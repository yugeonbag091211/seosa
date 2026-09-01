/*
 * 구매 성향 프로필 — 사용자가 실제로 말한 것에서만 만든다.
 *
 * ── 무엇을 고치려고 만들었나 ────────────────────────────────────
 *
 * 지금까지 취향은 낱말 하나짜리였다(priority = 'price' | 'quality' | …).
 * 먼저 걸린 규칙 하나가 이기고 나머지는 사라졌다. 그래서 이런 대화가
 * 제대로 다뤄지지 않았다.
 *
 *   "100만원 이하 노트북"        → 가격이 중요하다는 신호
 *   "영상편집도 해"              → 성능이 중요하다는 신호
 *   "근데 가벼웠으면 좋겠어"      → 휴대성이 중요하다는 신호
 *
 * 사람은 하나만 중요하다고 말하지 않는다. 여러 개를 순서 없이 말하고,
 * 뒤에 갈수록 강조가 바뀐다. 그것을 낱말 하나로 누르면 앞의 두 개가 버려진다.
 *
 * 그래서 차원별 가중치로 바꾼다. 말할 때마다 그 차원이 조금씩 올라가고,
 * 나머지는 상대적으로 내려간다. 아무 말도 안 하면 전부 균등하다 —
 * 즉 아무 말도 안 한 사람에게는 예전과 똑같이 동작한다.
 *
 * ── 지켜야 할 선 ────────────────────────────────────────────────
 *
 * ★ 사용자가 말하지 않은 성향을 만들지 않는다.
 *   모든 가중치 변화에는 근거(evidence)가 붙는다 — 사용자가 실제로 쓴
 *   문자열이다. 근거 없는 신호는 애초에 만들어지지 않는다.
 *
 * ★ "이 사람은 원래 이런 사람" 이라고 확정하지 않는다.
 *   여기 있는 것은 이번 대화에서 말한 것뿐이다. 세션이 끝나면 사라진다.
 *   서버에 개인 성향을 쌓아 두지 않는다.
 *
 * ★ 출처에 따라 무게가 다르다 (지시 5항).
 *   이번 발화(explicit) > 앞 대화(conversation) > 추론(inferred)
 *   추론은 애초에 만들지 않지만, 만들더라도 결정을 뒤집지 못하게 약하다.
 */

/*
 * 다룰 차원.
 *
 * design 은 목록에 두되 랭킹에 쓰지 않는다 — 우리에게 디자인을 잴 데이터가
 * 없기 때문이다. 사용자가 "예쁜 걸로" 라고 말한 사실은 기록하지만,
 * 그것으로 상품 순위를 바꾸면 근거 없는 정렬이 된다. 있는 척하지 않는다.
 */
// 조사 헬퍼 — "브랜드은" 같은 어긋남을 막는다(_specs 는 순수 정규식 모듈).
const { eunn, eulr } = require('./_specs');

const DIMS = ['price', 'quality', 'performance', 'portability', 'brand', 'design'];

/** 랭킹에 실제로 반영할 수 있는 차원 (데이터가 있는 것만) */
const ACTIONABLE = ['price', 'quality', 'performance', 'portability', 'brand'];

const DIM_LABEL = {
  price: '가격', quality: '품질·내구', performance: '성능',
  portability: '휴대성', brand: '브랜드', design: '디자인'
};

/** 출처별 신뢰 계수. 명시 > 앞 대화 > 추론 (지시 5항) */
const SOURCE_TRUST = { explicit: 1.0, conversation: 0.7, inferred: 0.35 };

/*
 * 신호 규칙.
 *
 * PRIORITY_RE(_shopintent)와 달리 "먼저 걸린 하나"가 아니라 걸리는 것을
 * 모두 모은다. 한 문장에서 두 차원이 함께 나오는 것이 정상이기 때문이다
 * ("가격보다 성능" → price 하향 + performance 상향).
 *
 * delta 는 한 번 언급의 무게다. 크게 잡으면 지나가는 말 한마디가 추천을
 * 뒤집는다. 작게 잡고 여러 번 말하면 쌓이게 한다.
 */
const SIGNALS = [
  // [차원, delta, 정규식]
  ['price',        +1.0, /가성비|가심비|저렴|싼 ?(거|게|걸|것)|싼거|최저가|알뜰|경제적|싸게|싼 ?맛/],
  ['price',        +1.2, /가격이? ?(제일|가장) ?중요|무조건 ?싼|돈 ?없|예산이? ?빠듯/],
  ['price',        -1.0, /가격 ?(은|이)? ?상관없|비싸도 (괜찮|돼|된)|돈 ?(좀 ?)?더 (써도|들어도)|예산 ?(은)? ?상관없/],

  ['quality',      +1.0, /품질|튼튼|내구|오래 ?쓰|오래 ?쓸|오래 ?사용|고급|프리미엄|퀄리티|좋은 ?(거|게|걸|것)/],
  ['quality',      +1.2, /가격보다 ?(품질|오래|내구)|싼 ?티 ?나는 ?(건|거) ?싫/],

  ['performance',  +1.0, /성능|스펙|빠른|빠르|사양|처리|렉|버벅|고사양/],
  ['performance',  +1.2, /영상 ?편집|게임|렌더링|작업용|전문가용|3d/i],

  ['portability',  +1.0, /휴대|가벼[운웠워울요]|가볍|경량|작은|컴팩트|들고 ?다[니닐녀]/],
  ['portability',  +1.2, /무거운 ?(건|거|게|것)? ?(싫|별로|안 ?좋)|무겁지 ?않|안 ?무거/],

  ['brand',        +1.0, /브랜드|정품|메이커|대기업|국내 ?브랜드/],

  // 데이터가 없어 랭킹에는 못 쓰지만, 말한 사실은 남긴다.
  ['design',       +1.0, /디자인|예쁜|예쁘|이쁜|이쁘|감성|색감|외관|미니멀/]
];

/** 아무 신호도 없는 초기 프로필. 모든 차원이 균등하다. */
function emptyProfile() {
  const weights = {};
  DIMS.forEach(d => { weights[d] = 1; });
  return { weights, signals: [] };
}

/**
 * 발화 한 덩어리에서 성향 신호를 읽는다.
 *
 * @param {string} text
 * @param {string} source 'explicit'(이번 발화) | 'conversation'(앞 대화)
 * @returns {Array<{dim,delta,source,evidence}>}
 */
function readSignals(text, source) {
  const s = String(text || '');
  const src = SOURCE_TRUST[source] ? source : 'conversation';
  const out = [];
  if (!s.trim()) return out;

  SIGNALS.forEach(([dim, delta, re]) => {
    const m = s.match(re);
    if (!m) return;
    out.push({
      dim,
      delta: delta * SOURCE_TRUST[src],
      source: src,
      // ★ 근거는 사용자가 실제로 쓴 문자열이다. 이것이 없으면 신호도 없다.
      evidence: m[0].trim().slice(0, 24)
    });
  });
  return out;
}

/*
 * 한 번 언급이 가중치를 얼마나 움직이는가.
 *
 * 0.35 는 "두세 번 말해야 뚜렷해진다" 는 뜻이다. 한 번에 크게 움직이면
 * 지나가는 말 한마디가 추천을 뒤집고, 사용자는 왜 바뀌었는지 모른다.
 */
const STEP = 0.35;
/** 가중치 상·하한. 한 차원이 전부를 먹지 않게 한다. */
const W_MIN = 0.35;
const W_MAX = 3.0;

/**
 * 신호를 반영한 새 프로필을 만든다 (원본을 건드리지 않는다).
 *
 * @param {object} profile 이전 프로필 (없으면 균등)
 * @param {Array}  signals readSignals 결과
 */
function applySignals(profile, signals) {
  const base = (profile && profile.weights) ? profile : emptyProfile();
  const weights = Object.assign({}, base.weights);
  const kept = (base.signals || []).slice(-20);   // 근거는 최근 것만 남긴다

  (signals || []).forEach(sig => {
    if (!sig || DIMS.indexOf(sig.dim) < 0) return;
    const cur = weights[sig.dim] || 1;
    const next = cur * (1 + STEP * sig.delta);
    weights[sig.dim] = Math.max(W_MIN, Math.min(W_MAX, next));
    kept.push(sig);
  });

  return { weights, signals: kept.slice(-20) };
}

/**
 * 랭킹에 곱할 배수.
 *
 * 균등하면 전부 1.0 이다 — 아무 취향도 말하지 않은 사용자에게는 예전과
 * 똑같이 동작한다는 뜻이고, 그게 이 설계에서 가장 중요한 성질이다.
 *
 * ★ design 은 배수를 만들지 않는다. 우리에게 디자인을 잴 데이터가 없다.
 */
function multipliers(profile) {
  const w = (profile && profile.weights) || emptyProfile().weights;
  const out = {};
  // 실제로 쓸 수 있는 차원만 평균을 낸다(못 쓰는 차원이 평균을 끌어당기지 않게).
  const vals = ACTIONABLE.map(d => w[d] || 1);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  ACTIONABLE.forEach(d => {
    out[d] = mean > 0 ? (w[d] || 1) / mean : 1;
  });
  return out;
}

/** 이 프로필이 균등한가 (= 취향을 말한 적이 없는가) */
function isNeutral(profile) {
  const m = multipliers(profile);
  return ACTIONABLE.every(d => Math.abs(m[d] - 1) < 0.02);
}

/**
 * 프롬프트에 실을 한 줄.
 *
 * ★ 숫자를 적지 않는다. "가격 0.15" 는 사용자에게 아무 뜻이 없고, 모델이
 *   그것을 답변에 옮기면 근거 없는 권위가 된다. 무엇을 더 중요하게
 *   보는지와 그 근거만 적는다.
 */
function profileLine(profile) {
  if (!profile || isNeutral(profile)) return '';
  const m = multipliers(profile);
  const up = ACTIONABLE.filter(d => m[d] >= 1.12).sort((a, b) => m[b] - m[a]);
  const down = ACTIONABLE.filter(d => m[d] <= 0.88).sort((a, b) => m[a] - m[b]);
  if (!up.length && !down.length) return '';

  // 근거는 그 차원에 대해 사용자가 실제로 쓴 말이다.
  const ev = dim => {
    const s = (profile.signals || []).filter(x => x.dim === dim).slice(-1)[0];
    return s ? `"${s.evidence}"` : '';
  };

  /*
   * ★ 근거가 있는 것만 적는다.
   *
   * 한 차원이 올라가면 나머지는 상대적으로 내려간다. 그런데 그것을
   * "가격은 덜 중요하게 봄" 이라고 적으면, 사용자가 하지 않은 말을
   * 성향으로 확정하는 것이 된다. 실제로 그렇게 말한 차원(근거가 있는 것)만
   * 적고, 상대적으로 밀린 것은 침묵한다.
   */
  const parts = [];
  up.forEach(d => {
    const e = ev(d);
    if (e) parts.push(`${eulr(DIM_LABEL[d])} 더 중요하게 봄 (${e})`);
  });
  down.forEach(d => {
    const e = ev(d);
    if (e) parts.push(`${eunn(DIM_LABEL[d])} 덜 중요하게 봄 (${e})`);
  });
  return parts.join(' · ');
}

/**
 * 대화 전체에서 프로필을 만든다.
 *
 * 앞 대화는 conversation, 이번 발화는 explicit 으로 읽는다 — 방금 한 말이
 * 세 턴 전에 한 말보다 무겁다.
 *
 * @param {string} question 이번 발화
 * @param {Array}  hist     [{role, text}] 앞 대화
 */
function buildProfile(question, hist, clip) {
  let p = emptyProfile();
  const cut = s => (typeof clip === 'function' ? clip(s, 450) : String(s || '').slice(0, 450));

  (hist || []).forEach(h => {
    if (!h || h.role === 'assistant') return;     // 우리가 한 말은 사용자의 성향이 아니다
    p = applySignals(p, readSignals(cut(h.text || h.content), 'conversation'));
  });
  p = applySignals(p, readSignals(cut(question), 'explicit'));
  return p;
}

module.exports = {
  emptyProfile, readSignals, applySignals, multipliers, isNeutral,
  profileLine, buildProfile,
  DIMS, ACTIONABLE, DIM_LABEL, SOURCE_TRUST, STEP, W_MIN, W_MAX
};
