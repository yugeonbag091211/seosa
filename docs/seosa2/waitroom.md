# ② 구매 대기실 — 설계 노트

## 흐름

```
사용자 ── POST /api/waitroom (토큰) ──▶ waitroom_items (목표가, armed=true)
                                              │
GitHub Actions (KST 09:40, WAITROOM_ENABLED=1 일 때만)
  scripts/check-waitroom.js
    ├ price_history 최근 3일 → 항목 옵션의 최신 관측 (sameVendorRows)
    ├ api/_waitroom.evaluate → NOTIFY / REARM / NONE
    └ NOTIFY: 무장 해제(CAS) → 발송 기록 선점(UNIQUE) → Resend(idempotency key) → 결과 기록
```

## 중복 알림 방지 (세 겹 + 한 겹)

| 겹 | 무엇이 막나 |
|---|---|
| `waitroom_notifications (email, product_id, mall, notify_date)` UNIQUE | 같은 사람·같은 상품 같은 날 두 번 (재실행·동시 실행·항목 재등록·옵션 표기 차이) |
| `armed` + REARM_RATIO 1.03 | 목표가 아래에 머무는 동안 매일 발송 · 목표가 ±1% 진동 |
| 발송 기록 + COOLDOWN_DAYS 7 (사람·상품 기준) | 같은 상품 7일에 두 번 이상 — 항목을 지우고 다시 담아도 |
| NOTIFY_MAX_STALE_DAYS 1 | 이틀 넘은 관측으로 «지금 도달» 을 말하는 것 |

**중복 방지 단위는 항목(item_id)이 아니라 «같은 사람·같은 상품» (`email, product_id, mall`)이다.**
첫 판은 세 겹 모두 item_id 기준이었고 발송 기록이 `on delete cascade` 였다. 테스트에서 다음 세 경로가
같은 상품 메일을 두 번 보냈다: ① 알림 뒤 항목 삭제 → 재등록, ② 같은 상품을 옵션 번호 있이/없이 두 번 담기,
③ 수락 여부 불명(`claimed`) 기록이 삭제와 함께 사라진 뒤 재등록. 지금은 발송 기록을 `on delete set null`로
남기고, 쿨다운·미확정 차단·같은 날 UNIQUE·공급자 키를 모두 사람·상품 기준으로 본다
(`scripts/test-v2-waitroom.js` «계열 중복» 절). 첫 판을 이미 적용한 테스트 프로젝트는
`supabase/2026-09-25-seosa2-waitroom-series-dedupe.UPGRADE.sql` 로 올린다 (운영에는 불필요).
한계: 같은 상품의 서로 다른 두 옵션을 담으면 먼저 닿은 쪽 한 통만 가고, 다른 옵션은 7일 뒤에 알린다
(중복보다 누락을 택하는 정책과 메일 본문의 «같은 상품은 7일에 한 번까지» 약속에 맞춘 것).

Resend에는 `waitroom/{sha256(email|product_id|mall) 앞 32자}/{KST 날짜}` 키를 보낸다 (이메일 원문은 싣지 않는다).
성공이면 항목의 `notified_at`·cooldown을 먼저
기록한 뒤 발송 행을 `sent`로 바꾼다. 명확한 공급자 거절만 `failed`로 기록하고 같은 날 최대 3번까지
재시도한다.

타임아웃·연결 단절·HTTP 408/409/5xx처럼 **공급자가 수락했는지 모르는 결과**는 `claimed`로 남긴다.
항목은 재무장하지 않고, 다음 잡도 이전 `claimed`를 확인해 재전송을 막는다. 프로세스가 Resend 수락 직후
DB 기록 전에 종료된 경우에도 같은 안전 규칙을 적용한다. 이때 메일이 실제로 전달되지 않았을 수 있으며
자동 재시도하지 않는다 — 운영자가 공급자 로그와 발송 기록을 대조해 수동으로 해결해야 한다.

따라서 정책은 at-most-once 이며 exactly-once 전달을 보장하지 않는다. 모호한 장애에서는 중복보다 누락을
선택한다. 실제 이메일 전송은 별도 승인 전까지 하지 않는다.

## 추적 범위 (정직하게)

대기실은 **가격을 새로 수집하지 않는다.** 이미 SEOSA 카탈로그에 있고 수집기가 다시 찾아갈 수 있는 상품
(`productLifecycle().reachable` — 쿠팡/ADPICK + keyword)만 매일 가격이 쌓인다. 그렇지 않은 상품은
`tracking: 'UNTRACKED'` 로 표시하고 저장 응답에서 «알림이 가지 않을 수 있어요» 라고 알린다.
대기실 상품을 수집 대상에 넣는 것은 수집 부하(쿠팡 호출)를 바꾸는 일이라 이번 범위에서 하지 않았다 — 운영 승인 사항.

## 운영 적용 순서 (승인 후)

1. Supabase SQL Editor 에서 `supabase/2026-09-24-seosa2-waitroom.sql` 실행
2. `supabase/2026-09-24-seosa2-waitroom.VERIFY.sql` 로 표·RLS·권한·제약 확인
3. 배포 후에도 API 는 `WAITROOM_API_ENABLED` 가 없으면 계속 503 으로 닫힌다.
4. 별도 승인 후 Vercel 에 `WAITROOM_API_ENABLED=1` 설정 → 등록 API 와 화면 링크를 연다.
5. Actions 에서 `SEOSA Waitroom (gated)` 를 `dry_run=true` 로 수동 실행해 판정만 확인
6. **실제 이메일 발송 별도 승인 후에만** 저장소 변수 `WAITROOM_ENABLED=1` 설정 → 매일 KST 09:40 발송 시작.

되돌리기: 변수 삭제(발송 중단) → 필요 시 `.ROLLBACK.sql` (항목·기록 삭제 — 먼저 내보낼 것).

