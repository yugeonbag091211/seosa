# SEOSA 현재 상태 (2026-08-25 감사 기준)

이 문서는 출시 전 전체 감사 시점의 사실만 적는다. 계획이나 희망은 「J. 다음 개발 우선순위」에만 둔다.
배포 절차는 [DEPLOY.md](DEPLOY.md) 에 있다.

---

## A. 현재 기능 현황

| 기능 | 상태 | 근거 |
|---|---|---|
| 홈 (오늘의 셀렉션 / 이달의 큐레이션) | 동작 | `api/init.js`, 운영 200 / 87ms |
| 상품 검색 | 동작 | `api/search.js`, 운영 200 / 7.6s (쿠팡 실시간 호출) |
| 상품 카드 · 상세 · 쿠팡 이동 | 동작 | `public/index.html`, `Fmt.safeUrl` 로 스킴 검증 |
| 가격 이력 차트 | 동작 | `api/history.js`, 운영 200 |
| 오늘의 가격 하락 | 동작 (3중 검증) | `price_drop_top` + `_price.todayDropConfirmed` + `plausibleDrop` |
| AI Concierge | 동작 | `api/ai.js` (OpenRouter) — **크레딧 402 상태, 아래 H 참고** |
| 찜 / 최근 본 / 검색 기록 | 동작 | `api/sync.js` → `user_data` |
| 프로필 (닉네임·예산·취향) | 동작 | `api/sync.js?resource=profile` → `profiles` |
| 가격 알림 | 동작 | `scripts/check-alerts.js` (GitHub Actions) |
| 이메일 코드 로그인 | 동작 | `api/auth.js` + `api/_auth.js` |
| PRO 결제 (최초) | 동작 | `api/payment.js` — 실결제 미검증, 아래 I 참고 |
| PRO 자동 갱신 | **신규, 미검증** | `_billing.renewDueSubscriptions` ← `api/cron.js`, 마이그레이션 필요 |
| 모바일 UI | 동작 | 반응형 단일 HTML |
| **사용자 계측** | **신규, 마이그레이션 필요** | `api/_analytics.js` ← `/api/stats`, 방문/재방문/검색/클릭/AI |

---

## A-2. UI/UX 전면 리디자인 (2026-08-30)

사용자 피드백: **"일단 UI가 너무 Claude 스러워서 거부감이 생김. 그래서 아예 클릭조차 하지 않았음."**

### 무엇이 Claude 처럼 보이게 했는가 — 색이 아니라 조합

다섯 가지가 동시에 작동하고 있었다. 하나만 바꿔서는 안 되는 문제였다.

1. 웜 페이퍼 배경 `#FCFCFB` + 웜 그레이 텍스트 `#6E6E68`
2. 세리프 디스플레이 (로고 · `<em>서사</em>` = Noto Serif KR)
3. 넓은 자간의 모노 eyebrow (`DAILY PRICE LEDGER`, letter-spacing 2.15px, 대문자)
4. 중앙 정렬 에디토리얼 레이아웃 + `--sec-gap:120px`
5. 모노크롬 + 검정 알약 CTA

### 새 디자인 언어 — 「가격 원장(Ledger)」

이 제품의 정체성은 "예쁜 큐레이션"이 아니라 **매일 가격을 기록하는 원장**이다.
그 사실에서 시각 언어를 끌어냈다.

- **카드가 아니라 행(row)** — 규칙선이 구조를 만든다. 카드는 사진이 필요할 때만.
- **색은 데이터의 것** — 상시 의미색은 하락(초록)·상승(빨강) 둘뿐. 크롬은 무채색.
  브랜드색(황동 `#8A6D1C`)은 「기록」 정체성 자리에만 쓰고 컨트롤에는 쓰지 않는다.
- **표면은 순백** — 상품 사진이 흰 배경 누끼로 오므로 페이지가 웜 페이퍼면
  카드마다 흰 얼룩이 보인다. 표면색은 취향이 아니라 사진에 맞추는 문제다.
- **관측일을 항상 밝힌다** — 쿠팡도 네이버도 하지 않는 것. SEOSA 만의 표식.

### 실측 (리디자인 전 → 후)

| 지표 | 데스크톱 1280 | 모바일 413 |
|---|---|---|
| 히어로 높이 | 612px → **125px** | 415px → **110px** |
| 첫 원장 행까지 | 990px → **404px** (폴드 안) | 631px → **290px** |
| 첫 상품 카드까지 | 2043px → **1134px** | 1446px → **981px** |
| 검색 결과 첫 카드까지 | — | 610px → **335px** |
| 문서 전체 높이 | 5860px → 4701px | 6426px → 5130px |
| `border-radius ≥ 20px` 요소 | **122개 → 17개** (전부 의도된 원) |
| 카드 높이 / 그중 버튼 | 598px / 99px → **491px / 39px** |

