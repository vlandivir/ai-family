create index agent_jobs_due_telegram
  on agent_jobs (not_before, created_at, id)
  where source = 'telegram' and status = 'queued';
