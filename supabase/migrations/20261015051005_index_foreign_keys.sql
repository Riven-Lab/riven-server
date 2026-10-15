-- Index the foreign keys used for joins and delete checks as event volume grows.
create index if not exists project_api_keys_project_id_idx
  on public.project_api_keys (project_id);

create index if not exists events_api_key_id_idx
  on public.events (api_key_id);
