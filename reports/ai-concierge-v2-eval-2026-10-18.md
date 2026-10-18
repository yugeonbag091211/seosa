# AI Concierge v2 실측·비교 보고 (2026-10-18)

PR #169 · 브랜치 `claude/seosa-gpt-shopping-agent-da8d5f`

## 한 줄 요약

- **v1 은 실제 데이터에서도 보고된 사고를 그대로 재현했다.** 22턴 중 21턴이 degraded 였다.
  - "가성비 노트북" → 셀러론 N5100 추천.
  - "두 번째 거 지금 사도 돼?" → 재테크 **책**.
  - "지금 사는 게 좋을까?" → 다른 상품, 또는 **책**.
  - "단점 알려줘" → "찾지 못했어요".
- **v2 는 실제 OpenAI 로 아직 재지 못했다.** `OPENAI_API_KEY` 가 Production 에만 있어서, Preview 에서 v2 는 설계대로 v1 에 넘겼다(실측 1건으로 확인).
- v2 의 도구 계층은 **실제 판매 상품명**으로 검증해 결함 7가지를 고쳤다(아래 §4). 오프라인 검사는 146/146 이다.

## 1. 방법

| 항목 | 값 |
|---|---|
| 대상 | Preview `seosa-git-claude-seosa-gpt-shopping-agent-da8d5f-seosa.vercel.app` (Vercel Authentication 보호) |
| 인증 | Vercel CLI 로그인 → `vercel curl` 이 프로젝트의 보호 우회 토큰을 스스로 붙임. 스크립트는 비밀값을 다루지 않는다 |
| 전송 | `AI_EVAL_TRANSPORT=vercel-curl npm run eval:agent-live` — 지연은 curl `time_total`(실제 HTTP 왕복) |
| 시나리오 | 12개 대화, 22턴. 지시서 12항 A·B 와 실제 사고 2건 (`scripts/eval-ai-agent-live.js` DIALOGS) |
| 원자료 | `reports/ai-agent-v1-v2-live-2026-10-18-preview-v1-baseline.{md,json}` |
| 쓰기 | 앱이 원래 하는 일 외에는 없다. AI 검색이 관측을 저장하는 것은 일반 사용자 질문과 같다. Production 설정·배포 변경은 없다 |

### 실행 중 해결한 환경 문제

| 문제 | 원인 | 해결 |
|---|---|---|
| `vercel whoami` → `Cannot convert argument to a ByteString` | PC 호스트 이름이 한글(U+BC15…)이고, CLI 가 이것을 HTTP 헤더에 넣음 | `scripts/_vercel-ascii-hostname.js` preload. CLI 프로세스에서만 ASCII 이름을 쓰고 시스템은 그대로 둔다 |
| `vercel curl /api/ai` 가 `/C:/Program Files/Git/api/ai` 로 요청 | Git Bash(MSYS) 경로 변환 | `MSYS_NO_PATHCONV=1`(평가 스크립트는 자동 적용) |
| 요청마다 401 | Preview 가 Vercel Authentication 으로 보호됨 | `vercel curl` 이 우회 토큰을 생성·사용 |
| v2 헤더를 보냈는데 v1 이 답함 | `OPENAI_API_KEY`·`OPENAI_MODEL` 이 Production 전용(Sensitive). `ADPICK_API_KEY`·`GROQ_API_KEY` 도 같음 | 값은 읽거나 복사할 수 없다. **사용자가 Preview 대상에 추가해야 한다** |

⚠ `vercel curl --debug` 출력이 프로젝트의 보호 우회 토큰을 **평문으로** 찍었다. 이 세션 기록에 한 번 남았으므로 **Vercel → Settings → Deployment Protection 에서 Protection Bypass for Automation 을 재발급**하길 권한다. 저장소·리포트에는 들어가지 않았다(검사함).

## 2. v1 실측 기준선 (Preview, 실제 쿠팡·DB 데이터)

Preview 의 v1 은 OpenAI 가 없어 무료 OpenRouter 사슬로 답했고, 대부분 실패해 결정론 답으로 나갔다. 그래서 **문장 품질은 Production 보다 나쁘다.** 그러나 **검색·랭킹·카드·검증·대체 로직은 Production 과 같은 코드**이므로, 아래 상품 선택 결과는 그대로 유효하다.

