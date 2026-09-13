'use strict';

/**
 * 뽐뿌 «뽐뿌게시판» 공식 RSS adapter — External Hotdeal Radar 의 첫 실제 소스.
 *
 * ── 왜 이 소스인가 (2026-09-13 확인) ────────────────────────────────
 *   - 운영진 공지(notice #461, 2009-12-07)가 rss.php?id=ppomppu 주소를 공개했다.
 *   - robots.txt 는 rss.php 를 막지 않는다 (Disallow 는 /openapi/·/redirect.php 등).
 *   - 로그인·anti-bot·HTML 파싱이 필요 없다. XML 문서 하나를 한 번 읽는다.
 *
 * ── 이용 규칙과의 경계 ───────────────────────────────────────────────
 *   뽐뿌 이용 규칙은 «게시된 정보를 무단 복제하거나 제3자에게 제공» 을 금지한다.
 *   그래서
 *     - 본문(description)·작성자·조회수는 읽지도 저장하지도 않는다.
 *     - 제목에서 상품명·가격·배송비·몰만 뽑고, 원문 링크로 출처를 남긴다.
 *     - 사용자 노출은 기본 OFF(shadow)다. 공개 전에 이용 허락 확인이 먼저다.
 *
 * ── 호출 예산 ──────────────────────────────────────────────────────
 *   실행당 GET 1회. 네트워크 오류·5xx 에만 1회 재시도하고 timeout·429·4xx 는
 *   재시도하지 않는다(느리거나 거절하는 서버를 두 번 두드리지 않는다).
 *   같은 프로세스에서 10분 안에 다시 부르면 요청하지 않고 degraded 로 끝난다.
 */

const { HotdealSourceAdapter, SourceError } = require('../base');
const HD = require('../../_hotdeal');
const { normalizeMall } = require('../../_hotsource');

const BOARD_ID = 'ppomppu';
const FEED_URL = `https://www.ppomppu.co.kr/rss.php?id=${BOARD_ID}`;
const USER_AGENT = 'SEOSA-HotdealRadar/1.0 (+https://seosa.ai.kr; RSS reader, 1 request per run)';
const TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 1500;
const MIN_INTERVAL_MS = 10 * 60 * 1000;
const MAX_BYTES = 512 * 1024;
/** 한 문서에서 읽는 항목 상한. 피드가 비정상적으로 커져도 파이프라인이 휘둘리지 않는다. */
const MAX_ITEMS = 100;

/* ── XML ─────────────────────────────────────────────────────────── */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function codePoint(n) {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** 한 번에 치환한다 — "&amp;lt;" 가 "<" 로 두 번 풀리지 않는다. */
function decodeEntities(value) {
  return String(value || '').replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos));/gi,
    (_, hex, dec, name) => (hex ? codePoint(parseInt(hex, 16))
      : dec ? codePoint(Number(dec)) : NAMED_ENTITIES[name.toLowerCase()]));
}

function tagText(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return '';
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (cdata ? cdata[1] : decodeEntities(m[1])).replace(/\s+/g, ' ').trim();
}

function parseRss(xml) {
  const text = String(xml || '');
  if (!/<rss[\s>]/i.test(text) || !/<channel[\s>]/i.test(text)) {
    throw new SourceError('parse', 'response is not an RSS 2.0 document');
  }
  const items = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(text)) !== null && items.length < MAX_ITEMS) {
    // description·author·hits 는 의도적으로 읽지 않는다 (위 «이용 규칙과의 경계»).
    items.push({ title: tagText(m[1], 'title'), link: tagText(m[1], 'link'), pubDate: tagText(m[1], 'pubDate') });
  }
  return items;
}

/* ── 제목: "[몰] 상품명 (가격/배송)" ─────────────────────────────── */

const ENDED_RE = /^\s*[[(]?\s*(종료|품절|마감)\s*[\])]?/;
const FOREIGN_CURRENCY_RE = /[$€¥£]|달러|usd|위안|유로/i;

function parseKrw(text) {
  const t = String(text || '').replace(/\s+/g, '');
  if (FOREIGN_CURRENCY_RE.test(t)) return { error: 'foreign_currency' };
  const man = t.match(/^\D*?(\d+(?:\.\d+)?)만원?\D*$/);
  if (man) return { amount: Math.round(Number(man[1]) * 10000) };
  const nums = t.match(/\d{1,3}(?:,\d{3})+|\d+/g) || [];
  if (!nums.length) return { error: 'missing_price' };
  // "1+1 9,900원" 처럼 숫자가 여럿이면 어느 것이 가격인지 모른다. 추측하지 않는다.
  if (nums.length > 1) return { error: 'ambiguous_price' };
  return { amount: Number(nums[0].replace(/,/g, '')) };
}

