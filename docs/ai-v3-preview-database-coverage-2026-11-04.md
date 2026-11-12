# SEOSA AI v3 — 정확 모델 검색 수정 및 실제 DB 커버리지 점검
검증일: 2026-11-04. 범위: `feat/ai-v3-clean-20261104` Preview 한정. Production 미변경.

## 이번 변경
- `f5e3772`: 갤럭시탭 FE/FE+ 구분, 모델+용량 정밀 DB 재조회, 중고·액세서리만 발견한 경우 검색 조기 종료 방지.
- `d27eb78`: GPT가 검색어를 축약해도 사용자 발화/대화 상태에서 확정한 모델·용량 조건을 `createEngine → searchProducts → searchCatalog`로 전달. LLM 검색어를 새 사용자 요구조건으로 취급하지 않음.
- 새 로직은 DB SELECT만 수행하고 `SEOSA_DB_READONLY=1` 안전장치를 유지함.

## 오프라인 회귀 검증
| 분류 | PASS | FAIL |
|---|---:|---:|
| AI v3 기본 | 34 | 0 |
| 모델·옵션 정체성 | 46 | 0 |
| DB 카탈로그 검색 | 12 | 0 |
| **합계** | **92** | **0** |

실제 판매처/전체 사용자 질문에서의 품질 지표가 아님.

## 실제 GPT Preview 호출 (`d27eb78`, READY)
| 질문 | HTTP | 검색·검사 후보 | 추천 카드 | 판정 |
|---|---:|---:|---:|---|
| 아이패드 에어 M4 256GB | 200 | 52 | 2 | 조건 충족 카드 확인 |
| 갤럭시탭 S9 FE 128GB | 200 | 80 | 0 | Preview DB에 해당 모델 부재 |
| 아이폰 16 128GB | 200 | 76 | 0 | Preview DB에 해당 모델 부재 |

모델 `gpt-4.1-mini`, 3개 질문에 GPT Responses API 총 4회, 입력 토큰 1,838 / 출력 토큰 233. 요금 청구액은 검증하지 않음.

## 실제 데이터베이스 읽기 전용 조사
| SQL 제목 매칭 조건 | Supabase `pcnhktxltojbkrmpafsz` | Neon `withered-dew-45175008` |
|---|---:|---:|
| products 전체 행 | 71,887 | 77,702 |
| iPad + M4 + 256 | 4 | 4 |
| Galaxy Tab + S9 + FE + 128 | 0 | 5 |
| iPhone + 16 + 128 | 0 | 5 |

이 숫자는 문자열 포함 건수임. 정확한 신품·모델·옵션이 모두 검증된 개수는 아님.
Neon 갤럭시탭 관련 5개 중 FE+ 및 중고가 포함되며, 기본형 `갤럭시탭S9FE ... 128GB SM-X510` 제목 1개를 확인.
Neon 아이폰 관련 목록에는 중고·상위 모델·통신사 약정 조건이 섞여 있어 5개를 모두 정상 추천 후보라고 판단하면 안 됨.

## 근본 원인과 보류
- 해당 v3 브랜치의 Vercel Preview에는 `NEON_DATABASE_URL`, `SEOSA_DB_BACKEND`, `SEOSA_NEON_EXPERIMENTAL`의 브랜치별 환경변수가 없음(값/비밀키 조회하지 않음).
- `api/_supabase.js`는 Neon 명시 설정이 없을 때 Supabase로 연결함. 따라서 Preview 추천 0개와 Supabase의 제목 매칭 0개가 일치함.
- Neon에는 관련 상품 제목이 존재하지만, Preview에서 Neon 연결 실험을 수행하지 않았으므로 신규 검색 코드의 Neon 실전 성공은 아직 미검증.

## 다음 단계
1. Vercel의 이 개발 브랜치 Preview에만 Neon 접속정보를 **비밀값으로 직접 설정**. `SEOSA_DB_BACKEND=neon`, `SEOSA_NEON_EXPERIMENTAL=1`, `SEOSA_DB_READONLY=1` 유지. 비밀값은 채팅·로그·커밋에 기록하지 말 것.
2. 해당 Preview 새 배포가 READY인지 확인하고 모델별 결과 재검증. 초기에는 3문항만 실행.
3. 중고·FE+·아이폰 16e·통신사 개통 조건을 구분하고, 확인된 구매가·배송비 및 재고 검증은 별도 단계로 진행.
4. 비용 상한과 장애 중지 장치 적용 후 동일 질문·새 질문으로 기존 AI와 A/B 검증. Production 반영은 별도 승인 전까지 금지.

Production 마지막 확인: `718fe7f76b2f023476473896797cf69b02149b7c` READY 유지.
