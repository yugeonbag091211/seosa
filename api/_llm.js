'use strict';
/*
 * OpenRouter 호출을 한 곳으로 모은다 — 모델 사슬 · 실패 분류 · 시간 예산 · 캐시.
 *
 * ── 왜 만들었나 ────────────────────────────────────────────────
 *
 * api/ai.js 는 세 자리에서 fetch 로 직접 OpenRouter 를 불렀고, 모델은 하나뿐이었다.
 * 그 하나가 402(크레딧 부족)를 내면 AI 기능 전체가 죽는다. 2026-08-28~29 운영에서
 * 실제로 그렇게 죽어 있었다 — 코드는 멀쩡한데 잔액이 0이라 아무도 답을 못 받았다.
 *
 * 여기서 모델을 사슬로 만든다.
 *
 *   1순위(유료·품질)  →  무료 모델들  →  (호출부의) SEOSA 결정론 답변
 *
 * 무료 모델은 크레딧 잔액이 0이어도 호출된다. 그래서 잔액이 떨어져도
 * AI 가 침묵하지 않는다. 잔액을 채우면 자동으로 1순위로 되돌아간다 —
 * 배포도 환경변수 변경도 필요 없다.
 *
 * ── 지키는 선 ──────────────────────────────────────────────────
 *
 *   · 새 서버리스 함수를 만들지 않는다. `_` 접두사 = 공유 모듈 (Vercel 11/12 유지)
 *   · 업스트림 원문을 호출부로 돌려주지 않는다. 이유 코드(reason)만 준다.
 *     ("Insufficient credits …" 가 사용자 말풍선에 그대로 뜬 적이 있다)
 *   · API 키는 로그에 절대 남기지 않는다. 응답 본문도 키 모양이면 지운다.
 *   · 사슬 전체가 요청 하나의 시간 예산 안에서 돈다. 모델이 4개라고
 *     타임아웃이 4배가 되면 함수가 상한까지 매달린다.
 */

const crypto = require('crypto');

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/* ═══════════════════════════════════════════════════════════════════
 *  ZERO-COST 정책 (2026-09-02 감사)
 *
 *  ── 무엇이 문제였나 ────────────────────────────────────────────
 *
 *  chainFor() 는 OPENROUTER_MODELS 가 없으면 사슬 1순위를 유료 모델
 *  (anthropic/claude-sonnet-5)로 두었다. 그런데 운영(Vercel)에는 그 환경변수가
 *  없다 — .env.local(= vercel env pull) 전수 확인. 즉 **로그인 사용자의 모든
 *  AI 요청이 유료 모델을 먼저 호출하고 있었다.**
 *
 *  2026-09-02 실측 (OpenRouter /api/v1/key, 읽기 전용):
 *      is_free_tier: false · usage(누적) $9.79 · usage_weekly $0.0147 · limit: null
 *  잔액 상한이 없어 호출한 만큼 계속 과금된다.
 *
 *  ── 이제 어떻게 하는가 ─────────────────────────────────────────
 *
 *  기본값이 무료 전용이다. 환경변수를 하나도 설정하지 않아도 유료 모델은
 *  호출되지 않는다. 유료를 쓰려면 OPENROUTER_ALLOW_PAID=1 을 **명시적으로**
 *  켜야 한다 — 실수로 켜지는 방향이 아니라 실수로 꺼지는 방향으로 설계한다.
 *
 *  방어는 두 겹이다. 하나가 뚫려도 다른 하나가 막는다.
 *    1) chainFor()  — 사슬을 만들 때 유료 모델을 걸러낸다
 *    2) attempt()   — 네트워크로 나가기 직전에 한 번 더 막는다
 *  2)가 있어야 OPENROUTER_MODELS 에 유료 id 를 잘못 적어도 과금되지 않는다.
 * ═══════════════════════════════════════════════════════════════════ */

/** 유료 모델 호출을 허용하는가. 기본은 거부다 (명시적 opt-in). */
function allowPaid() {
  return String(process.env.OPENROUTER_ALLOW_PAID || '').trim() === '1';
}

