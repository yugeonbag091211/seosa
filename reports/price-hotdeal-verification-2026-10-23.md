# SEOSA 실제 가격·핫딜 검증 — 2026-10-23

## 범위와 안전성

- 기준은 PR #184 head `9d2d176a5dcc892d25fc6869f2e1ce2c4cc1b00a`이며, 이 보고서는 그 위에 쌓는 `codex/seosa-price-hotdeal-validation` 변경을 기록한다.
- Neon 프로젝트에는 `production` 브랜치와 `migration-test-20261020` 브랜치가 있다. `production` 브랜치에는 조회 가능한 앱 테이블이 없어 가격 원장을 확인할 수 없었다.
- Vercel Production의 `NEON_DATABASE_URL` 존재는 확인했지만, 연결 문자열 값을 열거나 호스트를 출력하지 않았다. 따라서 Production URL이 어느 Neon 브랜치를 가리키는지는 확정하지 못했다.
- 데이터가 있는 `migration-test-20261020`에서만 `neondb_owner` 세션으로 조사했다. 모든 SQL 트랜잭션의 첫 문장은 `SET TRANSACTION READ ONLY`였고 `transaction_read_only=on`을 확인했다. 운영 DB 쓰기·삭제·초기화는 하지 않았다.
- 실제 API 확인은 Vercel Preview 배포 `claude/seosa-neon-r2-migration-80da39`에서 GET으로만 했다. Production 배포는 하지 않았다. Preview API 가격과 Neon 스냅샷 행이 일치했지만, 비밀 환경변수를 읽지 않았으므로 Production 연결까지 입증한 것은 아니다.

## 실제 가격 이력

- Neon 스냅샷에서 `price_history` 336,328행을 읽었다. 기록 범위는 2026-07-14–2026-10-23이며, DB 날짜 기준 최근 7일 42,545행, 최근 30일 187,400행이다.
- `대웅 취사 보온 전기밥솥 10인용` (`product_id=8327026885`, 쿠팡)의 현재가는 40,900원이다. 현재 옵션은 `vendor_item_id=95189584451`, `item_id=21246706432`다. `products.lprice`와 그 옵션의 최신 관측가가 모두 40,900원이며, 최신 관측일은 KST 2026-10-23이다.
- 해당 옵션의 Preview `/api/history` 응답은 관측 10일을 반환했다. KST 최근 7일 최저는 40,900원, 최근 30일 최저는 39,900원(10월 7–10일), 7일 평균은 40,900원, 30일 평균은 40,500원이다. 서버 통계의 30일 최저·평균·관측 수와 응답 점을 대조했다.
- 같은 `product_id`의 다른 옵션(`vendor_item_id=94472405909`, `item_id=24038750793`)에는 29,900원 관측이 있다. 요청한 `95189584451` 옵션의 가격에는 이 기록이 섞이지 않았다. AI 가격 통계 경로는 `strictOption`과 정확한 `vendor_item_id` 비교를 사용한다.
- 현재가, 옵션, 최저가, 마지막 관측일은 이 상품에서 서로 일치했다. 이 검증은 실제 Neon 스냅샷과 Preview 가격 이력 API 자료를 기준으로 했으며, 실제 모델이 이 데이터를 이용해 생성한 답변의 정확도 표본은 아니다.

## 실제 핫딜 피드

- Preview `/api/hotdeals?limit=48`은 200으로 내부 딜 13건을 반환했다: `VERIFIED_HOT` 3건, `GOOD_DEAL` 9건, `POTENTIAL_DEAL` 1건. 목록의 13건은 12시간 이내에 확인된 자료였다.
- 현재 `POTENTIAL_DEAL` 후보는 “앱코 축교환 레인보우 무빙 LED 기계식 유선 일반형 키보드”, 27,900원이다. 이전 AI 도구는 커뮤니티 여부만 확인하고 이를 `verified:true` 및 “내부 검증 핫딜”로 표시할 수 있었다.
- Preview `/api/hotdeals?view=external&limit=48`도 200으로 조회됐으며 `externalEnabled=true`, `externalPending=false`, 결과 0건이었다. Neon 원장에는 외부 커뮤니티 행이 있으나 최신 fetch가 10월 19일이고 2,130건이 `UNMATCHED`/미노출이다. 따라서 현재 노출 가능한 외부 검증 딜이나 최신 커뮤니티 제보는 확인되지 않았다. 데이터 조회 성공과 현재 노출 딜이 없다는 결과를 구분했다.

