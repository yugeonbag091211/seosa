# Supabase 종속성 점검 (2026-10-20)

소스는 Vercel Node 서버리스+정적 페이지 구조. api/_supabase.js가 @supabase/supabase-js를 통해 지연 생성한 클라이언트를 모든 API에 전달한다. 단순 문자열 바꾸기로는 Neon과 호환되지 않는다.

## 우선 이전 대상
- api/_shop.js, api/_seo-pages.js, api/_radarapi.js: 상품·가격 기록 조회, 검색/상세, SEO. 일부 SELECT * / 대량 조회의 전송량 최적화가 중요.
- api/_coupang.js, api/_adpick.js: 제휴사 캐시, api_calls 기록, 서버 전역 리미터 RPC; 새 DB에 공유 트랜잭션/함수 그대로 재현.
- api/_auth.js, api/_billing.js, api/_analytics.js, api/_funnel.js: 사용자 인증 코드, 결제, 방문 통계, 이벤트; 접근제어·개인정보 확인 필수.
- scripts/collect-all-prices.js, scripts/check-alerts.js 등 수집기/알림 워커: 가격 기록 INSERT/UPSERT, 상태, 동시성·Lock, 실패 복구 검증.
- Supabase SQL 마이그레이션/SQL 함수: 2026-09, 2026-10 수집 RPC 및 상품 identity. 단순 테이블 복사만으로 동작하지 않음.

## 기본 선택
- Neon pooled DATABASE_URL: Vercel의 일반적인 서버측 CRUD/API.
- Neon DATABASE_URL_UNPOOLED: pg_restore, SQL 마이그레이션, 세션 종속 작업.
- Cloudflare R2: 비공개 시계열 파일을 압축된 작은 객체로 저장하고 서버측 Vercel API를 통해 프라이빗 접근. Product+Mall+Option identity별 안정된 키.
- PostgREST 호환성이 필요하면 Neon Data API를 검토하되 JWT/RLS 및 API 공개면을 먼저 설계; 현재 Supabase SECRET KEY를 Neon 데이터 API의 대체 비밀번호로 사용할 수 없다. 현재 앱은 커스텀 auth_codes를 사용하므로 Neon Auth는 자동으로 활성화하지 않는다.
- 기존 Supabase에서 한 달 8GB 이상 Egress를 발생시킨 접근 패턴을 Neon에서도 고치지 않으면 무료 한도 반복 초과 위험이 있다.

## 실측/소스 인벤토리
node scripts/migration/preflight.js 출력에 Supabase 사용 API 파일 수 및 일부 파일명이 표시된다. 이는 정규식/문자열 기반의 단순 소스 인벤토리이며 동적 호출·의존 확장·DB 함수는 별도 정밀 감사가 필요하다.