/*
 * 유료 1순위. OPENROUTER_ALLOW_PAID=1 일 때만 사슬에 들어간다.
 * 값을 지우지 않는 이유 — 나중에 크레딧을 채우고 품질을 올리기로 하면
 * 환경변수 하나로 되돌아갈 수 있어야 한다. 기능을 없애는 것이 아니라
 * 기본값을 안전한 쪽으로 옮기는 것이다.
 */
const DEFAULT_ANSWER_MODEL   = 'anthropic/claude-sonnet-5';
const DEFAULT_CLASSIFY_MODEL = 'anthropic/claude-haiku-4.5';

/*
 * 무료 사슬.
 *
 * OpenRouter 의 `:free` 판은 잔액 0에서도 호출된다(대신 일일 횟수 제한이 있다).
 * 모델 id 는 공급자 사정으로 사라진다 — 없는 id 는 404 로 돌아오고, 그때 이
 * 프로세스에서 죽은 것으로 표시하고 다음으로 넘어간다(dead 참고).
 * 목록을 통째로 갈아끼우려면 OPENROUTER_MODELS 를 쓴다.
 *
 * ── 2026-08-30 실측으로 고른 목록 ──────────────────────────────
 *
 * 처음에는 흔히 알려진 무료 id(deepseek-chat-v3 / llama-3.3-70b / qwen-2.5-72b)를
 * 적었는데, 실제로 /api/v1/models 를 받아 보니 **셋 다 존재하지 않았다.**
 * 그 상태로 배포했으면 매 요청이 404 세 번을 거쳐 결정론 답변으로만 떨어졌을
 * 것이다. 그래서 실제 목록(무료 18종)을 받아 후보를 직접 돌려 보고 골랐다.
 *
 *   ── 2026-09-02 재측정 (이전 기록을 그대로 믿지 않고 다시 돌렸다) ──
 *
 * 이전 주석은 nemotron-3-super 를 "분류 5/5, 1순위" 로 적어 두었다. 12문항
 * × 2회, 요청 사이 4.5초를 띄워(분당 한도 오염 제거) 다시 재니 결과가 달랐다.
 * 운영은 두 경로 모두 reasoning:{enabled:false} 를 보내므로 그 조건만 본다.
 *
 *   모델                                    분류    답변                 지연
 *   minimax/minimax-m3:free                 6/6    310자 · 깨끗함       1,082ms  ← 1순위
 *   dots-studio/dots-3-note-preview:free    5/6    231자 · 깨끗함       1,065ms
 *   nvidia/nemotron-3.5-lightning:free      9/12   370자                  288ms
 *   nvidia/nemotron-3-super-120b-a12b:free  5/6    ★ 답변이 망가진다      379ms
 *   minimax/minimax-m2.7:free               0/6    reasoning 강제 → 무용지물
 *   inclusionai/ling-3.0-flash-fin:free     0/6    빈 응답
 *   z-ai/glm-5.2, google/gemma-4-*:free       —    429 (공급자 혼잡, 2회 모두)
 *   thinkingmachines/inkling-*:free           —    403 (계정에 권한 없음)
 *
 * ★ nemotron-3-super 를 답변 사슬에서 뺀 이유가 핵심이다. 이 모델은 답을
 *   쓰는 대신 우리가 넣어 준 [결정 데이터] 블록을 거의 그대로 되뱉었다.
 *   출력에 P1·P2 참조까지 남았다. 사용자에게는 내부 프롬프트가 새는 것으로
 *   보인다. 분류(A~E 한 글자)는 5/6 으로 멀쩡해서 분류 사슬에는 남긴다.
 *
 * 지어낸 금액은 위 네 모델 모두 0건이었다 — 프롬프트가 데이터를 주는 형태라
 * 그렇다. 그래도 Hallucination Firewall 은 그대로 둔다(모델을 믿지 않는다).
 *
 * ── 상업적 이용 조건 (2026-09-02 실제 라이선스 원문 확인) ────────
 *
 * SEOSA 는 제휴 수익이 있는 상업 서비스다. "무료 모델" 은 요금이 0원이라는
 * 뜻이지 아무 조건 없이 써도 된다는 뜻이 아니다. 그래서 각 모델의 라이선스
 * 원문을 직접 받아 확인했다.
 *
 *   minimax/minimax-m3:free
 *     MiniMax Community License — 상업 이용 허용, 단 조건 2개.
 *       (1) "Built with MiniMax M3" 를 제품에 눈에 띄게 표기 → public/index.html
 *       (2) api@minimax.io 로 1회 통지 (연매출 2천만 달러 미만인 경우)
 *           ★ 아직 보내지 않았다. 사람이 보내야 한다. DEPLOY.md 참고.
 *   nvidia/nemotron-3.5-lightning:free, nemotron-3-ultra-550b:free
 *     OpenMDW-1.1 — "deal in the Model Materials without restriction".
 *     사용 제한 없음. 재배포할 때만 고지 의무가 붙는데 우리는 재배포하지 않는다.
 *   nvidia/nemotron-3-super-120b-a12b:free
 *     NVIDIA Nemotron Open Model License — "Works are commercially usable" 명시.
 *
 *   dots-studio/dots-3-note-preview:free
 *     답변 품질은 2위였지만(231자·깨끗함) 뺐다. OpenRouter 에 모델 저장소가
 *     연결돼 있지 않아 라이선스 원문을 확인할 수 없다. 확인 못 한 것은 쓰지
 *     않는다 — 조건을 모르는 채로 상업 서비스에 넣는 것이 더 큰 위험이다.
 *
 * 분류용은 정확도 우선이다. 결정론 분류기(api/_intent.js)가 확신할 때는
 * LLM 을 아예 부르지 않으므로, 여기까지 오는 말은 원래 애매한 말이다.
 * 애매한 말일수록 맞히는 게 중요하지 빨리 틀리는 건 쓸모가 없다.
 */
