'use strict';

/*
 * Digital courses/services can share physical-device search terms.
 * Prevent their prices from becoming the minimum for a hardware search.
 *
 * Only bare device-category queries are filtered. Searches such as
 * "노트북 강의", "노트북LM" and "노트북 거치대" remain unmodified.
 * This is response curation only, not a change to collection/history.
 */
const PHYSICAL_DEVICE_QUERIES = new Set([
  '노트북', '랩탑', '맥북', 'laptop', 'notebook', 'macbook',
  '태블릿', '아이패드', 'tablet', 'ipad',
  '스마트폰', '핸드폰', '휴대폰', 'smartphone',
  '이어폰', '헤드폰', 'headphones', 'earphones',
  '모니터', 'monitor', '프린터', 'printer',
  '카메라', 'camera'
]);

const DIGITAL_SERVICE_MALLS = new Set([
  '크몽', '인프런', '탈잉', '클래스101', 'class101', '패스트캠퍼스'
]);

// Avoid broad words like '학습용' / '인강용': these can describe real laptops.
const DIGITAL_PRODUCT_TITLE = /(?:노트북\s*lm|notebook\s*lm|전자책|e[ -]?book|\bebook\b|온라인\s*(?:강의|강좌|클래스)|동영상\s*강의|강의\s*수강|인터넷\s*강의|강좌|\bpdf\s*(?:교재|책)\b|\[도서\]|\[전자책\])/i;

function normalize(value) {
  return String(value == null ? '' : value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function filterPhysicalSearchResults(keyword, items) {
  const list = Array.isArray(items) ? items : [];
  const query = normalize(keyword).replace(/\s+/g, '');
  if (!PHYSICAL_DEVICE_QUERIES.has(query)) return list;

  return list.filter(item => {
    if (!item) return false;
    const mall = normalize(item.mallLabel || item.mall || '');
    if (DIGITAL_SERVICE_MALLS.has(mall)) return false;
    return !DIGITAL_PRODUCT_TITLE.test(normalize(item.title));
  });
}

module.exports = { filterPhysicalSearchResults };