### 구조 변경

| 영역 | 변경 |
|---|---|
| Header | 검색을 헤더에 상주(`#q` 이동). 발견성↑ · 시각 지배↓ · 히어로 확보 |
| Hero | 612px 히어로 삭제 → 「오늘의 기록」 바 (수집일 + 하락 상품 수, 실데이터) |
| Category | 해시태그 알약 → 규칙선 위 가로 내비게이션 |
| Card | 전폭 버튼 3개 세로 스택 → 액션 한 줄. 위계를 가격 우선으로 역전 |
| Ledger | 흰 상자 안의 표 → 페이지 자체가 원장. 모바일에서도 액션 노출 |
| AI | 52px 검정 FAB(상품을 덮음) → 36px 앵커 + 맥락 진입점 |
| AI 패널 | 검정 말풍선(ChatGPT 클론) → 황동 세로선 + 흰 바탕 |
| Mobile | 상세 필터 기본 접힘(토글) — 첫 결과 카드가 610 → 335px |
| Type | Noto Serif KR 제거, 본문 Pretendard, 모노는 관측일 스탬프에만 |

### 이 과정에서 잡은 것

- **`related_product_click` 계측이 아예 없었다.** 추천 섹션(오늘의 셀렉션 ·
  관심 카테고리 · 이달의 큐레이션 · 최근 본)에서 일어난 상품 클릭이 지표에
  통째로 빠져 있었다. `trackCardOrigin()` + METRICS 화이트리스트 추가로 해결.
- **검색 결과 화면 맨 위에 기능 안내 카드 2장이 남아 있었다.** `.values` 만
  숨기고 같은 섹션의 `.feature-cards` 는 그대로 뒀기 때문. 섹션 전체를 접는다.
- **`.why-line` 색 방향 버그(리디자인 중 유입)** — "평균보다 23% 높아요"가
  하락색(초록)으로 나갔다. 방향별 클래스로 분리.

---

## B. 기술 스택

- **런타임** Node 22.x (`type: commonjs`), 의존성 2개 (`@supabase/supabase-js`, `dotenv`)
- **호스팅** Vercel Hobby — 서버리스 함수 **11 / 12** (상한 근접)
- **프론트** 빌드 없는 단일 `public/index.html` (ES5 문자열 결합, 번들러·프레임워크 없음)
- **DB** Supabase (PostgREST + Postgres)
- **외부 API** 쿠팡 파트너스, Toss Payments, OpenRouter, Resend(메일)
- **크론** Vercel Cron `0 18 * * *` (UTC) = KST 03:00 → `/api/cron`
- **테스트** 표준 라이브러리만 사용하는 자체 러너 (테스트 프레임워크 없음)

### 서버리스 함수 11개

`ai` `alerts` `auth` `cron` `history` `init` `payment` `rec` `search` `stats` `sync`
(`api/_*.js` 16개는 공유 모듈이라 함수로 세지 않는다.)

> ⚠️ **함수 1자리 남음.** 새 엔드포인트를 만들면 배포가 상한에 걸린다.
> 자동 갱신을 별도 엔드포인트가 아니라 `/api/cron` 에 얹은 이유가 이것이다.

---

## C. 결제 구조

```
[프론트] PRO 버튼
   → POST /api/payment?action=prepare        (토큰 필요)
       · orderId    서버 생성
       · customerKey 토큰의 이메일에서 파생  (프론트가 못 고친다)
       · amount     서버 상수 4,900원
       · payments 에 status='pending' 행을 먼저 남긴다   ★
   → TossPayments.requestBillingAuth()       (clientKey = 공개 키)
   → POST /api/payment?action=confirm { orderId, authKey }
       0)  원장 조회 → 주인·금액·상태 검증
       0b) status='charging' 이면 복구 경로 (재승인 안 함)
       0c) pending → charging 원자적 선점    ★
       1)  authKey → billingKey              (15초)
       2)  chargeBilling                     (60초, 멱등키 = orderId)
       3)  verifyPayment                     (orderId·금액·상태 대조)
       4)  charging → paid                   (WHERE status='charging')
       5)  activatePro                       (+30일)
```

### 상태 기계 (`_billing.ALLOWED_TRANSITIONS`)

```
pending  → charging | failed
charging → paid | failed
paid     → canceled
failed / canceled = 종착역 (되돌아가지 않는다)
```

### 이 설계가 막는 것