const FREE_ANSWER_CHAIN = [
  'minimax/minimax-m3:free',
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free'
];
const FREE_CLASSIFY_CHAIN = [
  'minimax/minimax-m3:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3.5-lightning:free'
];

/*
 * 사슬 길이 상한.
 *
 * 길게 늘어놓으면 장애가 났을 때 사용자가 그만큼 오래 기다린다. 실패가
 * 이어지면 답을 억지로 받아내는 것보다 빨리 결정론 답변으로 넘어가는 쪽이 낫다.
 */
const MAX_CHAIN = 4;

/* ─── 모델 단가 (USD / 1M 토큰) ────────────────────────────────────
 *
 * ★ 여기 없는 모델은 비용을 null 로 둔다 — 지어내지 않는다.
 * ★ 값은 사람이 관리한다. provider 가 단가를 바꾸면 이 표만 고치면 된다.
 *   토큰 수는 provider 응답(usage)에서 온 실측값이고, 비용만 이 표로
 *   곱해서 얻는 추정치다. 그래서 필드 이름도 costUsd(추정)로 둔다.
 *
 * :free 접미사 모델은 OpenRouter 무료 티어라 0 이다(호출 자체는 무료이며,
 * 분당/일일 상한이 대신 걸린다).
 */
const MODEL_PRICES_USD_PER_1M = {
  'anthropic/claude-sonnet-5':   { in: 3.00, out: 15.00 },
  'anthropic/claude-haiku-4.5':  { in: 1.00, out: 5.00 }
};

/** 무료 티어 모델인가 (OpenRouter 는 :free 접미사로 표시한다). */
function isFreeModel(model) { return /:free$/.test(String(model || '')); }

/**
 * 예상 비용(USD). 단가를 모르는 모델이면 null 을 준다.
 *
 * @param {string} model
 * @param {{inputTokens:number,outputTokens:number}|null} usage provider 실측 토큰
 * @returns {number|null}
 */
function estimateCostUsd(model, usage) {
  if (isFreeModel(model)) return 0;
  if (!usage) return null;                       // 토큰을 모르면 비용도 모른다
  const p = MODEL_PRICES_USD_PER_1M[model];
  if (!p) return null;                           // 단가 미등록 — 추정하지 않는다
  return (usage.inputTokens / 1e6) * p.in + (usage.outputTokens / 1e6) * p.out;
}

