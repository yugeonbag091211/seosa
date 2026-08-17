# SEOSA 배포 체크리스트

2026-08 안정화 작업 기준. 위에서부터 순서대로 진행하세요.
`[필수]` 항목을 건너뛰면 해당 기능이 동작하지 않습니다.

---

## 1. [필수] Supabase 마이그레이션

DDL 은 PostgREST API 로 실행할 수 없어서 스크립트가 대신 적용해 줄 수 없습니다.

1. Supabase 대시보드 > SQL Editor > New query
2. `supabase/2026-08-hardening.sql` 전체를 붙여넣고 **Run**
3. 확인:

```bash
node scripts/verify-schema.js
```

`FAIL` 이 하나도 없어야 합니다.

> `supabase/schema.sql` 은 **실행하지 마세요.**
> monthly_curation 7월 키워드를 하드코딩 값으로 덮어쓰고,
> keywords 를 jsonb 로 캐스팅하는데 실제 컬럼 타입은 text[] 라 실패합니다.

이걸 적용하면 해결되는 것:
- `auth_codes` 테이블 → 이메일 인증(찜/취향/알림 접근)이 동작
- `alerts.product_id` → 동명이물에 잘못된 알림 메일이 가지 않음
- `alerts.sent_at` → 같은 알림이 매일 재발송되지 않음
- `increment_search_stat` → 동시 검색 시 인기검색어 카운트 유실 방지
- 인덱스 5종 → price_history 가 커져도 차트·알림이 느려지지 않음
- RLS → anon 키가 노출돼도 개인 데이터가 읽히지 않음

---

## 2. [필수] Vercel 환경변수

Vercel > Settings > Environment Variables

| 변수 | 상태 | 없으면 |
|---|---|---|
| `RESEND_API_KEY` | **누락됨** | 인증 코드 메일이 안 나가서 찜·취향·알림을 아무도 못 씀 |
| `RESEND_FROM` | 선택 | 기본값 `SEOSA <alert@seosa.kr>` |
| `AUTH_SECRET` | 선택 | 없으면 `SUPABASE_SECRET_KEY` 에서 파생 (Supabase 키 교체 시 토큰 전부 무효화) |
| `SUPABASE_URL` / `SUPABASE_SECRET_KEY` | 설정됨 | — |
| `COUPANG_ACCESS_KEY` / `COUPANG_SECRET_KEY` | 설정됨 | — |
| `CRON_SECRET` | 설정됨 | — |
| `TOSS_CLIENT_KEY` | **미설정** | PRO 결제 버튼이 "PRO 준비 중" 으로만 표시됨 (결제 불가) |
| `TOSS_SECRET_KEY` | **미설정** | 〃 — 서버가 결제를 승인·검증할 수 없음 |
| `FREE_DAILY_AI_LIMIT` | 선택 | 기본 3 |
| `PRO_DAILY_AI_LIMIT` | 선택 | 기본 50 |

### 토스페이먼츠 키에 대하여

- `TOSS_CLIENT_KEY` 는 **공개 키**입니다. 프론트로 내려가며 노출되어도 됩니다.
- `TOSS_SECRET_KEY` 는 **절대 프론트로 내려가면 안 됩니다.** `api/_toss.js` 에서만
  읽고, 이 값 하나로 결제 승인·취소·조회가 전부 가능합니다.
- 두 키가 없으면 결제 기능이 **닫힙니다**. 키가 없다고 PRO 를 그냥 주는
  우회로는 코드에 없습니다 (의도된 동작 — `api/_toss.isConfigured()`).
- 테스트 키(`test_` 접두사)로 먼저 검증하고, PG 계약 완료 후 운영 키로 **값만
  교체**하면 코드 변경 없이 실결제로 전환됩니다.

#### ★ 키 유형을 반드시 "API 개별 연동" 으로 (결제위젯 아님)

토스 콘솔에는 결제 키가 두 종류입니다. **반드시 API 개별 연동 키를 쓰세요.**

| 종류 | client key 접두사 | secret key 접두사 | 우리 코드 지원 |
|---|---|---|---|
| **API 개별 연동** | `test_ck_…` / `live_ck_…` | `test_sk_…` / `live_sk_…` | ✅ (이걸 쓰세요) |
| 결제위젯 | `test_gck_…` / `live_gck_…` | `test_gsk_…` / `live_gsk_…` | ❌ 지원 안 함 |

우리 프론트(`public/index.html Pay.start`)는 `tp.payment({customerKey})` API 를
쓰는데, 여기에 결제위젯용 client key(`_gck_`)를 넣으면 SDK 가 초기화 단계에서
동기 throw 합니다:

> "API 개별 연동 키의 클라이언트 키로 SDK를 연동해주세요.
> 결제위젯 연동 키는 지원하지 않습니다."

서버가 `handlePrepare` 에서 미리 감지해 `PAYMENT_KEY_WRONG_TYPE` 로 거절하므로,
사용자에게는 "결제 키 설정이 올바르지 않아요." 라는 안내만 뜨고 결제창은 열리지
않습니다. Vercel 로그에는 어떤 키로 교체해야 하는지 문구가 남습니다.

**바꾸는 방법:**
1. 토스페이먼츠 콘솔 > 상점 관리 > **개발 정보 (API 개별 연동)** 섹션 열기
2. "클라이언트 키"(`test_ck_…` 또는 `live_ck_…`) 를 Vercel `TOSS_CLIENT_KEY` 로
3. "시크릿 키"(`test_sk_…` 또는 `live_sk_…`) 를 Vercel `TOSS_SECRET_KEY` 로
4. 환경변수 저장 후 **Redeploy** (Preview + Production 모두)

