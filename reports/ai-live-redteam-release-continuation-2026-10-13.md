# AI Live Red Team / release regression 이어서 검증

실행일: 2026-10-13 (Asia/Seoul). 기준 커밋: `4474335e311569484a1aeac1fea340cd90b8519e` (`origin/main`).

## 복구 범위

- 시작 checkout은 detached HEAD, tracked 수정 0개, untracked 0개였다. 전날 작업은 이미 존재하던 별도 checkout의 `claude/codex-live-redteam-fixes-5c2896` 브랜치에 미커밋 상태로 남아 있었다. 그곳의 8개 tracked 수정 및 4개 새 코드 파일을 해시 대조 후 현재 checkout에 복구했다. 원본 checkout과 보고서는 변경하지 않았다.
- 전날의 상세 공격 근거는 `reports/live-redteam-codex-handoff.md`에 보존했다. 원본의 대용량 raw 실행 파일들은 원래 위치에 그대로 있으며 이 변경에는 포함하지 않았다.
- 전날 raw 모델 평가의 414/625 PASS는 엄격한 성공률이 아니다. 오탐 PASS가 확인된 자동 휴리스틱이다. 당시 정확한 상품이 후보에 있던 케이스의 identity P@1은 92/140이었다. 아래 새 실행과 분모가 달라 직접적인 개선율로 계산하지 않는다.

## Release 7건의 원인과 조치

| 실패 | 원인 | 조치 |
|---|---|---|
| provider 402 HTTP 500 기대 | 실제 API는 안전한 `200`, `degraded: true` 답변을 준다 | 상태, degraded 표시, 미확인 사실 배제를 함께 확인 |
| 402의 “다시 시도” 문구 기대 | 실제 안전 답변은 “잠시 후 다시 질문해 주세요” | 정확한 사용자 안내를 확인 |
| provider 429 HTTP 500 기대 | 동일한 안전 degraded 계약 | degraded 및 쿼터 미사용 확인 |
| provider 500 HTTP 500 기대 | 동일한 안전 degraded 계약 | degraded 및 쿼터 미사용 확인 |
| timeout HTTP 500 기대 | 데이터가 없어도 오류 문구 대신 안전 fallback을 반환 | degraded, 미확인 사실 배제, 재질문 안내 확인 |
| malformed provider 응답 HTTP 500 기대 | 파싱 실패도 안전 fallback을 반환 | degraded 및 쿼터 미사용 확인 |
| SAFE 검사에서 search-ranking-intent를 외부 호출로 판정 | 해당 스크립트는 VM 안의 `fetch()`가 예외를 던지는 오프라인 검사 | VM fetch 차단 패턴을 SAFE 검사에 명시적으로 추가 |

이 7건은 현재 코드 계약에 뒤처진 기대값 또는 정적 검사 오탐이었다. 단순 성공 상태만 보도록 완화하지 않고 안전 fallback 조건과 쿼터/민감 문구 검사를 유지했다. 원래 release 결과는 **113/120**, 수정 후 **120/120**이다.

## 실제로 수정한 검색 문제

- 전날 미커밋 수정에서 본품/부속, 세대/등급/용량, 상품 계열, 제외 조건, 가격과 상품의 연결, 응답/카드 일치, 대화 상태, 주입 제목 노출 등을 방어하고 있었다. 관련 오프라인 회귀 테스트를 보존했다.
- 이번 독립 판매자 제목 공격에서 저가 `charging dock`, `OEM replacement ... compatible`, 유사품/replica/대체품이 정확한 본품보다 먼저 나오거나 AI 식별에서 정확한 상품으로 인정되는 사례를 재현했다. `_search.js`에서 충전 도크를 부속으로, 명시적인 대체품 표시를 별도 감점으로 처리하고 `_aiidentity.js`에서 동일한 표시를 exact 후보에서 제외했다. 명시적으로 도크나 replica를 찾는 질문과 본품+도크 번들은 대조군으로 보존했다.
- 실제 모델 재검증 중 `MXMaster3S 가격과 옵션`이 검색 API로 `MXMaster3S 옵션` 그대로 나가 정확한 후보를 못 찾는 2건을 발견했다. `_intent.js`는 필요한 붙임 모델 표기만 분리하고, 이 경우에만 일반 낱말 `옵션`을 검색어에서 걷어낸다. 일반 `블랙 옵션` 후속 질문과 `Buds3 Pro` 대화 식별은 그대로 유지한다. 실패를 먼저 고정한 회귀 테스트 1개를 추가했고, 기존 후속 대화 테스트 3건도 다시 통과시켰다.
- 외부 환경의 `OPENAI_API_KEY`가 무료 provider 모의 테스트를 바꾸는 문제는 해당 테스트 4개의 환경 격리로 해결했다. 유료 primary 경로는 별도 테스트가 계속 검증한다.