/** 이만큼도 안 남았으면 새 모델을 시도하지 않는다 (부르자마자 끊길 시간) */
const MIN_ATTEMPT_MS = 2500;

/*
 * 402 를 한 번 보면 그 뒤 이 시간 동안은 유료 모델을 건너뛴다.
 *
 * 잔액이 0인 계정은 다음 요청도, 그다음 요청도 402 다. 매번 확인하면
 * 사용자마다 한 번씩 헛걸음(왕복 + 지연)을 한다. 잔액을 채우면 최대
 * 이 시간 뒤에 자동으로 1순위로 돌아온다.
 */
const PAID_BLOCK_MS = 10 * 60 * 1000;

/** 없는 모델 id 를 기억해 두는 시간. */
const DEAD_MODEL_MS = 30 * 60 * 1000;

/** 모델 id 로 받아들일 모양. 환경변수로 아무 문자열이나 URL 에 실리지 않게 한다. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9._-]+)?$/;
const MAX_MODEL_LEN = 80;

/*
 * 프로세스 안에서만 사는 상태. 서버리스라 인스턴스마다 따로 논다 —
 * 그래도 같은 인스턴스가 받는 연속 요청에서는 헛걸음을 줄여 준다.
 * 판정 자체를 여기에 기대지는 않는다(어디까지나 최적화).
 */
const state = {
  paidBlockedUntil: 0,
  dead: new Map(),      // model → 언제까지 죽은 것으로 볼지
  cache: new Map(),     // key → { at, text, finish, model }
  /*
   * ── AI Cost Guard 계수기 (2026-09-02) ─────────────────────────
   *
   * "유료 비용 = $0" 을 주장하려면 측정할 수 있어야 한다. 프로세스 안에서만
   * 사는 값이라 서버리스 인스턴스마다 따로 놀지만, 그래도 두 가지를 답한다.
   *   · paidBlocked 가 0 이 아니면 어딘가에서 유료 호출을 시도했다는 뜻이다
   *   · paidCalls 가 0 이 아니면 실제로 유료 호출이 나갔다는 뜻이다 (경보)
   * /api/cron?diag=1 (CRON_SECRET) 에서 읽는다.
   */
  calls: 0,          // 실제로 네트워크로 나간 호출
  freeCalls: 0,
  paidCalls: 0,      // ★ 0 이 아니면 zero-cost 정책이 깨진 것이다
  paidBlocked: 0,    // 가드가 막은 유료 호출 시도
  failures: 0,
  cacheHits: 0,
  totalMs: 0,
  inTok: 0,
  outTok: 0,
  costUsd: 0
};

/** `:free` 로 끝나면 잔액이 없어도 부를 수 있는 모델이다. */
function isFree(model) {
  return /:free$/i.test(String(model || ''));
}

function sanitizeModel(raw) {
  const s = String(raw == null ? '' : raw).trim().slice(0, MAX_MODEL_LEN);
  return MODEL_RE.test(s) ? s : '';
}

function envList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map(sanitizeModel)
    .filter(Boolean);
}

/**
 * 이 역할에 쓸 모델 사슬.
 *
 * OPENROUTER_MODELS / OPENROUTER_CLASSIFY_MODELS 가 있으면 그것이 사슬 전체다
 * (무료만 적으면 비용이 0원인 운영이 된다). 없으면 기존 단일 모델을 1순위로
 * 두고 그 뒤에 무료 사슬을 잇는다.
 *
 * @param {'answer'|'classify'} role
 */
