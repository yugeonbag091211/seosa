-- 2026-08-28  "AI가 지금 사도 좋다고 하면 알려줘" 알림 조건
--
-- 지금까지 alerts 는 세 가지로 발동했다.
--   target  목표가 이하
--   drop    전일 대비 5% 이상 하락
--   atl     역대 최저가 갱신
--
-- 셋 다 "가격이 얼마인가" 만 본다. 그런데 사용자가 실제로 알고 싶은 것은
-- "지금이 살 만한 때인가" 이고, 그 판정은 이미 api/_deal.js 가 한다
-- (기록 대비 위치·30일 평균·추세·변동성·데이터 최신성을 함께 본다).
--
-- 목표가를 정하려면 사용자가 적정가를 알아야 한다. 모르면 못 쓴다.
-- 이 조건은 그 부담을 없앤다 — 금액을 몰라도 신청할 수 있다.
--
-- ※ alter ... add column if not exists 뿐이라 몇 번 실행해도 안전하다.
--   기존 데이터·기존 컬럼·기존 알림을 하나도 건드리지 않는다.
--   기본값 false 라서 이미 신청된 알림의 동작은 그대로다.

alter table alerts add column if not exists on_deal boolean not null default false;

-- target_price 를 안 쓰는 알림이 생긴다.
--
-- 지금 api/alerts.js 는 target_price > 0 을 요구하고, check-alerts.js 는
-- target_price 가 0 이면 target 조건을 건너뛴다(이미 그렇게 짜여 있다).
-- 그래서 on_deal 만 켠 알림은 target_price = 0 으로 저장된다.
-- NOT NULL DEFAULT 0 은 그대로 두므로 스키마 제약은 바뀌지 않는다.

comment on column alerts.on_deal is
  'true 면 api/_deal.js 판정이 BUY/GOOD_BUY 가 될 때 발송한다. 목표가와 함께 켤 수도 있다.';