| 위험 | 방어 |
|---|---|
| 승인 중 함수 타임아웃 → 이중 청구 | 타임아웃을 `failed` 로 굳히지 않고 `charging` 유지 → 다음 요청이 토스에 `orderId` 로 재조회 |
| 동시 요청 이중 승인 | `UPDATE ... WHERE status='pending'` 한 문장 (행 잠금) |
| 프론트가 금액 조작 | body 의 `amount`/`plan`/`email` 을 읽지 않는다 |
| 남의 주문 가로채기 | 주문 `email` 과 토큰 `email` 대조 |
| 웹훅 위조 | 토스는 결제 웹훅에 서명을 넣지 않는다 → 본문을 믿지 않고 `getPayment` 재조회 |
| 기록 없는 PRO | 원장 확정 실패 시 권한을 주지 않는다 |

### 키 구분

- `TOSS_CLIENT_KEY` (`test_ck_`/`live_ck_`) — 프론트 노출 정상
- `TOSS_SECRET_KEY` (`test_sk_`/`live_sk_`) — 서버 전용, 프론트에 없음 (테스트로 고정)
- 위젯 전용 키(`_ck_`가 아닌 형태)와 test/live 혼용은 `_toss.isMixedKeyEnv` 가 부팅 시 거부

### 자동 갱신

만료 3일 전부터 `/api/cron` 이 하루 한 번 최대 20건 처리. 연속 3회 실패 시 `billing_key` 를 지워 청구를 멈춘다(즉시 강등은 하지 않는다 — 이미 낸 기간은 살려 둔다).

---

## D. 가격 수집 구조

```
쿠팡 파트너스 API  (8초 타임아웃, 2분 서킷 브레이커, 최소 호출 간격)
   → _shop.searchAll → collapseOptions
   → products      (product_id, mall) UNIQUE
   → price_history (product_id, mall, vendor_item_id) 계열별
   → price_drop_top (뷰: 최근 30일, 계열별 latest vs prev, products INNER JOIN)
   → api/init.js  → todayDropConfirmed → plausibleDrop → 상품당 1장 → 상위 8
```

### 날짜 규칙

- 저장·비교 **모두 KST**. `_kst.kstToday()` 는 런타임 TZ 에 의존하지 않는다.
- 하루 경계는 `recorded_date` 라벨이 아니라 **`recorded_at` 실제 시각**으로 판정 (커밋 `d5766aa`).
- 달력 월은 `_kst.kstMonth()`. `new Date().getMonth()` 는 Vercel(TZ=UTC)에서 KST 매월 1일 9시간 동안 지난달을 가리켰다.

### "오늘의 가격 하락" 3중 검증

1. **뷰** — 최근 30일 계열만, `products` INNER JOIN (고아 이력 배제)
2. **`todayDropConfirmed`** — ① 오늘(KST) 수집분이 있는가 ② 화면에 찍을 `current_price` 가 그 오늘 값과 같은가 ③ 직전 관측보다 실제로 내려갔는가 ④ 화면의 `prev_price` 가 원장의 직전 관측과 같은가
3. **`plausibleDrop`** — 쿠팡만, `product_id` 가 숫자, `link` 존재, 하락률 상한

> **"예전에 떨어진 가격이 오늘의 하락에 계속 뜨는 문제" 는 해결됐다.**
> 위 2번의 ①③ 이 직접 막고, `scripts/test-regression.js` 의 O1 15케이스가 이 성질을 고정한다.

### 재개 가능 수집 (`price_job_state`)

`job_date`(KST) + `cursor_key` + `status`. 같은 날 완료되면 재실행은 no-op.

**2026-08-25 운영 실측:**

```
job_date 2026-08-25  status completed  processed 1101/1101
쿠팡 products 1115 / 오늘 가격 있음 522 (46.8%) / 없음 593
같은 상품·같은 날 중복 기록  0건  (전체 기간 0건)
실패 검색어 0종
```

> ⚠️ 수집 **작업**은 완전히 끝났지만 **커버리지가 46.8%** 다. 원인은 실패가 아니라 `notFound`(104건) — 등록된 상품이 해당 키워드의 쿠팡 검색 결과에 더는 안 잡힌다. 아래 H 참고.

---

## E-2. 사용자 계측 구조 (2026-08-25 신규)

```
[브라우저]  seosa_vid = 난수 (localStorage)
   진입      → GET /api/stats?event=visit&vid=…   → track_visit  RPC
   상품 클릭 → GET /api/stats?event=click          → bump_metric  RPC
   검색      → 기존 /api/stats?keyword=… 요청 안에서 함께 센다 (요청 추가 없음)

[관리자]  GET /api/stats?report=1   Authorization: Bearer $CRON_SECRET
```