function chainFor(role) {
  const classify = role === 'classify';
  const override = envList(classify ? 'OPENROUTER_CLASSIFY_MODELS' : 'OPENROUTER_MODELS');
  const paidOk = allowPaid();
  const freeChain = classify ? FREE_CLASSIFY_CHAIN : FREE_ANSWER_CHAIN;

  let list;
  if (override.length) {
    list = override;
  } else if (paidOk) {
    const head = sanitizeModel(
      process.env[classify ? 'OPENROUTER_CLASSIFY_MODEL' : 'OPENROUTER_MODEL']
    ) || (classify ? DEFAULT_CLASSIFY_MODEL : DEFAULT_ANSWER_MODEL);
    list = [head].concat(freeChain);
  } else {
    /*
     * ★ 기본 경로 — 무료 전용.
     *   OPENROUTER_MODEL(단수)이 설정돼 있어도 무료 모델일 때만 앞에 세운다.
     *   유료 id 가 들어 있으면 조용히 무시한다(로그는 attempt 가 남긴다).
     */
    const head = sanitizeModel(
      process.env[classify ? 'OPENROUTER_CLASSIFY_MODEL' : 'OPENROUTER_MODEL']
    );
    list = (head && isFree(head) ? [head] : []).concat(freeChain);
  }

  const seen = Object.create(null);
  const out = [];
  list.forEach(m => {
    if (seen[m]) return;
    seen[m] = true;
    out.push(m);
  });

  /*
   * ── 방어 1 — 유료 모델을 사슬에서 걷어낸다 ──────────────────
   *
   * 전부 걸러져 비면 무료 사슬로 되돌린다. "아무것도 시도하지 않는 것"이
   * 가장 나쁜 결과이고, 그때도 비용은 0원이어야 하므로 무료로 채운다.
   */
  const filtered = paidOk ? out : out.filter(isFree);
  const finalList = filtered.length ? filtered : freeChain.slice();
  return finalList.slice(0, MAX_CHAIN);
}

/**
 * 지금 시도해 볼 만한 모델만 남긴다.
 *
 * ★ 전부 걸러지면 거르지 않은 사슬을 그대로 쓴다. 최적화 때문에 아무것도
 *   시도하지 않는 것이 가장 나쁜 결과다 — 기억이 틀렸을 수도 있으니
 *   한 번은 부딪혀 본다.
 */
function usableChain(chain, now) {
  const live = chain.filter(m => {
    const until = state.dead.get(m) || 0;
    if (until > now) return false;
    if (until) state.dead.delete(m);
    if (!isFree(m) && state.paidBlockedUntil > now) return false;
    return true;
  });
  return live.length ? live : chain.slice();
}

/**
 * 업스트림 상태코드를 우리가 다룰 수 있는 갈래로 옮긴다.
 *
 * advance=false 는 "다음 모델을 시도해도 소용없다" 는 뜻이다. 키가 잘못됐으면
 * 사슬 전체가 같은 키를 쓰므로 네 번 더 물어봐야 네 번 다 401 이다.
 */
function classifyStatus(status) {
  if (status === 401 || status === 403) return { reason: 'auth',   advance: false };
  if (status === 402)                   return { reason: 'quota',  advance: true };
  if (status === 429)                   return { reason: 'rate',   advance: true };
  if (status === 400 || status === 404) return { reason: 'model',  advance: true };
  if (status >= 500)                    return { reason: 'server', advance: true };
  return { reason: 'http', advance: true };
}

/*
 * 로그에 남기기 전에 키 모양을 지운다.
 *
 * 업스트림 본문이 우리 키를 되돌려 줄 이유는 없지만, 로그는 한 번 새면
 * 되돌릴 수 없다. 값싼 보험이다.
 */
function redact(s) {
  return String(s == null ? '' : s).replace(/sk-or-[A-Za-z0-9_-]+/g, 'sk-or-***');
}

/* ── 캐시 ─────────────────────────────────────────────────────────
 *
 * 같은 프롬프트는 같은 답을 낸다(temperature 가 낮다). 새로고침·같은 질문
 * 반복에서 호출 1회를 통째로 아낀다.
 *
 * ★ 기본값은 꺼짐(0)이다.
 *   프롬프트에는 그 시점의 가격이 박혀 있어서 가격이 바뀌면 키도 바뀐다.
 *   그래도 "같은 질문에 늘 한 글자도 같은 답" 은 상담으로서 어색할 수 있어,
 *   켜고 끄는 판단을 운영에 맡긴다. AI_CACHE_TTL_MS 로 켠다.
 */
