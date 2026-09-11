# SEOSA 핫딜 UX 작업 보고서

> **2026-09-11 — 이 문서의 UI는 제거됐다.** 홈의 «오늘의 핫딜» 섹션과 `/hotdeals.html`(`hotdeals.js` · `hotdeals.css` · `hot-cards.css` · `hot-view.js`)을 지웠다.
> 사용자에게 «핫딜»은 이제 홈의 가격 하락 섹션(`#priceDrop`, 구 «최근 가격이 내려간 상품»)이다 — 데이터는 그대로 `/api/init` → `price_drop_top` → `todayDropConfirmed`.
> 엔진·군집·수집기(`_hotdeal` · `_hotgroup` · `_hotsource` · `_adpickhot` · `collect-hotdeals`)와 `hotdeals` 표는 레이더 HOT_DEAL 신호가 읽으므로 남긴다. `/api/hotdeals`는 화면 소비자가 없지만 삭제하지 않았다.

## 1. UX 감사 결과

기준: `feat/seosa-hot-v1`, `37d41622f5cb74083bad6babacb34e44e31332d7`. 원본 작업 트리는 깨끗했다. Claude와 동시 작업 충돌을 피하기 위해 별도 로컬 복제본의 `feat/hotdeal-ux`에서 작업했다. 저장소 내 AGENTS.md는 발견되지 않았다.

| 수정 전 확인 항목 | 감사 결과 |
|---|---|
| 진입점 / 탐색 | 데스크톱 span 클릭으로 홈 섹션 스크롤. 900px 이하에서 숨겨지며 모바일 메뉴 대체 경로 없음. |
| 핫딜 페이지 | 전용 페이지 없음. 홈에 최대 12개만 노출. |
| 모바일 / 데스크톱 | 브라우저에서 모바일 메뉴 누락과 데스크톱 텍스트 진입점 확인. 기존 카드는 auto-fill 그리드. |
| 상품 카드 | 이미지보다 배지·원시 점수가 먼저이며 상품명이 가격보다 뒤에 위치. article 클릭은 기본 키보드 링크가 아님. |
| 상품 상세 | productId가 있으면 /p/{id}, 없으면 /api/hotdeals JSON으로 이동. |
| 가격 그래프 | 기존 /p/{id}의 서버 렌더링 가격 그래프와 홈 가격 추이 기능 존재. |
| Coupang / ADPICK | 판매처와 제휴 링크 존재. 홈에 쿠팡 고지, 기존 상세에 제휴 고지 존재. |
| 상태 UI | 로딩·빈 목록은 있지만 오류 시 섹션 전체를 숨김. |
| 접근성 | 클릭 전용 핫딜 카드와 span 탐색에 키보드 접근 문제. 기존 focus 및 테마 기반 의미색 있음. |
| 디자인 시스템 | 흰색 / 쿨 다크, 무채색 규칙선, 하락 초록, S 로고, 기존 CSS 변수와 시스템 폰트 사용 가능. |
| 다크모드 | data-theme 및 seosa_theme 저장값 기반. |
| API | 목록: id/status/score/title/image/mall/price/reason/productId/url/checkedAt. 상세: reasons/observations/spanDays/median30/observedLow 등. |

이미 구현된 목록 API·판정·기존 상세·그래프를 재사용한다. 발견성, JSON 이동, 근거 위계, 오류 복구, 반응형과 키보드 접근을 이번 범위로 정했다.

## 2. 가장 큰 문제

모바일에서 발견하기 어렵고, 일부 카드가 사용자용 상세 대신 JSON으로 이동했다. 검증 중인 상품까지 “검증된 핫딜” 아래 표시되어 신뢰 수준 구분도 약했다.

## 3. 변경한 사용자 흐름

홈의 작은 상시 링크 / 데스크톱 메뉴 / 모바일 메뉴 → 전용 핫딜 목록 → 가격 근거 상세 → 기존 상품 상세·가격 그래프 또는 판매처 확인.

새 목록 주소는 `/hotdeals.html`, 근거 상세는 `/hotdeals.html?id=…`다. 카드 전체가 기본 HTML 링크여서 Enter, 새 탭 열기, 뒤로 가기를 지원한다. productId가 없는 상품도 SEOSA 안에서 근거를 먼저 확인한다.

## 4. 핫딜 카드 구조

이미지 → 상품명 → 현재 관측 가격 → 서버가 제공한 이유 → 한국어 검증 상태 → 판매처·확인 시각.

원시 점수는 제거했다. 없는 금액을 0원으로 표시하지 않는다. 이미지 공간을 예약하고 lazy loading을 사용한다. 가격 하락 금액·비율은 현재 별도 API 필드가 없으므로 만들어내지 않는다.

