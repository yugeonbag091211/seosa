-- ══════════════════════════════════════════════════════════════════
--  2026-08-27  price_history 무결성 최종 정리
--
--    A. legacy UNIQUE (product_id, mall, recorded_date) 제거
--    B. recorded_date 를 KST 달력으로 저장하도록 트리거 함수 교체
--
--  적용 방법
--    Supabase 대시보드 > SQL Editor > New query 에 붙여넣고 Run.
--    A 블록과 B 블록을 따로 실행해도 되고, 이 파일을 통째로 Run 해도 된다.
--
--  ══════════════════════════════════════════════════════════════════
--  왜 앞선 DROP INDEX 가 듣지 않았나
--  ══════════════════════════════════════════════════════════════════
--
--  2026-08-27 실측: DROP INDEX IF EXISTS idx_ph_unique 를 실행했는데도
--  idx_ph_unique 가 남아 있고, 지금도 강제되고 있다.
--
--    같은 (pid, mall, recorded_date) 에 vid 만 다른 2행째 insert
--      → 23505 duplicate key value violates unique constraint "idx_ph_unique"
--
--  가장 가능성이 높은 원인은 이것이 "그냥 인덱스" 가 아니라 UNIQUE 제약이
--  뒤에 달고 있는 인덱스라는 것이다. 그런 인덱스는 DROP INDEX 로 지울 수 없다:
--
--    ERROR: cannot drop index idx_ph_unique because constraint idx_ph_unique
--           on table price_history requires it
--    HINT:  You can drop constraint idx_ph_unique on table price_history instead.
--
--  ★ IF EXISTS 는 이 오류를 삼키지 않는다. IF EXISTS 가 막아 주는 것은
--    "그런 이름이 없다" 뿐이고, 의존성 오류는 그대로 난다. 그리고 SQL Editor 의
--    한 번의 Run 은 하나의 트랜잭션이라, 그 오류 하나로 뒤따르던 DO 블록과
--    notify pgrst 까지 통째로 롤백된다. 그래서 "실행했는데 아무것도 안 바뀐"
--    상태가 된다.
--
--  다른 가능성(권한 부족, 다른 스키마)도 있지만 추측으로 하나를 고르지 않는다.
--  아래 DO 블록이 제약인지 인덱스인지 스스로 판별해서 각각 맞는 방법으로
--  지운다. 어느 원인이든 한 번에 해결된다.
--
--  ══════════════════════════════════════════════════════════════════
--  안전 장치
--  ══════════════════════════════════════════════════════════════════
--
--   · 지우는 대상은 "컬럼이 정확히 (mall, product_id, recorded_date) 3개인
--     UNIQUE" 뿐이다. 컬럼 집합을 직접 대조하므로 이름에 의존하지 않는다.
--   · price_history_pid_mall_vid_date_key 는 이름으로도, 컬럼 대조로도
--     제외된다(그건 4컬럼이다).
--   · PRIMARY KEY 는 indisprimary / contype='p' 로 제외한다.
--   · 새 VID UNIQUE 가 없으면 아예 중단한다(raise exception). 그게 없는데
--     legacy 를 지우면 price_history 에 유일성이 하나도 남지 않는다.
--   · DELETE / TRUNCATE / UPDATE 없음. 데이터 행을 한 줄도 건드리지 않는다.
--   · 기존 recorded_date 값을 보정하지 않는다 (파일 끝 "기존 데이터" 참고).
--   · 재실행 안전. 두 번 돌려도 같은 상태가 된다.
-- ══════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════
--  A. legacy UNIQUE (product_id, mall, recorded_date) 제거
--
--  왜 지워야 하나 — 이게 살아 있으면 옵션(vendor_item_id)이 둘인 쿠팡 상품을
--  같은 날 저장할 때마다 price_history upsert 가 통째로 23505 로 실패한다.
--  api/_shop.js 의 onConflict 는 4컬럼 키를 타겟으로 하므로 3컬럼 위반은
--  해소되지 않고 그대로 예외가 된다. 2026-08-27 감사에서 확인한
--  "원장 없는 카탈로그 갱신 81행" 의 원인이 바로 이것이다.
-- ══════════════════════════════════════════════════════════════════

do $$
declare
  r       record;
  dropped int := 0;
  legacy  text[] := array['mall','product_id','recorded_date'];