function parseShipping(text) {
  const t = String(text || '').replace(/\s+/g, '');
  if (!t) return { shippingFee: null, shippingNote: 'unknown' };
  if (/^(무료|무배|무료배송|무)$/.test(t) || /^0원?$/.test(t)) return { shippingFee: 0, shippingNote: 'free' };
  const m = t.match(/^(\d{1,3}(?:,\d{3})+|\d+)원?$/);
  if (m) {
    const fee = Number(m[1].replace(/,/g, ''));
    if (fee <= 50000) return { shippingFee: fee, shippingNote: fee ? 'paid' : 'free' };
  }
  // 조건부무료·와우무료·착불 … 배송비를 확정할 수 없다.
  return { shippingFee: null, shippingNote: 'conditional' };
}

function parsePriceGroup(group) {
  const parts = String(group || '').split('/');
  const priceText = parts[0] || '';
  const parsed = parseKrw(priceText);
  if (parsed.error) return { error: parsed.error };
  if (!Number.isSafeInteger(parsed.amount) || parsed.amount < 100 || parsed.amount > 50000000) {
    return { error: 'implausible_price' };
  }
  return {
    price: parsed.amount,
    // "3,440원~" 은 가장 싼 옵션의 가격이다. 특정 상품의 가격이 아니다.
    priceIsFrom: /~|부터|최저/.test(priceText),
    // "카드 25,900원", "개당 990원" — 가격 칸에 조건이 붙어 있다.
    priceHasCondition: /[가-힣a-z]/i.test(priceText.replace(/원|만|~|부터|최저/g, '')),
    ...parseShipping(parts.slice(1).join('/'))
  };
}

