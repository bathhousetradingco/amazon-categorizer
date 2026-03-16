create table if not exists public.product_lookup_audit (
  id uuid primary key default gen_random_uuid(),
  merchant text not null default 'any',
  item_number text not null,
  previous_product_name text,
  new_product_name text not null,
  reason text,
  user_id uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

alter table public.product_lookup_audit enable row level security;

drop policy if exists "Users can read their product lookup audit" on public.product_lookup_audit;
create policy "Users can read their product lookup audit"
  on public.product_lookup_audit
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their product lookup audit" on public.product_lookup_audit;
create policy "Users can insert their product lookup audit"
  on public.product_lookup_audit
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create index if not exists product_lookup_audit_item_number_idx
  on public.product_lookup_audit(merchant, item_number, created_at desc);
