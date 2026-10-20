# 서사 SEOSA: Supabase → Neon + Cloudflare R2 안전 이전

## 현황 (2026-10-20 확인값)
- 이전 전 운영 DB: Supabase PostgreSQL 17, 약 490MiB. public.products 약 71,550건; public.price_history 약 320,413건. 서버에서 직접 읽은 수치이며, 이전 시점에 다시 확인해야 한다.
- Supabase Free는 이미 Egress 5GB를 초과하여 REST API가 HTTP 402로 차단된 상태다. 오래된 행을 지워도 이미 사용한 네트워크 전송량은 줄지 않는다.
- 새 DB: Neon 프로젝트 withered-dew-45175008, production 브랜치 br-withered-mud-aoxop0nr, 싱가포르, PostgreSQL 18, 빈 데이터베이스. neon init 및 neon deploy 성공, SELECT 1 접속 확인.
- 파일 저장소: Cloudflare R2 버킷 seosapricehistory (사용자 생성). API 토큰/연결 및 실제 데이터 업로드는 미완료.
- 별도 체크아웃: C:\Users\yugeo\seosa-neon-r2-migration-20261020. 운영 main / 배포 설정 변경 없음.
- 로컬 백업: D:\SEOSA-Archive\supabase, D:\SEOSA-Archive\r2. 데이터를 담기 전까지 용량은 확보(예약)되지 않는다.

## 구조
Vercel(서사 API·웹/앱) → Neon PostgreSQL (products, 최신 가격, 계정/인증 데이터, 제휴 API 호출 제한, 캐시, 컬렉터 상태) + Cloudflare R2 (가격 이력의 오래된 구간, 상품별 그래프 JSON.gz/압축 파일, 별도 백업). 최신 price_history는 그래프 정합성을 위해 DB에도 일정 기간 유지하고, 최신분과 과거분을 합쳐 기존 화면의 정확한 순서를 제공한다. 개인 데이터/민감 정보는 공개 R2 버킷에 두지 않는다. R2 객체는 비공개로 두고 Vercel의 서버측 API가 권한·상품 옵션을 검사한 후 읽도록 한다. 캐시와 압축으로 Egress·호출량을 억제한다.

## 매우 중요한 호환성 문제
현재 api/_supabase.js는 @supabase/supabase-js의 PostgREST 클라이언트를 반환하며, API 경로는 .from(...), .rpc(...), Storage 기능 등에 의존한다. Neon의 DATABASE_URL은 PostgreSQL 연결 문자열이므로 Supabase 클라이언트의 SUPABASE_URL에 넣어도 동작하지 않는다. 대부분의 DB 접근을 Vercel 서버측 pg/@neondatabase/serverless 쿼리로 변경하거나 Neon Data API + 정당한 JWT/RLS 방식을 별도 설계해야 한다. Neon Data API를 공용 서비스 역할처럼 공개하는 방식은 금지한다. Supabase의 SQL 함수(RPC), 인증·수집·결제·알림·AI 상품 카드·옵션 매칭 모두 이전 뒤 회귀 검증 필수.

## 비용 주의
Neon Free의 DB 1GB는 넉넉한 보장이 아니다. Supabase 현재 약 490MiB이고 인덱스·WAL·추가 데이터·기타 스키마 구조에 따라 달라진다. Neon 네트워크 전송량을 최적화하지 않으면 이전 Supabase처럼 무료 한도를 초과할 수 있다. R2도 저장량 외 객체 읽기/쓰기 호출에 대한 한도가 있다. 서비스 비용은 트래픽에 달려 있다.

## 0단계: 반드시 백업
1. 소유자만 접근 가능한 로컬 D:\SEOSA-Archive\supabase 경로 사용; 가능하면 BitLocker/외장 추가 복제.
2. Supabase 대시보드 Connect 메뉴에서 **직접 연결(또는 덤프가 가능한 세션 풀러) 연결 정보**와 DB 비밀번호를 확보한다. 비밀번호나 연결 문자열을 채팅으로 전송하지 않는다.
3. 클라이언트에 PostgreSQL 17 또는 18 도구(pg_dump, pg_restore)를 설치한다. pg_dump 버전은 소스 서버 17 이상이어야 한다.
4. 사용자 노트북의 비공개 PowerShell 세션에서 PGHOST, PGPORT(기본 5432), PGDATABASE, PGUSER, PGPASSWORD 환경변수를 설정하고 scripts/migration/backup-supabase.ps1 -BackupDir 'D:\SEOSA-Archive\supabase' 실행. 연결 정보, 특히 비밀번호를 명령 인자로 노출시키지 않는다. 이 스크립트는 public 스키마만 백업한다. 별도 Supabase 관리 스키마(auth/storage 등)가 필요하면 서비스별로 별도 덤프·호환성 검토를 수행한다. 따라서 이 스크립트 하나로 '모든 데이터 백업 완료'라고 판단하면 안 된다.
5. node scripts/migration/verify-backup.js 'D:\SEOSA-Archive\supabase' '<manifest JSON의 전체 경로>' 실행. 파일 무결성 검증이며 행 수까지 보장하지 않는다.
6. 백업 시점에 Supabase에서 제품/가격 기록 건수, 중요 테이블/함수 목록, 제약조건·인덱스 수를 기록한다. 백업을 네온에 테스트 복원한 뒤 각각 대조해야 한다.

