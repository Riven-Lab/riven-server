-- Core storage for projects, project credentials, and append-only analytics events.
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.project_api_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists project_api_keys_active_hash_idx
  on public.project_api_keys (key_hash) where revoked_at is null;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  api_key_id uuid not null references public.project_api_keys(id) on delete restrict,
  event_name varchar(128) not null,
  properties jsonb not null default '{}'::jsonb check (jsonb_typeof(properties) = 'object'),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now()
);

create index if not exists events_project_occurred_idx
  on public.events (project_id, occurred_at desc);
create index if not exists events_project_name_occurred_idx
  on public.events (project_id, event_name, occurred_at desc);

-- RLS is enabled even though this first API accesses data only through its server credential.
alter table public.projects enable row level security;
alter table public.project_api_keys enable row level security;
alter table public.events enable row level security;

-- The RPC keeps key validation, last-used update, and event insert in one database transaction.
create or replace function public.record_ingestion_event(
  p_key_hash text,
  p_event_name text,
  p_properties jsonb,
  p_occurred_at timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_key_id uuid;
  v_project_id uuid;
  v_event_id uuid;
begin
  select k.id, k.project_id
    into v_key_id, v_project_id
    from public.project_api_keys as k
    join public.projects as p on p.id = k.project_id
    where k.key_hash = p_key_hash
      and k.revoked_at is null
      and p.archived_at is null
    for update of k;

  if not found then
    return null;
  end if;

  update public.project_api_keys set last_used_at = now() where id = v_key_id;
  insert into public.events (project_id, api_key_id, event_name, properties, occurred_at)
    values (v_project_id, v_key_id, p_event_name, p_properties, p_occurred_at)
    returning id into v_event_id;

  return v_event_id;
end;
$$;

-- Only the backend service role may invoke ingestion. The secret used by that role stays server-side.
revoke all on function public.record_ingestion_event(text, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.record_ingestion_event(text, text, jsonb, timestamptz) to service_role;

revoke all on table public.projects, public.project_api_keys, public.events from anon, authenticated;
grant select, insert, update, delete on table public.projects, public.project_api_keys, public.events to service_role;
