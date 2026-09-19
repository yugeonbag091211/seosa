-- 2026-09-19
-- Distributed fixed-window rate limiting for cost/security-sensitive serverless APIs.
-- Raw IP addresses are never stored: application code sends an HMAC-SHA256 subject hash.

create table if not exists public.security_rate_limits (
  bucket text not null,
  subject_hash text not null,
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  expires_at timestamptz not null,
  primary key (bucket, subject_hash, window_start)
);

alter table public.security_rate_limits enable row level security;
revoke all on table public.security_rate_limits from public;
revoke all on table public.security_rate_limits from anon;
revoke all on table public.security_rate_limits from authenticated;
grant select, insert, update, delete on table public.security_rate_limits to service_role;

create index if not exists security_rate_limits_expires_idx
  on public.security_rate_limits (expires_at);

create or replace function public.security_rate_limit(
  p_bucket text,
  p_subject_hash text,
  p_limit integer,
  p_window_ms integer
)
returns table(allowed boolean, remaining integer, retry_after integer)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  now_ts timestamptz := clock_timestamp();
  window_seconds integer;
  start_ts timestamptz;
  end_ts timestamptz;
  new_count integer;
begin
  if p_bucket is null or length(p_bucket) < 1 or length(p_bucket) > 80 then
    raise exception 'invalid bucket';
  end if;
  if p_subject_hash is null or length(p_subject_hash) < 16 or length(p_subject_hash) > 128 then
    raise exception 'invalid subject';
  end if;
  if p_limit < 1 or p_limit > 10000 then
    raise exception 'invalid limit';
  end if;
  if p_window_ms < 1000 or p_window_ms > 86400000 then
    raise exception 'invalid window';
  end if;

  window_seconds := greatest(1, ceil(p_window_ms / 1000.0)::integer);
  start_ts := to_timestamp(
    floor(extract(epoch from now_ts) / window_seconds) * window_seconds
  );
  end_ts := start_ts + make_interval(secs => window_seconds);

  insert into public.security_rate_limits(
    bucket, subject_hash, window_start, request_count, expires_at
  )
  values (p_bucket, p_subject_hash, start_ts, 1, end_ts + interval '2 minutes')
  on conflict (bucket, subject_hash, window_start)
  do update set
    request_count = public.security_rate_limits.request_count + 1,
    expires_at = excluded.expires_at
  returning request_count into new_count;

  -- Opportunistic bounded cleanup. Live windows are never touched.
  if (new_count % 25) = 1 then
    delete from public.security_rate_limits
    where ctid in (
      select ctid
      from public.security_rate_limits
      where expires_at < now_ts
      limit 200
    );
  end if;

  return query
  select
    new_count <= p_limit,
    greatest(p_limit - new_count, 0),
    greatest(1, ceil(extract(epoch from (end_ts - now_ts)))::integer);
end;
$$;

revoke all on function public.security_rate_limit(text,text,integer,integer) from public;
revoke all on function public.security_rate_limit(text,text,integer,integer) from anon;
revoke all on function public.security_rate_limit(text,text,integer,integer) from authenticated;
grant execute on function public.security_rate_limit(text,text,integer,integer) to service_role;
