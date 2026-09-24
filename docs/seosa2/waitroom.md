# ② 구매 대기실 — 설계 노트

## 흐름

```
사용자 ── POST /api/waitroom (토큰) ──▶ waitroom_items (목표가, armed=true)
                                              │
GitHub Actions (KST 09:40, WAITROOM_ENABLED=1 일 때만)
  scripts/check-waitroom.js
    ├ price_history 최근 3일 → 항목 옵션의 최신 관측 (sameVendorRows)
    ├ api/_waitroom.evaluate → NOTIFY / REARM / NONE
    └ NOTIFY: 무장 해제(CAS) → 발송 기록 선점(UNIQUE) → Resend → sent/failed
```

## 중복 알림 방지 (세 겹 + 한 겹)

| 겹 | 무엇이 막나 |
|---|---|
| `waitroom_notifications (item_id, notify_date)` UNIQUE | 같은 날 두 번 (재실행·동시 실행) |
| `armed` + REARM_RATIO 1.03 | 목표가 아래에 머무는 동안 매일 발송 · 목표가 ±1% 진동 |
| `notified_at` + COOLDOWN_DAYS 7 | 같은 항목 7일에 두 번 이상 |
| NOTIFY_MAX_STALE_DAYS 1 | 이틀 넘은 관측으로 «지금 도달» 을 말하는 것 |

발송 순서는 **at-most-once** 다 — 무장 해제 → 선점 → 발송. 중간에 죽으면 그 알림은 빠지지만 두 번 가지 않는다.
실패는 같은 날 3번까지 다시 시도한다.

## 추적 범위 (정직하게)

대기실은 **가격을 새로 수집하지 않는다.** 이미 SEOSA 카탈로그에 있고 수집기가 다시 찾아갈 수 있는 상품
(`productLifecycle().reachable` — 쿠팡/ADPICK + keyword)만 매일 가격이 쌓인다. 그렇지 않은 상품은
`tracking: 'UNTRACKED'` 로 표시하고 저장 응답에서 «알림이 가지 않을 수 있어요» 라고 알린다.
대기실 상품을 수집 대상에 넣는 것은 수집 부하(쿠팡 호출)를 바꾸는 일이라 이번 범위에서 하지 않았다 — 운영 승인 사항.

## 운영 적용 순서 (승인 후)

1. Supabase SQL Editor 에서 `supabase/2026-09-24-seosa2-waitroom.sql` 실행
2. `supabase/2026-09-24-seosa2-waitroom.VERIFY.sql` 로 표·RLS·권한·제약 확인
3. 배포 (API 가 503 → 200 으로 열린다)
4. Actions 에서 `SEOSA Waitroom (gated)` 를 `dry_run=true` 로 수동 실행해 판정만 확인
5. 저장소 변수 `WAITROOM_ENABLED=1` 설정 → 매일 KST 09:40 발송 시작

되돌리기: 변수 삭제(발송 중단) → 필요 시 `.ROLLBACK.sql` (항목·기록 삭제 — 먼저 내보낼 것).