const CACHE_MAX = 200;

/*
 * ★ 기본값을 켬으로 바꿨다 (2026-09-02).
 *
 * 예전 기본값은 0(꺼짐)이었다. 유료 모델을 쓸 때는 "같은 질문에 늘 한 글자도
 * 같은 답" 이 어색하다는 이유였는데, 무료 전용으로 가면 사정이 달라진다.
 * 이제 아끼는 것은 돈이 아니라 **분당 호출 한도**다 — OpenRouter 무료 모델은
 * free-models-per-min 상한을 공유하고, 실측에서 실제로 429 를 받았다.
 * 그 한도를 캐시로 아끼면 동시 사용자가 늘어도 AI 가 조용히 죽지 않는다.
 *
 * 5분인 이유: 프롬프트에 그 시점의 가격이 박혀 있어 가격이 바뀌면 키가 바뀐다.
 * 즉 이 TTL 은 "가격이 안 바뀐 동안 같은 질문" 에만 걸린다. 그래도 오래 두면
 * 재고·판매 상태가 달라질 수 있으므로 짧게 잡는다.
 */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

function cacheTtl() {
  const raw = process.env.AI_CACHE_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_CACHE_TTL_MS;
  const n = Number(raw);
  // 명시적으로 0 을 주면 끈다 (테스트가 그렇게 쓴다).
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30 * 60 * 1000) : 0;
}

function cacheKey(role, messages, maxTokens, temperature) {
  return crypto.createHash('sha1')
    .update(`${role}|${maxTokens}|${temperature}|${JSON.stringify(messages)}`)
    .digest('hex');
}

function cacheGet(key, ttl, now) {
  if (!ttl) return null;
  const hit = state.cache.get(key);
  if (!hit) return null;
  if (now - hit.at > ttl) { state.cache.delete(key); return null; }
  return hit;
}

function cacheSet(key, ttl, value) {
  if (!ttl) return;
  // 가장 오래된 것부터 버린다. Map 은 넣은 순서를 지킨다.
  if (state.cache.size >= CACHE_MAX) {
    const oldest = state.cache.keys().next();
    if (!oldest.done) state.cache.delete(oldest.value);
  }
  state.cache.set(key, value);
}

/**
 * 모델 하나에 한 번 물어본다.
 *
 * @returns {{ok:boolean, text?:string, finish?:string, reason?:string, advance?:boolean}}
 */