## 공격·mutation 결과

| 검증 | 수정 전 | 수정 후 |
|---|---:|---:|
| 판매자 제목 공격을 포함한 오프라인 red team | 3120/3131, 11 FAIL | 3142/3142, 0 FAIL |
| 고정 seed 개발 분할 | 재검증 전 | 2311/2311 |
| 고정 seed holdout | 825/825 (추가 공격 전) | 831/831 |
| 별도 seed 독립 공격 | 598/598 (추가 공격 전) | 598/598 |
| 전날 Live의 첫 realistic pilot 24건 재실행 | 전날 raw 평가에는 오탐 포함 | 24/24 PASS, exact P@1 24/24 |
| 상품 제목 주입 Live 10건 | 8/10, `MXMaster3S` 검색 누락 2건 | 10/10, exact P@1 10/10 |

오프라인 공격은 광고성 접두/접미, `for`/`compatible with`, 케이스·필름·충전기·도크, OEM/대체품/가품, 중고·리퍼·해외판, 키워드 반복, 부분 모델·브랜드·계열 일치, 세대/등급/용량 차이, 띄어쓰기·혼용·오타 및 대화 이어쓰기를 포함한다. 판매자 제목 공격 10개와 대조군 4개를 추가했다. 핵심 대체품 감점만 임시로 제거하면 판매자 제목 검사가 2/10으로 떨어지고 전체 8건이 실패했다(3123/3131). 즉 새 검사가 실제 보호 로직에 민감하다. mutation은 즉시 원복했고 diff를 확인했다.

실제 OpenAI 호출은 합성 카탈로그와 네트워크 방화벽을 사용했으며 운영 DB·쇼핑 공급자를 호출하지 않았다. 최종 제목 주입 Live 실행에서 한 provider timeout과 그 뒤의 cooldown이 있었지만 서버의 결정론 fallback은 정확한 본품을 보여 줬다. 같은 실패 케이스의 별도 6건 재실행은 provider 6/6 성공이었다. 자동 Live PASS와 P@1은 이 합성 카탈로그에만 적용되며 운영 재고의 품질 수치로 해석하지 않는다.

## 전체 검증 및 범위

- `npm run test:all`: 성공. 내부 `npm test` 성공, `test:regression` **85/85**, `test:release` **120/120**.
- `npm run test:search`: 성공. 검색·ranking intent 및 red-team 개발 분할 **2311/2311**.
- red-team 전체 **3142/3142**, holdout **831/831**, 독립 seed **598/598**, Live 회귀 고정 **197/197**. 이 검증에서 확인된 기존 정상 fixture의 퇴보는 **0건**이다.
- 루트 `package.json`에는 별도 golden, build, lint, typecheck 명령이 없다. AI 평가 스크립트와 user-flow/API 테스트는 `npm test`에 포함되어 실행됐다. 모바일 UI는 이번 변경 범위가 아니다.
- 실제 운영 상품 데이터 및 외부 쇼핑 공급자에 대한 Live 검증은 수행하지 않았다. 이 점이 남는 적용 범위의 한계다.
