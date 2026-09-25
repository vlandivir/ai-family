create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  telegram_chat_id bigint,
  telegram_topic_id int,
  repo_url text,
  created_at timestamptz not null default now()
);

alter table projects enable row level security;

alter table conversations
  add constraint conversations_project_id_fkey
  foreign key (project_id) references projects (id);

alter table agent_jobs
  add constraint agent_jobs_project_id_fkey
  foreign key (project_id) references projects (id);

insert into projects (name, slug, telegram_chat_id, telegram_topic_id)
values ('Квартира в Белграде', 'belgrade-apartments', -1003563449188, 28);

update conversations
set project_id = projects.id
from projects
where projects.slug = 'belgrade-apartments'
  and conversations.kind = 'topic'
  and conversations.telegram_chat_id = projects.telegram_chat_id
  and conversations.telegram_topic_id = projects.telegram_topic_id;