| 지표 | 출처 |
|---|---|
| 총 방문자 | `count(visitors)` |
| 오늘 방문자 | `visitors.last_date = 오늘(KST)` |
| **재방문자** | `visitors.visit_days > 1` — **같은 날 새로고침은 세지 않는다** |
| 상품 검색 횟수 | `daily_metrics['search']` |
| 상품 클릭 횟수 | `daily_metrics['click']` |
| AI 사용 횟수 | **`ai_usage` 에서 읽는다 — 새로 쌓지 않는다** |

### 설계상 지킨 것

- **새 함수 없음** — `/api/stats`(이미 인증 없이 쓰기를 받는 유일한 엔드포인트)에 얹었다. 11/12 유지.
- **개인정보 없음** — IP·User-Agent·이메일 어느 것도 저장하지 않는다. `vid` 는 브라우저가 만든 난수이고 계정과 잇지 않는다.
- **원본 이벤트 미적재** — 처음부터 날짜별 카운터로 접는다. 하루에 2행만 는다.
- **서비스를 막지 않는다** — 모든 계측 함수가 절대 throw 하지 않는다(값 변환까지 `try` 안). 프론트는 `keepalive` fire-and-forget.
- **지표는 관리자만** — `CRON_SECRET`, 미설정 시 fail closed.
- **화이트리스트** — `search`/`click` 외의 metric 은 세지 않는다(인증 없는 엔드포인트라 아무 문자열이나 쌓이면 안 된다).

> ℹ️ 프론트에 Google Analytics(`G-3YZDQ1X888`)가 이미 붙어 있다. 그쪽은 페이지뷰만 보고, 위 계측은 **상품 클릭·AI 사용·재방문**처럼 GA 가 모르는 제품 지표를 본다. 둘은 겹치지 않는다.

---

## E. AI 구조

```
POST /api/ai   (토큰 필수 — 익명 호출로 요금이 나가지 않는다)
   → _plan.resolvePlan          FREE / PRO 판정 (expires_at 기준)
   → _plan.reserve              ai_quota_reserve RPC 한 문장으로 예약   ★
   → 의도 분류  (_llm 사슬, 8초, 직전 4턴)
   → 상품 질문이면 검색·가격기록·랭킹·Deal·Decision 계산
   → 그 결론을 프롬프트에 싣고 본 모델 호출 (_llm 사슬)
   → 모델이 전부 실패하면 _concierge 가 같은 결론을 문장으로 만든다   ★
   → 후속 질문 생성 (LLM 호출 0회)
   → 실패하면 예약한 쿼터를 되돌린다                                    ★
```

### 모델 사슬 (`api/_llm.js`, 2026-08-30 신규)

```
1순위 (기본 anthropic/claude-sonnet-5)
   ↓ 402 · 429 · 5xx · 404 · 빈 응답 · 타임아웃
무료 모델 (`:free` — 잔액 0에서도 호출된다)
   ↓ 전부 실패
SEOSA 결정론 답변 (api/_concierge.js)
```

- **왜** — 2026-08-28~29 운영에서 잔액이 0이 되자 402 로 AI 가 통째로 멈췄다.
  모델이 하나뿐이라 대안이 없었다. 이제 잔액이 0이어도 답이 나가고, 잔액을
  채우면 최대 10분 안에 스스로 1순위로 되돌아간다(재배포 불필요).
- **401 은 넘어가지 않는다** — 사슬이 같은 키를 쓰므로 물어봐야 소용없다.
- **402 를 보면 그 인스턴스는 10분간 유료 모델을 건너뛴다** — 사용자마다
  헛걸음(왕복 지연)을 반복하지 않기 위해서다.
- **요청 하나에 시간 예산 27초** — 사슬이 길다고 프론트 대기(30초)를 넘기지 않는다.
  분류 단계는 답변 몫 9초를 반드시 남기고 물러난다.
- **비용 0원 운영** — `OPENROUTER_MODELS` 에 `:free` 모델만 적으면 그 목록이
  사슬 전체가 된다. (DEPLOY.md 「AI 모델 사슬」 참고)
- **중복 질문 캐시** — `AI_CACHE_TTL_MS` 로 켠다. 기본값은 꺼짐.

### LLM 없이 만드는 답 (`api/_concierge.js`, 2026-08-30 신규)

판정은 원래부터 코드가 한다(`_deal` · `_decision` · `_pricestat` · `_shopintent`).
모델은 그것을 사람 말로 옮길 뿐이다. 그래서 모델이 전부 죽어도 결론·근거·
구매 시점·주의·다른 후보를 그대로 전할 수 있다.

- 새 사실을 만들지 않는다 — 답변의 모든 금액이 입력 데이터에 실제로 있는 값이다
- 확신도가 낮으면 문장도 낮춘다 (`hedgeFor`)
- 기록상 비싸면 비싸다고 말한다 — `WAIT`/`DONT_BUY` 는 "서두르지 마세요" 로 나간다
- 같은 모듈이 **후속 질문**도 만든다. 답할 수 있는 질문만, 재촉 없이, 최대 4개

