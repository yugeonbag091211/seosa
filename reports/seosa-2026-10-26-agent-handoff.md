# SEOSA 2026-10-26 Claude Code 중단 후 인수인계

> 최종 상태는 다시 검증해야 한다. 이 문서는 2026-10-26 10:15 KST 시점의 Claude Code 기록과 당시 GitHub/Vercel 실제 조회 결과를 대조한 것이다.

## 1. 배포 경계

- 운영 Git main: `5cce850d8ea7d38cfa28413638e1a0c2b10e3406`.
- Vercel Production: `dpl_ofK5DTt54sUBVjSaqsCmq2fcV9Wj` (`READY`, `seosa.ai.kr`).
- 통합 PR: [#197](https://github.com/yugeonbag091211/seosa/pull/197), `integration/seosa-ai-final-20261026`, **draft/open/unmerged**.
- PR #197의 Claude Code 마지막 푸시: `58f28c085ea274e19e088f6b75480c492f73dcc5`. 현재 문서는 그 이후 CI 안전망 변경과 함께 추가됨.
- 기존 PR #194(점심·저녁 변동성 수집)와 #195(수집 결과 이메일)는 **Production에 반영된 상태를 유지**.
- PR #196의 옛 분기 자체는 여전히 열려 있으며, #197이 그것을 대신 통합하는 경로다.

## 2. Claude의 실제 수행 기록(사용자가 공유한 로그 기준)

1. PR #196을 최신 main에 통합하고, 예산 상한 근처에 상품이 없어도 다른 예산 내 상품을 거절하는 결함, 새 주제에도 카드 한 장으로 제한하는 결함, 색상 제외 하드코딩, 비교 질문 예산 필터 오류를 재현·수정.
2. 모의 GPT/고정 상품 카탈로그를 사용한 **서로 다른 질문 1,000개** 평가기를 도입. 사용자 로그에 따르면 최종 결과는 1,000/1,000.
3. 홀드아웃 185문항: **첫 평가 155/185**, 오류를 보고 코드와 판정기를 수정한 뒤 **185/185**. 그러므로 이것을 *완전히 새로운 독립 검증 185/185*이라고 주장하면 안 된다.
4. 로그에 기록된 동일 판정기 비교는 원래 Production 603/1,000, 원래 #196 680/1,000, 최종 수정본 1,000/1,000. 비교는 동일 모의 카탈로그와 테스트 오라클 범위에서만 유효하다.
5. AI 코드를 위한 재현·보안·오퍼 매칭 테스트 및 `npm test`가 모두 통과했다고 기록. 실제 GPT E2E, 실제 쿠팡·ADPICK 검색 통합 실호출은 **0회**.
6. 모바일 앱에서 서버가 보내는 `identityNote`(예: 다른 옵션: 용량 다름)를 실제 카드에 표시하도록 수정. 타입·린트·173/173 검사 통과. Expo 웹 렌더링 375px/768px은 확인했으나 Android/iPad 실기기 검증은 하지 못함.
7. 가격 재확인 작업은 당시 기준 실행된 적 없었고, 12:05 및 19:05 KST 예약 실행의 결과·메일 실수신을 확인하지 못함.
8. 상세한 문항별 결과 폴더 `reports/ai-eval-1000-2026-10-26/`는 로컬에만 남아 있고 커밋되지 않았다고 보고됨. 같은 데이터가 GitHub에 있다고 주장하지 않는다.

## 3. 이번 인수인계에서 검증 및 보강

- GitHub API 재조회: PR #197 **mergeable/clean**, draft, CI `test`, `ai-validation`, 모바일 `check` 성공.
- PR head `58f28c0`의 Vercel Preview `dpl_56hEhGN8TfA93rFyksA3DDUHaBPe`는 `READY`로 확인.
- AI 수정이 공유 상품/옵션 판정기 `api/_identitycore.js`를 건드린다. 이전 클로드 로그에서 그 판정기가 변경돼 오퍼 동일성 테스트에서 **FP(잘못된 동일상품 판정) 1건**이 발생했다가 수정된 전력이 있다.
- 그래서 `.github/workflows/collector-regression.yml`에 공유 identity parser 관련 변경을 트리거로 추가하고 `scripts/test-offer-identity.js`, `scripts/test-identity.js`를 명시적으로 실행하도록 강화. 운영 수집 코드/쿼터/DB는 변경하지 않았다.

## 4. 남은 작업 — 실제로 필요한 릴리스 게이트

### 1순위: PR #197

- 새 커밋 HEAD의 `Tests`, `AI validation`, `Mobile Check`, `Collector Regression`, Vercel Preview 빌드 모두 PASS 확인.
- 공유 오퍼 식별 테스트에서 다른 상품·옵션의 FP=0 유지.
- **실제 GPT + 실제 판매처 검색 E2E**를 읽기 전용 Preview 또는 격리된 DB에서 실행하고, 예산/두 제품 비교/후속 카드/옵션/보안/가격 근거가 정상인지 기록.
- 상업 API 크레딧, 쿠팡·ADPICK 호출 제한과 타임아웃을 준수. 격리 없는 Preview의 쓰기 경로 사용 금지.
- 필수 릴리스 게이트 충족 전 `main` 병합 및 Production 배포 금지. PR draft 유지.

### 2순위: 평가

- 저장소에 없는 로컬 원본 평가 로그를 복구할 수 없으면 '미커밋'이라고 명시. 평가 script 자체는 저장소에 있음.
- 실패 사례에 대한 문항별 분류를 생성하고, 기존 수정에 사용되지 않은 **새로운 독립 홀드아웃** 세트로 품질 재평가.
- 오프라인/모의 점수와 실제 GPT+실판매처 점수 분리 보고.
- 실제 비용·API 호출 수 계측이 어렵거나 공유 수집기로 인한 호출 제한이 있으면 무리한 유료 호출 금지.

### 3순위: 가격 수집

- `volatile-prices.yml`의 **2026-10-26 KST 12:05 / 19:05 예약 실행** 이후 워크플로 Run/Job 로그를 따로 확인.
- API 실제 호출 수, 저장 건수, 실제 표시가격 변경 건수, blocked/lock/quota/skipped, 메일 발송 API 결과 확인.
- 이메일 API 응답 성공과 실제 수신함 도착은 분리한다. 종료 전에는 실행 완료 주장 금지.
- 운영 DB 데이터 쓰기는 기존 승인된 수집 코드만 수행. 수동 검증용 가격 덮어쓰기 금지.

### 4순위: 모바일

- 이미 수정한 `identityNote` 라벨의 Android/iPad **실제 렌더링**을 확인.
- 앱의 웹 동등성 비교표를 작성하되 미구현 기능을 완료로 표기하지 않는다.
- `apps/mobile/app.json`의 `ios.supportsTablet=false`는 iPad 고유 레이아웃 미지원이라는 사실을 유지해서 기록.
- `npm audit`에 남은 Expo/@expo/cli 및 ESLint 도구 경로 권고 사항을 재검토. SDK를 이전 버전으로 강제 다운그레이드하지 않는다.
- QR은 실제 접근 가능한 Expo 개발 서버가 있을 때에만 제공. 유료 빌드·스토어 공개는 별도 승인.

## 5. 결론

**현재 완료된 것**: 변경 코드 푸시, PR #197 Preview 빌드, 기존 코드 CI(수정 전 head) 통과, 모바일 옵션 라벨 코드 개선.

**아직 완료하지 않은 것**: 이번 CI 보강 후 재검증, 실제 GPT·실검색 E2E, Production 병합, 12:05/19:05 예약 작업 및 메일 실측, Android/iPad 실기기 테스트, 원본 평가 기록 커밋.

Claude Code의 사용량 한도로 작업이 중단됐을 뿐, GitHub의 커밋과 PR은 유지된다. 다음 에이전트는 이 보고서를 기준으로 작업을 재개하되 새 HEAD와 운영 상태를 먼저 다시 조회한다.
