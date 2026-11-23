# SEOSA 전수 감사 — 진행 상황

작업 브랜치: `claude/seosa-system-audit-fixes-c7536b`
시작: 2026-11-23 21:59 KST (12:59 UTC)
마지막 갱신: 2026-11-23 22:30 KST

이 파일은 중단되더라도 다음 실행이 이어받을 수 있게 유지한다.
발견 내역은 `SEOSA_FULL_AUDIT.md`, 수정 내역은 `SEOSA_FIX_LOG.md`,
못 고친 것은 `SEOSA_REMAINING.md` 에 있다.

---

## 기준선 (수정 전, 재현 가능)

워크트리에서 `npm install` 뒤 각 테스트 스크립트를 **독립 실행**했다.
`npm test` 를 그대로 돌리지 않은 이유: `pretest` 의 `npm run test:ai-answer-quality`
가 추적 중인 `reports/` 파일을 덮어쓴다.

| 스위트 | 결과 |
|---|---|
| `test` 체인 145단계 (개별 실행) | **145 PASS / 0 FAIL**, 합계 126초 |
| `pretest` 23단계 (answer-quality 제외) | **23 PASS / 0 FAIL** |
| `test:search` 5단계 | **5 PASS / 0 FAIL** |
| `test:regression` | PASS (14.2초) |
| `test:release` | PASS |
| 워크트리 오염 | 없음 (`git status` 깨끗) |

즉 **기준선은 전부 초록**이다. 메모리에 남아 있던 «main CI 가 날짜 폭탄으로
빨갛다» 는 이 브랜치(=main 35afa08)에는 해당하지 않는다.

Production 기준선 (2026-11-23 22:0x KST, 읽기 전용 측정):

- `GET /` → 200, brotli 211 KB, TTFB 0.66 s, total 2.3 s (`X-Vercel-Cache: HIT`)
- `GET /api/init` → 200, 15.4 KB, priceDrop 8건
- `GET /api/hotdeals?view=today-drop&limit=60` → 200, 60건, **verified 0건**
- `GET /api/hotdeals` (기본 뷰) → 200, **items 0건**
- `GET /api/hotdeals?view=external` → 200, items 0건 (섹션은 스스로 숨는다)
- `GET /sitemap.xml` → 200, pages.xml + products-1..15.xml
- 없는 주소 → 404 (`text/plain`)

---

## 단계별 상태

| # | 단계 | 상태 |
|---|---|---|
| 1 | 저장소·배포·cron 구조 파악 | 완료 |
| 2 | 기준선 확보 (테스트 175단계 + 운영 probe) | 완료 |
| 3 | 검색 품질 실측 (운영 10개 검색어) | 완료 |
| 4 | 검색 랭킹 결함 재현·수정 | **F-01 수정 완료** |
| 5 | 가격 데이터 정합성 | 진행 중 |
| 6 | 제휴 링크 | 진행 중 |
| 7 | 성능·캐시 | 진행 중 |
| 8 | 보안 | 미착수 |
| 9 | SEO | 진행 중 |
| 10 | UI/UX (데스크톱·모바일) | 진행 중 |
| 11 | 전체 회귀 + PR | 미착수 |

---

## 다음 작업

1. 가격 데이터: `verified 0건` 의 원인(아래 F-02)을 코드/운영 어느 쪽으로 분류할지 확정.
2. `no-store` 로 CDN 캐시가 꺼진 범위와 비용 측정 (F-03).
3. 보안: `_ratelimit.clientKey` 의 `x-forwarded-for` 신뢰 여부 확인.
4. 모바일 뷰포트 UI 점검 (375 / 390 px).
5. 검색어를 바꿔 가며 랭킹 재검증 (F-01 수정의 실측 효과 확인).