`RESEND_API_KEY` 는 GitHub Actions 시크릿에도 따로 있어야 합니다
(가격 알림 발송은 Actions 에서 돌아갑니다). 두 곳은 별개입니다.

---

## 3. [필수] 도메인 연결

### 현재 상태 (2026-08-08 실측)

| 호스트 | 레코드 | 가리키는 곳 | 응답 |
|---|---|---|---|
| `seosa.ai.kr` | A × 4 → `185.199.108.153` `.109.153` `.110.153` `.111.153` | GitHub Pages | 404 `server: GitHub.com` |
| `www.seosa.ai.kr` | CNAME → `yugeonbag091211.github.io` | GitHub Pages | 404 |
| `seosa-chi.vercel.app` | — | Vercel | **200 (실제 서비스)** |

코드 곳곳(`canonical`, `og:url`, `sitemap.xml`, `robots.txt`, CORS 기본 허용
목록)이 `seosa.ai.kr` 기준이라, 지금 공유되는 링크·검색 색인은 전부 404 로
갑니다.

### 바꿔야 할 DNS 값

DNS 는 `pcns.bora.net` 네임서버에서 관리되고 있습니다. 등록기관 DNS 관리에서:

| 이름 | 지금 | 바꿀 값 |
|---|---|---|
| `@` (apex) | A `185.199.108~111.153` (4개) | A `76.76.21.21` — 기존 4개는 삭제 |
| `www` | CNAME `yugeonbag091211.github.io` | CNAME `cname.vercel-dns.com` |

> apex 에 ALIAS/ANAME 을 지원하는 DNS 라면 A 대신 `cname.vercel-dns.com` 을
> ALIAS 로 두는 쪽이 낫습니다. Vercel 이 IP 를 바꿔도 따라갑니다.

### 순서

1. Vercel > 프로젝트 > Settings > Domains 에서 `seosa.ai.kr` 과
   `www.seosa.ai.kr` 을 **먼저 추가** (검증 대기 상태가 됨)
2. 위 표대로 DNS 레코드 변경
3. 전파 후 Vercel 이 자동으로 인증서를 발급 (보통 수 분~1시간)

### GitHub Pages 영향

**없습니다.** 두 주소 모두 이미 404 라 게시된 Pages 사이트가 없습니다
(도메인만 GitHub 쪽을 향해 있고 연결된 사이트가 없는 상태).

다만 정리해 두면 좋습니다:
- GitHub 저장소 > Settings > Pages > Custom domain 비우기
- Pages 브랜치에 `CNAME` 파일이 있으면 삭제

안 지워도 DNS 를 옮기는 순간 GitHub 쪽으로는 트래픽이 가지 않습니다.

### 확인

```bash
node -e "(async()=>{for(const u of ['https://seosa.ai.kr/','https://www.seosa.ai.kr/']){const r=await fetch(u,{redirect:'manual'});console.log(u,r.status,r.headers.get('server'));}})()"
```

`server: Vercel` 과 `200` 이 나오면 완료입니다.

---

## 4. 쿠팡 API 상태 확인

2026-08-08 기준, 로컬에서 쿠팡 API 가 **HTTP 200 + "Sorry! Access denied" HTML**
을 돌려줍니다. User-Agent / Accept / Accept-Language 조합을 모두 시도해도
같았고, 응답이 40ms 로 떨어지는 것으로 보아 엣지(WAF) 단계 IP 차단입니다.

마지막 정상 호출은 2026-08-07 18:15 UTC 의 Vercel cron 이었습니다.
**프로덕션에서도 막혔는지 반드시 확인하세요.**

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://<배포주소>/api/cron?diag=1&live=1"
```

- `from: "api"` → 정상. 로컬 IP만 막힌 것입니다.
- `blocked: true` + `Access denied` → 계정/IP 차단. partners.coupang.com 에서 확인 후
  해제되면 `select coupang_unblock();`

로컬에서 원인을 좁힐 때:

```bash
node scripts/coupang-probe.js "무선 이어폰"
```

---

## 5. 배포 후 확인

```bash
npm test                      # 인증 토큰 + 쿠팡 응답 처리 회귀 테스트
node scripts/verify-schema.js # 스키마
node scripts/audit-relevance.js  # 검색어-상품 정합성 (보고만, 삭제 안 함)
```

브라우저에서:
1. 검색 → 결과가 나오고, 캐시로 응답한 경우 상단에 안내 문구가 뜨는지
2. 카드에 가격 추이 그래프(스파크라인)가 그려지는지
3. 위시리스트 > 불러오기 → 이메일 인증 창이 뜨고 코드 메일이 오는지
4. 홈 "오늘의 가격 하락" 에 비상식적인 하락률(90%+)이 없는지

---

## 6. 알아둘 것

- **GitHub Actions 일일 수집이 2026-07-30 이후 한 행도 저장하지 못했습니다.**
  이제 실패하면 exit 1 로 끝나 워크플로가 빨간불이 되고 알림이 옵니다.
  첫 실행 결과를 꼭 확인하세요.
- **수집률 지표가 바뀌었습니다.** 예전 "4.6%" 는 수집 불가능한 행
  (비쿠팡 709개, keyword 없는 293개)까지 분모에 넣은 값이었습니다.
  이제 수집 대상 312개 기준으로 보고합니다.
- **오래된 캐시 값은 더 이상 "오늘 가격"으로 저장되지 않습니다.**
  쿠팡이 막힌 날은 기록을 남기지 않습니다 (없는 가격을 지어내는 것보다 낫습니다).
