create table if not exists public.ai_v3_monitor_events (
  created_at timestamptz not null default now(),
  version text not null check (version in ('v3', 'legacy')),
  success boolean not null
);
create index if not exists ai_v3_monitor_events_version_created_idx on public.ai_v3_monitor_events (version, created_at desc);
alter table public.ai_v3_monitor_events enable row level security;
revoke all on public.ai_v3_monitor_events from public, anon, authenticated;
grant select, insert on public.ai_v3_monitor_events to service_role;