## 5. 모바일 개선

360 / 390 / 430px에서 2열, 768px에서 3열, 1440px에서 4열. 긴 이름은 두 줄로 제한하고 상세에서는 전체 표시한다. 가격과 근거는 줄바꿈 가능하며 배지·메타데이터가 겹치지 않도록 했다. 주요 탐색·정렬·버튼은 44px 이상 터치 영역, 키보드 포커스, reduced motion을 지원한다.

## 6. 신뢰성 개선

“가격 검증됨 / 좋은 가격 / 추가 확인 중”으로 상태를 설명한다. 확인 시각, 관측 횟수·기간, 최근 30일 중앙값, 관측 최저가는 실제 값이 있을 때만 표시한다. 중앙값을 평균가라고 바꾸지 않는다. 전체 상품 수처럼 오해하지 않도록 “N개 표시 중”을 쓴다. 쿠팡·ADPICK 제휴 및 최종 결제 조건 고지를 제공한다.

## 7. Claude API와 연결한 부분

GET /api/hotdeals의 score/recent/price 정렬, cursor 페이지 추가, GET /api/hotdeals?id 상세를 연결했다. 판정·HOT SCORE·수집·가격 이력·상품 통합 로직은 변경하지 않았다.

현재 API에 다중 판매처 목록과 하락 금액·비율 필드가 없으므로 해당 비교 UI는 숨긴다. 가격 그래프는 productId와 mall을 보존해 기존 /p/ 상세로 연결한다. 상품 ID가 없으면 그래프 링크도 숨긴다. 기존 AI 기능은 유지하며 근거 없는 새 AI 진입 흐름을 만들지 않았다.

## 8. 테스트 결과

- 기존 package.json의 test 체인 및 test:regression / test:release: 41개 스크립트 모두 통과.
- 추가 test-hotdeal-ui.js: HTML escape, 위험 URL, 누락 가격, 내부 상세 링크, empty/error/retry, 페이지 추가 실패 복구, 중복 재표시 방지, 정렬 응답 경합, 근거 조건부 표시, 404 통과. 기본 test 체인에 포함했다.
- 신규 JS와 홈 인라인 JS 문법 검사, git diff --check 통과.
- 브라우저: 1440/768/430/390/360px에서 가로 overflow 없음. 홈 진입, 목록, 상세, 판매처, 누락 이미지·가격·시간, empty/error/loading 및 재시도 성공, 정렬, 다크모드, Enter 상세 진입, Tab 포커스 확인.
- 신규 핫딜 페이지 최종 브라우저 콘솔 error 0건.

검증 한계: 브라우저 화면 검증은 운영과 분리한 로컬 fixture 서버의 `[UX 테스트]` 데이터로 진행했다. 테스트 서버·데이터는 제품 코드에 포함하지 않았다. 운영 DB / 실판매처 결제 / 운영 상품 그래프의 실제 데이터 로딩은 검증하지 않았다. 기존 상품 상세·가격 그래프는 기존 테스트 통과와 연결 URL 확인으로 회귀를 확인했다. Lighthouse 점수 및 스크린리더 실기기는 측정하지 않았다.

## 9. Before / After 요약

| Before | After |
|---|---|
| 모바일 핫딜 메뉴 누락 | 홈 상시 링크와 모바일 메뉴 |
| 홈 12개 목록만 존재 | 전용 목록·API 정렬·더 보기 |
| productId 없으면 JSON | SEOSA 근거 상세 |
| 원시 HOT 점수 노출 | 서버 이유·한국어 상태 |
| 오류 시 섹션 사라짐 | 안내와 재시도 |
| 클릭 전용 article | 기본 링크와 포커스 |

## 10. 변경 파일

- public/index.html: 홈 탐색·프리뷰·오류 복구
- public/hotdeals.html: 전용 목록·상세 화면 뼈대
- public/hotdeals.js: API 요청·상태·정렬·상세 표시
- public/hotdeals.css: 페이지 스타일
- public/hot-cards.css: 홈과 전용 페이지의 공유 카드·반응형 스타일
- public/hot-view.js: 안전한 공통 카드·가격·시각 표시
- public/hot-theme.js: 기존 테마 설정 재사용
- scripts/test-hotdeal-ui.js: UI 동작 회귀 테스트
- package.json: UI 테스트 등록
- docs/hotdeal-ux.md: 감사·구현·검증 기록

## 11. 커밋 SHA

커밋 후 전달 보고서에 기록한다. 작업은 별도 로컬 브랜치에서 커밋까지만 진행하며 push, merge, production 배포는 하지 않는다.
