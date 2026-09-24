'use strict';
/*
 * SEOSA 2.0 라우터 — 새 서버리스 함수 없이 새 API 를 얹는 단 한 곳.
 *
 * ── 왜 이 파일이 있는가 ────────────────────────────────────────────
 *
 * Vercel Hobby 는 서버리스 함수 12개가 상한이고 이 저장소는 이미 12개다
 * (api/sync.js · api/_radarapi.js 주석). 그래서 레이더·상품 페이지가 그랬듯
 * 새 기능도 기존 함수의 `__route` 분기에 얹는다.
 *
 * 여섯 기능을 여러 브랜치에서 동시에 만들면 history.js · alerts.js · ai.js ·
 * vercel.json 을 저마다 고치게 되고, 그 줄들이 서로 부딪친다. 그래서 라우트를
 * **이 표 한 곳에 미리 다 적어 둔다** (docs/seosa2/CONTRACTS.md §1). 호스트
 * 함수는 첫 줄에서 이 표만 본다. 기능 브랜치는 모듈 파일을 «추가» 만 하고,
 * 공유 파일은 한 줄도 고치지 않는다.
 *
 * 모듈이 아직 없으면 501 NOT_READY 로 답한다 — 라우트가 먼저 배포돼도 안전하다.
 *
 * ★ 기존 경로를 건드리지 않는다. __route 가 이 표에 없으면 routeOf 가 null 을
 *   돌려주고, 호스트 함수는 예전 코드를 그대로 탄다.
 */

const ROUTES = Object.freeze({
  timing:      { host: 'history', module: './_timing-api',       feature: '① 구매 타이밍' },
  waitroom:    { host: 'alerts',  module: './_waitroom-api',     feature: '② 구매 대기실' },
  investigate: { host: 'ai',      module: './_investigator-api', feature: '③ 쇼핑 조사관' },
  lookup:      { host: 'history', module: './_lookup-api',       feature: '④ 브라우저 확장' },
  cart:        { host: 'history', module: './_cart-api',         feature: '⑤ 장바구니 최저가' },
  anomaly:     { host: 'history', module: './_anomaly-api',      feature: '⑥ 가격 이상 패턴' }
});

/**
 * 이 요청이 SEOSA 2.0 라우트인가.
 *
 * @param {object} req
 * @param {'history'|'alerts'|'ai'} host  부른 함수. 다른 함수의 라우트는 받지 않는다 —
 *   /api/alerts?__route=timing 같은 우회로 private CORS 함수에 public 라우트를
 *   태우지 못하게 한다.
 * @returns {string|null} 라우트 이름
 */
function routeOf(req, host) {
  const name = String((req && req.query && req.query.__route) || '');
  if (!name || !Object.prototype.hasOwnProperty.call(ROUTES, name)) return null;
  return ROUTES[name].host === host ? name : null;
}

/** 이 모듈 파일이 아직 없어서 난 MODULE_NOT_FOUND 인가 (모듈 «안의» require 실패와 가른다). */
function isOwnModuleMissing(err, spec) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') return false;
  const base = spec.replace(/^\.\//, '');
  const first = String(err.message || '').split('\n')[0];
  return first.indexOf(`'${spec}'`) > -1 || first.indexOf(`/${base}'`) > -1
    || first.indexOf(`/${base}.js'`) > -1;
}

/**
 * 라우트 모듈의 handler(req, res) 로 넘긴다.
 *
 * 모듈 로드 실패를 둘로 가른다.
 *   · 모듈 파일 자체가 없다 → 501 NOT_READY (기능이 아직 배포되지 않음)
 *   · 모듈 안에서 터졌다     → 500 (진짜 오류 — 숨기지 않고 Sentry 로)
 */
async function dispatch(name, req, res) {
  const route = ROUTES[name];
  const { fail, applyCors } = require('./_http');
  let mod;
  try {
    mod = require(route.module);
  } catch (e) {
    if (isOwnModuleMissing(e, route.module)) {
      if (!applyCors(req, res, route.host === 'history' ? 'public' : 'private')) return;
      return res.status(501).json({
        ok: false, code: 'NOT_READY', feature: name,
        error: `${route.feature} 기능은 아직 준비 중이에요.`
      });
    }
    return fail(res, e, { where: `v2-${name}`, route: `/api/${name}`, message: '잠시 후 다시 시도해 주세요.' });
  }
  try {
    return await mod.handler(req, res);
  } catch (e) {
    return fail(res, e, { where: `v2-${name}`, route: `/api/${name}`, message: '잠시 후 다시 시도해 주세요.' });
  }
}

module.exports = { ROUTES, routeOf, dispatch, _internal: { isOwnModuleMissing } };
