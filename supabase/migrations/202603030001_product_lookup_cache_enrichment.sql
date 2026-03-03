alter table if exists public.product_lookup_cache
  add column if not exists normalized_sku text generated always as (regexp_replace(sku, '^0+', '')) stored,
  add column if not exists source_url text,
  add column if not exists last_checked_at timestamptz not null default now();

create index if not exists product_lookup_cache_normalized_sku_idx
  on public.product_lookup_cache(normalized_sku);

create index if not exists product_lookup_cache_last_checked_idx
  on public.product_lookup_cache(last_checked_at desc);
