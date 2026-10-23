'use strict';
/*
 * AI 가 핫딜을 «읽는» 길 — 조건에 맞는 검증된 핫딜만 골라 준다 (2026-10-23 감사 CO-09).
 *
 * ── 왜 생겼나 ──────────────────────────────────────────────────────
 *
 * 핫딜 판정 엔진과 /api/hotdeals 는 이미 있다. 그런데 AI 는 그 목록을 볼 길이 없어서
 * "30만원 이하 핫딜 있어?" 에 매번 새 검색을 돌렸다. 검증된 딜이 바로 옆에 있는데도.
 *
 * ── 어떻게 ────────────────────────────────────────────────────────
 *
 * 새 SQL 을 쓰지 않는다. /api/hotdeals 핸들러를 그대로 불러 쓴다. 그래야
 *
 *   · 노출 상태(VERIFIED_HOT·GOOD_DEAL·POTENTIAL_DEAL)와 만료 규칙,
 *   · 군집 대표 하나만 내보내는 규칙,
 *   · 제휴 링크 관문(_affiliate safeBuyLink),
 *   · 내부 검증 딜과 외부 커뮤니티 제보의 구분
 *
 * 이 한 벌만 남는다. 핫딜의 «진실» 은 거기 한 군데에 있다.
 *
 * ── 지키는 선 ──────────────────────────────────────────────────────
 *
 * ★ 읽기 전용이다. 아무것도 쓰지 않는다.
 * ★ 미검증 커뮤니티 제보를 검증된 딜처럼 올리지 않는다. 기본값은 내부 검증 피드만이고,
 *   커뮤니티를 넣을 때도 verified:false 와 라벨을 그대로 달고 별도 목록으로 나간다.
 * ★ 예산 상한은 서버가 거른다. 모델·옵션·제외 상태도 서버가 거른다(_aiidentity 계약).
 *   모델이 목록을 다시 고르거나 상한 밖 상품을 올리지 못하게, 프롬프트에 실리는 것이 곧 결과다.
 * ★ 오래 확인하지 않은 딜은 내보내지 않는다 — "지금 그 가격" 이라고 말할 근거가 없다.
 */

const AIID = require('./_aiidentity');

/** 마지막 확인이 이보다 오래된 딜은 내보내지 않는다. */
const MAX_STALE_HOURS = 12;
/** 한 번에 넘길 수 있는 최대 개수 (프롬프트에 실리는 양이다). */
const MAX_ITEMS = 8;
/** /api/hotdeals 에서 받아올 후보 수 — 걸러낸 뒤에도 남게 넉넉히. */
const FETCH_LIMIT = 48;

/**
 * /api/hotdeals 를 그 자리에서 호출한다 (네트워크 없이 핸들러를 직접).
 * 핸들러는 res.json 으로만 답한다 — 그 몸통을 받아 온다.
 */
async function callHotdeals(query, view) {
  const handler = require('./hotdeals.js');
  let status = 200;
  let payload = null;
  const params = Object.assign({}, query || {});
  if (view) params.view = view;
  const res = {
    status(c) { status = c; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    json(v) { payload = v; return this; },
    end() { payload = payload || {}; return this; }
  };
  await handler({ method: 'GET', headers: {}, query: params, socket: {}, connection: {} }, res);
  if (status >= 400) {
    const message = payload && (payload.error || payload.message) ? String(payload.error || payload.message) : `status ${status}`;
    const source = view === 'external' ? '외부 핫딜 피드' : '내부 핫딜 피드';
    const e = new Error(`${source}를 읽지 못했습니다: ${message}`);
    e.hotdealUnavailable = true;
    throw e;
  }
  if (!payload || !Array.isArray(payload.items)) {
    const source = view === 'external' ? '외부 핫딜 피드' : '내부 핫딜 피드';
    const e = new Error(`${source} 응답에 목록이 없습니다`);
    e.hotdealUnavailable = true;
    throw e;
  }
  if ((view === 'external' && (payload.externalPending || payload.pending))
      || (!view && payload.pending)) {
    const source = view === 'external' ? '외부 핫딜 피드' : '내부 핫딜 피드';
    const e = new Error(`${source}가 준비되지 않았습니다`);
    e.hotdealUnavailable = true;
    throw e;
  }
  return payload;
}

function hoursSince(iso, now) {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return Infinity;
  return (now - t) / 3600000;
}

/** 예산 관문 — 상한 위는 버린다. 하한은 "그 아래는 의심" 이 아니라 사용자가 말한 구간이다. */
function withinBudget(price, budgetMin, budgetMax) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return false;
  if (budgetMax > 0 && p > budgetMax) return false;
  if (budgetMin > 0 && p < budgetMin) return false;
  return true;
}

