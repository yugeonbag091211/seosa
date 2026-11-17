# SEOSA Hallmark 리디자인 — 2026-11-18

## 작업 선택

- **Redesign** · full · 앱과 주요 공개 페이지 전체
- **Before** · 기존 사이트는 밝은 배경의 가격 원장 스타일과 장식 캐러셀을 사용했다. 주요 SPA 기능과 표시 데이터는 유지한다.
- **Keeps** · 기존 경로, 링크, 폼, 핸들러, DOM ID, API 호출, 가격/검색/추천 데이터 바인딩, 분석 호출, 제휴 고지, 법률 문구
- **Files** · 스타일 교체: `public/index.html`, `public/radar.css`, `public/privacy.html`, `public/terms.html`, `public/support.html`, `api/_product-page.js`, `api/_seo-pages.js`; 공유 스타일 신규: `public/css/tokens.css`, `public/css/base.css`, `public/css/app.css`, `public/css/content.css`; 회귀 검사 계약을 공유 CSS 구조에 맞게 갱신; 페이지 링크 연결: `public/radar.html`; 기록: 이 문서
- **Dropped** · 라우트나 기능 없음. 기존 캐러셀의 장식 SVG는 소스와 DOM에 유지하고 새 테마에서는 표시하지 않는다.

## 조사한 화면과 경로

| 화면 | 경로 / 소스 | 보존할 동작 |
| --- | --- | --- |
| 홈·추천·핫딜·검색 | `/`, `/?q=`, `public/index.html` | `#q`, 자동완성, 인기/추천/최근 본 상품, 핫딜, 검색/판매처/신뢰/배송 필터와 정렬 |
| 가격 기록 상세 | `/?p=`, `public/index.html` | 7/30/90일·전체 그래프, 판정/신뢰 정보, 판매처 비교, 알림, AI 연결, 구매 이동 |
| AI 쇼핑 | 홈/상품/비교 화면의 서사 AI 패널 | 질문, 대화 및 추천 카드, 구매 링크 |
| 개인 영역 | 프로필·내 레이더 패널, `/radar.html` | 취향 저장, 찜/동기화, 목표 가격, 가격 변화 |
| 로그인·알림·정책 모달 | `public/index.html` | 인증, 가격 알림, 도움/약관/사업자 정보 |
| 상품 SEO | `/p/:pid`, `api/_product-page.js` | 상품 내용, 가격 이력, 저장, 판매처 링크, 인접 상품 |
| 카테고리·브랜드 SEO | `/category`, `/category/:slug`, `/brand/:slug`, `api/_seo-pages.js` | 목록·페이지 번호·가격 통계·내부 링크 |
| 정책·지원 | `/privacy`, `/terms`, `/support` | 기존 문구, 앵커, 메일/내부 링크 |

관리용 `public/identity-review.html`은 사용자용 플로우가 아니므로 범위 밖이다. `vercel.json`, 검색·가격·AI·인증·결제·제휴 로직, DB, 환경변수, 크론은 건드리지 않는다. API 템플릿에서는 CSS 상수만 공용 스타일 링크로 교체한다.

## 콘셉트와 시스템

