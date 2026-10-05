create table scan_queue_status (
  project_id uuid primary key references projects (id) on delete cascade,
  updated_at timestamptz not null default now(),
  queue_total int not null default 0,
  ready_now int not null default 0,
  waiting int not null default 0,
  notifications int not null default 0,
  dismissed_total int not null default 0,
  apartment_used int not null default 0,
  apartment_limit int not null default 500,
  house_used int not null default 0,
  house_limit int not null default 100,
  active_task jsonb,
  search_state jsonb,
  by_source jsonb not null default '{}'::jsonb,
  by_scenario jsonb not null default '{}'::jsonb
);

alter table scan_queue_status enable row level security;
