# AI v3 대화 계약 · 100문항 하네스 · 검색 정확도 · Neon 전송량 — 2026-11-14

작성: Claude Code (코드 수정·테스트). 독립 검증: ChatGPT.
운영 DB·환경변수·Neon 플랜·워크플로는 **바꾸지 않았다**. 운영 배포·병합도 하지 않았다.

| PR | 브랜치 | 내용 |
|---|---|---|
| [#235](https://github.com/yugeonbag091211/seosa/pull/235) (긴급) | `fix/neon-transfer-20261114` | P1 Neon 전송량 + main 에서 깨져 있던 테스트 4건 |
| 이 PR | `fix/ai-v3-web-parity-and-harness-20261114` | P1 + P2 대화 계약 + P3 하네스 + P4 검색 정확도 |

## 0. 지금 가장 급한 것 (사용자 결정 필요)

- **Neon 공용망 전송 5.194 GB (4.837 GiB, 09:52Z)** / 무료 5 GB. 아직 정지되지 않아 한도는 5 GiB 로 보이며 남은 여유 ≈ 0.17 GB.
  최근 카운터 증가 ≈ 70 MB/52분. 소진되면 **12-01 까지 컴퓨트 정지**(Neon 공식 문서, SQLSTATE 53000) → 검색·핫딜·AI·결제·수집 전부 멈춘다.
- **연산 70.24 / 100 CU-h** (컴퓨트 87% 시간 활성) → 11-19~20 경 같은 정지.
- 코드 수정(#235)만으로는 남은 시간을 보장하지 못한다. 선택지: 유료 플랜 전환 · 병합 전까지 `volatile-prices` 워크플로 일시 중지 ·
  #235 우선 병합(수집기 쪽은 병합 즉시 다음 Actions 실행부터 적용).
- **운영 v3 는 지금 한 번도 돌지 않는다.** `/api/ai?v=3` → `X-Ai-Version: legacy`. 원인: v3 회로 측정 표 `ai_v3_monitor_events`
  (와 `ai_v3_profiles`, 함수 `merge_ai_v3_user_profile`)가 운영 DB 에 없다 — 마이그레이션 `20261113000000`·`20261113000001` 미적용.
  회로가 측정 표를 못 읽으면 fail-closed 로 legacy 에 넘긴다. 적용 여부는 사용자 결정(운영 DB 변경).

## 1. P1 — Neon 전송량

상세: [`docs/neon-transfer-audit-2026-11-14.md`](neon-transfer-audit-2026-11-14.md)

- `price_job_state.last_result` = 1.69 MB 를 할 일 없는 수집·재확인 실행까지 하루 ≈90회 통째로 읽음 → ≈155 MB/일.
  → 상태 «요약»(JSON 경로, ≈0.3 KB)으로 «잠금 충돌 / 오늘 완료 / 하루 예산 소진» 을 먼저 판정. 쓰기 규칙 불변.
- 홈 핫딜 today-drop 이 운영에서 no-store 라 방문마다 원장 1.6만 행(≈5.6 MB) → 판정 열만 스캔(운영 원장 실측 −60%),
  카드 문구는 카드만, 인스턴스 메모 60초(single-flight). canonical 묶기는 요청마다 그대로.
- Neon 어댑터 `rpc().select()` 지원(직전 관측 RPC 가 전 열 대신 7열).
- 확인 안 된 것: 운영 실제 절감량(카운터 지연 갱신) — 병합·배포 뒤 하루 단위로 `data_transfer_bytes` 증가분 비교 필요.

## 2. P2 — 대화 상태 계약 (웹·앱·하네스·폴백)

| 발견(실측) | 수정 |
|---|---|
| v3 는 `request.history` 만 읽음 → **앱(chatHistory 만 보냄)은 v3 플래너에 대화 기록 0줄** | `api/_ai-v3-history.js`: `chatHistory`(우선) 또는 `history` 를 한 모양으로 |
| 웹(79b45f5)은 500자로 자르고 sig 를 뺀 `history` 사본을 보내 **이번 질문이 두 번** 실림 | 웹은 `chatHistory` 만 보냄, 서버가 끝의 중복 질문 제거 |
| assistant 발화가 **서명 확인 없이** assistant 역할로 모델에 들어감(가짜 이전 답변 주입 가능) | legacy 와 같은 `turnSig`(같은 키·6시간)로 원문 검증, 안 맞으면 «검증되지 않은 인용» user 메시지 |
| v3 답에는 `turnSig` 가 없어 v3→legacy 폴백 때 이전 답이 버려짐 | v3 답에도 `turnSig` — 서로의 답을 인정 |
| 서명된 state 토큰이 **영원히 유효** | `iat` + 6시간 수명, `stats.state` = absent·valid·invalid·expired |
| 회로 **기록** 실패 시 받은 좋은 v3 답을 버리고 legacy 를 또 부름(비용·시간 2배) | 답은 그대로 내보내고 실패는 다음 요청의 `check()` 가 막는다(fail-closed 유지) |
| v3 가 왜 안 도는지 보이지 않음 | `x-ai-v3-gate`: off · not_assigned · monitor_unavailable · circuit_open · engine_error · engine_status_5xx · served |

검증: `scripts/test-ai-v3-conversation-contract.js` 44개(2턴 대화에서 예산·직전 추천 유지, 평문 state 위조·토큰 변조·서명 없는
assistant 지시문 무시, 앱 모양 요청, 게이트 사유, 기록 실패 시 답 유지, 엔진 예외 → legacy). 운영(v3 꺼짐)에서는 확인 불가.

## 3. P3 — 100문항 하네스 (`scripts/test-100-questions.js`)

```bash
node scripts/test-100-questions.js                                    # 드라이런: 요청 0회, 호출량·비용 추정
node scripts/test-100-questions.js --offline --snapshot=<catalog.jsonl> --label=after
node scripts/test-100-questions.js --live --base=https://seosa.ai.kr --require-v3 --price-in=<$> --price-out=<$>   # 승인 뒤에만
```

- 질문 100개는 원본과 글자까지 같다(sha256 `9f9ae05e580bd45f` 고정). 11개 범주.
- 후속 Q046–Q055 는 seed 와 **같은 세션**에서 웹과 같은 요청 모양(chatHistory+turnSig, state 그대로, convState)으로 순서 실행.
- 판정: HTTP 200 ≠ 정확. hard(유형·액세서리·예산·브랜드·모델·중고·낡은 가격·https·후속 문맥) → FAIL,
  soft·판단 문항 → UNVERIFIED(근거를 적은 `--review-file` 로만 확정, 자동 FAIL 은 리뷰로 PASS 가 되지 않음).
- 집계: 범주별 판정, 추천률, 카드 정확도, 오류율, avg/p50/p95(seed 별도), 토큰·USD.
- `scripts/test-ai-100-grader.js` 48개가 판정 규칙·질문 해시·플래너·오프라인 경로를 고정한다.

## 4. P4 — 검색 정확도 (오프라인, 같은 하네스 · 동결 카탈로그 77,737행 · GPT 대역)

| 실행 | 코드 | PASS | FAIL | UNVERIFIED | 추천률 | 카드 정확도 |
|---|---|---|---|---|---|---|
| before-all | `8f3c3d2` (수정 전) | 33 | 19 | 48 | 71.1% | 91.5% (189장 중 16 위반) |
| before-p4 | `ee443a8` (P2·P3 후) | 37 | 19 | 44 | 71.1% | 91.5% |
| after-p4 | `f7dd99e` | **40** | **16** | 44 | 64.4% | **100%** (176장 중 0) |

결과 파일: `reports/ai-100/2026-11-14/{before-all,before-p4,after-p4}-offline.json`

- PASS 33→37 은 동작 변화가 아니라 **측정 변화**다: 새 서버가 `stats.state`·`stats.conversation` 을 보고해 후속 4문항(Q050·Q052·Q053·Q054)의
  계약을 검증할 수 있게 됐다(옛 서버는 «검증 불가»).
- 37→40, 카드 위반 16→0 이 엔진 수정이다:

| 문항 | 전 | 후 | 원인 → 수정 |
|---|---|---|---|
| Q005 노트북 거치대 | FAIL 노트북 4장(35만~250만원) | 카드 없음 + 액세서리 미지원 안내 | 액세서리 중심 명사 판정 |
| Q008 아이패드 케이스 | FAIL 아이패드 4장 | 〃 | 〃 |
| Q010 모니터 암 | FAIL 모니터 4장 | 〃 | 〃 |
| Q020 3만원짜리 마우스 | FAIL 14.5만·21.9만원 + **열차 티켓** | PASS(≤34,500원) | 근사 가격 · 비상품 목록 |
| Q034 아이패드 미니 7 | FAIL A20 Pro 신형 | PASS(7세대만) | «미니 7»·A17 Pro → 7세대 |
| Q046 더 싼 거 없어? | FAIL 같은 4장 | PASS(최저가보다 싼 것) | «더 싼 거» 해석 |

- 추천률 하락(71.1→64.4%)은 엉뚱한 본체 카드를 지운 결과다.
- 수정 중 하네스가 잡은 내 회귀 2건도 고쳤다: «좀 더 비싼 거» 를 «싼 거» 로 읽음(«비싼 거» ⊃ «싼 거»), 악기 «전자키보드» 를 키보드로.
- 회귀 테스트 `scripts/test-ai-v3-search-accuracy-20261114.js` 23개. v3/v3.1~v3.4 스위트 전부 통과(속성 3,510회 포함).

## 5. 응답시간 · 비용 · 오류율

| 측정 | 요청 | 오류율 | avg | p50 | p95 | 비용 |
|---|---|---|---|---|---|---|
| 오프라인 after-p4 (엔진만, GPT·네트워크 없음) | 110 | 0% | 27 ms | 23 ms | 101 ms | $0 (모델 호출 0) |
| 운영 라이브 11-13 01:01Z (legacy 게스트, 옛 하네스, HTTP 만 판정) | 100 | 1% (Q097 70초 뒤 fetch failed) | 3,339 ms | 2,167 ms | **11,483 ms** | LLM 0 (게스트 모드) · 판매처 검색·Neon 전송 발생 |
| 운영 라이브 새 하네스 | **미실행** | — | — | — | — | 승인 필요 |

- 오프라인 지연은 서버 파이프라인만 잰 값이라 운영 지연과 비교할 수 없다.
- 새 하네스 라이브 실행 추정(드라이런): 110요청, 약 31분, 판매처 검색 각 ≤95회(분당 ≈5회, ADPICK 10/분 이하),
  v3 가 켜져 있으면 OpenAI ≤≈300호출. **지금 운영은 legacy 게스트**라 LLM 비용은 0 이지만 요청마다 Neon 전송이 생긴다 →
  Neon 한도가 해결되기 전에는 실행하지 않기를 권한다.

## 6. 미해결 결함 · 위험 (원인 · 재현)

1. **Neon 전송·연산 한도 임박** — `neon projects get withered-dew-45175008` 의 `data_transfer_bytes`·`compute_time_seconds`.
2. **운영 v3 미가동** — 마이그레이션 2건 미적용. 재현: `POST /api/ai?v=3` → `X-Ai-Version: legacy`(이 PR 배포 뒤에는 `X-Ai-V3-Gate: monitor_unavailable`).
   적용하더라도 `ai_v3_monitor_events` 는 요청마다 1행씩 쌓이고 보존 기한이 없다 — 정리 정책이 필요하다.
3. **닫힌 상품 사전** — 오프라인 FAIL 16건 전부: 미지원 상품군 10(USB-C 허브·전동 킥보드·캠핑 의자·전자책 리더기·안마의자·블렌더·세탁기·
   충전 케이블·다이슨 에어랩·닌텐도 스위치), 액세서리 3(노트북 거치대·아이패드 케이스·모니터 암), 브랜드만 3(애플·다이슨·샤오미).
   이제 정직하게 안내하지만 추천은 못 한다. 재현: `--offline --only=Q009,Q011,Q088`. 유형 추가는 분류·목록·검색 세 모듈을 함께 바꿔야 한다(후속).
4. **재확인 슬롯 원장 소실 → 거짓 MISSED 경보 메일** — 11-14 09:53Z 실행이 «11-13 점심·저녁, 11-14 점심 누락» 메일 3통을 보냈지만
   11-14 04:02Z(13:02 KST, 창 안)에 실제 실행이 있었다. `price_job_state.last_result` 에 `volatileSlots` 키가 없다 —
   수집기의 상태 저장이 원장을 덮는 것으로 의심(미확인).
5. **`releaseLock` 이 일한 실행마다 1.69 MB 를 한 번 더 읽음** (하루 ≈10~20회) — 마지막으로 쓴 상태로 CAS 해제하는 개선 가능(후속).
6. **v3 실패 → legacy 폴백의 시간 예산(코드 읽기, 미검증)** — v3 는 OpenAI 호출당 24초 제한이 2~3번 이어질 수 있고 그 뒤 legacy(27초 예산)가
   돈다. 웹 35초·앱 30초 제한을 넘을 수 있다. 재현하려면 모델 응답을 늦추는 모의 어댑터로 라우트를 돌려야 한다.
7. **오프라인 결과의 한계** — GPT 계획·분류 품질, 실시간 재고, 오늘 가격은 재지 않았다. UNVERIFIED 44건(비교·구매 시점·스펙·지식 질문)은 사람 리뷰 필요.
8. **Q051 «좀 더 비싼 거»** — 이제 더 비싼 키보드를 보이지만, 앞서 말한 «20만원 이하» 를 넘겨도 되는지는 판단 문제라 UNVERIFIED 로 둔다.
9. 하네스의 자동 유형 사전도 완전하지 않다(악기 건반을 처음엔 놓쳤다). «카드 정확도 100%» 는 «하네스 자동 검사 기준» 이다.
10. `x-ai-v3-gate` 헤더는 롤아웃 상태(off/not_assigned)를 드러낸다 — 진단 편의와 맞바꾼 작은 정보 노출.

## 7. 테스트 (수정 전후 분리 보존)

- 수정 전(`8f3c3d2`, LF 체크아웃): `npm test` **exit 1** — `test-ai-conv-state` 2건에서 사슬이 멈춰 이후 ~70 스위트가 돌지 않음(main 동일, #233 부터).
  이어서 `test-account-delete`(ai_v3_profiles 개명), `test-seo`(cc300da 새 문구), CI 전용 `test-ai-v3`(SEOSA_DB_READONLY)도 실패 상태였다.
- 수정 후: 아래 «최종 테스트» 절 참고.

### 최종 테스트 (LF 체크아웃, pretest + test 를 명령별로 끝까지 실행)

| 시점 | 명령 수 | 실패 | 비고 |
|---|---|---|---|
| 수정 전 `8f3c3d2` | 169 | 2 | `test-ai-conv-state`(64/66) · `test-account-delete`(37/39) — main 과 같은 원인. `npm test` 는 첫 실패에서 멈춰 exit 1 |
| 수정 후 `f7dd99e` | 177 (+8 새 테스트) | 0 | `npm test` exit 0 |
| 최종 `daef309` | 177 | 미확정 | 문서·리포트·CI 전용 테스트 수정만 추가 — 로컬 재실행이 끝나기 전에 마감, PR #236 CI `test` 로 확인 필요 |

- `ai-v34-eval` 의 v3 회귀 루프 22개 스위트: `SEOSA_DB_READONLY=1`(CI 조건) · 미설정 · 시계 +30일 모두 통과.
- Windows CRLF 작업 사본에서는 `test-identity-promotion-mutations`·`test-identity-review-mutations` 가 «mutation target not found» 로 실패한다 —
  LF 체크아웃에서는 수정 전후 모두 6/6 killed(기존 현상, npm test 사슬 밖).
- 재현:

```bash
git -c core.autocrlf=false worktree add ../lf HEAD   # Windows CRLF 체크아웃에서는 test-identity-review-mutations 가 실패한다(기존)
```

```bash
npm ci && npm test
```

```bash
node scripts/test-ai-v3-conversation-contract.js && node scripts/test-ai-v3-search-accuracy-20261114.js && node scripts/test-ai-100-grader.js && node scripts/test-neon-transfer-guards.js
```
