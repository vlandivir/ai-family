alter table listings
  add column source_urls jsonb not null default '[]'::jsonb;

update listings
set source_urls = jsonb_build_array(source_url)
where source_url is not null
  and source_urls = '[]'::jsonb;