/**
 * 모델·옵션·제외 상태 관문 — 이번 턴의 식별 계약과 같은 판정을 쓴다.
 * 찾는 상품을 말하지 않았으면(그냥 "핫딜 뭐 있어?") 통과시킨다.
 */
function identityGate(product, userText, excludedConditions) {
  const contract = AIID.buildContract({ query: String(product || ''), userText: String(userText || '') });
  (excludedConditions || []).forEach(x => {
    if (contract.condition && !(contract.condition.mentioned || new Set()).has(x)) {
      contract.condition.excluded.add(x);
      contract.empty = false;
    }
  });
  return item => {
    if (!contract || contract.empty) return { ok: true, tier: null };
    const v = AIID.verdict(contract, item);
    // EXACT·NEAR 만 — 형제 모델(G304 X)·다른 상태(중고)는 요청한 상품이 아니다.
    return { ok: v.tier <= AIID.TIER.NEAR, tier: v.tier };
  };
}

function dedupeKey(it) {
  return [it.productId || '', it.vendorItemId || '', it.mall || '', String(it.title || '').slice(0, 40)].join('|');
}

/**
 * 조건에 맞는 핫딜을 읽는다.
 *
 * @param {object} o
 *   product             찾는 상품 구절 (없으면 종류를 가리지 않는다)
 *   userText            이번 발화 원문 (제외 표현을 읽는 데 쓴다)
 *   budgetMax/budgetMin 예산 (0 이면 없음)
 *   excludedConditions  앞 대화에서 빼 달라고 한 상태 (api/_convstate.js)
 *   limit               최대 개수 (기본 5, 최대 8)
 *   includeCommunity    외부 커뮤니티 제보도 함께 볼지 (기본 false)
 *   now                 기준 시각 (테스트용)
 * @returns {Promise<{verified:Array, community:Array, counts:object, state:string}>}
 *   state: 'found' | 'empty' | 'unavailable'
 */
