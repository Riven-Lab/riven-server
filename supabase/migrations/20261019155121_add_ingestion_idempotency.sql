-- Persist idempotency keys alongside accepted events so safe client retries
-- return the original event ID instead of creating duplicate rows.
alter table public.events
  add column idempotency_key_hash text
    constraint events_idempotency_key_hash_format_check
    check (idempotency_key_hash is null or idempotency_key_hash ~ '^[0-9a-f]{64}$');

create unique index events_project_idempotency_key_uidx
  on public.events (project_id, idempotency_key_hash)
  where idempotency_key_hash is not null;

create or replace function public.record_idempotent_ingestion_event(
  p_key_hash text,
  p_idempotency_key_hash text,
  p_event_name text,
  p_properties jsonb,
  p_occurred_at timestamptz
)
returns table (event_id uuid, replayed boolean, conflict boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_key_id uuid;
  v_project_id uuid;
  v_event_id uuid;
  v_existing_event_id uuid;
  v_existing_name text;
  v_existing_properties jsonb;
  v_existing_occurred_at timestamptz;
begin
  if p_idempotency_key_hash is null
     or p_idempotency_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid idempotency key digest';
  end if;

  -- Hold the key row lock so revocation cannot race this transaction.
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

  insert into public.events (
    project_id,
    api_key_id,
    event_name,
    properties,
    occurred_at,
    idempotency_key_hash
  )
  values (
    v_project_id,
    v_key_id,
    p_event_name,
    p_properties,
    p_occurred_at,
    p_idempotency_key_hash
  )
  on conflict (project_id, idempotency_key_hash)
    where idempotency_key_hash is not null
    do nothing
  returning id into v_event_id;

  if v_event_id is not null then
    return query select v_event_id, false, false;
    return;
  end if;

  -- If another request won the unique-index race, an identical body reuses
  -- its ID. A changed body with the same key is an explicit conflict.
  select e.id, e.event_name, e.properties, e.occurred_at
    into v_existing_event_id, v_existing_name, v_existing_properties, v_existing_occurred_at
    from public.events as e
    where e.project_id = v_project_id
      and e.idempotency_key_hash = p_idempotency_key_hash;

  if not found then
    raise exception 'Conflicting idempotent event could not be found';
  end if;

  if v_existing_name is distinct from p_event_name
     or v_existing_properties is distinct from p_properties
     or v_existing_occurred_at is distinct from p_occurred_at then
    return query select v_existing_event_id, false, true;
    return;
  end if;

  return query select v_existing_event_id, true, false;
end;
$$;

-- Only the server service role may invoke this RPC.
revoke all on function public.record_idempotent_ingestion_event(text, text, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_idempotent_ingestion_event(text, text, text, jsonb, timestamptz)
  to service_role;