## 1단계: 대상 DB 안전 테스트 복원
- production에 첫 시도부터 덮어쓰지 말고 Neon의 임시 개발 브랜치/격리 DB에 백업을 복원한다. 빈 대상에서 시작하며 기존 테이블을 강제로 삭제하지 않는다.
- Neon 공식 Supabase 이전 가이드: pg_restore --no-owner --no-acl, 복원 연결은 **비풀링(unpooled)** DATABASE_URL_UNPOOLED를 사용한다.
- Supabase 전용 ROLE, 권한/RLS, 확장, 외부 의존 함수를 재설계한 뒤 public 데이터·함수·인덱스를 검증한다. PostgreSQL 17 → 18의 호환성도 검사한다.
- 현재 백업 일부(price_history 등)를 R2 JSON 압축 아카이브로 변환하는 도구는 별도로 구현·시험한다. R2 업로드에는 버킷 한정 읽기·쓰기 권한의 API 토큰이 필요하다.
- Neon과 R2 각각의 상품별 조회 수, 가격 이력 합집합/최솟값/최댓값/날짜·mall·vendorItemId 정확도, 중복/옵션 분리 여부를 비교한다.

## 2단계: 앱 이전 (별도 Feature Flag)
- 새 Vercel 코드가 Neon의 서버측 드라이버로 조회·삽입·RPC 등 모든 데이터 경로를 처리하도록 고치고, 숨겨진 기능까지 회귀 테스트. 환경변수는 Production이 아니라 Preview에 먼저 설정.
- 서사 검색, 상세, 가격 이력 그래프, AI 카드, 쿠팡/ADPICK 호출 제한, 일일 컬렉터, 인기 검색, 핫딜, 검색 통계, 회원 이메일 인증, 결제, 알림, 보안 제한, SEO 사이트맵, 모바일 앱을 확인.
- 예전 DB와 새로운 DB 간 건수·응답·가격 옵션 정확도 일치와 성능/데이터 전송량을 확인.
- 수집기는 중복 적재와 레이트리밋 공유 혼선이 없도록 **한쪽만** 실제로 동작하게 점진적 전환. 데이터를 읽다가 분리된 최신/과거 그래프에서 결측 날짜가 발생하지 않아야 한다.
- 예외 발생 시 원래 Supabase 환경변수/코드로 돌아갈 수 있어야 한다. 원본 데이터 삭제 금지.

## 3단계: 검증 후 운영 전환
- Preview 100% 통과, 샘플/무작위 상품·옵션의 데이터 일치, 수집 재개와 다음날 데이터 연속성, 이용자 개인정보 권한, 원본/백업 SHA-256, 하루 이상 모니터링 확인.
- 운영 배포는 사용자 승인 후에만. Supabase 프로젝트 삭제는 **마지막 작업**, 사용자의 명시적 삭제 승인 없이 실행하지 않는다.

## 확인된 제약/차단 사유
- 현재 원본 Supabase DB 비밀번호가 준비되지 않았고 노트북에서 pg_dump/pg_restore를 찾지 못했다.
- Cloudflare R2 버킷 연결에 필요한 범위 제한 API 키가 없다.
- 현재 Neon은 비어 있다. Supabase 상품·가격 데이터가 이전되었다는 기록은 없다.
- 기존 코드에는 npm run build 명령이 없고, Vercel 서버리스 사이트이므로 해당 명령은 실패한다. npm test/Preview HTTP 스모크가 적합한 검증이다.
- 현재 서사는 Supabase HTTP 402로 검색·조회가 실패한다. Neon에 단순 프로젝트 생성만 해서는 복구되지 않는다.

Neon 공식 문서: https://neon.com/docs/import/migrate-from-supabase.md
Neon 보안/데이터 API: https://neon.com/docs/data-api/access-control.md
