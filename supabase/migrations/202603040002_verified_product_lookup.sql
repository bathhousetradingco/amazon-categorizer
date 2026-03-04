create table if not exists public.product_lookup (
  item_number text primary key,
  product_name text not null,
  verified_by_user boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.product_lookup enable row level security;

drop policy if exists "Users can read verified product lookup" on public.product_lookup;
create policy "Users can read verified product lookup"
  on public.product_lookup
  for select
  to authenticated
  using (true);

drop policy if exists "Users can upsert verified product lookup" on public.product_lookup;
create policy "Users can upsert verified product lookup"
  on public.product_lookup
  for insert
  to authenticated
  with check (verified_by_user = true);

drop policy if exists "Users can update verified product lookup" on public.product_lookup;
create policy "Users can update verified product lookup"
  on public.product_lookup
  for update
  to authenticated
  using (true)
  with check (verified_by_user = true);
