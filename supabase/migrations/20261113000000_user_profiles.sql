-- Private, shopping-only preferences. The server uses a hash of the verified
-- identity as user_id; request-supplied identities are never trusted.
create table if not exists public.user_profiles (
  user_id text primary key check (user_id ~ '^[a-f0-9]{64}$'),
  preferred_brands text[] not null default '{}',
  budget_min bigint check (budget_min > 0),
  budget_max bigint check (budget_max > 0),
  category_interests text[] not null default '{}',
  recent_searches text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (budget_min is null or budget_max is null or budget_min <= budget_max)
);
alter table public.user_profiles enable row level security;
revoke all on public.user_profiles from public, anon, authenticated;
grant select, insert, update, delete on public.user_profiles to service_role;

-- Merge in one atomic upsert, so concurrent searches do not lose preferences.
create or replace function public.merge_ai_v3_user_profile(
  p_user_id text, p_brand text, p_category text, p_budget_min bigint, p_budget_max bigint
) returns void language sql security invoker set search_path = '' as $$
  insert into public.user_profiles as u
    (user_id, preferred_brands, budget_min, budget_max, category_interests, recent_searches)
  values (p_user_id, case when p_brand is null then '{}'::text[] else array[p_brand] end,
    p_budget_min, p_budget_max,
    case when p_category is null then '{}'::text[] else array[p_category] end,
    case when p_category is null then '{}'::text[] else array[p_category] end)
  on conflict (user_id) do update set
    preferred_brands = case when p_brand is null then u.preferred_brands
      else (array[p_brand] || array_remove(u.preferred_brands, p_brand))[1:20] end,
    budget_min = case when p_budget_min is null and p_budget_max is null then u.budget_min else p_budget_min end,
    budget_max = case when p_budget_min is null and p_budget_max is null then u.budget_max else p_budget_max end,
    category_interests = case when p_category is null then u.category_interests
      else (array[p_category] || array_remove(u.category_interests, p_category))[1:20] end,
    recent_searches = case when p_category is null then u.recent_searches
      else (array[p_category] || array_remove(u.recent_searches, p_category))[1:20] end,
    updated_at = now();
$$;
revoke all on function public.merge_ai_v3_user_profile(text,text,text,bigint,bigint) from public, anon, authenticated;
grant execute on function public.merge_ai_v3_user_profile(text,text,text,bigint,bigint) to service_role;