async function attempt(model, opts, timeoutMs) {
  /*
   * ── 방어 2 — 네트워크로 나가기 직전 최종 관문 ─────────────────
   *
   * chainFor 가 이미 걸렀지만, 여기서 한 번 더 본다. 이 한 줄이 있어야
   * "환경변수에 유료 id 를 잘못 적었다" 같은 사고로 과금되지 않는다.
   * 던지지 않고 다음 모델로 넘긴다 — 사용자 요청을 죽일 이유는 없다.
   */
  if (!isFree(model) && !allowPaid()) {
    state.paidBlocked++;
    console.warn(`[llm] ZERO-COST: 유료 모델 호출 차단 — ${model} `
      + '(허용하려면 OPENROUTER_ALLOW_PAID=1)');
    return { ok: false, reason: 'paid-blocked', advance: true };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const body = {
    model,
    messages: opts.messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature
  };
  // reasoning:{enabled:false} 같은 공급자 옵션. 지원하지 않는 모델은 그냥 무시한다.
  if (opts.extra) Object.keys(opts.extra).forEach(k => { body[k] = opts.extra[k]; });

  // Cost Guard — 네트워크로 나가는 순간에만 센다 (가드가 막은 것은 위에서 이미 셌다).
  const startedAt = Date.now();
  state.calls++;
  if (isFree(model)) state.freeCalls++; else state.paidCalls++;

  let r;
  try {
    r = await fetch(ENDPOINT, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    state.failures++;
    state.totalMs += Date.now() - startedAt;
    if (e && e.name === 'AbortError') return { ok: false, reason: 'timeout', advance: true };
    console.warn(`[llm] ${model} 연결 실패: ${redact(e && e.message)}`);
    return { ok: false, reason: 'network', advance: true };
  } finally {
    clearTimeout(timer);
  }

  state.totalMs += Date.now() - startedAt;

  if (!r || !r.ok) {
    state.failures++;
    const status = (r && r.status) || 0;
    const cls = classifyStatus(status);
    let detail = '';
    try { detail = redact(String(await r.text()).slice(0, 200)); } catch (e) { detail = ''; }
    console.warn(`[llm] ${model} ${status} ${cls.reason}${detail ? ` — ${detail}` : ''}`);
    if (cls.reason === 'quota') state.paidBlockedUntil = Date.now() + PAID_BLOCK_MS;
    if (cls.reason === 'model') state.dead.set(model, Date.now() + DEAD_MODEL_MS);
    return { ok: false, reason: cls.reason, advance: cls.advance };
  }

  let data;
  try { data = await r.json(); }
  catch (e) {
    state.failures++;
    console.warn(`[llm] ${model} 응답 파싱 실패`);
    return { ok: false, reason: 'parse', advance: true };
  }

  const choice = ((data && data.choices) || [])[0] || {};
  const text = String(((choice.message || {}).content) || '');
  /*
   * 빈 답도 실패로 본다.
   *
   * 무료 모델에서 실제로 자주 나는 모양이다 — 200 을 주고 content 가 빈 문자열.
   * 성공으로 다루면 호출부가 "답변을 만들지 못했어요" 로 끝내 버린다.
   * 다음 모델에 물어보면 대개 답이 나온다.
   */
  if (!text.trim()) { state.failures++; return { ok: false, reason: 'empty', advance: true }; }

  /*
   * ★ usage 는 provider 가 준 값을 그대로만 싣는다 (2026-09-01).
   *   OpenRouter 는 OpenAI 호환 형식으로 prompt_tokens / completion_tokens /
   *   total_tokens 를 준다. 없으면 null 이다 — 추정해서 채우지 않는다.
   *   답변 동작에는 관여하지 않는다(계측 전용).
   */
  const u = (data && data.usage) || null;
  const usage = u ? {
    inputTokens:  Number(u.prompt_tokens) || 0,
    outputTokens: Number(u.completion_tokens) || 0,
    totalTokens:  Number(u.total_tokens) || ((Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0))
  } : null;

  if (usage) { state.inTok += usage.inputTokens; state.outTok += usage.outputTokens; }
  const cost = estimateCostUsd(model, usage);
  if (cost) state.costUsd += cost;

  return { ok: true, text, finish: String(choice.finish_reason || ''), usage };
}

/**
 * 사슬을 따라 답이 나올 때까지 물어본다.
 *
 * @param {object} opts
 *   role        'answer' | 'classify'
 *   messages    OpenRouter 메시지 배열
 *   maxTokens   출력 상한
 *   temperature
 *   extra       공급자 옵션 (선택)
 *   perCallMs   모델 하나당 타임아웃
 *   budgetMs    사슬 전체에 쓸 수 있는 시간
 *
 * @returns {{ok:boolean, text:string, finish:string, model:string,
 *            reason:string, tried:Array<{model:string, reason:string}>}}
 *   ok=false 일 때 reason 은 마지막 실패 이유다. 업스트림 원문은 담기지 않는다.
 */
async function chat(opts) {
  const o = opts || {};
  const role = o.role === 'classify' ? 'classify' : 'answer';
  const messages = Array.isArray(o.messages) ? o.messages : [];
  const maxTokens = Math.max(1, Number(o.maxTokens) || 900);
  const temperature = Number.isFinite(Number(o.temperature)) ? Number(o.temperature) : 0.2;
  const perCallMs = Math.max(1000, Number(o.perCallMs) || 25000);
  const budgetMs = Math.max(1000, Number(o.budgetMs) || perCallMs);

  const tried = [];
  if (!process.env.OPENROUTER_API_KEY) {
    return { ok: false, text: '', finish: '', model: '', reason: 'nokey', tried };
  }
  if (!messages.length) {
    return { ok: false, text: '', finish: '', model: '', reason: 'nomessages', tried };
  }

  const ttl = cacheTtl();
  const key = ttl ? cacheKey(role, messages, maxTokens, temperature) : '';
  const now0 = Date.now();
  const hit = cacheGet(key, ttl, now0);
  if (hit) {
    state.cacheHits++;
    return { ok: true, text: hit.text, finish: hit.finish, model: hit.model, reason: 'cache', tried,
      // 캐시 히트는 토큰을 쓰지 않는다. usage 는 null 이고 cached 로 구분한다.
      cached: true, usage: null, costUsd: 0, latencyMs: Date.now() - now0 };
  }

  const deadline = now0 + budgetMs;
  const chain = usableChain(chainFor(role), now0);

  let last = 'none';
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      tried.push({ model, reason: 'budget' });
      last = 'budget';
      break;
    }

    const r = await attempt(model, { messages, maxTokens, temperature, extra: o.extra },
      Math.min(perCallMs, remaining));

    if (r.ok) {
      // 유료 모델이 성공했다 = 잔액이 돌아왔다. 건너뛰기를 즉시 푼다.
      if (!isFree(model)) state.paidBlockedUntil = 0;
      tried.push({ model, reason: 'ok' });
      cacheSet(key, ttl, { at: Date.now(), text: r.text, finish: r.finish, model });
      return { ok: true, text: r.text, finish: r.finish, model, reason: 'ok', tried,
        cached: false, usage: r.usage || null,
        costUsd: estimateCostUsd(model, r.usage), latencyMs: Date.now() - now0 };
    }

    tried.push({ model, reason: r.reason });
    last = r.reason;
    if (!r.advance) break;   // 키 문제 등 — 다음 모델도 같은 결과다
  }

  return { ok: false, text: '', finish: '', model: '', reason: last, tried };
}