async function searchHotdeals(o) {
  const opts = o || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const limit = Math.max(1, Math.min(MAX_ITEMS, Number(opts.limit) || 5));
  const budgetMax = Number(opts.budgetMax) > 0 ? Number(opts.budgetMax) : 0;
  const budgetMin = Number(opts.budgetMin) > 0 ? Number(opts.budgetMin) : 0;
  const counts = { fetched: 0, overBudget: 0, mismatch: 0, stale: 0, duplicate: 0, community: 0, potential: 0 };

  // 내부 이력 딜과 외부 레이더는 서로 다른 API view 다. 외부 view 에는
  // SEOSA 가격으로 검증된 딜과 아직 확인하지 않은 커뮤니티 제보가 함께 온다.
  // 둘 다 읽어야 검증된 외부 딜을 추천하고, 제보는 별도 목록으로 격리할 수 있다.
  const [internalResult, externalResult] = await Promise.allSettled([
    callHotdeals({ limit: String(FETCH_LIMIT) }),
    callHotdeals({ limit: String(FETCH_LIMIT) }, 'external')
  ]);
  const sources = {
    internal: internalResult.status === 'fulfilled' ? 'available' : 'unavailable',
    external: externalResult.status === 'fulfilled'
      ? (externalResult.value.externalEnabled === false ? 'disabled' : 'available')
      : 'unavailable'
  };
  const errors = [internalResult, externalResult]
    .filter(x => x.status === 'rejected')
    .map(x => x.reason && x.reason.message ? x.reason.message : '핫딜 피드 조회 실패');
  const internalRows = internalResult.status === 'fulfilled' ? internalResult.value.items : [];
  const externalRows = externalResult.status === 'fulfilled' ? externalResult.value.items : [];
  const rows = internalRows.concat(externalRows);
  if (sources.internal === 'unavailable' && sources.external === 'unavailable') {
    // 공급 실패를 "핫딜이 없다" 로 바꾸지 않는다 (CO-05 와 같은 원칙).
    return { verified: [], community: [], potential: [], counts, state: 'unavailable', sources, error: errors.join('; ') };
  }
  const partial = sources.internal === 'unavailable' || sources.external === 'unavailable';

  const gate = identityGate(opts.product, opts.userText, opts.excludedConditions);
  const seen = new Set();
  const verified = [];
  const community = [];
  const potential = [];

  counts.fetched = rows.length;
  rows.forEach(it => {
    if (!it) return;
    const isCommunity = !!it.communityOnly || it.verificationStatus === 'UNMATCHED';
    if (isCommunity) counts.community++;
    if (isCommunity && !opts.includeCommunity) return;
    if (!withinBudget(it.price, budgetMin, budgetMax)) { counts.overBudget++; return; }
    const g = gate(it);
    if (!g.ok) { counts.mismatch++; return; }
    // 커뮤니티 제보는 우리가 확인한 시각이 없다 — 그 피드의 노출 기간 규칙(24시간)을 따른다.
    if (!isCommunity && hoursSince(it.checkedAt, now) > MAX_STALE_HOURS) { counts.stale++; return; }
    const key = dedupeKey(it);
    if (seen.has(key)) { counts.duplicate++; return; }
    seen.add(key);

    const status = String(it.status || it.verificationStatus || '').toUpperCase();
    // 내부 POTENTIAL_DEAL 은 가격 후보 판정 단계다. 외부 API 의 verified=true 는
    // 별도로 가격 이력 검증을 통과했다는 뜻이므로 그대로 검증 목록에 둔다.
    const isVerified = !isCommunity && (it.verified === true
      || ['VERIFIED_HOT', 'GOOD_DEAL', 'STRONG_DEAL'].includes(status));
    const isPotential = !isCommunity && !isVerified;
    if (isPotential) counts.potential++;

    const out = {
      title: it.title,
      price: Number(it.price) || 0,
      mall: it.mall || '',
      url: it.url || it.productUrl || '',
      sourceUrl: it.sourceUrl || '',
      source: it.source || '',
      // 가격 검증된 딜만 verified 다. 제보·잠정 후보는 끝까지 false 다.
      verified: isVerified,
      label: isCommunity ? '커뮤니티 제보(미검증)'
        : isVerified
          ? (it.source === 'internal-history' ? '내부 가격 이력 검증 핫딜' : 'SEOSA 가격 검증 핫딜')
          : '내부 잠정 후보(검증 필요)',
      status,
      dropPercent: it.signals ? it.signals.priceDropPercent : null,
      referencePrice: it.signals ? it.signals.referencePrice : null,
      checkedAt: it.checkedAt || null,
      identityTier: g.tier
    };
    (isCommunity ? community : isPotential ? potential : verified).push(out);
  });

  return {
    verified: verified.slice(0, limit),
    community: community.slice(0, limit),
    potential: potential.slice(0, limit),
    counts,
    sources,
    error: errors.length ? errors.join('; ') : '',
    state: partial ? 'partial' : (verified.length || community.length || potential.length ? 'found' : 'empty')
  };
}

function won(n) { return `${Number(n || 0).toLocaleString('ko-KR')}원`; }

