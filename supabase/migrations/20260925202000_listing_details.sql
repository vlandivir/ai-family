alter table listings
  add column details jsonb not null default '{}'::jsonb;
