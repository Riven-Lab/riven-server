-- Store one idempotency record per accepted batch so a lost HTTP response can
-- be retried without inserting the events twice.
create table public.ingestion_batches (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  event_ids uuid[] not null default '{}'::uuid[] check (cardinality(event_ids) <= 100),
  created_at timestamptz not null default now(),
  unique (project_id, idempotency_key_hash)
);

alter table public.ingestion_batches enable row level security;
revoke all on table public.ingestion_batches from anon, authenticated;
grant select, insert, update, delete on table public.ingestion_batches to service_role;

create or replace function public.record_idempotent_ingestion_batch(
  p_key_hash text,
  p_idempotency_key_hash text,
  p_payload_hash text,
  p_events jsonb
)
returns table (event_ids uuid[], replayed boolean, conflict boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_key_id uuid;
  v_project_id uuid;
  v_batch_id uuid;
  v_existing_payload_hash text;
  v_existing_event_ids uuid[];
  v_event_ids uuid[] := '{}'::uuid[];
  v_event jsonb;
  v_event_id uuid;
  v_event_count integer;
begin
  if p_idempotency_key_hash is null
     or p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
     or p_payload_hash is null
     or p_payload_hash !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'Invalid idempotent ingestion batch';
  end if;

  v_event_count := jsonb_array_length(p_events);
  if v_event_count < 1 or v_event_count > 100 then
    raise exception 'Ingestion batch must contain between 1 and 100 events';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_events) as item(value)
      where jsonb_typeof(item.value) is distinct from 'object'
         or jsonb_typeof(item.value -> 'name') is distinct from 'string'
         or (item.value ->> 'name') !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'
         or jsonb_typeof(coalesce(item.value -> 'properties', '{}'::jsonb)) is distinct from 'object'
         or item.value ->> 'occurred_at' is null
  ) then
    raise exception 'Invalid event in ingestion batch';
  end if;

  -- Lock the credential while checking revocation and updating last_used_at.
  select k.id, k.project_id
    into v_key_id, v_project_id
    from public.project_api_keys as k
    join public.projects as p on p.id = k.project_id
    where k.key_hash = p_key_hash
      and k.revoked_at is null
      and p.archived_at is null
    for update of k;

  if not found then
    return;
  end if;

  update public.project_api_keys
    set last_used_at = now()
    where id = v_key_id;

  -- Reserve the project-scoped key before writing events. ON CONFLICT waits
  -- for an in-flight reservation, so only one transaction can own this batch.
  insert into public.ingestion_batches (
    project_id,
    idempotency_key_hash,
    payload_hash
  )
  values (
    v_project_id,
    p_idempotency_key_hash,
    p_payload_hash
  )
  on conflict (project_id, idempotency_key_hash) do nothing
  returning id into v_batch_id;

  if v_batch_id is null then
    select b.payload_hash, b.event_ids
      into v_existing_payload_hash, v_existing_event_ids
      from public.ingestion_batches as b
      where b.project_id = v_project_id
        and b.idempotency_key_hash = p_idempotency_key_hash
      for update;

    if not found then
      raise exception 'Conflicting batch reservation could not be found';
    end if;

    if v_existing_payload_hash is distinct from p_payload_hash then
      return query select v_existing_event_ids, false, true;
      return;
    end if;

    return query select v_existing_event_ids, true, false;
    return;
  end if;

  -- Keep event order in the response by inserting each bounded item in order.
  for v_event in select value from jsonb_array_elements(p_events) as item(value)
  loop
    insert into public.events (
      project_id,
      api_key_id,
      event_name,
      properties,
      occurred_at
    )
    values (
      v_project_id,
      v_key_id,
      v_event ->> 'name',
      coalesce(v_event -> 'properties', '{}'::jsonb),
      (v_event ->> 'occurred_at')::timestamptz
    )
    returning id into v_event_id;

    v_event_ids := array_append(v_event_ids, v_event_id);
  end loop;

  update public.ingestion_batches
    set event_ids = v_event_ids
    where id = v_batch_id;

  return query select v_event_ids, false, false;
end;
$$;

revoke all on function public.record_idempotent_ingestion_batch(text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_idempotent_ingestion_batch(text, text, text, jsonb)
  to service_role;
