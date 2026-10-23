# PR #186 출시 차단 후속 검증 — 2026-10-23

## 기준과 보안 경계

- 검증 시작 시 PR #186 head는 `8ae914b1ca509a8ff612e9fc4ed1046a4c8e093c`였다. #183–#185 변경은 기존 #186 통합 브랜치에 남아 있다.
- Vercel Production에는 `NEON_DATABASE_URL`과 Neon 백엔드 설정이 있지만, 환경 변수 값은 열지 않았다. 따라서 Production의 프로젝트·브랜치 식별자를 Neon 검증 브랜치와 대조하지 못했다.
- Neon 가격 이력은 `migration-test-20261020` 브랜치에서 `SET TRANSACTION READ ONLY`로 읽었다. Production 데이터라는 주장은 하지 않는다. DB 쓰기·삭제·초기화와 배포는 수행하지 않았다.

## 실제 GPT + Neon 가격 사실

실제 OpenAI Responses API와 `gpt-6-luna`를 사용했다. 제품과 가격 이력은 Neon 스냅샷에서 가져왔고, 검색 결과는 검증 harness에 주입했다. 저장 호출은 억제됐다. 그러므로 이는 실제 모델 응답 검증이며 실제 판매처 검색 검증은 아니다.

| 상품 옵션 | 현재가 / 마지막 관측 | 7일 최저 (가격 기록일 수 / 해당 최저 관측 횟수) | 30일 최저 (가격 기록일 수 / 해당 최저 관측 횟수) | 관측 전체 최저 |
|---|---:|---:|---:|---:|
| LG 퓨리케어 Hit 62㎡ 공기청정기 | 345,580원 / 10월 23일 | 343,330원 (7일 / 2회) | 332,100원 (22일 / 1회) | 332,100원 |
| 갤럭시북4 프로 256GB | 1,749,000원 / 10월 23일 | 1,699,000원 (3일 / 1회) | 1,699,000원 (6일 / 1회) | 1,699,000원 |
| KXM2700FH75 화이트 모니터 | 128,250원 / 10월 23일 | 125,000원 (6일 / 1회) | 125,000원 (14일 / 1회) | 125,000원 |
| 에어팟 프로 3 USB-C | 296,000원 / 10월 23일 | 296,000원 (7일 / 4회) | 293,420원 (29일 / 1회) | 293,420원 |

- 네 상품군에서 실제 모델 응답 21개를 최신 판정기로 재평가해 21/21이 가격·기간·관측일 사실을 충족했다. 검증 질문은 현재가/마지막 관측일, 7일·30일 최저, 관측 공백, 전체 최저 여부, 노트북 옵션 가용성을 포함했다. 총 추정 API 비용은 `$0.0098019`였다.
- 노트북 512GB 가격은 스냅샷에 없어 모델이 사용할 수 없다고 답했다. 다른 옵션이나 상품의 가격을 그 옵션에 귀속하지 않았다.
- 이 표본은 가격 이력 사실 확인 4개 옵션의 21개 응답이다. 검색 순위나 전체 추천 정확도 점수로 해석하지 않는다.

## 핫딜

- 읽기 전용 검증 브랜치의 내부 피드에는 활성·미만료 primary 딜 13건이 있었다: `VERIFIED_HOT` 3건, `GOOD_DEAL` 9건, `POTENTIAL_DEAL` 1건. 잠정 후보는 검증 딜로 승격하지 않는다.
- 외부 피드는 최근 72시간 게시물이 없어 현재 추천 가능한 검증 외부 딜과 커뮤니티 제보가 각각 0건이었다. 최근 수집은 10월 19일이다. 실데이터 기반 실제 AI 핫딜 추천 성공은 확인하지 못했다.
- 격리된 fixture 회귀는 전체 `npm test` 안의 `scripts/test-ai-hotdeal-tool.js`를 포함해 통과했다. `AI_HOTDEAL_TOOL` 기본 비활성 설정을 유지한다.

## CI 취소 및 재실행

