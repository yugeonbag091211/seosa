'use strict';
/*
 * 구매 링크 검증 — 사용자에게 «구매하러 가기» 로 내보내는 URL 의 단일 관문.
 *
 * ── 왜 한 곳인가 (2026-10-04 독립 리뷰) ──────────────────────────────
 *
 * 처음에는 _shop.toClientProduct 에서 네이버 가격비교 경유 링크(/re/PCS…)만
 * 막았다. 그 경로 밖(핫딜·AI·검색 응답)으로는 그대로 새 나갔고, 다른
 * 파트너의 lptag · lptag 없는 AFF 링크 · /re/UNKNOWN · 쿠팡 상품 페이지 원본
 * URL 은 어디서도 막히지 않았다. 셋 다 누르면 SEOSA 수익으로 잡히지 않는다.
 * 그래서 구매 링크를 내보내는 모든 자리가 이 함수 하나를 지난다.
 *
 * ── 허용하는 쿠팡 형식 ────────────────────────────────────────────────
 *
 *   link.coupang.com/re/AFF…?lptag=<SEOSA>   파트너스 검색·딥링크 API 가 준 링크
 *   link.coupang.com/a/<code>                파트너스 단축 링크 (히어로 등)
 *
 * 그 밖의 쿠팡 URL 은 전부 막는다. 막은 링크를 쿠팡 원본 URL 로 «되살리지»
 * 않는다 — 원본으로 보내는 순간 추적이 사라진다. 막힌 상품은 «판매처 링크
 * 없음» 이다(화면이 이미 그렇게 그린다).
 *
 * ADPICK commissionlink(biz.adpick.co.kr)는 그대로 둔다. 그 밖의 호스트(예스24
 * 같은 다른 제휴처)는 이 파일의 판단 대상이 아니므로 스킴만 본다.
 *
 * ── 옵션 일치 ─────────────────────────────────────────────────────────
 *
 * 쿠팡 제휴 링크에는 vendorItemId 가 실려 있다. 항목이 자기 옵션을 알고
 * 있는데 링크의 옵션이 다르면, «가격은 A 옵션 · 링크는 B 옵션» 이다. 그
 * 링크는 내보내지 않는다.
 *
 * public/index.html 의 Fmt.buyUrl 이 같은 규칙을 브라우저에서 한 번 더 건다
 * (localStorage 에 남은 옛 찜·최근 본 상품의 링크까지 막으려면 거기서도 필요하다).
 */

/** SEOSA 쿠팡 파트너스 lptag. 모든 SEOSA 쿠팡 제휴 링크에 공개적으로 실려 있는 값이다. */
const SEOSA_COUPANG_LPTAG = String(process.env.COUPANG_PARTNER_LPTAG || 'AF8789251').trim();

const COUPANG_HOST_RE = /(^|\.)coupang\.com$|^coupa\.ng$/i;
const ADPICK_HOST_RE = /^biz\.adpick\.co\.kr$/i;

/**
 * 쿠팡 링크 판정.
 * @returns {{ok:boolean, kind:string}}
 *   kind: 'aff' | 'short' | 'foreign-lptag' | 'no-lptag' | 'unknown-path' | 'raw-product' | 'not-coupang' | 'bad-url'
 */
function classifyCoupang(link) {
  let u;
  try { u = new URL(String(link || '')); } catch (e) { return { ok: false, kind: 'bad-url' }; }
  if (!COUPANG_HOST_RE.test(u.hostname)) return { ok: false, kind: 'not-coupang' };
  if (u.protocol !== 'https:') return { ok: false, kind: 'bad-url' };
  if (u.hostname.toLowerCase() !== 'link.coupang.com') return { ok: false, kind: 'raw-product' };
  if (/^\/a\/[A-Za-z0-9]+\/?$/.test(u.pathname)) return { ok: true, kind: 'short' };
  if (!/^\/re\/AFF[A-Z]*$/.test(u.pathname)) return { ok: false, kind: 'unknown-path' };
  const tag = u.searchParams.get('lptag');
  if (!tag) return { ok: false, kind: 'no-lptag' };
  if (tag !== SEOSA_COUPANG_LPTAG) return { ok: false, kind: 'foreign-lptag' };
  return { ok: true, kind: 'aff' };
}

/**
 * 사용자에게 내보내도 되는 구매 링크. 안 되면 '' (링크 없음).
 *
 * @param {string} link
 * @param {object} [item] 그 링크를 단 항목. vendorItemId(또는 vendor_item_id)가
 *                        있으면 쿠팡 링크의 옵션과 맞는지까지 본다.
 */
function safeBuyLink(link, item) {
  const s = String(link == null ? '' : link).trim();
  if (!/^https?:\/\//i.test(s)) return '';
  let u;
  try { u = new URL(s); } catch (e) { return ''; }

  if (COUPANG_HOST_RE.test(u.hostname)) {
    if (!classifyCoupang(s).ok) return '';
    const want = String((item && (item.vendorItemId || item.vendor_item_id)) || '').trim();
    const got = u.searchParams.get('vendorItemId') || '';
    if (want && got && want !== got) return '';
    return s;
  }
  if (ADPICK_HOST_RE.test(u.hostname)) return u.protocol === 'https:' ? s : '';
  return s;
}

/** 여러 후보 중 처음으로 통과하는 링크. 전부 막히면 ''. */
function firstSafeBuyLink(candidates, item) {
  for (const c of candidates || []) {
    const ok = safeBuyLink(c, item);
    if (ok) return ok;
  }
  return '';
}

/** 항목 배열의 link 를 제자리에서 검증한다 (같은 배열을 돌려준다). */
function sanitizeItemLinks(items, field) {
  const key = field || 'link';
  (items || []).forEach(it => { if (it && typeof it === 'object') it[key] = safeBuyLink(it[key], it); });
  return items;
}

module.exports = {
  SEOSA_COUPANG_LPTAG, classifyCoupang, safeBuyLink, firstSafeBuyLink, sanitizeItemLinks
};
