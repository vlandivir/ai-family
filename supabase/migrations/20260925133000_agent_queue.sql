create table conversations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid,
  kind text not null check (kind in ('private', 'topic')),
  telegram_chat_id bigint not null,
  telegram_topic_id int,
  opened_by text,
  cursor_chat_id text,
  started_at timestamptz not null default now(),
  closed_at timestamptz
);

create unique index one_open_private
  on conversations (opened_by)
  where kind = 'private' and closed_at is null;

create unique index one_topic
  on conversations (telegram_chat_id, telegram_topic_id)
  where kind = 'topic';

create table agent_jobs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id),
  project_id uuid,
  created_by uuid,
  source text not null,
  external_user_id text,
  kind text not null,
  payload jsonb not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  not_before timestamptz not null default now(),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  attempts int not null default 0,
  result jsonb,
  error text,
  context jsonb,
  artifacts jsonb not null default '[]'::jsonb
);

alter table conversations enable row level security;
alter table agent_jobs enable row level security;