begin
  -- 0) 안전 장치: 새 VID UNIQUE 가 반드시 있어야 한다.
  if not exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where i.indrelid = 'price_history'::regclass
      and i.indisunique
      and c.relname = 'price_history_pid_mall_vid_date_key'
  ) then
    raise exception
      'price_history_pid_mall_vid_date_key (4컬럼 VID UNIQUE) 가 없습니다. '
      'legacy UNIQUE 를 지우면 유일성이 사라지므로 중단합니다.';
  end if;

  -- 1) UNIQUE "제약" 으로 걸려 있는 경우 → ALTER TABLE ... DROP CONSTRAINT
  --    (제약이 달고 있는 인덱스는 이때 함께 사라진다)
  for r in
    select con.conname as name
    from pg_constraint con
    where con.conrelid = 'price_history'::regclass
      and con.contype = 'u'                                    -- unique 만. p(PK) 제외
      and con.conname <> 'price_history_pid_mall_vid_date_key'
      and (
        select array_agg(a.attname::text order by a.attname)
        from unnest(con.conkey) as k(attnum)
        join pg_attribute a
          on a.attrelid = con.conrelid and a.attnum = k.attnum
      ) = legacy
  loop
    raise notice 'legacy UNIQUE 제약 제거: %', r.name;
    execute format('alter table price_history drop constraint %I', r.name);
    dropped := dropped + 1;
  end loop;

  -- 2) 제약 없이 인덱스로만 존재하는 경우 → DROP INDEX
  --    conindid 로 "제약이 뒤에 달린 인덱스" 를 제외한다. 그걸 DROP INDEX 하면
  --    위에서 설명한 의존성 오류가 난다.
  for r in
    select c.relname as name
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where i.indrelid = 'price_history'::regclass
      and i.indisunique
      and not i.indisprimary                                   -- PK 제외
      and c.relname <> 'price_history_pid_mall_vid_date_key'
      and not exists (
        select 1 from pg_constraint pc where pc.conindid = i.indexrelid
      )
      and (
        select array_agg(a.attname::text order by a.attname)
        from pg_attribute a
        where a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      ) = legacy
  loop
    raise notice 'legacy UNIQUE 인덱스 제거: %', r.name;
    execute format('drop index if exists %I', r.name);
    dropped := dropped + 1;
  end loop;

  if dropped = 0 then
    raise notice '제거 대상 없음 — (mall, product_id, recorded_date) UNIQUE 는 이미 없습니다.';
  else
    raise notice '완료: legacy UNIQUE %개 제거', dropped;
  end if;
end $$;


-- ══════════════════════════════════════════════════════════════════
--  B. recorded_date 를 KST 달력으로 저장
--
--  recorded_at 은 timestamptz 다(2026-08-27 실측: '+09:00' 으로 넣은 값이
--  '+00:00' 으로 환산되어 돌아온다). timestamptz 를 ::date 로 자르면 세션
--  TimeZone 을 따르고, Supabase 기본값이 UTC 라 UTC 날짜가 된다. 수집 크론이
--  KST 01·03·06시(=UTC 16·18·21시)에 도니 하루치가 전날 라벨을 달았다.
--
--  AT TIME ZONE 'Asia/Seoul' 은 세션 TimeZone 설정과 무관하게 동작한다.
--
--  ★ 트리거 trg_recorded_date 는 건드리지 않는다. CREATE OR REPLACE FUNCTION
--    은 본문만 갈아끼우고 소유자·권한·트리거 연결을 그대로 둔다.
--    트리거를 DROP/CREATE 하면 중복 생성·소유권 변경 위험이 있다.
-- ══════════════════════════════════════════════════════════════════

create or replace function set_recorded_date()
returns trigger
language plpgsql
as $$
begin
  -- recorded_at 이 NULL 이면 결과도 NULL — 기존 동작과 같다.
  -- (운영 17,557행 중 recorded_at 결측 0건)
  NEW.recorded_date := (NEW.recorded_at AT TIME ZONE 'Asia/Seoul')::date;
  return NEW;
end;
$$;


-- PostgREST 스키마 캐시 갱신
notify pgrst, 'reload schema';


-- ══════════════════════════════════════════════════════════════════
--  ROLLBACK — 데이터는 건드리지 않는다
-- ══════════════════════════════════════════════════════════════════
--
--  B 되돌리기 (트리거 함수만 원복):
--
--    create or replace function set_recorded_date()
--    returns trigger
--    language plpgsql
--    as $$
--    begin
--      NEW.recorded_date := NEW.recorded_at::DATE;
--      return NEW;
--    end;
--    $$;
--
--  A 되돌리기 (legacy UNIQUE 복원):
--    ★ 권장하지 않는다. 되살리면 옵션별 이력 저장이 다시 실패한다.
--      정말 필요할 때만, 그리고 복원 전에 중복이 없는지 먼저 확인할 것.
--
--    -- 먼저 확인 (0 이어야 복원 가능)
--    -- select count(*) from (
--    --   select product_id, mall, recorded_date
--    --   from price_history group by 1,2,3 having count(*) > 1
--    -- ) t;
--    --
--    -- create unique index if not exists idx_ph_unique
--    --   on price_history (product_id, mall, recorded_date);


-- ══════════════════════════════════════════════════════════════════
--  기존 데이터 (이 파일은 손대지 않는다 — 의도된 것이다)
-- ══════════════════════════════════════════════════════════════════
--
--  운영 9,040행의 recorded_date 가 KST 관측일보다 하루 이르다. 보정하지 않는다.
--
--   1) 읽기 경로가 이미 라벨을 믿지 않는다. api/_price.observedKstDate 가
--      recorded_at 을 KST 로 환산해서 쓴다 → 라벨을 고쳐도 화면 값은 그대로다.
--   2) 고치는 순간 UNIQUE 충돌이 난다. 같은 KST 하루가 두 라벨로 갈린 73건이
--      같은 키가 되어 대량 UPDATE 가 23505 로 실패한다. 어느 행을 남길지
--      정하는 것은 데이터 삭제 결정이고 이 파일의 범위가 아니다.
--   3) 이미 덮어써진 관측치는 복구 불가다. recorded_at 만으로 되살릴 수 없다.
--      이 migration 은 앞으로의 유실만 막는다.
