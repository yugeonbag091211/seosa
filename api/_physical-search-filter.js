'use strict';

/*
 * Digital courses/services and "experience"/workshop listings can share
 * physical-product search terms word-for-word (not a coincidental
 * substring match — see api/_search.js for that bug class). A title can
 * contain the exact, correctly-spelled query and still not be selling
 * the physical item: an eBook *about* a 그래픽카드, or a craft workshop
 * that teaches you to make an 에어팟케이스 among several other trinkets.
 * Prevent these from becoming/polluting results for a hardware search.
 *
 * 2026-11-26: broadened from "digital courses only" to also catch
 * location-tagged experience/workshop listings (Codex-reported FAILs
 * for "그래픽카드" → eBook, "케이스" → 가죽공방 체험).
 *
 * Only bare device/accessory-category queries are filtered. Searches
 * such as "노트북 강의", "노트북LM" and "노트북 거치대" remain unmodified.
 * This is response curation only, not a change to collection/history.
 */
const PHYSICAL_DEVICE_QUERIES = new Set([
  '노트북', '랩탑', '맥북', 'laptop', 'notebook', 'macbook',
  '태블릿', '아이패드', 'tablet', 'ipad',
  '스마트폰', '핸드폰', '휴대폰', 'smartphone',
  '이어폰', '헤드폰', 'headphones', 'earphones',
  '모니터', 'monitor', '프린터', 'printer',
  '카메라', 'camera',
  '그래픽카드', 'gpu', '케이스', 'case'
]);

const DIGITAL_SERVICE_MALLS = new Set([
  '크몽', '인프런', '탈잉', '클래스101', 'class101', '패스트캠퍼스',
  '프립', 'frip', '마이리얼트립'
]);

// Avoid broad words like '학습용' / '인강용': these can describe real laptops.
const DIGITAL_PRODUCT_TITLE = /(?:노트북\s*lm|notebook\s*lm|전자책|e[ -]?book|\bebook\b|온라인\s*(?:강의|강좌|클래스)|동영상\s*강의|강의\s*수강|인터넷\s*강의|강좌|\bpdf\s*(?:교재|책)\b|\[도서\]|\[전자책\])/i;

/*
 * "체험"/원데이클래스/공방 같은 오프라인 만들기 체험 상품 제목.
 * "[서울/중구] 가죽 소품 만들기 카드지갑, 네임택, ..., 에어팟케이스, ..."
 * 처럼 지역 태그([시/구] 형태)나 "소품 만들기"/"원데이클래스"/"체험 공방"
 * 같은 표현이 있으면, 제목에 검색어가 그대로 들어있어도 실제로는 그 물건
 * 하나를 파는 게 아니라 여러 가지를 만들어보는 체험 상품이다. 흔한
 * 상품명에도 있을 수 있는 "체험판" 같은 단어는 포함하지 않도록 범위를
 * 좁혀서 정의한다.
 */
const EXPERIENCE_LISTING_TITLE = /(?:\[[^\]]{1,12}\/[^\]]{1,12}\]|원데이\s*클래스|소품\s*만들기|공방\s*(?:체험|클래스|수업)|체험\s*(?:공방|클래스|수업))/;

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
    const title = normalize(item.title);
    if (DIGITAL_PRODUCT_TITLE.test(title)) return false;
    return !EXPERIENCE_LISTING_TITLE.test(title);
  });
}

module.exports = { filterPhysicalSearchResults };