- 이전 취소 실행은 `setup-node` 단계에서 취소됐고 설치·테스트 단계는 모두 건너뛰었다. workflow에 동일 ref의 `cancel-in-progress: true`가 설정되어 있어 더 새 실행의 대체와 일치하지만, 저장된 로그에 취소 주체·정확한 사유가 없어 원인을 확정할 수 없다.
- 직전 PR head `8ae914b`의 AI security validation, Mobile Check, Tests는 모두 성공이었다. 이번 후속 소스 수정 뒤 전체 `npm test`도 종료 코드 0으로 완료됐다. 브랜치에 새 커밋을 올리면 해당 커밋의 GitHub 검사 결과를 다시 확인한다.

## 모바일 의존성 감사

- 새 `npm audit --prefix apps/mobile --json` 실행은 종료 코드 1을 반환했고, 21개 취약 패키지 경로(18 high / 3 moderate)를 계속 표시했다. 이 수치는 21개의 독립 취약점이 아니라 전이 의존성의 상위 패키지 전파를 포함한다.
- `braces` GHSA는 2026-10-23 GitHub Advisory Database에서 실제 악용 가능성이 없다는 이유로 철회됐다. 감사 응답에는 철회 전 항목이 남아 있어 npm 결과와 최신 GHSA 상태 사이에 지연이 있다: [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
- 현재 high 항목인 `node-forge@1.4.0`은 `expo → @expo/cli → @expo/code-signing-certificates → node-forge` 개발·빌드 도구 경로다. 해당 패키지에서 취약한 인증서 서명 검증 API를 호출하는 코드가 확인됐고 아직 패치 버전은 없다: [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv). 앱 설정은 OTA 업데이트와 code signing을 비활성화하며 앱 소스에서 해당 패키지 호출은 발견하지 못했다. 이는 네이티브 앱 런타임 취약점으로 확인된 사항은 아니지만 빌드 도구 공급망 위험으로 추적해야 한다.
- `uuid@7.0.3`은 `xcode@3.0.1`에서만 보였고, 사용 코드는 `uuid.v4()`만 호출한다. 현재 advisory는 v3/v5/v6의 외부 출력 버퍼 경계 검증을 다루므로 확인한 호출 경로는 영향받지 않는다. 패치 버전은 `11.1.1` 이상이다: [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
- NPM 자동 수정은 Expo 44 / React Native 0.72 메이저 다운그레이드를 제안했다. 이는 현재 SDK와 호환되는 안전한 수정이 아니므로 의존성을 변경하지 않았다. 상위 SDK와 네이티브 모듈을 호환 매트릭스에 따라 갱신하는 것이 안전한 수정 경로다.

## 회귀 수정 및 검사

- 실제 모델이 “관측 기록에서 가장 낮게 관측된 가격”을 최저가 후보라고 설명하고 “확정되지는 않았습니다”를 덧붙인 표현을 기존 재현 응답으로 고정했다. 날짜 숫자와 7일·30일 전체 관측일 수가 해당 최저 가격의 반복 횟수로 오인되지 않도록 파서와 검증기를 보정했다.
- 별도 회귀 사례로 7일·30일 전체 관측일 수와 그 창의 최저가 출현 횟수를 분리해 검증했다.
- `node scripts/test-ai-provenance.js`: 285/285 통과.
- `node --test scripts/test-live-price-check.js`: 12/12 통과.
- `node scripts/test-price-integrity.js`: 전체 `npm test` 경로에서 통과.
- `node scripts/test-ai-hotdeal-tool.js`: 전체 `npm test` 경로에서 통과.
- 전체 `npm test`: 종료 코드 0. 첫 sandbox 실행은 loopback fixture 제한으로 실패했고, 로컬 테스트 loopback 접근을 허용한 재실행은 성공했다.
- Mobile Check 동등 명령 `npm run check --prefix apps/mobile`: 타입 검사·린트·172개 테스트 통과.

## 출시 판정

**FAIL — Production 배포 보류.** 가격 이력 사실과 실제 GPT 응답은 네 상품군 스냅샷에서 확인했다. 하지만 Vercel Production Neon 브랜치 매핑과 실제 판매처 검색은 확인되지 않았고, 외부 핫딜 실데이터에서 현재 적격 추천 후보도 없었다. `node-forge` 빌드 경로 advisory도 패치가 없다. PR #186은 갱신하되 main 병합과 Production 배포는 하지 않는다.
