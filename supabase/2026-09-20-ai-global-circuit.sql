-- AI provider circuit shared by Vercel instances.
-- Apply this additive script before deploying the code that calls these RPCs.
-- It contains no user input, prompts, email addresses, or IP addresses.
-- Re-running it preserves existing circuit rows and never shortens a valid block.

create table if not exists public.ai_provider_circuit (
  provider      text        not null,
  model         text        not null,
  reason        text        not null default '',
  blocked_until timestamptz,
  probe_until   timestamptz,
  probe_token   uuid,
  updated_at    timestamptz not null default now(),
  constraint ai_provider_circuit_pkey primary key (provider, model),
  constraint ai_provider_circuit_provider_chk
    check (provider in ('gemini', 'groq', 'openrouter')),
  constraint ai_provider_circuit_model_chk
    check (model = '*' or (length(model) between 1 and 120
      and model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$')),
  constraint ai_provider_circuit_reason_chk
    check (reason in ('', 'auth', 'quota', 'rate', 'model', 'server',
      'timeout', 'network', 'parse', 'empty', 'http'))
);

-- public is an exposed schema. No client-facing policy is needed: the server's
-- service_role key is the only intended caller, and it bypasses RLS.
alter table public.ai_provider_circuit enable row level security;
revoke all on table public.ai_provider_circuit from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.ai_provider_circuit from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.ai_provider_circuit from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on table public.ai_provider_circuit to service_role;
  end if;
end $$;

-- One gate call checks provider-wide auth state (*) and the requested model.
-- CLOSED performs no UPDATE. At expiry, row locks and the probe token grant
-- exactly one caller a short HALF_OPEN lease across both matching scopes.
create or replace function public.ai_circuit_gate(
  p_provider text, p_model text, p_token uuid
)
returns table (
  allowed boolean, probe_token uuid, remaining_ms integer,
  reason text, scope text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_global public.ai_provider_circuit%rowtype;
  v_model  public.ai_provider_circuit%rowtype;
  v_has_global boolean := false;
  v_has_model  boolean := false;
  v_now timestamptz;
  v_max_until timestamptz;
  v_probe_until timestamptz;
  v_corrupt boolean;
begin
  if p_provider is null or p_provider not in ('gemini', 'groq', 'openrouter')
     or p_model is null or p_model = '*'
     or length(p_model) not between 1 and 120
     or p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
     or p_token is null then
    return query select false, null::uuid, 0, 'invalid'::text, ''::text;
    return;
  end if;

  -- Fast path: even OPEN and HALF_OPEN reads take no row lock. Under a storm,
  -- hundreds of blocked requests must not serialize on one tuple. A decision
  -- to probe is re-read under lock below; a concurrently opened circuit can
  -- still race a previously allowed network call, as with any in-flight call.
  select c.* into v_global
    from public.ai_provider_circuit c
   where c.provider = p_provider and c.model = '*'
     and c.blocked_until is not null;
  v_has_global := found;

  select c.* into v_model
    from public.ai_provider_circuit c
   where c.provider = p_provider and c.model = p_model
     and c.blocked_until is not null;
  v_has_model := found;

  v_now := clock_timestamp();
  v_max_until := v_now + interval '30 minutes';
  v_probe_until := v_now + interval '15 seconds';
  v_corrupt := (v_has_global and (v_global.blocked_until > v_max_until
      or coalesce(v_global.probe_until > v_now + interval '30 seconds', false)))
    or (v_has_model and (v_model.blocked_until > v_max_until
      or coalesce(v_model.probe_until > v_now + interval '30 seconds', false)));

  if not v_corrupt then
    if v_has_global and v_global.blocked_until > v_now then
      return query select false, null::uuid,
        ceil(extract(epoch from (v_global.blocked_until - v_now)) * 1000)::integer,
        v_global.reason, '*'::text;
      return;
    end if;
    if v_has_model and v_model.blocked_until > v_now then
      return query select false, null::uuid,
        ceil(extract(epoch from (v_model.blocked_until - v_now)) * 1000)::integer,
        v_model.reason, p_model;
      return;
    end if;
    if v_has_global and v_global.probe_until > v_now then
      return query select false, null::uuid,
        ceil(extract(epoch from (v_global.probe_until - v_now)) * 1000)::integer,
        'half_open'::text, '*'::text;
      return;
    end if;
    if v_has_model and v_model.probe_until > v_now then
      return query select false, null::uuid,
        ceil(extract(epoch from (v_model.probe_until - v_now)) * 1000)::integer,
        'half_open'::text, p_model;
      return;
    end if;
    if not v_has_global and not v_has_model then
      return query select true, null::uuid, 0, 'closed'::text, p_model;
      return;
    end if;
  end if;

  -- Expired or malformed state needs a transaction-level decision. Re-read
  -- and lock in stable order because another instance may have changed it
  -- after the fast snapshot.
  select c.* into v_global
    from public.ai_provider_circuit c
   where c.provider = p_provider and c.model = '*'
     and c.blocked_until is not null
   for update;
  v_has_global := found;
  select c.* into v_model
    from public.ai_provider_circuit c
   where c.provider = p_provider and c.model = p_model
     and c.blocked_until is not null
   for update;
  v_has_model := found;

  -- All deadlines use the database clock, never a Vercel instance clock.
  v_now := clock_timestamp();
  v_max_until := v_now + interval '30 minutes';
  v_probe_until := v_now + interval '15 seconds';

  -- A corrupt timestamp cannot strand a provider for years. Normalize once
  -- to a fixed DB-time deadline; subsequent reads do not slide the deadline.
  if v_has_global and (v_global.blocked_until > v_max_until
      or v_global.probe_until > v_now + interval '30 seconds') then
    update public.ai_provider_circuit c
       set blocked_until = least(c.blocked_until, v_max_until),
           probe_until = case when c.probe_until is null then null
             else least(c.probe_until, v_now + interval '30 seconds') end,
           updated_at = v_now
     where c.provider = p_provider and c.model = '*';
    v_global.blocked_until := least(v_global.blocked_until, v_max_until);
    if v_global.probe_until is not null then
      v_global.probe_until := least(v_global.probe_until, v_now + interval '30 seconds');
    end if;
  end if;
  if v_has_model and (v_model.blocked_until > v_max_until
      or v_model.probe_until > v_now + interval '30 seconds') then
    update public.ai_provider_circuit c
       set blocked_until = least(c.blocked_until, v_max_until),
           probe_until = case when c.probe_until is null then null
             else least(c.probe_until, v_now + interval '30 seconds') end,
           updated_at = v_now
     where c.provider = p_provider and c.model = p_model;
    v_model.blocked_until := least(v_model.blocked_until, v_max_until);
    if v_model.probe_until is not null then
      v_model.probe_until := least(v_model.probe_until, v_now + interval '30 seconds');
    end if;
  end if;

  if v_has_global and v_global.blocked_until > v_now then
    return query select false, null::uuid,
      ceil(extract(epoch from (v_global.blocked_until - v_now)) * 1000)::integer,
      v_global.reason, '*'::text;
    return;
  end if;
  if v_has_model and v_model.blocked_until > v_now then
    return query select false, null::uuid,
      ceil(extract(epoch from (v_model.blocked_until - v_now)) * 1000)::integer,
      v_model.reason, p_model;
    return;
  end if;
  if v_has_global and v_global.probe_until > v_now then
    return query select false, null::uuid,
      ceil(extract(epoch from (v_global.probe_until - v_now)) * 1000)::integer,
      'half_open'::text, '*'::text;
    return;
  end if;
  if v_has_model and v_model.probe_until > v_now then
    return query select false, null::uuid,
      ceil(extract(epoch from (v_model.probe_until - v_now)) * 1000)::integer,
      'half_open'::text, p_model;
    return;
  end if;

  if v_has_global or v_has_model then
    -- Both relevant rows are locked and confirmed expired. A single token
    -- owns both when both scopes need a recovery probe.
    if v_has_global then
      update public.ai_provider_circuit c
         set probe_token = p_token, probe_until = v_probe_until,
             updated_at = v_now
       where c.provider = p_provider and c.model = '*';
    end if;
    if v_has_model then
      update public.ai_provider_circuit c
         set probe_token = p_token, probe_until = v_probe_until,
             updated_at = v_now
       where c.provider = p_provider and c.model = p_model;
    end if;
    return query select true, p_token, 0, 'half_open'::text,
      case when v_has_global then '*'::text else p_model end;
    return;
  end if;

  return query select true, null::uuid, 0, 'closed'::text, p_model;
end;
$$;

-- Failure reports use DB time and update only for a material extension or
-- a probe-state transition. Fifty simultaneous 429 reports may make fifty RPC
-- calls, but near-identical deadlines do not cause fifty row rewrites.
create or replace function public.ai_circuit_fail(
  p_provider text, p_model text, p_reason text,
  p_duration_ms integer, p_token uuid
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_scope text;
  v_now timestamptz := clock_timestamp();
  v_until timestamptz;
  v_stored_until timestamptz;
  v_duration_ms integer;
begin
  if p_provider is null or p_provider not in ('gemini', 'groq', 'openrouter')
     or p_model is null or length(p_model) not between 1 and 120
     or (p_model = '*' and p_reason <> 'auth')
     or (p_model <> '*' and p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$')
     or p_reason is null
     or p_reason not in ('auth', 'quota', 'rate', 'model', 'server',
       'timeout', 'network', 'parse', 'empty', 'http') then
    return 0;
  end if;

  v_scope := case when p_reason = 'auth' then '*' else p_model end;
  v_duration_ms := least(greatest(coalesce(p_duration_ms, 0), 1000), 1800000);
  v_until := v_now + v_duration_ms * interval '1 millisecond';

  insert into public.ai_provider_circuit as c
    (provider, model, reason, blocked_until, probe_until, probe_token, updated_at)
  values (p_provider, v_scope, p_reason, v_until, null, null, v_now)
  on conflict (provider, model) do update
     set blocked_until = case when c.blocked_until is null
           then excluded.blocked_until
           else greatest(least(c.blocked_until, v_now + interval '30 minutes'),
             excluded.blocked_until) end,
         reason = case
           when c.blocked_until is null or excluded.blocked_until >= c.blocked_until
             then excluded.reason else c.reason end,
         probe_until = null,
         probe_token = null,
         updated_at = v_now
   where c.blocked_until is null
      or c.blocked_until > v_now + interval '30 minutes'
      or excluded.blocked_until > c.blocked_until + interval '1 second'
      or (c.probe_token is not null
          and (p_token is null or c.probe_token = p_token))
  returning blocked_until into v_stored_until;

  if v_stored_until is null then
    select c.blocked_until into v_stored_until
      from public.ai_provider_circuit c
     where c.provider = p_provider and c.model = v_scope;
  end if;
  return least(1800000, greatest(0,
    ceil(extract(epoch from (v_stored_until - clock_timestamp())) * 1000)::integer));
end;
$$;

-- Only the holder of the current lease may close it. A late success from an
-- older probe cannot erase a newer failure because failure clears the token.
create or replace function public.ai_circuit_success(
  p_provider text, p_model text, p_token uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_scope text;
  v_closed boolean := false;
begin
  if p_provider is null or p_provider not in ('gemini', 'groq', 'openrouter')
     or p_model is null or length(p_model) not between 1 and 120
     or (p_model <> '*' and p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$')
     or p_token is null then
    return false;
  end if;

  -- The same token may own both '*' and model after simultaneous expiry.
  -- Lock in the same stable order used by ai_circuit_gate.
  for v_scope in
    select c.model from public.ai_provider_circuit c
     where c.provider = p_provider and c.probe_token = p_token
     order by case when c.model = '*' then 0 else 1 end, c.model
     for update
  loop
    update public.ai_provider_circuit c
       set blocked_until = null, probe_until = null, probe_token = null,
           reason = '', updated_at = clock_timestamp()
     where c.provider = p_provider and c.model = v_scope
       and c.probe_token = p_token;
    if found then v_closed := true; end if;
  end loop;
  return v_closed;
end;
$$;

-- Do not copy the older coupang_* grant block: on this project's live DB,
-- explicit anon/authenticated EXECUTE grants survived a PUBLIC-only REVOKE.
revoke all on function public.ai_circuit_gate(text, text, uuid) from public;
revoke all on function public.ai_circuit_fail(text, text, text, integer, uuid) from public;
revoke all on function public.ai_circuit_success(text, text, uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.ai_circuit_gate(text, text, uuid) from anon;
    revoke all on function public.ai_circuit_fail(text, text, text, integer, uuid) from anon;
    revoke all on function public.ai_circuit_success(text, text, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.ai_circuit_gate(text, text, uuid) from authenticated;
    revoke all on function public.ai_circuit_fail(text, text, text, integer, uuid) from authenticated;
    revoke all on function public.ai_circuit_success(text, text, uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.ai_circuit_gate(text, text, uuid) to service_role;
    grant execute on function public.ai_circuit_fail(text, text, text, integer, uuid) to service_role;
    grant execute on function public.ai_circuit_success(text, text, uuid) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';

-- Read-only deployment check. Expected: table_exists=true, rls_enabled=true,
-- public_execute=false, anon_execute=false, authenticated_execute=false,
-- service_execute=true for every function.
select
  to_regclass('public.ai_provider_circuit') is not null as table_exists,
  (select c.relrowsecurity from pg_class c
    where c.oid = 'public.ai_provider_circuit'::regclass) as rls_enabled,
  p.proname,
  exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute,
  has_function_privilege('anon', p.oid, 'execute') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
  has_function_privilege('service_role', p.oid, 'execute') as service_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('ai_circuit_gate', 'ai_circuit_fail', 'ai_circuit_success')
order by p.proname;
