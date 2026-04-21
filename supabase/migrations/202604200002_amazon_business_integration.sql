-- Amazon Business Reporting API integration.
-- Stores OAuth connection state and synced order line items for transaction enrichment.

create extension if not exists pgcrypto;

alter table if exists public.transactions
  add column if not exists source text,
  add column if not exists source_payload jsonb not null default '{}'::jsonb,
  add column if not exists amazon_business_order_id text,
  add column if not exists amazon_business_line_item_key text,
  add column if not exists superseded_by_source text,
  add column if not exists superseded_at timestamptz;

create unique index if not exists transactions_amazon_business_line_item_unique_idx
  on public.transactions(user_id, amazon_business_order_id, amazon_business_line_item_key);

create index if not exists transactions_user_source_idx
  on public.transactions(user_id, source);

create index if not exists transactions_user_superseded_idx
  on public.transactions(user_id, superseded_at);

create table if not exists public.amazon_business_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  region text not null default 'NA',
  marketplace_region text not null default 'US',
  refresh_token text not null,
  status text not null default 'connected',
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_error text
);

create table if not exists public.amazon_business_oauth_states (
  state text primary key,
  user_id uuid not null,
  region text not null default 'NA',
  marketplace_region text not null default 'US',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create table if not exists public.amazon_business_order_line_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  order_id text not null,
  line_item_key text not null,
  order_date timestamptz,
  order_status text,
  purchase_order_number text,
  asin text,
  title text,
  seller_name text,
  quantity numeric,
  item_subtotal numeric,
  item_tax numeric,
  item_total numeric,
  currency text,
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, order_id, line_item_key)
);

create index if not exists amazon_business_order_line_items_user_date_idx
  on public.amazon_business_order_line_items(user_id, order_date desc);

create index if not exists amazon_business_order_line_items_user_order_idx
  on public.amazon_business_order_line_items(user_id, order_id);

alter table if exists public.amazon_business_connections enable row level security;
alter table if exists public.amazon_business_oauth_states enable row level security;
alter table if exists public.amazon_business_order_line_items enable row level security;

drop policy if exists amazon_business_connections_select_own on public.amazon_business_connections;
create policy amazon_business_connections_select_own
  on public.amazon_business_connections
  for select
  using (auth.uid() = user_id);

drop policy if exists amazon_business_order_line_items_select_own on public.amazon_business_order_line_items;
create policy amazon_business_order_line_items_select_own
  on public.amazon_business_order_line_items
  for select
  using (auth.uid() = user_id);
