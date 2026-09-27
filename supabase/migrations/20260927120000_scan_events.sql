create table scan_events (
  id bigint generated always as identity primary key,
  project_id uuid not null references projects (id),
  listing_id uuid references listings (id) on delete set null,
  created_at timestamptz not null default now(),
  source_url text not null,
  action text not null check (action in ('search_page', 'candidate', 'recheck', 'analyze')),
  result text not null,
  http_status int,
  error text,
  details jsonb not null default '{}'::jsonb
);

create index scan_events_project_time
  on scan_events (project_id, created_at desc);

alter table scan_events enable row level security;