### 무료 모델 실측에서 잡은 것 (2026-08-30)

`scripts/eval-live-answers.js --free` — 쿠팡 0회 · 운영 DB 쓰기 0회 · 비용 0원으로
실제 모델을 불러 지시 18항의 열 가지 질문을 돌린다. 그 과정에서 잡은 것:

| 문제 | 원인 | 수정 |
|---|---|---|
| **모든 질문이 잡담(A)으로 분류돼 검색이 한 번도 안 돌았다** | 본답변에는 `reasoning:{enabled:false}` 를 주는데 **분류기 호출에는 빠져 있었다.** 무료 모델이 32토큰을 전부 생각에 써서 글자를 못 냈다 (`finish_reason: length`) | `CLASSIFY_EXTRA` 로 분류기·검색어 해석에도 reasoning 을 끈다 |
| 형식을 어긴 출력에서 엉뚱한 글자를 의도로 읽었다 | `\b([A-E])\b` 가 영어 서술 안의 글자를 주웠다 | `parseClassification` — 글자가 정확히 하나여야 통과. 아니면 분류 실패(전체 맥락으로 답한다) |
| 모델이 내부 결정 블록을 **그대로 베껴** 냈다 (내부 메모까지 사용자에게) | 작은 모델은 블록을 옮겨 말하지 못하고 복사한다 | 품질 게이트 — 내부 라벨 2개 이상이면 `_concierge` 조립본으로 대체 |
| "이유:" 첫 줄이 **부정형**이었다 ("검색어와 상품명이 일치하지 않음") | `decide().decisive` 는 랭킹 사실 모음이라 부정형도 섞인다 | `_concierge.reasons` 가 부정형을 걸러 `주의:` 쪽으로 넘긴다 |

> ⚠️ **남은 한계**: 비교 질문("A랑 B 비교해줘")을 무료 모델이 여전히 B(지식)로
> 분류할 때가 있다. 그러면 상품 데이터 없이 답하게 되고, 그 경로에는
> firewall 이 돌지 않아(A·B 는 일반 지식 금액 오탐을 피하려 의도적으로 제외)
> 모델이 가격을 지어낼 수 있다. **10건 중 1건에서 실제로 관측됐다.**
> 크레딧이 있으면 1순위 모델이 처리하므로 나타나지 않는다.

- **제공자** OpenRouter (`OPENROUTER_API_KEY`)
- **한도** FREE 3회/일, PRO 50회/일 (`FREE_DAILY_AI_LIMIT` / `PRO_DAILY_AI_LIMIT` 로 조정)
- **쿼터 원자성** `ai_quota_reserve` RPC — `UPDATE ... WHERE used < limit` 이라 동시 요청이 한도를 넘지 못한다
- **오류 처리** 업스트림이 401/402/429/타임아웃/파싱불가 중 무엇으로 실패하든 사용자에게 사람 말로 안내하고 **쿼터를 되돌린다**. 벌거벗은 500 은 나가지 않는다 (`test-release.js` AI 28케이스가 고정)

---

## F. DB 구조

### 테이블 11개 + 뷰 1개

| 테이블 | 용도 | 핵심 제약 |
|---|---|---|
| `products` | 상품 카탈로그 | UNIQUE `(product_id, mall)` |
| `price_history` | 가격 원장 | 계열 = `(product_id, mall, vendor_item_id)` |
| `price_job_state` | 재개 가능 수집 커서 | `job_date` (KST) |
| `payments` | 결제 원장 | UNIQUE `order_id`, UNIQUE `payment_key`, RLS on |
| `subscriptions` | 구독 상태 | `plan` / `status` / `expires_at` / `billing_key` |
| `ai_usage` | 일일 AI 사용량 | `ai_quota_reserve` RPC 로만 증가 |
| `auth_codes` | 로그인 코드 | `auth_code_attempt` RPC (미적용) |
| `profiles` | 닉네임·예산·취향 | |
| `user_data` | 찜·조회·검색 기록 | |
| `alerts` | 가격 알림 | |
| `coupang_api_calls` / `coupang_api_state` / `coupang_search_cache` | 쿠팡 쿼터·캐시 | 7일 후 정리 |
| `visitors` *(신규)* | 익명 방문자 | PK `visitor_id`, `visit_days` = **방문한 날 수** |
| `daily_metrics` *(신규)* | 날짜별 카운터 | PK `(metric_date, metric)` |
| **뷰** `price_drop_top` | 하락 후보 | 최근 30일, `products` INNER JOIN |

`payments.status` 에는 **CHECK 제약이 없다** — `pending`/`charging` 을 추가해도 DDL 변경이 필요 없다 (확인 완료).

