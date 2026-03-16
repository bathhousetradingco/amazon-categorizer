alter table if exists public.product_lookup
  add column if not exists normalized_item_number text generated always as (regexp_replace(item_number, '^0+', '')) stored;

create index if not exists product_lookup_normalized_item_number_idx
  on public.product_lookup(normalized_item_number);
