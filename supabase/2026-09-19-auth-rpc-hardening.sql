-- 2026-09-19
-- Harden the email OTP attempt RPC.
-- The backend calls this only with the Supabase service role, so SECURITY DEFINER is
-- unnecessary. Keep the function fail-closed, schema-qualify the table, and pin
-- search_path including pg_temp.

create or replace function public.auth_code_attempt(
  p_email text,
  p_hash text,
  p_max integer
)
returns table(allowed boolean, matched boolean, attempt_count integer, expired boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_hash    text;
  v_expires timestamptz;
  v_count   integer;
begin
  if p_email is null or length(p_email) < 3 or length(p_email) > 254 then
    return query select false, false, 0, false;
    return;
  end if;
  if p_hash is null or length(p_hash) <> 64 then
    return query select false, false, 0, false;
    return;
  end if;
  if p_max < 1 or p_max > 20 then
    return query select false, false, 0, false;
    return;
  end if;

  update public.auth_codes a
     set attempts = a.attempts + 1
   where a.email = lower(p_email)
     and a.attempts < p_max
  returning a.code_hash, a.expires_at, a.attempts
       into v_hash, v_expires, v_count;

  if not found then
    return query select false, false, p_max, false;
    return;
  end if;

  if v_expires < clock_timestamp() then
    delete from public.auth_codes where email = lower(p_email);
    return query select false, false, v_count, true;
    return;
  end if;

  if v_hash = p_hash then
    delete from public.auth_codes where email = lower(p_email);
    return query select true, true, v_count, false;
    return;
  end if;

  return query select true, false, v_count, false;
end;
$$;

revoke all on function public.auth_code_attempt(text,text,integer) from public;
revoke all on function public.auth_code_attempt(text,text,integer) from anon;
revoke all on function public.auth_code_attempt(text,text,integer) from authenticated;
grant execute on function public.auth_code_attempt(text,text,integer) to service_role;