/**
 * 프롬프트에 실을 블록. 여기 실린 것이 곧 답할 수 있는 전부다 —
 * 모델이 목록 밖의 딜을 지어내거나 미검증 제보를 검증된 것처럼 말하지 못하게 못 박는다.
 */
function hotdealBlock(result) {
  if (!result) return '';
  if (result.state === 'unavailable') {
    return [
      '[핫딜 목록 — 확인 실패]',
      '- 지금 핫딜 목록을 읽지 못했다. 핫딜이 «없다» 는 뜻이 아니다.',
      '- 확인하지 못했다고만 말하고, 핫딜을 지어내지 마라.'
    ].join('\n');
  }
  const lines = ['[핫딜 목록 — 서버가 조건으로 걸러 확인한 것. 여기 없는 핫딜은 말하지 마라]'];
  if (result.state === 'partial') {
    lines.push(`- 일부 피드를 읽지 못했다 (${String(result.error || '원인 불명').slice(0, 180)}). 아래 결과만 확인됐으며, 읽지 못한 피드에 조건에 맞는 핫딜이 없는지는 알 수 없다.`);
  }
  if (result.sources && result.sources.external === 'disabled') {
    lines.push('- 외부 핫딜 피드는 비활성화되어 확인하지 않았다.');
  }
  if (!result.verified.length) {
    lines.push('- 조건에 맞는 «가격 검증 핫딜»은 지금 없다. 잠정 후보를 검증된 딜처럼 추천하지 마라.');
  } else {
    result.verified.forEach((d, i) => {
      const drop = d.dropPercent == null ? '' : ` · 하락 ${Math.round(d.dropPercent)}%`;
      lines.push(`  ${i + 1}. [${d.label}] ${String(d.title).slice(0, 60)} · ${won(d.price)} · ${d.mall}${drop}`);
    });
  }
  if (result.potential && result.potential.length) {
    lines.push('- 아래 후보는 내부 가격 기록에 잡혔지만 검증 핫딜 기준을 통과하지 않았다. 검증된 딜로 단정하지 말고 확인 필요 후보로만 소개하라.');
    result.potential.forEach((d, i) => {
      lines.push(`  P${i + 1}. [내부 잠정 후보·검증 필요] ${String(d.title).slice(0, 60)} · ${won(d.price)} · ${d.mall}`);
    });
  }
  if (result.community.length) {
    lines.push('- 아래는 커뮤니티 제보다. **검증되지 않았다.** 가격·재고를 사실로 말하지 말고,');
    lines.push('  제보이며 확인이 필요하다고 분명히 밝혀라. 검증된 핫딜과 섞어 추천하지 마라.');
    result.community.forEach((d, i) => {
      lines.push(`  C${i + 1}. [커뮤니티 제보·미검증] ${String(d.title).slice(0, 60)} · ${won(d.price)} · ${d.mall || '출처 참조'}`);
    });
  }
  lines.push('- 가격은 이 목록의 값만 쓴다. 할인율·정가를 네가 계산해 새 수치로 말하지 마라.');
  lines.push('- 만료·품절은 우리가 보장하지 않는다. 링크에서 확인이 필요하다고 한 번 알려라.');
  return lines.join('\n');
}

/*
 * 핫딜을 묻는 말인가 — "핫딜", "특가", "할인 중인 거", "세일".
 * ★ 좁게 잡는다. "할인율 알려줘" 처럼 그 상품의 할인을 묻는 말은 핫딜 목록이 아니다.
 */
const HOTDEAL_ASK_RE = /(핫\s*딜|hotdeal|특가|떨이|세일\s*(?:중|하는|상품|제품)|할인\s*(?:중인|하는)\s*(?:거|것|상품|제품)|지금\s*(?:싼|저렴한)\s*(?:거|것|상품|제품))/i;

function asksHotdeal(text) {
  return HOTDEAL_ASK_RE.test(String(text || ''));
}

module.exports = {
  searchHotdeals, hotdealBlock, asksHotdeal,
  MAX_STALE_HOURS, MAX_ITEMS, HOTDEAL_ASK_RE
};
