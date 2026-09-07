# Growth UX 작업 보고서

## 1. Growth UX audit

기준 커밋은 `5703f453fc9509a29828aa9e0ce5877dbcb57247`이다. 기존 홈에는 검색 카드 저장과 위시리스트 패널, 가격 알림, 가격 그래프가 있었고 서버 상품 상세에는 구매 판정이 있었다. 핫딜과 서버 상품 상세에서는 저장할 수 없었고, 저장 화면은 목표가격이나 재방문 시 가격 변화를 중심으로 구성되지 않았다. 저장 취소도 측정되지 않았다.

## 2. 새 사용자 흐름

검색·핫딜·상품 상세 → 저장 → 내 레이더 → 목표가격 설정 → 가격 변화와 서버 판정 확인 → 상품 상세·가격 그래프 → 구매처 확인으로 연결했다.

## 3. Radar

기존 `seosa_wishlist` 데이터를 그대로 읽는 `/radar.html`을 추가했다. 목표 도달, 저장 뒤 가격 하락, 지켜보는 상품으로 나누고 실제 저장 데이터가 있을 때만 변화 개수를 표시한다. 비어 있으면 짧은 설명과 상품 탐색 링크만 보인다.

## 4. 목표가격

레이더 항목에서 숫자를 설정·수정·삭제할 수 있다. 브라우저 저장소에 남아 새로고침 뒤에도 유지된다. 이메일이나 푸시 알림을 약속하지 않고 SEOSA에서 확인하는 목표가격으로 표현했다. 기존 이메일 가격 알림은 별도 기능으로 유지했다.

## 5. BUY/WAIT/WATCH

서버 상품 상세의 `dealOf()` 판정과 이유를 그대로 저장 항목에도 보존한다. 프론트에서 판정이나 좋은 구매 가격을 계산하지 않는다. 판정 상세 노출 이벤트를 추가했다.

## 6. 대체상품/AI 비교

기존 서버가 같은 검색어로 돌려주는 상품을 최대 3개로 줄여 “비슷한 가격의 다른 선택”으로 노출하고 열기 이벤트를 측정한다. 현재 계약에는 핵심 차이와 사양 근거가 없으므로 AI 비교를 가장한 프롬프트나 차이 문구를 생성하지 않았다. `goodBuyPrice`, `unitPrice`도 계약에 없어 숨겼다.

## 7. 재방문 UX

내 레이더를 홈 패널과 모바일 메뉴에서 찾을 수 있다. 저장 당시 가격과 현재가격이 다를 때만 변화 문구가 나오며, 목표에 도달한 상품을 먼저 보여준다. 가짜 badge나 urgency는 없다.

## 8. 구매전환 UX

상품 판단과 저장을 구매처 이동보다 먼저 제공한다. 구매처 버튼은 판매처 이름을 유지하며 제휴 링크 속성과 가격 출처 고지를 보존했다.

## 9. Analytics

기존 fire-and-forget 카운터 계약에 `product_save`, `product_unsave`, `target_price_set`, `target_price_delete`, `decision_view`, `alternative_open`, `affiliate_click`을 추가했다. 링크 기본 동작을 가로채지 않으므로 middle click과 새 탭이 유지된다.

## 10. Responsive/accessibility

360, 390, 430, 768, 1440px에서 가로 overflow가 없음을 확인했다. 모바일에서 목표가격 입력과 버튼은 44px 이상이며 한 열로 재배치된다. landmark, heading, label, focus-visible, aria-pressed, status와 reduced motion을 적용했다. 다크모드에서 빈 레이더를 확인했다.

## 11. 테스트

기존 `test`, `test:regression`, `test:release` 전체가 통과했고 별도 레이더 테스트도 통과했다. 상품 페이지 53개 검증, 핫딜 UI, 신규 JavaScript 문법, 홈 인라인 스크립트, `git diff --check`를 통과했다. 브라우저에서는 빈 상태·다크모드·5개 화면 폭을 확인했다. 로컬에 운영 DB 자격증명이 없어 실제 저장 상품 카드의 브라우저 화면과 운영 가격 갱신은 단위 테스트로 검증했다.

## 12. 변경 파일

- `public/radar.html`, `public/radar.css`, `public/radar.js`, `public/radar-store.js`
- `public/index.html`
- `public/hotdeals.html`, `public/hotdeals.js`, `public/hot-cards.css`
- `api/_product-page.js`, `api/_analytics.js`
- `scripts/test-radar-ui.js`, `package.json`

## 13. commit SHA

커밋 후 최종 보고에 기록한다. push, merge, deploy, production migration은 수행하지 않는다.
