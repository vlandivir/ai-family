create table listings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id),
  catalog_number int,
  status text not null default 'new',
  city text,
  municipality text,
  neighborhood text,
  address text,
  source_url text,
  asking_price_eur int,
  area_m2 numeric,
  rooms numeric,
  floor int,
  year_built int,
  heating text,
  notes text,
  fit text,
  created_at timestamptz not null default now()
);

alter table listings enable row level security;

insert into listings (
  project_id,
  status,
  city,
  municipality,
  neighborhood,
  address,
  source_url,
  asking_price_eur,
  area_m2,
  rooms,
  floor,
  year_built,
  heating,
  notes,
  fit
)
select
  id,
  'test',
  'Belgrade',
  'Zvezdara',
  'Slavujev venac',
  'Тестовая, не из каталога',
  'https://example.com/test-listing',
  200000,
  70,
  3,
  3,
  2013,
  'central',
  'Проверка, что строка карточки читается. К переносу старого каталога не относится.',
  'не оценивалась'
from projects
where slug = 'belgrade-apartments';
