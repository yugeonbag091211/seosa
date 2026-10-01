'use strict';

/*
 * Offline adversarial fixtures, not captured provider/catalog results.
 * A = requested main product; B = same head, another family/model;
 * C = accessory/compatible part; D = unrelated.
 * Prices intentionally favor accessories to expose relevance saturation.
 * Brand names live in test data only; production must work for unknown heads.
 */
function item(id, title, label, lprice, mall = '쿠팡') {
  return { productId: id, title, label, lprice, mall,
    mallLabel: mall === 'ADPICK' ? '알리' : mall,
    trust: { level: 'high', score: 100 }, link: `https://fixture.invalid/${id}` };
}
function group(query, rows) {
  return { query, items: rows.map((r, i) => item(`${query}-${i}`, ...r)) };
}

const brands = [
  group('삼성', [
    ['삼성전자 갤럭시 S26 자급제 SM-S942N', 'A', 1150000],
    ['삼성전자 갤럭시 A37 자급제 SM-A376N', 'A', 480000],
    ['삼성전자 갤럭시 버즈3 FE 블루투스 이어폰', 'A', 159000],
    ['삼성전자 갤럭시북6 노트북', 'A', 1690000],
    ['삼성전자 OLED TV 65인치', 'A', 2250000],
    ['삼성전자 비스포크 냉장고', 'A', 1950000],
    ['[해외] JC97-04574A HP LaserJet Managed 삼성 K7 시리즈용 레이저 스캐너 어셈블리', 'C', 49000, 'ADPICK'],
    ['[해외] 삼성 CLX-9201 카세트 브래킷 서브 리프팅 베벨 기어', 'C', 12000, 'ADPICK'],
    ['삼성 MLT-D758S 정품토너 검정', 'C', 19000, 'ADPICK'],
    ['삼성 정품토너 MLT-K250L', 'C', 25000],
    ['ABC 삼성 프린터용 호환 토너 카트리지', 'C', 3900, 'ADPICK'],
    ['Compatible replacement scanner for 삼성 K7 printer', 'C', 9900],
    ['대나무 주방 도마', 'D', 500]
  ]),
  group('애플', [
    ['애플 아이폰 17 자급제 256GB', 'A', 1290000],
    ['애플 아이폰 17 프로 자급제', 'A', 1790000],
    ['애플 에어팟 프로3 블루투스 이어폰', 'A', 359000],
    ['애플 아이패드 에어 태블릿', 'A', 949000],
    ['애플 맥북 에어 노트북', 'A', 1690000],
    ['애플 워치 스마트워치', 'A', 579000],
    ['ABC 애플 아이폰용 호환 케이스', 'C', 1900, 'ADPICK'],
    ['애플 아이폰 17 강화유리 보호필름', 'C', 3900],
    ['Replacement battery compatible with 애플 아이폰', 'C', 7900, 'ADPICK'],
    ['애플 에어팟 실리콘 케이스', 'C', 5900],
    ['ABC 애플 맥북 전용 충전기', 'C', 15900],
    ['나무 식탁', 'D', 500]
  ]),
  group('LG', [
    ['LG전자 그램 14 노트북 14ZD95U', 'A', 1799000],
    ['LG전자 그램 프로16 노트북', 'A', 2099000],
    ['LG전자 OLED TV 65인치', 'A', 2499000],
    ['LG전자 오브제 냉장고', 'A', 1699000],
    ['LG전자 트롬 세탁기', 'A', 1299000],
    ['LG전자 퓨리케어 공기청정기', 'A', 499000],
    ['LG 그램 14ZD95U 키스킨', 'C', 3900],
    ['ABC LG 노트북용 호환 충전기', 'C', 9900, 'ADPICK'],
    ['LG 냉장고 replacement filter 호환 필터', 'C', 4900],
    ['HP LG 프린터용 교체 토너', 'C', 5900, 'ADPICK'],
    ['Compatible battery for LG 그램 laptop', 'C', 8900],
    ['우드 수저통', 'D', 500]
  ]),
  group('소니', [
    ['소니 WH-1000XM6 무선 노이즈캔슬링 헤드폰', 'A', 549000],
    ['소니 WF-1000XM5 블루투스 이어폰', 'A', 249000],
    ['소니 알파 A7M4 미러리스 카메라', 'A', 2790000],
    ['소니 플레이스테이션5 게임 콘솔', 'A', 698000],
    ['소니 BRAVIA TV', 'A', 1990000],
    ['소니 SRS 휴대용 블루투스 스피커', 'A', 159000],
    ['ABC 소니 카메라용 호환 배터리', 'C', 3900, 'ADPICK'],
    ['소니 WH-1000XM6 교체 이어패드', 'C', 5900],
    ['Replacement battery compatible with 소니 카메라', 'C', 1900],
    ['소니 플레이스테이션5 전용 보호 케이스', 'C', 7900],
    ['ABC 소니 WH-1000XM6 전용 충전 케이블', 'C', 2900, 'ADPICK'],
    ['원목 책상', 'D', 500]
  ]),
  group('다이슨', [
    ['다이슨 V15 무선 청소기', 'A', 699000],
    ['다이슨 V12 무선 청소기', 'A', 599000],
    ['다이슨 에어랩 멀티 스타일러', 'A', 549000],
    ['다이슨 슈퍼소닉 헤어드라이어', 'A', 399000],
    ['다이슨 빅앤콰이엇 공기청정기', 'A', 1099000],
    ['다이슨 WashG1 물청소기', 'A', 799000],
    ['샤오미 다이슨 호환 청소기 필터', 'C', 2900, 'ADPICK'],
    ['다이슨 V15 교체용 브러시 헤드', 'C', 4900],
    ['Replacement filter compatible with 다이슨 V12', 'C', 1900],
    ['ABC 다이슨 청소기 전용 배터리', 'C', 7900],
    ['다이슨 에어랩 보관 케이스', 'C', 5900],
    ['일반 주방 그릇', 'D', 500]
  ]),
  group('나이키', [
    ['나이키 에어맥스 운동화', 'A', 159000],
    ['나이키 페가수스 러닝화', 'A', 139000],
    ['나이키 드라이핏 트레이닝 티셔츠', 'A', 39000],
    ['나이키 스포츠 반바지', 'A', 49000],
    ['나이키 축구화', 'A', 99000],
    ['나이키 스포츠 백팩', 'A', 59000],
    ['ABC 나이키 운동화용 replacement 깔창', 'C', 900, 'ADPICK'],
    ['나이키 호환 운동화 교체용 신발끈', 'C', 1500],
    ['ABC 나이키 신발 전용 보호 커버', 'C', 2900],
    ['Replacement sole compatible with 나이키 운동화', 'C', 4900],
    ['나이키 신발용 수선 부품', 'C', 3900],
    ['대나무 도마', 'D', 500]
  ])
];