- **Hallmark Grid · Editorial**: 제품 비교를 위한 엄격한 그리드, 따뜻한 종이 표면, 잉크색 본문, 선명한 울트라마린 탐색/행동색을 쓴다.
- **형태**: counter hero + slab navigation + 근거가 먼저 읽히는 상품 목록 + 짧은 statement footer.
- **상품 경험**: 실제 상품 이미지와 가격 정보는 서버 데이터 바인딩을 그대로 사용한다. 카드 모서리·그림자를 걷고, 상품 이미지 정사각 슬롯과 밑줄 구분으로 목록의 밀도와 가격 위계를 맞춘다.
- **가격 의미**: 기존 의미를 보존한다. 하락은 초록, 상승은 빨강이며 파랑은 상호작용에만 쓴다.
- **타이포그래피**: Radio Canada / Radio Canada Big 및 Noto Sans KR 폴백. 본문 최소 16px, 수치 tabular, 제목은 한 가지 강조색/굵기로 둔다.
- **접근성/반응형**: 명시적인 `:focus-visible`, 44px 이상 조작 목표, 320–1920px 재배치, OS/사용자 다크 모드, `prefers-reduced-motion`, 가로 오버플로 방지.
- **캐러셀**: 기존 슬라이드와 수동 컨트롤을 보존하고, 자동 넘김을 멈추거나 다시 시작할 수 있는 보이는 제어를 추가한다.
- **이미지**: 운영 UI는 실제 API가 주는 판매 상품 이미지를 유지한다. 장식용 책/기념물 그림은 DOM과 JS 참조를 보존하고 스타일에서 숨긴다. 테스트 목업에 사용할 로컬 사진은 실상품과 혼동되지 않도록 시험 데이터라고 표시한다.
- **콘텐츠**: 페이지/모달의 사실, 가격, 주장, 법적 문구는 바꾸지 않는다. 제휴 고지 원문도 유지한다.

## 단계별 완료 현황

| 단계 | 상태 | 완료율 | 근거 |
| --- | --- | ---: | --- |
| 1. 프로젝트 조사 | 완료 | 100% | 주요 화면, 경로, DOM 연결점, 안전하지 않은 개발 서버 경계 확인 |
| 2. Hallmark 분석 | 완료 | 100% | redesign, flow, layout, craft, imagery, responsive, interaction, patterns 검토 |
| 3. 콘셉트 선정 | 완료 | 100% | Grid editorial 선택 및 이유 기록 |
| 4. 디자인 시스템 | 완료 | 100% | 토큰, 공통 기반, 홈·공용 페이지 스타일, 다크/반응형 규칙 연결 및 검토 |
| 5–7. 화면 구현·통합 | 완료 | 100% | 홈, 상품/카테고리 템플릿, 레이더, 정책·지원 페이지 연결 |
| 8–10. 반응형/기능/시각 검증 | 완료(실상품/전체 폭 캡처 한계 기록) | 90% | 6개 폭 로컬 목업, 검색/메뉴/레이더·정책, 콘솔, 회귀 및 2회 이상 시각 확인 |
| 11. Preview 배포 | 격리 설정 적용, 새 Preview 확인 중 | 50% | 이 브랜치 Preview에만 격리 변수 17개를 적용했다. 설정 이후 새 배포를 만들고 확인해야 한다. |
| 12. 커밋·Push | 완료 | 100% | 단계별 커밋 3개를 작업 브랜치에 Push했다. |

**현재 전체 진행률: 약 92%** — 구현, 로컬 검증, 세 단계 커밋/Push와 브랜치 Preview 격리 설정을 마쳤다. 남은 작업은 새 Preview 재배포·확인이다.

## Preview 검증 안전 경계

`npm run dev`는 `.env`를 자동으로 로드하고 서버리스 API를 직접 실행하므로 사용하지 않았다. 로컬 시각 검증은 `.hallmark/local-preview.cjs`로만 실행했다. 이 fixture 서버는 `.env`를 읽지 않고, `/api/*`는 합성 응답을 돌려주며, CSP로 외부 자산·API 연결을 막는다. 시험 상품은 상단 배너와 페이지 본문에 목업/시험값이라고 표시했다.

Vercel `seosa` 프로젝트의 Preview에는 `SUPABASE_URL`, `SUPABASE_SECRET_KEY`와 결제·검색·AI·제휴 자격 증명이 등록되어 있다. Production과 Preview가 같은 키 이름을 공유함을 확인했고, 실제 Production 값은 조회하지 않았다. 작업 브랜치를 Push한 뒤 `codex/hallmark-full-redesign-20261117` 브랜치의 Preview에만 자격 증명 15개를 무효 문자열로 덮어쓰고, `SUPABASE_URL`을 loopback 주소로, `SEOSA_DB_READONLY=1`로 설정했다. 각 변수의 대상은 Preview뿐이며 브랜치 한정이다. Production 환경변수는 변경하지 않았다. 변수 설정을 적용하려면 새 배포가 필요하다. 프로젝트의 Preview 배포는 SSO 보호가 켜져 있다.

