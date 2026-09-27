create table listing_number_counters (
  project_id uuid primary key references projects (id),
  last_number int not null check (last_number >= 0)
);

alter table listing_number_counters enable row level security;

insert into listing_number_counters (project_id, last_number)
select project_id, max(catalog_number)
from listings
where catalog_number is not null
group by project_id;

with missing as (
  select id, project_id,
         row_number() over (partition by project_id order by created_at, id)::int as ordinal
  from listings
  where catalog_number is null
)
update listings as listing
set catalog_number = coalesce(counter.last_number, 0) + missing.ordinal
from missing
left join listing_number_counters as counter on counter.project_id = missing.project_id
where listing.id = missing.id;

insert into listing_number_counters (project_id, last_number)
select project_id, max(catalog_number)
from listings
where catalog_number is not null
group by project_id
on conflict (project_id) do update
set last_number = excluded.last_number;

alter table listings
  alter column catalog_number set not null,
  add constraint listing_catalog_number_positive check (catalog_number > 0);

create unique index listings_project_catalog_number_unique
  on listings (project_id, catalog_number);

create function assign_listing_catalog_number()
returns trigger
language plpgsql
as $$
begin
  if new.catalog_number is null then
    insert into listing_number_counters (project_id, last_number)
    values (new.project_id, 1)
    on conflict (project_id) do update
    set last_number = listing_number_counters.last_number + 1
    returning last_number into new.catalog_number;
  else
    insert into listing_number_counters (project_id, last_number)
    values (new.project_id, new.catalog_number)
    on conflict (project_id) do update
    set last_number = greatest(listing_number_counters.last_number, excluded.last_number);
  end if;
  return new;
end;
$$;

create trigger assign_listing_catalog_number_before_insert
before insert on listings
for each row execute function assign_listing_catalog_number();

create function preserve_listing_catalog_number()
returns trigger
language plpgsql
as $$
begin
  if new.project_id is distinct from old.project_id
     or new.catalog_number is distinct from old.catalog_number then
    raise exception 'Listing project and catalog number cannot change';
  end if;
  return new;
end;
$$;

create trigger preserve_listing_catalog_number_before_update
before update on listings
for each row execute function preserve_listing_catalog_number();