const families = [
  group('아이폰', [['애플 아이폰 17 자급제 256GB', 'A', 1200000], ['애플 아이패드 태블릿', 'B', 600000], ['ABC 아이폰 17 전용 케이스', 'C', 500], ['ABC compatible replacement battery for 아이폰', 'C', 900], ['삼성 냉장고', 'D', 100]]),
  group('갤럭시', [['삼성전자 갤럭시 S26 자급제', 'A', 1100000], ['삼성전자 갤럭시 버즈3 이어폰', 'A', 159000], ['삼성전자 비스포크 냉장고', 'B', 1900000], ['ABC 갤럭시 S26 전용 강화유리 보호필름', 'C', 1000], ['HP LaserJet 갤럭시용 scanner assembly replacement', 'C', 900], ['나무 식탁', 'D', 100]]),
  group('에어팟', [['애플 에어팟 프로3 블루투스 이어폰', 'A', 359000], ['애플 아이폰17 스마트폰', 'B', 1200000], ['ABC 에어팟 전용 실리콘 케이스', 'C', 1000], ['ABC replacement ear tips compatible with 에어팟', 'C', 900], ['원목 책상', 'D', 100]]),
  group('그램', [['LG전자 그램 14 노트북 14ZD95U', 'A', 1799000], ['LG전자 OLED TV', 'B', 1900000], ['그램 노트북 키스킨', 'C', 500], ['ABC 그램 노트북용 호환 충전기', 'C', 900], ['대나무 도마', 'D', 100]]),
  group('플레이스테이션', [['소니 플레이스테이션5 게임 콘솔', 'A', 690000], ['소니 WH-1000XM6 헤드폰', 'B', 549000], ['ABC 플레이스테이션 전용 거치대', 'C', 500], ['ABC replacement cable compatible with 플레이스테이션', 'C', 900], ['원목 식탁', 'D', 100]]),
  group('청소기', [['다이슨 V15 무선 청소기', 'A', 690000], ['LG 코드제로 무선 청소기', 'A', 590000], ['로보락 로봇 청소기', 'A', 1290000], ['ABC 청소기용 호환 필터', 'C', 500], ['ABC replacement battery for 청소기', 'C', 900], ['나무 도마', 'D', 100]])
];

const brandProducts = [
  group('삼성 갤럭시', [['삼성전자 갤럭시 S26 자급제', 'A', 1200000], ['삼성전자 OLED TV', 'B', 900000], ['ABC 삼성 갤럭시용 호환 케이스', 'C', 900], ['대나무 도마', 'D', 100]]),
  group('애플 아이폰', [['애플 아이폰17 자급제', 'A', 1200000], ['애플 맥북 노트북', 'B', 1900000], ['ABC 애플 아이폰 전용 케이스', 'C', 900], ['나무 도마', 'D', 100]]),
  group('소니 헤드폰', [['소니 WH-1000XM6 무선 헤드폰', 'A', 549000], ['소니 알파 카메라', 'B', 1200000], ['ABC 소니 헤드폰 교체용 이어패드', 'C', 900], ['원목 책상', 'D', 100]])
];