---

## G. 현재 해결된 문제

이번 감사에서 수정하고 테스트로 고정한 것 (커밋 `8ef5453`):

| # | 문제 | 수정 |
|---|---|---|
| R1 | 승인 중 함수 타임아웃 시 **이중 청구** 가능 | pending 원장 + charging 복구 경로 + orderId 재조회 |
| O4 | "구독 취소" 를 안내하면서 **자동 갱신이 없었다** (30일 뒤 조용히 FREE) | `renewDueSubscriptions` 를 `/api/cron` 에 |
| O7 | 인증 코드 시도 제한이 **비원자적** — 병렬 요청으로 6자리 코드 우회 가능 | `auth_code_attempt` RPC 한 문장 |
| — | 프론트에 **죽은 두 번째 결제 경로**(`Pro.pay`) — 카드창을 열고 반드시 실패 | 제거, `Pay.start` 단일 경로 |
| Y1 | 이달의 큐레이션이 **매월 1일 9시간 동안 지난달** (UTC 기준 월) | `kstMonth()` |
| Y2 | `coupang_finish` **인자 밀림** — 성공 기록의 `r_code` 에 상품 수 | 인자 5개로 정정 |
| R2 | 쿠팡 무응답 시 **함수가 상한까지 매달림** (fetch 기본 타임아웃 없음) | `AbortController` 8초 |
| O1 | 오늘의 하락에 **옛 하락이 계속 노출** | `todayDropConfirmed` 4중 판정 |
| O2 | `price_history` 직전 관측의 **가격과 옵션을 다른 행에서** 읽음 | 같은 행에서 함께 읽는다 |
| O3 | `check-alerts` 가 **PostgREST 1,000행 상한**에 조용히 잘림 | `range` 페이지네이션 (+ `id` 2차 정렬) |
| — | 시세판에 같은 상품이 **옵션별로 중복** 노출 | 상품당 카드 1장 |

### 테스트 결과 (2026-08-25 실행)

```
npm test                      743 PASS / 0 FAIL   (9개 스크립트, exit 0)
  test-auth              12 · test-coupang        22 · test-price       276
  test-price-batch       71 · test-ai             74 · test-ai-money     62
  test-payment          153 · test-sync           20 · test-analytics     53
npm run test:regression        52 PASS / 0 FAIL
npm run test:release          102 PASS / 0 FAIL
──────────────────────────────────────────────────
npm run test:all              897 PASS / 0 FAIL   (exit 0)

node scripts/verify-migrations.js   16 OK / 7 FAIL
  → 정적 검사 16건 전부 통과. FAIL 7건은 전부 "마이그레이션 미적용" 이다.
    3개 파일을 모두 적용하면 23 OK / 0 FAIL 이 된다.
```

**테스트 안전성이 테스트로 고정돼 있다** (`test-release.js` SAFE 6케이스):
`test:all` 체인에서 나가는 실제 네트워크 호출 **0건**. 운영 Supabase·쿠팡·결제사·메일 호출 0건.
`test-intent` / `test-ai-e2e` / `test-e2e` 는 의도적으로 체인 밖에 둔다.

---

## H. 아직 남은 문제

| 심각도 | 문제 | 상세 |
|---|---|---|
| **높음** | **마이그레이션 2건 미적용** | 자동 갱신이 매일 실패하고, 인증 시도 제한이 비원자적 폴백으로 동작. 코드는 폴백과 경고 로그를 갖췄지만 **문제 자체는 남아 있다**. |
| ~~높음~~ 중간 | **OpenRouter 크레딧 402** | ~~AI Concierge 가 실제로 답을 못 한다.~~ **2026-08-30 완화**: 모델 사슬(`api/_llm.js`)이 402 를 보면 무료 모델로 내려가고, 그마저 실패하면 `_concierge` 가 SEOSA 계산 결과로 답한다. 잔액을 채우면 자동으로 1순위 품질로 되돌아간다. **남은 위험은 무료 모델 id 의 수명** — 아래 참고. |
| 중간 | **무료 모델 id 가 검증되지 않았다** | `FREE_ANSWER_CHAIN` 의 `:free` 모델 id 는 OpenRouter 사정으로 바뀐다. 로컬에서 실제 호출로 확인하지 못했다(잔액·키 사정). 없는 id 는 404 로 돌아와 라우터가 건너뛰므로 서비스는 멈추지 않지만, 넷 다 죽으면 결정론 답변만 나간다. **배포 후 로그의 `[ai:obs] … "model":"…"` 를 한 번 볼 것.** |
| **치명** | **운영 PRO 결제가 시작조차 안 된다** | 운영 `TOSS_CLIENT_KEY` 가 **결제위젯 유형**(`test_gck_…`)이다. 우리 프론트는 "API 개별 연동"(`test_ck_…`)만 지원하므로 `handlePrepare` 가 **503 `PAYMENT_KEY_WRONG_TYPE`** 로 거절한다. 즉 **지금 아무도 PRO 를 결제할 수 없다.** 코드는 의도대로 fail-closed 동작 중이고, 고칠 곳은 Vercel 환경변수뿐이다. |
| **높음** | **실결제 미검증** | 테스트/운영 어느 쪽으로도 실제 카드 승인을 한 번도 통과시켜 본 적이 없다. 로컬에 Toss 키가 없어 검증 불가. |
| 중간 | **가격 커버리지 46.8%** | 1,115개 중 593개가 오늘 가격 없음. 실패가 아니라 `notFound` — 키워드 검색 결과에서 밀려난 상품. 상품별 조회 경로가 없으면 계속 벌어진다. |
| 중간 | **함수 11/12** | 자리가 1개뿐. 다음 기능은 기존 함수에 얹어야 한다. |
| 낮음 | **비쿠팡 이력 5,017행** | `products` 에는 0행. 뷰에서는 배제되지만 이력은 남아 있다(의도된 보존). |
| 낮음 | `api/_shop.js.wipbak`, `scripts/test-price.js.wipbak` | 추적 중인 백업 파일. 배포에는 영향 없음(`.js` 아님). |