## 최종 검증

### 시각/브라우저 확인

- 두 차례 이상 스크린샷을 확인하고 각 문제를 수정한 뒤 다시 확인했다. 헤더 탐색, 캐러셀, 핫딜·검색 영역, 상품 상세/카테고리, 레이더, 정책·지원 페이지를 확인했다.
- 요청된 홈 뷰포트 320, 390, 820, 1024, 1440, 1920 CSS px에서 `documentElement.scrollWidth`가 각각 305, 375, 805, 1009, 1425, 1905로 viewport 안에 있었다. 15px 안팎 차이는 페이지 스크롤바 영역이다.
- 모바일에서 캐러셀 컨트롤 간격, 검색 후 자동완성 숨김, 레이더의 44px 다크모드 버튼, 정책 표의 키보드 포커스/가로 스크롤을 확인했다. 모바일 메뉴·다크 모드·목업 검색도 동작했다.
- CUA 캡처 표면은 폭이 약 930px로 제한되어 1024/1440/1920 전체 폭 스크린샷은 저장되지 않았다. 해당 폭은 전체 viewport DOM 치수와 컨트롤 좌표로 확인했다. 320/390/820 모바일·태블릿 스크린샷은 전체 폭을 검토했다.
- 로컬 시험 데이터는 합성 SVG 상품 그림이다. Production API/DB를 호출하지 않았기 때문에 운영 상품 이미지는 검증하지 않았다.
- 브라우저 오류/경고 로그: 없음 (격리 로컬 fixture 페이지 기준).

### 기능/코드 회귀

| 검사 | 결과 |
| --- | ---: |
| `test-user-flow.js` | 36 PASS / 0 FAIL |
| `test-hotdeal-ui.js` | PASS |
| `test-radar-ui.js` | PASS |
| `test-policy-pages.js` | 77 PASS / 0 FAIL |
| `test-product-page.js` | 71 PASS / 0 FAIL |
| `test-seo.js` | 262 PASS / 0 FAIL |
| `test-affiliate-disclosure.js` | 99 PASS / 0 FAIL |
| `git diff --check` | PASS |

`test-policy-pages.js`는 이 checkout에 설치되지 않은 `@supabase/supabase-js`만 테스트 프로세스 안에서 빈 클라이언트로 대체해 실행했다. 검사는 인증 TTL·계정 삭제 상수와 정적 문서를 읽으며 Supabase 호출을 하지 않는다. 기존 Vercel 분석 호출과 정책 문구는 유지된다.

### 발견하고 수정한 UI 문제

- 390px에서 겹치던 캐러셀 화살표/도트 위치를 좌측 기준으로 다시 배치했다.
- 1024px 헤더 링크가 세로로 찌그러지던 breakpoint를 1120px로 조정했다.
- 검색 후 DOM에 남아 제목을 덮던 자동완성 상자를 닫힌 상태에서 숨기도록 수정했다.
- 핫딜 카드의 좁은 모바일 1열, 레이더의 44px 테마 버튼, 모바일 정책 표의 키보드 스크롤 초점을 추가했다.
- 뒤로 가기 버튼이 처음부터 보이던 top 버튼 상태를 수정했다. 캐러셀 자동 넘김 멈춤/시작 버튼도 보이도록 추가했다.

Preview URL은 격리 변수를 적용하기 전에 생성된 배포에는 접속하지 않는다. 설정 이후 생성된 브랜치 Preview에서만 마지막 확인을 진행한다.