## 발견한 결함과 수정

- AI 핫딜 도구가 내부 목록만 불러 외부 검증 딜과 커뮤니티 피드를 읽지 못했다. 이제 내부와 `view=external` 피드를 별도로 읽는다. 커뮤니티 제보는 기본 숨김을 유지하며, 활성화해도 검증 목록으로 승격하지 않는다.
- `POTENTIAL_DEAL`이 검증 목록에 들어가던 문제를 수정했다. 내부 `VERIFIED_HOT`·`GOOD_DEAL`은 가격 검증 딜로, `POTENTIAL_DEAL`은 `verified=false`인 잠정 후보로 분리한다. 외부 API가 `verified=true`로 표시한 검증 자료는 그 상태를 보존한다.
- 내부 피드의 HTTP 200 `pending` 응답이 빈 목록으로 오인되던 문제를 수정했다. 내부 또는 외부 피드가 실패하면 전체 실패나 `partial` 상태와 실패 원인을 남기며, 빈 목록 성공으로 바꾸지 않는다.
- 각 결함을 기존 코드에서 실패하는 회귀 테스트로 먼저 재현한 뒤 수정했다.

## 검사 결과와 남은 범위

- `scripts/test-ai-hotdeal-tool.js`: 수정 전 새 재현 사례 실패, 수정 후 **39/39 통과**.
- `scripts/test-price-integrity.js`: **99/99 통과**. 실제 데이터에서 확인한 옵션 혼합 사례와 기존 옵션 격리 테스트를 함께 확인했다.
- 변경을 포함한 전체 `npm test`: **종료 코드 0**. 로컬 쿠팡 모의 서버가 필요한 테스트는 루프백 접근을 허용해 실행했고, Production·실제 Coupang API를 호출하지 않았다.
- Mobile Check 워크플로는 `apps/mobile/**` 변경이 없어 자동 실행 대상이 아니었다. 워크플로와 동일한 `npm run check`를 현재 브랜치에서 직접 실행해 타입 검사·린트·테스트 **종료 코드 0**, 테스트 **170/170 통과**를 확인했다.
- 모바일 잠금 파일 기준 `npm ci` 감사 경고는 취약점 24건(중간 6, 높음 18)이었다. 이번 변경에서 의존성은 수정하지 않았다.
- 실제 모델을 새 가격·핫딜 데이터에 연결해 호출하지 않았다. PR #184 보고서의 이전 실제 모델 집중 검증은 4/4 통과였지만, 이번 기능 수정 후 모델 정확도 결과로 재사용할 수는 없다.
- 외부 커뮤니티 피드는 현재 신선한 노출 행이 0건이라 실제 제보를 AI 응답까지 전달하는 라이브 표본은 없다. 이 경로는 실제 API 조회와 결정론 테스트로 확인했다.
- Production Neon URL과 브랜치의 매핑은 입증되지 않았다. 따라서 실제 Production DB를 대상으로 한 가격 검증 및 핫딜 검증이라고 주장하지 않는다.

## 배포 판단

**배포 준비가 되지 않았다.** 외부 커뮤니티의 현재 데이터 표본이 없고, Production 연결 대상도 확인되지 않았다. 전체 로컬 `npm test`와 Mobile Check 동등 명령은 통과했으며, AI 핫딜 플래그는 기본 비활성 상태로 유지한다. 모바일 의존성 감사에서 확인한 24개 취약점도 별도 검토가 필요하다. main 병합과 Production 배포는 하지 않는다.
