# SEOSA Neon 테스트 복원 기록 (2026-10-20)

## 안전한 복원
- 소스 Supabase는 그대로 유지. Vercel Production 변경 없음.
- 원본 보존 백업: D:\SEOSA-Archive\supabase\supabase-public-20261020-222141-801.dump (82,659,037 bytes). SHA-256 매니페스트 확인 후 사용.
- 대상: Neon 프로젝트 withered-dew-45175008의 **테스트 브랜치** migration-test-20261020 (br-polished-meadow-aonxdoap). 테스트 URL의 정확한 endpoint id를 검증한 뒤 pg_restore 실행.
- Neon 운영 브랜치 production (br-withered-mud-aoxop0nr)는 테이블 0개이며 변경하지 않음.
- 테스트 브랜치는 2026-10-28T00:00:00Z 자동 만료. 운영 데이터의 보존 위치로 사용하지 말 것.
- PostgreSQL 17 pg_restore를 SSL verify-full 연결 및 Windows OS 신뢰 CA(ISRG Root X1) PEM 추출 사용. DB 비밀번호는 환경변수로만 전달.
- 트랜잭션 단위 복원, 오류 시 실패 처리, 원본에 대한 데이터 삭제/수정 작업 없음.

## 검증 결과
- 복원 정상 종료(약 88초). Neon 전체 DB 용량 약 404MB.
- 상품 products: 71,550행 일치.
- 가격기록 price_history: 320,413행 일치.
- public TABLE: 45개. FUNCTION: 45개. INDEX: 149개.
- public pg_policies: 0개, auth 스키마: 없음. Neon Data API를 외부에 공개하기 전에 새 권한 정책 필수.
- Supabase 관리 auth/storage 스키마는 **이번 public 덤프에 포함되지 않음**.
- 이 결과는 백업의 DB 복원 검증이지 서사 상품 검색이 Neon으로 정상 이전됐다는 뜻은 아님.

## 아직 필요한 작업
1. Supabase PostgREST 사용 API(최소 30개)들을 Neon server-side SQL driver 또는 별도 안전한 API 계층으로 이관. 기존 응답 계약/SQL RPC/가입·수집·가격기록·결제 기능 회귀 검사.
2. Cloudflare R2 seosapricehistory 버킷을 제한된 API 토큰으로 연결하고 과거 price_history의 일부만 안전하게 파일화. R2 직접 공개/PII 노출 금지.
3. Vercel Preview에만 새 DB 설정 후 검색·상세·가격 그래프·AI 카드·제휴사 쿼터 제한·핫딜·가격 수집 E2E 테스트.
4. 모든 회귀/비용/전송량 검증 및 cutover 시점 원본 증분 동기화 후에만 Neon Production을 준비, 명시적 배포 승인 필요.
5. Supabase 원본 데이터는 삭제하지 말 것. 클라우드 R2 및 데이터 전송 무료 한도도 점검.

전체 오류/실행 로그(비밀정보 없음): D:\SEOSA-Archive\reports\neon-staging-restore-20261020.log
