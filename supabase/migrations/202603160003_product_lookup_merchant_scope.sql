alter table if exists public.product_lookup
  add column if not exists merchant text not null default 'any';

alter table if exists public.product_lookup
  add column if not exists normalized_item_number text generated always as (regexp_replace(item_number, '^0+', '')) stored;

do $$
begin
  if exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'product_lookup'
      and constraint_name = 'product_lookup_pkey'
  ) then
    alter table public.product_lookup drop constraint product_lookup_pkey;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'product_lookup'
      and constraint_name = 'product_lookup_pkey'
  ) then
    alter table public.product_lookup add constraint product_lookup_pkey primary key (merchant, item_number);
  end if;
end $$;

create index if not exists product_lookup_normalized_item_number_idx
  on public.product_lookup(merchant, normalized_item_number);

create index if not exists product_lookup_normalized_item_number_any_idx
  on public.product_lookup(normalized_item_number)
  where merchant = 'any';