| 시나리오 | v1 결과 (실측) | 판정 |
|---|---|---|
| A1 성능좋고 가장 가성비인 노트북 최저가 | ★ 2022 노트북 11.6 **셀러론 N5100** 298,000원. 카드 4장이 모두 entry/basic CPU | ✗ 보고된 사고 재현. 성능 조건이 사라졌다 |
| A1 → 지금 사는 게 좋을까? | 다시 검색해 **다른 상품**(에이서 i5 11세대 **[리퍼코리아]** 298,000원)을 추천. 리퍼라는 말은 없음 | ✗ 기억 끊김 · 리퍼 미고지 |
| A2 가장 저렴한 노트북 | 같은 리퍼 에이서 · 리퍼 미고지 | ✗ |
| A3 50만 원 이하 문서용 | neobook 셀러론 319,000원 (예산 반영) | △ |
| A4 100만 원 이하 게임용 | "현재 AI 답변이 지연되고 있습니다" | ✗ (Preview 무료 사슬 실패) |
| A5 30만 원 이하 노캔 헤드폰 | 소니 WH-CH720N 139,000원 | ○ |
| A6 가성비 무선 마우스 | 로지텍 LIGHTSPEED 32,390원 | ○ |
| B1 → 더 싼 거 없어? | 첫 답과 **같은 상품**(398,000원)을 다시 추천 | ✗ |
| B2 → 두 번째 거 지금 사도 돼? | **「나의 첫 번째 재테크 교과서」**(책) 19,800원 | ✗ "번째" 검색 |
| B3 일반 질문(CPU·GPU 차이) | "AI 답변이 지연" | ✗ |
| B3 → 아까 추천한 첫 번째 제품 | 같은 마우스 재검색 | △ (우연히 같은 상품) |
| B4 → 지금 사는 게 좋을까? (마우스 뒤) | **「지금 어떤 마음일까?」**(책) | ✗ "지금" 검색 |
| G1 인텔·AMD 차이 | 답했지만 **마크다운 표** — 웹은 표를 그리지 못한다 | △ |
| G1 → 대학생 RAM 8GB 충분해? | "AI 답변이 지연" | ✗ |
| G2 → 추천해준 상품의 단점 알려줘 | **"지금 조건에 맞는 상품을 찾지 못했어요."** | ✗ 보고된 사고 재현 |

자동 집계 (정의는 `scripts/eval-ai-agent-live.js` CHECKS)

| 항목 | v1 (Preview) |
|---|---|
| HTTP 200 | 22/22 |
| degraded | 21/22 |
| 지연 p50 / p90 / 최대 | 4,892 ms / 8,951 ms / 11,953 ms |
| "찾지 못했" 류 | 1 |
| 인터넷 최저가·역대 최저 주장 | 0 / 0 |
| 가성비 노트북 1순위가 entry CPU | 예 |

## 3. v2 — 무엇을 재고 무엇을 못 쟀나

| 항목 | 상태 |
|---|---|
| Preview 에서 v2 경로 진입 | ✓ 헤더 `x-seosa-ai-engine: v2` 로 진입. 키가 없어 `nokey` → v1 으로 정상 위임됐다(실측 1건: HTTP 200, `engine` 없음, 오류 없음) |
| 실제 OpenAI Responses API 호출 성공 여부 | **미측정** — Preview 에 키 없음 |
| GPT 판단 품질·대화 기억·지연·비용(실측) | **미측정** — 같은 이유 |
| 요청 형식(도구·strict 스키마·json_schema·function_call_output 재전송) | 공식 문서와 대조해 일치. 실호출 검증은 아님 |
| 오프라인 배관(기억·검증·재작성·카드·플래그·장애) | ✓ 146/146 (`npm run test:agent`) |
| v1 회귀 | ✓ `npm test` 99/100 — 남은 1건은 Windows CRLF 뮤테이션 테스트로, 이 PR 과 무관한 기존 문제. test:regression 85/0, test:release 120/0 |

### 지연·비용 추정 (실측 아님)

v2 가 보내는 실제 문자열 크기를 쟀다. 토큰은 어림했다(한글 1자≈1토큰, 그 밖 3.6자≈1토큰).