function postIdentity(link) {
  const safe = HD.safeUrl(String(link || '').replace(/^http:\/\//i, 'https://'));
  if (!safe) return null;
  let url;
  try { url = new URL(safe); } catch (_) { return null; }
  if (!/(^|\.)ppomppu\.co\.kr$/i.test(url.hostname)) return null;
  const no = url.searchParams.get('no') || '';
  if (url.searchParams.get('id') !== BOARD_ID || !/^\d{1,12}$/.test(no)) return null;
  return { externalId: no, postUrl: `https://www.ppomppu.co.kr/zboard/view.php?id=${BOARD_ID}&no=${no}` };
}

/** RFC 822(피드 표준)는 그대로, 시간대 없는 표기는 KST 로 읽는다. 미래 시각은 버린다. */
function parsePostedAt(value, nowMs) {
  const s = String(value || '').trim();
  if (!s) return null;
  let ms = NaN;
  if (/(GMT|UTC|Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    ms = Date.parse(s);
  } else {
    const m = s.match(/^(\d{4})[-./](\d{2})[-./](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (m) ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+09:00`);
  }
  if (!Number.isFinite(ms)) return null;
  if (Number.isFinite(nowMs) && ms > nowMs + 10 * 60000) return null;
  return new Date(ms).toISOString();
}

function parseItem(entry, nowMs) {
  const rawTitle = HD.cleanTitle(entry && entry.title, 300);
  if (!rawTitle) return { skip: 'missing_title' };
  if (ENDED_RE.test(rawTitle)) return { skip: 'ended' };
  const post = postIdentity(entry.link);
  if (!post) return { skip: 'missing_url' };
  const postedAt = parsePostedAt(entry.pubDate, nowMs);
  if (!postedAt) return { skip: 'invalid_posted_at' };

  const mallMatch = rawTitle.match(/^\[([^\]]{1,40})\]\s*/);
  const rest = mallMatch ? rawTitle.slice(mallMatch[0].length) : rawTitle;
  const tail = rest.match(/^(.+?)\s*\(([^()]*)\)\s*$/);
  if (!tail) return { skip: 'missing_price' };
  const name = HD.cleanTitle(tail[1], 200);
  if (name.length < 2) return { skip: 'missing_title' };
  const priced = parsePriceGroup(tail[2]);
  if (priced.error) return { skip: priced.error };

  return {
    item: {
      externalId: post.externalId,
      title: name,
      price: priced.price,
      mall: mallMatch ? normalizeMall(mallMatch[1]) : '',
      productUrl: '',
      postUrl: post.postUrl,
      imageUrl: '',
      postedAt,
      metadata: {
        board: BOARD_ID,
        rawTitle,
        priceIsFrom: priced.priceIsFrom,
        priceHasCondition: priced.priceHasCondition,
        shippingFee: priced.shippingFee,
        shippingNote: priced.shippingNote
      }
    }
  };
}

/* ── HTTP ────────────────────────────────────────────────────────── */

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function header(res, name) {
  return res && res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null;
}

async function readBody(res) {
  if (Number(header(res, 'content-length')) > MAX_BYTES) {
    throw new SourceError('too_large', 'feed exceeds size cap', { retryable: false });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new SourceError('too_large', 'feed exceeds size cap', { retryable: false });
  const declared = (String(header(res, 'content-type') || '').match(/charset=([\w-]+)/i) || [])[1]
    || (buf.subarray(0, 200).toString('latin1').match(/encoding=["']([\w-]+)/i) || [])[1]
    || 'utf-8';
  try { return new TextDecoder(declared.toLowerCase()).decode(buf); }
  catch (_) { return new TextDecoder('utf-8').decode(buf); }
}

class PpomppuRssAdapter extends HotdealSourceAdapter {
  constructor(options) {
    super({ id: 'ppomppu', label: '뽐뿌', kind: 'rss' });
    const o = options || {};
    this.feedUrl = FEED_URL;
    this.fetchImpl = o.fetch || null;
    this.timeoutMs = o.timeoutMs || TIMEOUT_MS;
    this.retryDelayMs = o.retryDelayMs == null ? RETRY_DELAY_MS : o.retryDelayMs;
    this.minIntervalMs = o.minIntervalMs == null ? MIN_INTERVAL_MS : o.minIntervalMs;
    this.now = o.now || Date.now;
    this.lastRequestAt = 0;
  }

  enabled() { return process.env.EXTERNAL_HOTDEAL_PPOMPPU_ENABLED === '1'; }

  async request() {
    const doFetch = this.fetchImpl || globalThis.fetch;
    if (typeof doFetch !== 'function') throw new SourceError('network', 'fetch is unavailable', { attempts: 0 });
    const since = this.now() - this.lastRequestAt;
    if (this.lastRequestAt && since < this.minIntervalMs) {
      throw new SourceError('local_rate_limit', `previous request ${Math.round(since / 1000)}s ago`, { attempts: 0 });
    }
    this.lastRequestAt = this.now();

    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await doFetch(this.feedUrl, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8' }
        });
        const status = Number(res && res.status) || 0;
        if (status === 429) throw new SourceError('http_429', 'rate limited by source', { httpStatus: status, retryable: false });
        if (status >= 500) throw new SourceError('http_5xx', `HTTP ${status}`, { httpStatus: status, retryable: true });
        if (status < 200 || status >= 300) throw new SourceError('http_4xx', `HTTP ${status}`, { httpStatus: status, retryable: false });
        const body = await readBody(res);
        return { body, httpStatus: status, attempts: attempt };
      } catch (error) {
        const aborted = controller.signal.aborted
          || (error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
        const failure = error instanceof SourceError ? error
          : aborted ? new SourceError('timeout', `no response within ${this.timeoutMs}ms`, { retryable: false })
            : new SourceError('network', 'network error', { retryable: true });
        failure.attempts = attempt;
        if (!failure.retryable || attempt >= 2) throw failure;
        await sleep(this.retryDelayMs);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async fetch() {
    const { body, httpStatus, attempts } = await this.request();
    let raw;
    try { raw = parseRss(body); } catch (error) { error.httpStatus = httpStatus; error.attempts = attempts; throw error; }
    const nowMs = this.now();
    const items = [];
    const skipped = {};
    for (const entry of raw) {
      const parsed = parseItem(entry, nowMs);
      if (parsed.item) items.push(parsed.item);
      else skipped[parsed.skip] = (skipped[parsed.skip] || 0) + 1;
    }
    return { items, skipped, meta: { httpStatus, attempts, rawCount: raw.length } };
  }
}

const adapter = new PpomppuRssAdapter();
adapter.PpomppuRssAdapter = PpomppuRssAdapter;
adapter._internal = {
  FEED_URL, USER_AGENT, parseRss, parseItem, parsePriceGroup, parseShipping, parsePostedAt, postIdentity, decodeEntities
};
module.exports = adapter;
