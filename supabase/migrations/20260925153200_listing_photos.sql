create table listing_photos (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings (id),
  object_key text not null,
  position int not null default 0,
  created_at timestamptz not null default now()
);

alter table listing_photos enable row level security;

insert into listing_photos (listing_id, object_key, position)
select id, 'test/pixel.png', 0
from listings
where status = 'test'
  and address = 'Тестовая, не из каталога';