| 구성 | 크기 |
|---|---|
| 지시문 | 2,928자 ≈ 1.9k 토큰 |
| 도구 정의 + 출력 형식 | 2,285자 ≈ 0.9k 토큰 |
| `search_products` 결과 (실제 노트북 8건) | 2,624자 ≈ 0.9k 토큰 |

- **상품 질문 1턴**(검색 1회 + 최종 답 = 2라운드): 입력 ≈ 7.5–9k, 출력 ≈ 0.5–0.8k 토큰 → `gpt-6-luna` 단가(저장소 표 기준 $0.10 / $0.50 per 1M)로 **약 $0.001–0.0013**. 재작성이 붙으면 +$0.0007 안팎.
- **일반 대화 1턴**(1라운드): 약 $0.0005.
- 지연은 모델 왕복 2회 + 검색 1회다. v1 은 왕복 1회 + 검색이다. v2 가 v1 보다 왕복 1회만큼 느릴 것으로 예상하지만, 실측 전까지는 숫자를 대지 않는다.

## 4. 실제 상품명으로 찾은 v2 도구 결함과 수정

| 실제 상품명(Preview) | 수정 전 | 수정 후 |
|---|---|---|
| …노트북**[리퍼코리아]** | 상태 표기 없음(새 상품처럼 보임) | `refurbished` — v2 전용 보조 판정(공용 `_search` 는 v1 순위에 쓰이므로 그대로 둠) |
| **8세대** i7 **램8G** SSD256GB | `upper` 만 보이고 세대·램 없음 | `cpu_generation: 8`, `ram_gb: 8` + "낮은 세대 상위 등급은 최신 하위 등급보다 느릴 수 있다" 지시 |
| 512GB, 16GB, **Free DOS** | 램·저장 없음, OS 없음 | 뒤집힌 순서 해석 · `os: FreeDOS(윈도우 별도)` 를 가성비 판단에 반영하라는 지시 |
| i3-6006U 16GB 500GB **HDD** | 세대·HDD 없음 | `cpu_generation: 6`, `storage_type: HDD` |
| Galaxy Book5 Pro … **Ultra 5** RAM16GB | CPU 없음 | `Intel Core Ultra 5` (컴퓨터 상품명에서만 — "S24 Ultra 5G" 폰은 읽지 않음) |
| JUMPER … **WIN11** Home | 모델 = "WIN11" | 운영체제 표기는 모델이 아니다 |
| **목걸이클립 목걸이줄 이어폰목걸이** 무선이어폰 | 본품(main) | `accessory` ("케이스 포함" 본품은 그대로 main) |
| i5-**1135G7** | 모델 번호 잘림 | 보존 + 11세대 |
| (G1) GPT 류 답변의 마크다운 표 | 웹에 `| 구분 | …` 그대로 노출 | 지시문으로 표 금지 + v2 답 정리에서 표 → 목록, 제목 → 강조 |

각 항목은 `scripts/test-ai-agent.js` [U4]·[U6]·[U5] 에 실제 문자열로 고정했다.

## 5. 남은 한 단계 — v2 실측

1. Vercel → Settings → Environment Variables 에서 `OPENAI_API_KEY`·`OPENAI_MODEL` 의 대상에 **Preview** 를 추가한다(가능하면 브랜치 `claude/seosa-gpt-shopping-agent-da8d5f` 만). `ADPICK_API_KEY` 도 Preview 에 두면 Production 과 같은 후보 집합이 된다.
2. Preview 를 다시 배포한다(이 브랜치에 커밋을 하나 올리면 된다).
3. v1 과 v2 를 같은 Preview 에서 실행한다. 키가 생기면 Preview 의 v1 도 OpenAI 를 쓰므로, 지금의 무료 사슬 기준선보다 공정한 비교가 된다.
   `AI_EVAL_TRANSPORT=vercel-curl AI_EVAL_VERCEL_CWD=<.vercel 연결 폴더> AI_EVAL_BASE_URL=<preview> npm run eval:agent-live`

Production 전환(`AI_CONCIERGE_V2_ENABLED=1`)은 위 실측 결과를 보고 따로 결정한다.