---

## I. 내가 직접 해야 하는 작업

> 코드로는 할 수 없는 것만. 순서대로.

### 1. Supabase SQL Editor 에서 실행 (최우선)

Supabase 대시보드 → SQL Editor → New query → 파일 내용을 붙여넣고 Run.

- [ ] `supabase/2026-08-24-payment-pending-and-auth-attempts.sql`
- [ ] `supabase/2026-08-24-price-drop-top-orphan-policy.sql`
- [ ] `supabase/2026-08-25-analytics.sql`  *(사용자 계측 — 신규)*

세 파일은 **서로 의존하지 않는다.** 순서가 바뀌어도 되고, 한 번에 하나씩 실행해도 된다.

두 파일 모두 **재실행 안전**하고 `DROP`/`TRUNCATE` 가 없다. `price_history` 를 한 행도 지우지 않는다.
각 스크립트 끝에 **자체 검증 SELECT** 가 있어 결과 그리드에서 바로 확인된다
(SQL Editor 는 한 트랜잭션으로 돌아서 중간 실패 시 전부 롤백되는데, 화면만 봐서는 알기 어렵다).

실행 후 확인:

```bash
node scripts/verify-migrations.js
```

`16 OK / 7 FAIL` → **`23 OK / 0 FAIL`** 이 되어야 한다.

> 이전 판에는 목표가 `16 OK / 0 FAIL` 이라고 적혀 있었다. 검사 항목이 늘어서 숫자가 바뀐 것이다 —
> ① 계측 마이그레이션 검사 6건 추가, ② 테이블 존재 확인이 `head:true` 로는 **없는 테이블도 통과**시키던
> 거짓 통과를 고쳐 실제로 판정하게 됐다.

### 2. OpenRouter 크레딧 충전

- [ ] https://openrouter.ai/credits — 현재 402(잔액 부족). 충전 전에는 AI 가 답하지 못한다.

### 3. Toss 키 교체 — ★ 지금 PRO 결제가 막혀 있다

운영 `/api/init` 이 내려주는 `tossClientKey` 가 `test_gck_…` (**결제위젯 유형**) 이다.
우리 프론트는 "API 개별 연동" 방식만 지원하므로 서버가 결제를 **시작조차 하지 않는다**
(503 `PAYMENT_KEY_WRONG_TYPE`). 사용자에게는 "결제 키 설정이 올바르지 않아요" 로 보인다.

- [ ] Toss 콘솔 → **결제 > API 개별 연동** 섹션에서 키를 복사 (`test_ck_…` / `test_sk_…`)
      — "결제위젯" 섹션의 `gck`/`gsk` 키가 **아니다**
- [ ] Vercel → Settings → Environment Variables 에서 `TOSS_CLIENT_KEY` / `TOSS_SECRET_KEY` 교체
- [ ] **두 키를 함께** 교체할 것. test/live 혼용은 서버가 거부한다(`isMixedKeyEnv`)
- [ ] 재배포 후 확인:

```bash
curl -s https://seosa.ai.kr/api/init | grep -o 'test_[a-z]*'
```

`test_ck` 가 나와야 한다 (`test_gck` 면 아직 그대로다).

### 4. Toss 결제 테스트 (실결제 아님)

