create table if not exists public.product_lookup_cache (
  sku text primary key,
  clean_name text not null,
  source text not null default 'serpapi',
  brand text,
  category text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists product_lookup_cache_source_idx
  on public.product_lookup_cache(source);

create or replace function public.set_product_lookup_cache_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_product_lookup_cache_updated_at on public.product_lookup_cache;
create trigger trg_product_lookup_cache_updated_at
before update on public.product_lookup_cache
for each row execute function public.set_product_lookup_cache_updated_at();
