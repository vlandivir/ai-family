alter table agent_jobs add column telegram_update_id bigint unique;

create index agent_jobs_telegram_waiting
  on agent_jobs (created_at, id)
  where source = 'telegram' and status = 'queued';