- [ ] 위 3번을 끝낸 뒤 진행할 것
- [ ] 배포본에서 PRO 결제를 한 번 진행 — 토스 테스트 카드 사용
- [ ] `payments` 테이블에 `pending → charging → paid` 가 남는지 확인
- [ ] `subscriptions.expires_at` 이 +30일인지 확인
- [ ] 확인 후 라이브 키(`live_ck_` / `live_sk_`)로 교체. **test/live 혼용은 서버가 거부한다.**

### 5. 배포

- [ ] `git push` → PR → `main` 병합 (Vercel 자동 배포)
- [ ] **SQL 실행 후에 배포하는 것을 권한다.** 순서가 바뀌어도 코드가 폴백으로 버티지만, 그동안 자동 갱신은 돌지 않는다.

### 6. Vercel 환경변수 확인

- [ ] `CRON_SECRET` 설정 확인 — 없으면 `/api/cron` 이 500 으로 fail-closed (현재 운영은 401 응답 확인됨 = 정상)

---

## J. 다음 개발 우선순위

1. **상품별 가격 조회 경로** — 커버리지 46.8% 의 근본 해결. 키워드 검색에 의존하는 한 계속 벌어진다.
2. **결제 실패·만료 사용자 안내** — 현재는 조용히 FREE 로 떨어진다. 갱신 실패 시 메일 발송(Resend 는 이미 붙어 있다).
3. **PRO 전용 가치의 실체화** — 아래 「사업 검증」 참고. 지금 PRO 는 사실상 "AI 3회 → 50회" 뿐이다.
4. **계측 2단계** — 1단계(방문·재방문·검색·클릭·AI)는 2026-08-25 에 넣었다. 다음은 찜 전환율과 결제 화면 이탈 지점.
5. **함수 통합** — 11/12. `stats`/`rec` 을 `init` 에 얹으면 2자리가 난다.

---

## 사업 검증에서 부족한 것

> 코드 문제가 아니라 **증거** 문제다. 아래 질문에 지금 답할 수 있는지로 나눴다.

### 답할 수 있다

- **무엇을 해결하는가** — "이 가격이 지금 싼 건가?" 를 대신 판단해 준다. 쿠팡은 현재가만 보여 주고 과거를 숨긴다.
- **무엇이 다른가** — 가격 이력 원장 + 오늘 실제로 내려간 것만 고르는 3중 검증 + AI 상담. 다나와는 이력을, 쿠팡은 판단을, AI 쇼핑앱은 실제 가격 원장을 각각 갖고 있지 않다.
- **어떻게 버는가** — PRO 월 4,900원 + 쿠팡 파트너스 수수료.
- **가장 큰 약점** — 아래 「답할 수 없다」 전체가 곧 약점이다.

### 답할 수 없다 — 여기가 진짜 숙제

| 질문 | 현재 상태 |
|---|---|
| **실제 사용자가 있는가?** | **아직 모르지만, 이제 셀 준비는 됐다.** 계측 코드가 들어갔다(2026-08-25). `supabase/2026-08-25-analytics.sql` 적용 + 배포 후부터 방문자·재방문·검색·클릭·AI 사용이 쌓인다. **소급되지 않으므로 빨리 켤수록 좋다.** |
| **왜 다시 오는가?** | 재방문 유인이 "오늘의 가격 하락" 뿐인데, 그게 **매일 8칸을 채우는지조차 확인 안 됐다.** |
| **왜 PRO 를 결제하는가?** | **가장 약한 고리.** FREE 3회 → PRO 50회는 "더 많이" 이지 "다른 것" 이 아니다. 월 4,900원을 정당화하지 못한다. |
| **1개월 안에 검증할 것** | 아래 3가지. |

### 1개월 안에 검증할 3가지

1. **가입 → 7일 재방문율** — 이 숫자 하나가 제품이 사는지 죽는지를 결정한다. (계측 코드 없음 = 지금 당장 필요)
2. **가격 알림을 건 사용자가 다시 오는가** — 알림은 유일한 "돌아올 이유" 다. 실제로 작동하는 후크인지 확인.
3. **PRO 전환율 (목표 유료 전환 1%)** — 지금 구조로 0% 가 나오면 문제는 가격이 아니라 **PRO 의 내용**이다.

### 지금 가장 필요한 사용자 데이터

- 일일 방문자 / 가입자 / 재방문 (아무것도 없음)
- AI 질문 내용 분포 — 사람들이 무엇을 물어보는가 (`ai_usage` 는 횟수만 센다)
- 찜 → 알림 → 재방문 퍼널
- 결제 화면 진입 → 이탈 지점

> **투자자·멘토 앞에서 지금 가장 위험한 답변은 "사용자 수를 모른다" 이다.**
> 코드 품질(844 테스트 통과)은 강점이지만, 그건 아무도 묻지 않는 질문에 대한 답이다.