const models = [
  group('SM-S942N', [['삼성전자 갤럭시 S26 자급제 SM-S942N', 'A', 1200000], ['삼성전자 갤럭시 S26 자급제 SM-S941N', 'B', 950000], ['ABC SM-S942N 호환 케이스', 'C', 900], ['Replacement display compatible with SM-S942N', 'C', 1200], ['대나무 도마', 'D', 100]]),
  group('WH-1000XM6', [['소니 WH-1000XM6 무선 헤드폰', 'A', 549000], ['소니 WH-1000XM5 무선 헤드폰', 'B', 349000], ['소니 WH-1000XM6 전용 보호 케이스', 'C', 900], ['ABC replacement earpads compatible with WH-1000XM6', 'C', 1200], ['우드 책상', 'D', 100]]),
  group('14ZD95U', [['LG전자 그램 14 노트북 14ZD95U-GX56K', 'A', 1799000], ['LG전자 그램16 노트북 16Z95U', 'B', 1699000], ['LG 그램 14ZD95U 키스킨', 'C', 900], ['ABC replacement battery compatible with 14ZD95U', 'C', 1200], ['대나무 도마', 'D', 100]])
];

const accessories = [
  group('아이폰 케이스', [['애플 아이폰17 자급제', 'A', 1200000], ['아이폰17 전용 케이스 투명', 'C', 6900], ['삼성 갤럭시용 케이스', 'D', 500], ['아이폰17 강화유리 보호필름', 'B', 900]]),
  group('삼성 토너', [['삼성전자 갤럭시 S26 자급제', 'A', 1200000], ['삼성 정품토너 MLT-K250L', 'C', 35000], ['삼성 프린터용 호환 토너 MLT-D758S', 'C', 5900], ['HP 정품토너 카트리지', 'D', 900], ['삼성 프린터 부품 기어', 'B', 500]]),
  group('다이슨 필터', [['다이슨 V15 무선 청소기', 'A', 690000], ['다이슨 V15 정품 필터', 'C', 49000], ['ABC 다이슨 청소기용 호환 필터', 'C', 5900], ['LG 청소기 필터', 'D', 500], ['다이슨 V15 호환 배터리', 'B', 900]]),
  group('소니 배터리', [['소니 알파 A7M4 카메라', 'A', 1200000], ['소니 카메라용 정품 배터리 NP-FZ100', 'C', 95000], ['ABC 소니 카메라용 호환 배터리', 'C', 5900], ['캐논 카메라 배터리', 'D', 500], ['소니 WH-1000XM6 헤드폰', 'B', 549000]]),
  group('LG 충전기', [['LG전자 그램14 노트북', 'A', 1700000], ['LG 노트북 정품 충전기 65W', 'C', 39000], ['ABC LG 노트북용 호환 충전기', 'C', 5900], ['애플 아이폰 충전기', 'D', 500], ['LG OLED TV', 'B', 1500000]])
];

const longtails = [
  group('벤트론스', [['벤트론스 무선 청소기 Z800', 'A', 390000], ['ABC 벤트론스용 호환 필터', 'C', 900], ['Replacement battery compatible with 벤트론스 Z800', 'C', 500], ['대나무 도마', 'D', 100]]),
  group('ORBITON', [['ORBITON wireless headphones OX900', 'A', 290000], ['ABC compatible replacement battery for ORBITON', 'C', 500], ['ORBITON headphone replacement earpads', 'C', 900], ['wood cutting board', 'D', 100]]),
  group('태블릿나라', [['태블릿나라 스마트 태블릿 T900', 'A', 190000], ['ABC 태블릿나라용 보호필름', 'C', 500], ['태블릿나라 태블릿 전용 케이스', 'C', 900], ['대나무 도마', 'D', 100]])
];

const bundles = [
  group('에어팟', [['케이스 포함 애플 에어팟 프로3 블루투스 이어폰', 'A', 359000], ['에어팟 프로3 블루투스 이어폰 케이스 포함', 'A', 359000], ['ABC 에어팟 프로3 전용 케이스', 'C', 500]]),
  group('다이슨', [['다이슨 V15 무선 청소기 필터 포함', 'A', 690000], ['다이슨 V15 무선 청소기 배터리 증정', 'A', 690000], ['ABC 다이슨 V15 전용 필터', 'C', 500]])
];

module.exports = { item, group, brands, families, brandProducts, models, accessories, longtails, bundles };