/** 테스트가 프로세스 기억을 지우기 위해 부른다. */
function _reset() {
  state.paidBlockedUntil = 0;
  state.dead.clear();
  state.cache.clear();
  state.calls = 0; state.freeCalls = 0; state.paidCalls = 0; state.paidBlocked = 0;
  state.failures = 0; state.cacheHits = 0; state.totalMs = 0;
  state.inTok = 0; state.outTok = 0; state.costUsd = 0;
}

/**
 * AI Cost Guard — 이 인스턴스가 지금까지 무엇을 했는가.
 *
 * ★ zeroCost 가 false 면 유료 호출이 실제로 나갔다는 뜻이다. 그 자체가 경보다.
 * ★ 서버리스라 인스턴스마다 따로 센다. 절대량이 아니라 "유료가 0인가" 를 본다.
 */
function stats() {
  return {
    zeroCost: state.paidCalls === 0,
    allowPaid: allowPaid(),
    calls: state.calls,
    freeCalls: state.freeCalls,
    paidCalls: state.paidCalls,
    paidBlocked: state.paidBlocked,
    failures: state.failures,
    cacheHits: state.cacheHits,
    avgLatencyMs: state.calls ? Math.round(state.totalMs / state.calls) : 0,
    inputTokens: state.inTok,
    outputTokens: state.outTok,
    // 무료 모델은 단가가 0이라 이 값은 정의상 0이어야 한다.
    estimatedCostUsd: Math.round(state.costUsd * 1e6) / 1e6,
    answerChain: chainFor('answer'),
    classifyChain: chainFor('classify')
  };
}

module.exports = {
  chat, chainFor, isFree, allowPaid, stats,
  DEFAULT_ANSWER_MODEL, DEFAULT_CLASSIFY_MODEL,
  FREE_ANSWER_CHAIN, FREE_CLASSIFY_CHAIN,
  MODEL_PRICES_USD_PER_1M, estimateCostUsd, isFreeModel,
  MAX_CHAIN, MIN_ATTEMPT_MS, PAID_BLOCK_MS, DEAD_MODEL_MS,
  _internal: { sanitizeModel, classifyStatus, usableChain, redact, cacheKey, state, _reset, attempt }
};
